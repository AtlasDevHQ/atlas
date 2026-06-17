/**
 * OAuthStateToken — CSRF gate for Platform OAuth install flows.
 *
 * Per ADR-0004, Platform integration OAuth is a separate subsystem from
 * Better Auth's user OAuth. The `state` parameter that binds an install
 * start to its callback must be:
 *
 *   - signed (no client tampering)
 *   - keyed to `(workspaceId, catalogId)` so an attacker can't redirect
 *     a code earned for Workspace A into Workspace B's install record
 *   - short-lived (5–10 min default — the OAuth dance is interactive,
 *     so a long lifetime widens the attack window without buying us
 *     anything)
 *   - rotation-aware so an encryption-key rotation doesn't bulk-
 *     invalidate every in-flight install
 *
 * Token shape — a compact JWT-ish three-part format:
 *
 *   `base64url(header).base64url(payload).base64url(hmacSha256)`
 *
 * - header = `{ alg: "HS256", kid: <int>, typ: "AtlasOAuthState" }`
 *   - `kid` points into `ATLAS_ENCRYPTION_KEYS` (versioned keyset).
 *     Always written as the active version at mint time.
 * - payload = `{ workspaceId, catalogId, exp }` (exp in unix seconds)
 *
 * Why this shape (not full JWT via a library):
 *
 * - `@atlas/oauth-helper` exposes `decodeJwtPayload` for *consuming*
 *   tokens from external IDPs but doesn't ship an HMAC signer — adding
 *   one would require a package edit, which is out of scope for this
 *   slice (see issue #2652 footnote).
 * - The signing key derivation reuses the same versioned
 *   `ATLAS_ENCRYPTION_KEYS` keyset as `db/secret-encryption.ts`, so
 *   rotation is operator-aligned with the rest of the encryption story.
 * - `crypto.timingSafeEqual` guards against signature-comparison side
 *   channels.
 *
 * Verification policy:
 *
 *   `verify()` returns `null` on every failure path — malformed,
 *   tampered, expired, unknown kid, no key configured. Callers must NOT
 *   try to introspect which check tripped: leaking that lets attackers
 *   probe the validation pipeline. Token-validity is a boolean.
 */

import * as crypto from "crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";

const log = createLogger("integrations.install.oauth-state-token");

const SIG_ALGORITHM = "sha256";
const TYP = "AtlasOAuthState";
const ALG = "HS256";

/**
 * Default token lifetime. The OAuth dance is interactive — admin clicks
 * "Install Slack", lands on the consent screen, clicks "Allow". Ten
 * minutes covers reasonable network/think latency while keeping the
 * CSRF replay window narrow.
 *
 * Override via `ATLAS_OAUTH_STATE_TTL_SECONDS` at the env layer (per-
 * deploy tuning) or via the `ttlSeconds` option on `mint` (per-call,
 * primarily for tests). The env override is clamped to 60–3600s — values
 * outside the band are ignored with a `warn` log.
 */
const DEFAULT_TTL_SECONDS = 10 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;

export interface MintOptions {
  /** Override the token TTL in seconds. */
  readonly ttlSeconds?: number;
  /**
   * Override "now" in unix seconds — used by tests to mint expired or
   * far-future tokens deterministically. Defaults to `Date.now() / 1000`.
   */
  readonly nowSeconds?: number;
}

interface TokenHeader {
  readonly alg: typeof ALG;
  readonly kid: number;
  readonly typ: typeof TYP;
}

interface TokenPayload {
  readonly workspaceId: string;
  readonly catalogId: string;
  /** Expiration in unix seconds. */
  readonly exp: number;
}

