/**
 * The signed, short-lived, single-use **confirm token** primitive — the crypto
 * core behind every confirm-before-write gate in the product.
 *
 * It was written once, for the REST write gate (#3007,
 * `lib/openapi/rest-write-confirm.ts`). #5496 added a second gate on the same
 * shape — `correct_fact` staging a brain correction (`lib/brain/staged-correct.ts`)
 * — and the issue's instruction was *mirror it; do not re-derive it*. This module
 * is how that instruction is kept honest: there is now exactly ONE derivation of
 * the HMAC scheme, the canonicalization, the binding check and the nonce burn,
 * and the two gates differ only in their {@link ConfirmTokenKind} and their
 * claims.
 *
 * A second hand-copied implementation would not merely be duplication. Both
 * copies are security boundaries whose whole value is that a human's act is
 * SERVER-verifiable; two copies is two things that must stay correct, and the
 * one that rots is the one nobody reads.
 *
 * ## The scheme
 *
 * `base64url(header).base64url(payload).base64url(HMAC-SHA256)` — a JWT-shaped
 * token that is deliberately NOT a JWT: no `alg` negotiation (the header's `alg`
 * is checked equal to a constant, never dispatched on), and a mandatory `typ`
 * domain separator so a token minted for one gate cannot be presented at
 * another.
 *
 *   - {@link mintConfirmToken} signs `(claims…, nonce, exp)` with the ACTIVE key
 *     of the resolved encryption keyset (`ATLAS_ENCRYPTION_KEYS` →
 *     `ATLAS_ENCRYPTION_KEY` → `BETTER_AUTH_SECRET`) — the same keyset
 *     `oauth-state-token.ts` signs with, so no gate introduces a new secret.
 *   - {@link verifyConfirmToken} re-derives the expected claims from THIS
 *     request and rejects a missing / malformed / forged / expired token, or one
 *     minted for different claims. It is pure: it does not touch the nonce store.
 *   - {@link burnConfirmNonce} consumes the nonce so a replay is rejected.
 *
 * Mint THROWS when no signing key is configured, and that is the contract, not
 * an oversight: a human-in-the-loop gate must not degrade silently to an
 * unsigned (forgeable) token. Each caller maps the throw to a structured
 * "can't stage this" result so the operator gates the feature on real key
 * material.
 *
 * ## What this module does NOT own
 *
 * The claims. Each gate decides what its token binds and re-derives that binding
 * server-side at confirm time; this module only guarantees that a token whose
 * claims differ from the expected ones is refused. It also does not decide the
 * HTTP mapping of a rejection — every gate maps all attacker-probeable arms to
 * one neutral 400, so which check tripped cannot be probed.
 */
import * as crypto from "crypto";

import { createLogger } from "@atlas/api/lib/logger";
import { getEncryptionKeyset } from "@atlas/api/lib/db/encryption-keys";

const log = createLogger("confirm-token");

const SIG_ALGORITHM = "sha256";
const ALG = "HS256";
const NONCE_BYTES = 16;

/**
 * Default confirm-token lifetime. Every confirm step is interactive — something
 * is staged, a human reads a card ("this will delete 3 people") and clicks
 * Confirm. Ten minutes covers reasonable read/deliberate latency while keeping
 * the replay window narrow (the same interactive rationale as the OAuth state
 * token).
 */
export const DEFAULT_CONFIRM_TTL_SECONDS = 10 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;

/**
 * A confirm gate's identity: the `typ` domain separator that goes INSIDE the
 * signed header, plus the env var an operator overrides its TTL with.
 *
 * `typ` is what stops a token minted for one gate being replayed at another.
 * Both gates sign with the same key, so without it a valid REST-write confirm
 * token would verify at the brain-correction endpoint (and vice versa) as long
 * as the claims happened to line up — the signature alone says nothing about
 * WHICH gate asked for it. It is checked for equality against the kind the
 * verifier was called with, so adding a gate means adding a `typ`, not touching
 * this file's logic.
 */
