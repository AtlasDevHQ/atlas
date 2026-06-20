/**
 * Heuristic secret/credential detector for durable working memory (#3757,
 * ADR-0020).
 *
 * Durable memory persists values a tool or the agent chose to remember across
 * turns. Without a guard it would become an exfiltration surface: a leaked API
 * key or connection string written into a slot would ride every subsequent
 * turn's prompt (and the admin memory view). This detector is the WRITE-TIME
 * guard — `LiveDurableStateStore.set` runs a candidate value through it and
 * REJECTS the write before persistence if it trips.
 *
 * It is deliberately CONSERVATIVE: it matches well-known credential SHAPES, not
 * arbitrary "sensitive" data. The goal is to stop an obvious key/token/secret
 * from being durably stored, while letting ordinary analyst memory (table names,
 * filters, prose, row counts, SQL) through untouched. False negatives are
 * acceptable (this is defense-in-depth, not the only control); false positives
 * on normal analyst values are not, because they would break the feature.
 *
 * Two complementary signals:
 *   1. SHAPE patterns — provider key prefixes, PEM private-key blocks, JWTs,
 *      bearer headers, connection-string passwords. High precision.
 *   2. A long high-entropy token fallback — a 40+ char run of letters + digits
 *      (a letter-and-digit mix, not necessarily mixed case) with no whitespace
 *      and high Shannon entropy. Catches a raw secret with no recognizable
 *      prefix, without flagging prose (low entropy / has spaces) or UUIDs (too
 *      short / too few distinct symbols).
 *
 * Unlike `scrubSecretsFromMessage` (which needs the secret VALUE in advance to
 * redact it), this inspects an UNKNOWN value and decides if it LOOKS like a
 * credential. It does not redact — it only flags, so the caller can reject.
 */

/**
 * The credential shapes the detector recognizes. A closed union (not bare
 * `string`) so a consumer can switch exhaustively, and so `kind` is
 * self-documenting — it names a SHAPE, never the matched value.
 */
export type SecretLikeKind =
  | "pem-private-key"
  | "jwt"
  | "bearer-token"
  | "aws-access-key-id"
  | "provider-key-prefix"
  | "connection-string-password"
  | "inline-credential-assignment"
  | "high-entropy-token";

/** What tripped the detector — surfaced in the rejection message (never the value itself). */
export interface SecretLikeMatch {
  /** A short, value-free label for the credential shape that matched. */
  readonly kind: SecretLikeKind;
}

/**
 * Named SHAPE patterns. Each `test` returns true when `s` contains a substring
 * of that credential shape. Ordered most-specific-first only for a tidy `kind`
 * label; matching is independent per pattern.
 */
