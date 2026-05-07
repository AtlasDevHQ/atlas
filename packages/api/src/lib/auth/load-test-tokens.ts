/**
 * Mint short-lived MCP-scoped JWTs for k6-driven load testing (#2135).
 *
 * The MCP load-test profile in CI (#2129) drives `/mcp/{workspace_id}/sse`
 * with a Bearer token. We do NOT walk the full OAuth 2.1 DCR + auth-code +
 * PKCE ceremony to obtain that bearer — every re-run would either pollute
 * prod with a permanent client/user or get stuck in a 5-step ceremony at
 * 2 AM. Instead, the platform-admin route in `admin-load-test.ts` mints
 * tokens directly here, bounded by:
 *
 *   - **TTL ceiling** — caller may request up to 3600s (1h). The endpoint
 *     refuses larger asks at the route layer (400) so caps cannot be
 *     widened by silent clamping.
 *   - **Scope** — exactly `mcp:read`. Future write tools must keep the
 *     connection-level requirement at `mcp:read` and gate inside the tool
 *     handler on `mcp:write`; this minter never grants write.
 *   - **Synthetic subject** — `loadtest:<workspaceId>:<random>`. Tool
 *     handlers and the audit pipeline treat the actor id as an opaque
 *     string with no FK to the `user` table (see issue body's research
 *     note). The `loadtest:` prefix makes load-test traffic trivially
 *     filterable in audit log queries.
 *   - **Per-region issuer + audience** — derived from a region map so a
 *     token for `eu` carries `aud=https://api-eu.useatlas.dev/mcp` and
 *     verifies on the eu MCP edge but fails on us. Cross-region misuse
 *     fails closed.
 *
 * The signing keypair comes from Better Auth's `jwks` table — same JWK
 * the OAuth 2.1 path uses, same kid, same algorithm. The MCP verifier
 * (`packages/mcp/src/hosted.ts:verifyMcpBearer`) resolves the matching
 * public key through `/api/auth/jwks` and verifies our minted token
 * exactly the same way it verifies a real OAuth-issued one. There is no
 * "load-test only" verifier path.
 */

import * as jose from "jose";
import { symmetricDecrypt } from "better-auth/crypto";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { ATLAS_OAUTH_WORKSPACE_CLAIM } from "@atlas/api/lib/auth/oauth-claims";

/** Server-side TTL ceiling. Requests above this hard-fail at the route. */
export const LOAD_TEST_TOKEN_MAX_TTL_SECONDS = 3600;

/** Default TTL when the caller omits `ttlSeconds`. */
export const LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS = 300;

/** Minimum TTL — anything below 60s defeats the purpose and trips clock skew. */
export const LOAD_TEST_TOKEN_MIN_TTL_SECONDS = 60;

/** Synthetic OAuth client id stamped onto every load-test token's `azp`. */
export const LOAD_TEST_CLIENT_ID = "atlas-load-test";

/** Scope granted on every load-test token. */
export const LOAD_TEST_SCOPE = "mcp:read";

/** Synthetic-subject prefix; the MCP verifier accepts arbitrary string subs. */
export const LOAD_TEST_SUBJECT_PREFIX = "loadtest:";

/**
 * Distinct error class so the route handler can map to 503 (vs 500 for
 * unexpected failures). The MCP verifier needs the JWKS endpoint to
 * resolve our `kid` — if there's no key in the table, the verify-side
 * resolver would 404 every minted token. Surface as 503 so the caller
 * knows to seed the table (any auth request will do).
 */
export class JwksNotInitializedError extends Error {
  readonly code = "jwks_not_initialized" as const;
  constructor() {
    super(
      "Better Auth JWKS table is empty. Hit any /api/auth/* endpoint on this region once to seed the keypair, then retry.",
    );
    this.name = "JwksNotInitializedError";
  }
}

export interface MintLoadTestTokenInput {
  /** Workspace id stamped onto the token's URN-shaped workspace claim. */
  readonly workspaceId: string;
  /** Time-to-live in seconds. Caller-supplied; the route enforces the [60, 3600] window before this is called. */
  readonly ttlSeconds: number;
  /** Resolved per-region issuer URL — `https://<region-api>/api/auth`. */
  readonly issuer: string;
  /** Resolved per-region audience URL — `https://<region-api>/mcp`. */
  readonly audience: string;
  /**
   * The validated `BETTER_AUTH_SECRET` (or equivalent) used to decrypt
   * Better Auth's stored `privateKey` envelope. Required whenever the
   * `jwks` row was written with `disablePrivateKeyEncryption: false`,
   * which is the default. Pass `null` to skip decryption (only safe if
   * the operator explicitly disabled JWKS encryption).
   */
  readonly secret: string | null;
}

export interface MintedLoadTestToken {
  /** The signed JWT — never log this. */
  readonly bearer: string;
  /** The synthetic actor id stamped on `sub`. Safe to log + audit. */
  readonly sub: string;
  /** JWT id — the audit row's correlation handle. Safe to log. */
  readonly jti: string;
  /** Wall-clock expiry as ISO 8601. */
  readonly expiresAt: string;
  /** Scope string burned onto the token. Mirrors {@link LOAD_TEST_SCOPE}. */
  readonly scope: string;
  /** Issuer URL the token claims (same value the verifier expects). */
  readonly issuer: string;
  /** Audience URL the token claims (same value the verifier expects). */
  readonly audience: string;
}