export interface ConfirmTokenKind {
  /** Domain separator, e.g. `"AtlasRestConfirm"`. Distinct per gate. */
  readonly typ: string;
  /** Env var overriding this gate's TTL, clamped [60, 3600]. */
  readonly ttlEnvVar: string;
}

/**
 * The claims a token binds, as already-derived strings. Values must be strings
 * so the structural check after signature verification is total — a gate that
 * wants to bind structured data hashes it first (see {@link claimsHash}).
 */
export type ConfirmClaims = Readonly<Record<string, string>>;

export interface MintConfirmTokenOptions {
  /** Override the TTL in seconds (≥1). Primarily for tests; production uses the env/default. */
  readonly ttlSeconds?: number;
  /** Override "now" in unix seconds — tests mint expired / far-future tokens deterministically. */
  readonly nowSeconds?: number;
  /** Override the random nonce — tests only (forces a deterministic single-use id). */
  readonly nonce?: string;
}

interface TokenHeader {
  readonly alg: typeof ALG;
  readonly kid: number;
  readonly typ: string;
}

/** Why a confirm token was refused. Machine-readable for server-side logging; every caller maps the attacker-probeable arms to one neutral 400. */
export type ConfirmTokenRejection =
  | "missing"
  | "malformed"
  | "no-key"
  | "bad-signature"
  | "binding-mismatch"
  | "expired";

/** The result of {@link verifyConfirmToken}. On success it carries the nonce + exp the caller burns. */
export type ConfirmTokenVerification =
  | { readonly ok: true; readonly nonce: string; readonly expSeconds: number }
  | { readonly ok: false; readonly reason: ConfirmTokenRejection };

/**
 * Mint a single-use confirm token binding `claims`. Always signs with the active
 * (highest-version) key in the resolved encryption keyset.
 *
 * Throws when no signing key is configured — see the module header. The caller
 * maps the throw to a structured "can't stage this" result.
 *
 * `n` and `exp` are reserved: a gate must not use them as claim names, or its
 * binding would be silently overwritten by the nonce/expiry. Enforced here
 * rather than left to review, because the failure is invisible at rest — the
 * token still verifies, just against a claim the gate never actually bound.
 */
export function mintConfirmToken(
  kind: ConfirmTokenKind,
  claims: ConfirmClaims,
  options: MintConfirmTokenOptions = {},
): string {
  for (const reserved of ["n", "exp"] as const) {
    if (reserved in claims) {
      throw new Error(
        `mintConfirmToken(${kind.typ}): "${reserved}" is a reserved payload field (nonce / expiry) and cannot be a claim name.`,
      );
    }
  }

  const keyset = getEncryptionKeyset();
  if (!keyset) {
    throw new Error(
      `mintConfirmToken(${kind.typ}): no signing key configured — set ATLAS_ENCRYPTION_KEYS / ATLAS_ENCRYPTION_KEY / BETTER_AUTH_SECRET. ` +
        "The confirm-before-write gate cannot fall through to an unsigned token.",
    );
  }

  const ttl = resolveTtlSeconds(kind, options.ttlSeconds);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + ttl;
  const nonce = options.nonce ?? crypto.randomBytes(NONCE_BYTES).toString("base64url");

  const header: TokenHeader = { alg: ALG, kid: keyset.active.version, typ: kind.typ };
  // Claim order follows the caller's literal — the payload is compared field by
  // field at verify time, never by its serialization, so order is cosmetic here.
  const payload = { ...claims, n: nonce, exp };

  const headerB64 = encodeJson(header);
  const payloadB64 = encodeJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac(SIG_ALGORITHM, keyset.active.key).update(signingInput).digest();
  return `${signingInput}.${sig.toString("base64url")}`;
}