const SHAPE_PATTERNS: ReadonlyArray<{ kind: SecretLikeKind; re: RegExp }> = [
  // PEM private key block (RSA / EC / OPENSSH / generic).
  { kind: "pem-private-key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  // JWT: three base64url segments separated by dots, header starts `eyJ`.
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // Bearer / Authorization header carrying a token.
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  // AWS access key id.
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{12,}\b/ },
  // Common provider/secret key prefixes (Stripe, OpenAI/Anthropic `sk-`,
  // GitHub `ghp_`/`gho_`/`ghs_`, Slack `xox*`, Google `AIza`).
  {
    kind: "provider-key-prefix",
    re: /\b(?:sk[-_][A-Za-z0-9_-]{16,}|pk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[posu]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/,
  },
  // Connection string with an inline password: scheme://user:pass@host.
  { kind: "connection-string-password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i },
];

/**
 * The inline `password = …` / `api_key: …` assignment shape is the ONE pattern
 * that legitimately collides with ordinary analyst memory: a remembered SQL
 * query compares a credential-NAMED column (`WHERE api_key = '2026-q1-prod'`),
 * which is a predicate, not a leaked secret. It is therefore kept SEPARATE from
 * {@link SHAPE_PATTERNS} (whose patterns match credential VALUE shapes that never
 * appear as SQL column names) and is suppressed when the surrounding string
 * {@link looksLikeSql}. A bare `password=…` key/value line (no SQL context) still
 * trips it — #3757 AC: reject leaked credentials, but never an analyst's SQL.
 */
const INLINE_CREDENTIAL_ASSIGNMENT =
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*\S{6,}/i;

/**
 * Heuristic: does `s` read as a SQL statement? Looks for a SQL verb AND a
 * structural keyword (FROM/WHERE/SET/INTO/VALUES) so a sentence that merely
 * contains the word "select" or "where" isn't misread as SQL. Used only to
 * suppress the inline-credential-assignment match (above) — a remembered query
 * that compares an `api_key`/`password` column is a predicate, not a secret.
 */
function looksLikeSql(s: string): boolean {
  const hasVerb = /\b(?:select|insert|update|delete|with|merge)\b/i.test(s);
  const hasStructure = /\b(?:from|where|set|into|values|join)\b/i.test(s);
  return hasVerb && hasStructure;
}

/** Lower bound for the high-entropy fallback. Below this length even a random token is too short to be a meaningful secret (and a UUID is 36). */
const HIGH_ENTROPY_MIN_LENGTH = 40;
/**
 * Shannon-entropy threshold (bits/char) for the fallback. Set to admit ordinary
 * analyst memory while still catching a raw secret:
 *   - a random base62 secret ≈ 5.2–6.0 → caught (well above the bar);
 *   - a long snake_case data-warehouse identifier with a year/version suffix
 *     (e.g. `daily_revenue_summary_by_product_category_2024`) ≈ 4.2–4.3 → passes;
 *   - a git SHA / hex digest ≈ 3.8–4.0 → passes;
 *   - English prose ≈ 4.0–4.5 (but it has spaces, so it's split into short
 *     low-length tokens that never reach the length bound anyway).
 * 4.5 sits in the gap between the DW-identifier ceiling (~4.3) and the
 * random-secret floor (~5.2). Raised from 4.0 after a remembered table name
 * tripped the old bar (#3757 review).
 */
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4.5;
/** A high-entropy candidate must be a single unbroken token of credential-alphabet chars. */
const TOKEN_RE = /^[A-Za-z0-9_\-+/.=]+$/;

/** Shannon entropy (bits per character) of a string. */
function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True when `token` is a long, single, high-entropy run that looks like a raw
 * secret. Requires BOTH high entropy AND a mix of letter+digit (a long lowercase
 * dictionary phrase joined by dashes would otherwise sneak past on length).
 */
function isHighEntropyToken(token: string): boolean {
  if (token.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (!TOKEN_RE.test(token)) return false;
  const hasLetter = /[A-Za-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  if (!hasLetter || !hasDigit) return false;
  return shannonBitsPerChar(token) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

/** Scan a single string for any credential shape or a high-entropy token. */
function scanString(s: string): SecretLikeMatch | null {
  for (const { kind, re } of SHAPE_PATTERNS) {
    if (re.test(s)) return { kind };
  }
  // The inline `key = value` assignment shape fires UNLESS the string is a SQL
  // statement (where `api_key = '…'` is a column predicate, not a secret). The
  // value-shape patterns above already ran, so a real credential VALUE pasted
  // inside SQL (e.g. a literal `sk-live-…`) is still caught by its own pattern.
  if (!looksLikeSql(s) && INLINE_CREDENTIAL_ASSIGNMENT.test(s)) {
    return { kind: "inline-credential-assignment" };
  }
  // High-entropy fallback: check each whitespace-delimited token, so a secret
  // embedded in a longer string (a log line) is still caught, while a prose
  // sentence (many low-entropy short words) is not.
  for (const token of s.split(/\s+/)) {
    if (isHighEntropyToken(token)) return { kind: "high-entropy-token" };
  }
  return null;
}

/**
 * Inspect an arbitrary JSON-serializable value (the shape a memory slot holds)
 * and return the first credential-shape match, or `null` if nothing trips.
 * Recurses into objects/arrays so a secret nested inside a remembered config
 * object is caught, not just a top-level string. Object KEYS are scanned too —
 * a key like `Authorization` carrying a token value is the common shape.
 *
 * Bounded recursion: a pathological deeply-nested or cyclic structure can't be
 * persisted anyway (the commit path's `JSON.stringify` would throw on a cycle),
 * but the depth guard keeps this total even if called on a raw value.
 */
export function findSecretLike(value: unknown, depth = 0): SecretLikeMatch | null {
  if (depth > 8) return null;
  if (typeof value === "string") return scanString(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretLike(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyHit = scanString(k);
      if (keyHit) return keyHit;
      const valHit = findSecretLike(v, depth + 1);
      if (valHit) return valHit;
    }
    return null;
  }
  // numbers / booleans / null / undefined — never a credential.
  return null;
}