export interface VerifiedState {
  readonly workspaceId: string;
  readonly catalogId: string;
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mints a signed state token binding the OAuth install start to its
 * callback. Always signs with the active (highest-version) key in the
 * configured keyset.
 *
 * Throws when no encryption key is configured — unlike opaque-secret
 * encryption (which has a dev-friendly plaintext passthrough), CSRF
 * protection cannot degrade silently. Fail loud at boot or first install
 * attempt so the operator gates this on real key material.
 */
export function mintOAuthStateToken(
  workspaceId: string,
  catalogId: string,
  options: MintOptions = {},
): string {
  const keyset = getEncryptionKeyset();
  if (!keyset) {
    throw new Error(
      "OAuthStateToken.mint: no encryption key configured — set ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET. CSRF state cannot fall through to plaintext.",
    );
  }

  const ttl = resolveTtlSeconds(options.ttlSeconds);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + ttl;

  const header: TokenHeader = {
    alg: ALG,
    kid: keyset.active.version,
    typ: TYP,
  };
  const payload: TokenPayload = { workspaceId, catalogId, exp };

  const headerB64 = encodeBase64UrlJson(header);
  const payloadB64 = encodeBase64UrlJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto
    .createHmac(SIG_ALGORITHM, keyset.active.key)
    .update(signingInput)
    .digest();

  return `${signingInput}.${encodeBase64Url(sig)}`;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verifies a state token. Returns the bound `(workspaceId, catalogId)`
 * on success, `null` on every failure mode (malformed, bad signature,
 * expired, unknown kid, no key configured). Never throws.
 *
 * Verification is constant-time on the signature comparison via
 * `crypto.timingSafeEqual`. Other checks (segment count, JSON parsing)
 * are not constant-time but reveal only "wrong shape" — the same answer
 * any random garbage string produces — so timing leaks have no useful
 * signal.
 */
export function verifyOAuthStateToken(token: string): VerifiedState | null {
  if (typeof token !== "string" || token.length === 0) return null;

  // `getEncryptionKeyset()` throws on malformed `ATLAS_ENCRYPTION_KEYS`
  // (duplicate version labels, mixed prefixed/bare, out-of-range version
  // ints). Those are operator misconfig that should normally fail at
  // boot — but the keyset resolver is lazy, so a regression that bypasses
  // the boot-time validation could surface the throw here. `verify` is
  // contractually `null`-only; warn loud once so the operator sees the
  // misconfig in logs, then return null. We don't surface the message to
  // callers because the verify return value is a boolean-shaped signal.
  let keyset: ReturnType<typeof getEncryptionKeyset>;
  try {
    keyset = getEncryptionKeyset();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "verifyOAuthStateToken: keyset resolution threw — operator misconfig in ATLAS_ENCRYPTION_KEYS; rejecting all tokens",
    );
    return null;
  }
  if (!keyset) {
    log.debug("verifyOAuthStateToken: no encryption key configured — rejecting");
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeBase64UrlJson<TokenHeader>(headerB64);
  if (!header || header.alg !== ALG || header.typ !== TYP) return null;
  if (typeof header.kid !== "number" || !Number.isFinite(header.kid)) return null;

  const key = keyset.byVersion.get(header.kid);
  if (!key) {
    log.debug(
      { kid: header.kid, activeKid: keyset.active.version },
      "verifyOAuthStateToken: unknown kid — rejecting (key may have been rotated out)",
    );
    return null;
  }

  const expectedSig = crypto
    .createHmac(SIG_ALGORITHM, key)
    .update(`${headerB64}.${payloadB64}`)
    .digest();

  let providedSig: Buffer;
  try {
    providedSig = base64UrlToBuffer(sigB64);
  } catch {
    // intentionally ignored: `verify` returns null on every failure
    // mode. A non-base64url signature segment is the same signal as
    // any other tampering — surfacing the specific cause (log or
    // distinct return value) would help an attacker probe the
    // pipeline. The contract is boolean-shaped.
    return null;
  }
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

  const payload = decodeBase64UrlJson<TokenPayload>(payloadB64);
  if (!payload) return null;
  if (typeof payload.workspaceId !== "string" || payload.workspaceId.length === 0) return null;
  if (typeof payload.catalogId !== "string" || payload.catalogId.length === 0) return null;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSeconds) return null;

  return { workspaceId: payload.workspaceId, catalogId: payload.catalogId };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveTtlSeconds(override: number | undefined): number {
  if (override !== undefined) {
    // Per-call override is for tests — allow anything ≥1 second.
    if (override >= 1 && Number.isFinite(override)) return Math.floor(override);
    return DEFAULT_TTL_SECONDS;
  }
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const envRaw = getSettingAuto("ATLAS_OAUTH_STATE_TTL_SECONDS");
  if (!envRaw) return DEFAULT_TTL_SECONDS;
  const parsed = Number.parseInt(envRaw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
    log.warn(
      { ATLAS_OAUTH_STATE_TTL_SECONDS: envRaw, min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS },
      "Ignoring out-of-range ATLAS_OAUTH_STATE_TTL_SECONDS — using default",
    );
    return DEFAULT_TTL_SECONDS;
  }
  return parsed;
}

function encodeBase64Url(buf: Buffer): string {
  // Standard base64 output has at most 2 trailing `=` padding chars, so
  // the strip pattern is bounded at `{0,2}` rather than `+`. CodeQL's
  // polynomial-regex check flags an unbounded `=+$` on input that flows
  // from `mintOAuthStateToken` callers (`workspaceId` / `catalogId`),
  // even though `Buffer.toString("base64")` can't produce >2 `=` chars.
  // Bounding the quantifier closes that finding without changing output.
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={0,2}$/, "");
}

function encodeBase64UrlJson(value: unknown): string {
  return encodeBase64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64UrlToBuffer(input: string): Buffer {
  // Restore standard base64 padding before letting Buffer parse it.
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const buf = Buffer.from(padded + pad, "base64");
  // `Buffer.from` is tolerant — round-trip to confirm the input was
  // valid base64url, so garbage like "@@@" doesn't sneak through.
  const reencoded = encodeBase64Url(buf);
  if (reencoded !== input) {
    throw new Error("invalid base64url");
  }
  return buf;
}

function decodeBase64UrlJson<T>(input: string): T | null {
  try {
    const buf = base64UrlToBuffer(input);
    const parsed = JSON.parse(buf.toString("utf8")) as T;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    // intentionally ignored: helper's return type pairs success with
    // `null` for both base64url and JSON parse failures. Callers in
    // `verifyOAuthStateToken` already gate on the null and return
    // null to the outer caller — the boolean-shaped contract is
    // documented at the function level.
    return null;
  }
}