/**
 * Mint a short-lived MCP-scoped JWT for load testing.
 *
 * Steps:
 *   1. Read the most-recent JWK row from Better Auth's `jwks` table.
 *      Empty table → throw {@link JwksNotInitializedError} so the route
 *      can map to 503 with retry guidance.
 *   2. Decrypt the `privateKey` envelope using the supplied secret. The
 *      envelope shape is whatever Better Auth wrote — `JSON.stringify(...)`
 *      around either an encrypted blob (default) or a plain JWK string
 *      (when the operator opted out of encryption). We mirror Better
 *      Auth's own `signJWT` (in `better-auth/plugins/jwt/sign.mjs`) so a
 *      future encryption-format bump on their side surfaces here as a
 *      `BetterAuthError` we propagate, not as a silently-broken signature.
 *   3. Build the claim set verbatim against the MCP verifier's contract
 *      in `packages/mcp/src/hosted.ts`. Drift between this claim shape
 *      and the verifier is what would cause every minted token to 401 —
 *      both modules import `ATLAS_OAUTH_WORKSPACE_CLAIM` from the shared
 *      `oauth-claims.ts` so the workspace key cannot drift.
 *   4. Sign with `jose.SignJWT`. Algorithm comes from the JWK's embedded
 *      `alg` field (after JSON-parsing the column value) or falls back
 *      to `EdDSA` to match Better Auth's own default. The kid is the
 *      row's `id` so the verifier's JWKS resolver finds the matching
 *      public key by exact match.
 *
 * Tested against `better-auth@^1.6.9`. Envelope-shape changes upstream
 * (the JSON.stringify wrapping convention, `symmetricEncrypt`'s output,
 * the JWKS schema's column names) require revisiting `unwrapPrivateJwk`
 * + `readActiveJwk`.
 */