/**
 * Verify a confirm token against the claims re-derived from THIS confirm
 * request. Pure — it does not touch the single-use store (the caller
 * {@link burnConfirmNonce}s the returned nonce once the rest of validation
 * passes). Returns a tagged result; callers map every `ok: false` arm to one
 * neutral 400 (never revealing which check tripped — that would let an attacker
 * probe the pipeline).
 *
 * `nowSeconds` is injectable for deterministic expiry tests; it defaults to
 * wall-clock.
 */
export function verifyConfirmToken(
  kind: ConfirmTokenKind,
  token: string,
  expected: ConfirmClaims,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ConfirmTokenVerification {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing" };

  let keyset: ReturnType<typeof getEncryptionKeyset>;
  try {
    keyset = getEncryptionKeyset();
  } catch (err) {
    // getEncryptionKeyset throws on malformed ATLAS_ENCRYPTION_KEYS (operator
    // misconfig that should normally fail at boot). Warn once, reject all tokens.
    log.warn(
      { typ: kind.typ, err: err instanceof Error ? err.message : String(err) },
      "verifyConfirmToken: keyset resolution threw — operator misconfig; rejecting",
    );
    return { ok: false, reason: "no-key" };
  }
  if (!keyset) return { ok: false, reason: "no-key" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeJson<TokenHeader>(headerB64);
  // `typ` is the domain separator: a token minted for a DIFFERENT gate is
  // malformed here, before its signature is even checked.
  if (!header || header.alg !== ALG || header.typ !== kind.typ) return { ok: false, reason: "malformed" };
  if (typeof header.kid !== "number" || !Number.isFinite(header.kid)) return { ok: false, reason: "malformed" };

  const key = keyset.byVersion.get(header.kid);
  // Unknown kid (key rotated out) — treat like a bad signature: we can't verify it.
  if (!key) return { ok: false, reason: "bad-signature" };

  // The signature covers the received `headerB64.payloadB64` literally, so ANY
  // tampering of either segment fails this comparison — constant-time on the sig.
  const expectedSig = crypto.createHmac(SIG_ALGORITHM, key).update(`${headerB64}.${payloadB64}`).digest();
  const providedSig = Buffer.from(sigB64, "base64url");
  if (providedSig.length !== expectedSig.length) return { ok: false, reason: "bad-signature" };
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return { ok: false, reason: "bad-signature" };

  // Signature verified ⇒ the payload is trusted. Decode + structurally check it.
  const payload = decodeJson<Record<string, unknown>>(payloadB64);
  if (
    !payload ||
    typeof payload.n !== "string" ||
    payload.n.length === 0 ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }

  // Binding: every expected claim must be present and equal. Checked in BOTH
  // directions — a token carrying an EXTRA claim is refused too, so a gate that
  // narrows its binding in a later version cannot have an old, wider token
  // accepted against the subset it still checks.
  const expectedKeys = Object.keys(expected);
  const payloadClaimKeys = Object.keys(payload).filter((k) => k !== "n" && k !== "exp");
  if (payloadClaimKeys.length !== expectedKeys.length) return { ok: false, reason: "binding-mismatch" };
  for (const claim of expectedKeys) {
    if (typeof payload[claim] !== "string" || payload[claim] !== expected[claim]) {
      return { ok: false, reason: "binding-mismatch" };
    }
  }

  if (payload.exp <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, nonce: payload.n, expSeconds: payload.exp };
}

// ─────────────────────────────────────────────────────────────────────
//  Single-use nonce store (in-process)
// ─────────────────────────────────────────────────────────────────────

/**
 * Burned-nonce store: `nonce → exp (unix seconds)`. Only holds nonces that were
 * actually consumed (human-gated confirms — tiny). Eviction is lazy / on-write:
 * each {@link burnConfirmNonce} call first drops entries past their token's
 * `exp`, so if confirm traffic stops, already-expired entries linger until the
 * next burn — harmless, since the expiry check in {@link verifyConfirmToken}
 * rejects an expired token regardless of whether its nonce is still in the store.
 *
 * ONE store across all gates, deliberately: a nonce is 16 random bytes, so a
 * cross-gate collision is not a real event, and one store means one eviction
 * policy rather than N that can drift. A token is already pinned to its gate by
 * the `typ` domain separator, so the store does not need to distinguish them.
 *
 * In-process, like the rate-limit token bucket in `validate-rest-operation.ts`:
 * the single-use guarantee is exact WITHIN a process (the check-and-set is
 * synchronous, so two concurrent replays can't both win). Across replicas a
 * captured token could in principle be replayed on a different instance before
 * its short TTL — the same multi-instance caveat the rate-limit bucket documents.
 * A process restart drops the store, which only invalidates pending confirms
 * (fail-safe). Reset between tests via {@link _resetConfirmNonces}.
 */
const burnedNonces = new Map<string, number>();

/**
 * Atomically consume a confirm nonce. Returns `true` when it was newly burned
 * (caller may proceed to dispatch), `false` when it was already burned (a replay —
 * caller must reject). MUST be called synchronously with no intervening `await`
 * between token verification and dispatch, so concurrent replays of the same token
 * can't both pass before the nonce is recorded.
 */
export function burnConfirmNonce(
  nonce: string,
  expSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  // Opportunistic eviction of expired entries (store is small — short TTL, low
  // volume). Deleting during Map iteration is safe.
  for (const [n, exp] of burnedNonces) {
    if (exp <= nowSeconds) burnedNonces.delete(n);
  }
  if (burnedNonces.has(nonce)) return false; // replay
  burnedNonces.set(nonce, expSeconds);
  return true;
}

/** Clear the burned-nonce store. For tests. */
export function _resetConfirmNonces(): void {
  burnedNonces.clear();
}

// ─────────────────────────────────────────────────────────────────────
//  Claim helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * sha256 hex of a canonicalized value — the way a gate binds STRUCTURED data
 * (params, a replacement object) into a string claim without embedding it in a
 * token the client can read.
 */
export function claimsHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, `undefined`
 * object values dropped, array order preserved (query array values are
 * order-significant). So the same logical value always produces the same string
 * (and thus the same {@link claimsHash}), regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

// ─────────────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * The effective confirm-token TTL in seconds for one gate. Per-call override
 * (tests) takes precedence; otherwise read the gate's own env var, clamped
 * [60, 3600], defaulting to 600. Mirrors `ATLAS_OAUTH_STATE_TTL_SECONDS`.
 */
function resolveTtlSeconds(kind: ConfirmTokenKind, override?: number): number {
  if (override !== undefined) {
    if (Number.isFinite(override) && override >= 1) return Math.floor(override);
    return DEFAULT_CONFIRM_TTL_SECONDS;
  }
  const raw = process.env[kind.ttlEnvVar];
  if (!raw) return DEFAULT_CONFIRM_TTL_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
    log.warn(
      { envVar: kind.ttlEnvVar, value: raw, min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS },
      `Ignoring out-of-range ${kind.ttlEnvVar} — using default`,
    );
    return DEFAULT_CONFIRM_TTL_SECONDS;
  }
  return parsed;
}

/** base64url-encode a JSON value (native — no hand-rolled regex strip). */
function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Decode a base64url JSON segment to `T`, or `null` on any parse failure. For
 * the PAYLOAD this is only called AFTER signature verification, so a tampered
 * segment has already been rejected; this just guards against a
 * structurally-broken (but somehow signed) payload. The HEADER is necessarily
 * decoded before verification — which is why nothing in it is trusted beyond
 * selecting a key by `kid` and matching two constants.
 */
function decodeJson<T>(b64: string): T | null {
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as T;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    // intentionally ignored: a malformed segment collapses to null, which the
    // caller maps to a uniform rejection — the contract is boolean-shaped.
    return null;
  }
}