export async function mintLoadTestToken(
  input: MintLoadTestTokenInput,
): Promise<MintedLoadTestToken> {
  const jwk = await readActiveJwk();
  if (jwk === null) throw new JwksNotInitializedError();

  const privateJwk = await unwrapPrivateJwk(jwk.privateKey, input.secret);
  const alg = resolveAlg(privateJwk);
  const privateKey = await jose.importJWK(privateJwk, alg);

  const sub = synthesizeSubject(input.workspaceId);
  const jti = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + input.ttlSeconds;

  // The custom workspace claim is set last so the spread of "standard"
  // jose-managed claims (iat/exp/nbf/sub/aud/iss/jti) cannot accidentally
  // overwrite the URN-keyed value. Belt-and-braces — the URN shape can't
  // collide with any RFC 7519 claim — but it keeps the surface honest if
  // we ever add a second custom claim.
  const claims: Record<string, unknown> = {
    azp: LOAD_TEST_CLIENT_ID,
    scope: LOAD_TEST_SCOPE,
    [ATLAS_OAUTH_WORKSPACE_CLAIM]: input.workspaceId,
  };

  const bearer = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg, kid: jwk.id })
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(expSeconds)
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(sub)
    .setJti(jti)
    .sign(privateKey);

  return {
    bearer,
    sub,
    jti,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
    scope: LOAD_TEST_SCOPE,
    issuer: input.issuer,
    audience: input.audience,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

interface JwkRow {
  /** kid — the load-bearing handle the verifier uses to look up the public key. */
  readonly id: string;
  /** JSON-stringified public JWK (e.g. `{"kty":"OKP","crv":"Ed25519","x":"..."}`). */
  readonly publicKey: string;
  /**
   * JSON-stringified private key envelope. When Better Auth's
   * `disablePrivateKeyEncryption` is false (default), this is
   * `JSON.stringify(symmetricEncrypt(privateJwkJson))`. When true, it is
   * `JSON.stringify(privateJwkJson)`. We branch on shape inside
   * {@link unwrapPrivateJwk} rather than reading the auth options here
   * — fewer cross-module assumptions.
   */
  readonly privateKey: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * Read the freshest non-expired JWK from the `jwks` table. Returns null
 * when the table is empty so the caller can map to a typed 503 — vs a
 * 500 that would look like an unexpected failure to the SDK consumer.
 *
 * Column names are quoted because Better Auth writes camelCase identifiers
 * (`"publicKey"` etc.) — unquoted Postgres would fold them to lowercase
 * and the SELECT would return `null` for every row. Algorithm is NOT
 * read here — it lives inside the JWK after `JSON.parse`, not as a
 * separate column.
 */
async function readActiveJwk(): Promise<JwkRow | null> {
  const rows = await internalQuery<{
    id: string;
    publicKey: string;
    privateKey: string;
    createdAt: Date;
    expiresAt: Date | null;
  }>(
    `SELECT id, "publicKey", "privateKey", "createdAt", "expiresAt"
       FROM jwks
   ORDER BY "createdAt" DESC
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    publicKey: row.publicKey,
    privateKey: row.privateKey,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Unwrap the stored `privateKey` column to a usable JWK object.
 *
 * Better Auth wraps every stored key in `JSON.stringify(...)` regardless
 * of whether it's encrypted. The inner value is either:
 *
 *   - an encrypted envelope string (default — `symmetricEncrypt` output),
 *     which we feed back through `symmetricDecrypt` to get the JWK JSON
 *     string, then `JSON.parse` into a JWK object.
 *   - a plain JWK JSON string (when the operator set
 *     `disablePrivateKeyEncryption: true`), which we `JSON.parse` directly.
 *
 * We branch on shape (presence of jose's expected JWK keys after a
 * straight `JSON.parse`) so the two configurations don't need separate
 * code paths in the route — operators that disabled encryption keep
 * working without a config flag we'd have to plumb down.
 *
 * Throws if neither path produces a JWK object — never returns
 * partially-typed data, which would cause `jose.importJWK` to throw with
 * a less actionable error.
 */
async function unwrapPrivateJwk(
  storedPrivateKey: string,
  secret: string | null,
): Promise<jose.JWK> {
  let outer: unknown;
  try {
    outer = JSON.parse(storedPrivateKey);
  } catch (err) {
    throw new Error(
      `Failed to JSON.parse jwks.privateKey: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Case 1: operator disabled encryption — outer is already the JWK object.
  if (isJwkObject(outer)) return outer as jose.JWK;

  // Case 2: outer is the encrypted envelope string — decrypt then parse.
  if (typeof outer !== "string") {
    throw new Error(
      `jwks.privateKey JSON-parsed to ${typeof outer}, expected string envelope or JWK object`,
    );
  }
  if (secret === null) {
    throw new Error(
      "jwks.privateKey is encrypted but no secret was supplied — set BETTER_AUTH_SECRET or pass disablePrivateKeyEncryption.",
    );
  }
  const decrypted = await symmetricDecrypt({ key: secret, data: outer });
  let inner: unknown;
  try {
    inner = JSON.parse(decrypted);
  } catch {
    // CRITICAL: do NOT propagate the underlying JSON.parse error.
    // JSC/V8's parser embeds a fragment of the failing input in
    // err.message (verified empirically: `JSON.parse("secret-foo")` →
    // `JSON Parse error: Unexpected identifier "secret"`). The input
    // here is the *decrypted* signing key — leaking even a fragment of
    // it into the failure-path log/audit row would expose more material
    // than the bearer it protects. The route's failure-path catch
    // forwards `.message` into pino + `admin_action_log.metadata.error`,
    // so the message must carry no attacker-recoverable content. The
    // `cause` option is also intentionally omitted — pino's err
    // serializer walks the cause chain and would surface the original
    // JSON.parse message identically. The bare `catch` (no binding) is
    // the explicit "we deliberately do not propagate the caught error"
    // signal to project conventions.
    throw new Error(
      "Decrypted jwks.privateKey is not valid JSON. The envelope may be corrupted, the row may have been written under a different secret, or the encryption format may have changed.",
    );
  }
  if (!isJwkObject(inner)) {
    // Same hazard as above: do not include the parsed value (or any
    // derivative of it) in the message. `inner` could be anything from
    // a partially-corrupt JWK to an attacker-supplied plaintext.
    throw new Error(
      "Decrypted jwks.privateKey did not parse to a JWK object (missing or empty `kty` field).",
    );
  }
  return inner as jose.JWK;
}

/**
 * Minimal structural check for a JWK. We only verify that `kty` is a
 * non-empty string — `jose.importJWK` does the full validation. The
 * cheap shape check is enough to disambiguate the encrypted-string
 * branch from the unwrapped-JWK branch above.
 */
function isJwkObject(value: unknown): value is jose.JWK {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kty?: unknown }).kty === "string" &&
    (value as { kty: string }).kty.length > 0
  );
}

/**
 * Resolve the JWS algorithm. Mirrors Better Auth's own `signJWT` in
 * `better-auth/plugins/jwt/sign.mjs`: prefer the JWK's embedded `alg`
 * (`JSON.parse(privateKey).alg` after decryption), fall back to the
 * documented default. There is no `alg` column on the `jwks` table in
 * v1.6.9 — algorithm provenance lives entirely inside the serialized
 * JWK.
 */
function resolveAlg(jwk: jose.JWK): string {
  if (typeof jwk.alg === "string" && jwk.alg.length > 0) return jwk.alg;
  return "EdDSA";
}

function synthesizeSubject(workspaceId: string): string {
  // 8 random bytes → 16 hex chars = 64 bits of CSPRNG entropy. Enough
  // to make collisions across a single workspace's load-test history
  // vanishingly unlikely without bloating the audit row's `actor_id`.
  // (Slicing UUIDv4 hex would only yield ~58 effective bits because of
  // the version + variant bits that sit at fixed positions in the
  // first 16 hex chars.) The workspace prefix keeps forensic queries
  // pivoting cleanly on `actor_id LIKE 'loadtest:%'`.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${LOAD_TEST_SUBJECT_PREFIX}${workspaceId}:${random}`;
}
