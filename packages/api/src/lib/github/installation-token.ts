/**
 * GitHub App installation-token minting (v0.0.2 slice 6c, #3030).
 *
 * GitHub Apps don't carry a long-lived bearer credential. Atlas persists only
 * the `installation_id`; the executable credential is a short-lived
 * **installation access token** (~1hr) minted on demand:
 *
 *   1. Sign a short App JWT (RS256) with the App's private key — whichever
 *      caller's key is passed in `deps` (operator env `GITHUB_APP_PRIVATE_KEY`,
 *      or a workspace's own; see the call sites below) — `iss = appId`,
 *      back-dated `iat` for clock skew, ≤10min `exp`.
 *   2. POST it (as `Authorization: Bearer <jwt>`) to
 *      `/app/installations/<installation_id>/access_tokens`.
 *   3. GitHub returns `{ token, expires_at }`. We cache the token in-process
 *      until shortly before `expires_at` ({@link TOKEN_REFRESH_MARGIN_MS}) and
 *      re-mint transparently afterward.
 *
 * This is the OQ5 "refresh" path: installation-token re-minting, NOT
 * refresh-token rotation. Three call sites depend on it:
 *
 *   - the install handler (`oauth-datasource-handler.ts`) mints once at install
 *     as a credential health-check (a failure flips the install to
 *     "reconnect needed"),
 *   - the workspace REST datasource resolver (`workspace-datasource.ts`) mints
 *     (or serves the cache) per chat turn to bake a `bearer` credential for the
 *     github-data datasource — "cache the shape, mint the secret", and
 *   - the per-workspace `github` ACTION target (`lib/tools/actions/github.ts`,
 *     #5555), which passes the TENANT's own App id and private key in `deps`
 *     rather than letting either default to operator env.
 *
 * That third caller is why the two claims this module used to make about the
 * private key both needed narrowing. It is still true of the operator tier
 * that the key never reaches the DB (only the installation_id is persisted);
 * for the workspace tier the tenant's key IS stored, encrypted, in
 * `workspace_action_credentials`, and arrives here already decrypted. And a
 * caller's credentials are now part of the cache key, so one tier can never be
 * served a token the other minted — see {@link cacheKey}.
 *
 * The cache is process-local and best-effort: a miss/expiry just re-mints. A
 * mint failure throws {@link GitHubInstallationTokenError} (never cached, so the
 * next call retries) — callers decide whether that's fatal (install) or
 * fail-soft skip (resolver).
 */

import { createHash } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("github.installation-token");

const GITHUB_API_BASE = "https://api.github.com";
const JWT_ALG = "RS256";
/**
 * App-JWT lifetime measured from `now` (the `exp` claim is `now + this`). GitHub
 * rejects a JWT whose `exp` is more than 10min after its `iat`; with the 60s
 * back-date below the `exp − iat` span is 540 + 60 = 600s = exactly that 10min
 * cap. Do NOT raise either constant independently — together they sit on the
 * limit, so any increase pushes the span over it and GitHub rejects the JWT.
 */
const APP_JWT_TTL_SECONDS = 9 * 60;
/** Back-date `iat` so a fast/slow clock at GitHub doesn't reject a just-minted JWT. */
const APP_JWT_BACKDATE_SECONDS = 60;
/** Re-mint this far before the installation token's stated expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Hard timeout on the mint round-trip. */
const MINT_FETCH_TIMEOUT_MS = 15_000;
/** GitHub installation ids are positive integers — reject anything else (path-injection guard). */
const INSTALLATION_ID_RE = /^[1-9][0-9]{0,18}$/;

/**
 * Thrown when an installation token cannot be minted — missing App config,
 * malformed installation id, a GitHub-side non-2xx, an unparseable response, or
 * a transport fault. A plain `Error` subclass (no Effect `_tag`): every call
 * site catches it locally (install → "reconnect needed"; resolver → skip), so it
 * never needs HTTP-status mapping. The message never includes the App private
 * key or the minted token.
 */
export class GitHubInstallationTokenError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "GitHubInstallationTokenError";
    this.reason = reason;
  }
}

/** Injectable seams — production reads env + the global `fetch` + the wall clock. */
export interface InstallationTokenDeps {
  /** GitHub App id (the `iss` claim). Defaults to `GITHUB_APP_ID`. */
  readonly appId?: string;
  /** GitHub App private key, PKCS8 PEM. Defaults to `GITHUB_APP_PRIVATE_KEY`. */
  readonly privateKey?: string;
  /** `fetch` override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** "now" in ms, for deterministic cache/expiry tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly token: string;
  /** Absolute ms after which the token must be re-minted (already net of the margin). */
  readonly refreshAtMs: number;
}

/**
 * Process-local cache, keyed by installation id AND a fingerprint of the App
 * credentials that minted the token — see {@link cacheKey}.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Cache/single-flight key: the installation id plus a fingerprint of the App
 * credentials the token would be minted with.
 *
 * The credential half is load-bearing, not defensive tidiness (#5555). An
 * installation token carries the permissions of the App that minted it, so
 * keying on the installation id ALONE means "whoever minted first for this
 * installation decides which App's token everyone gets". That was harmless
 * while one operator-env App was the only caller; it stops being harmless the
 * moment a second caller brings its OWN credentials, which is exactly what
 * the per-workspace GitHub action target does:
 *
 *   Atlas's operator App mints for installation 42 and caches it. A tenant
 *   then configures the `github` action target with installation 42 and a key
 *   that is wrong, revoked, or simply theirs — and the cache hands back the
 *   OPERATOR's token before either the key or the App id is ever exercised.
 *   The tenant's issue is created as Atlas, with Atlas's scopes.
 *
 * Hashing rather than concatenating keeps the private key out of a long-lived
 * Map key, and the NUL separator keeps `("1", "23")` from colliding with
 * `("12", "3")`. This is a cache key, never a credential check: a token is
 * still only ever minted by actually signing with the key presented.
 */
function cacheKey(installationId: string, appId: string, privateKey: string): string {
  const fingerprint = createHash("sha256")
    .update(`${appId}\u0000${privateKey}`)
    .digest("hex")
    .slice(0, 32);
  return `${installationId}:${fingerprint}`;
}

/**
 * In-flight mints, keyed exactly as the cache is ({@link cacheKey}). Coalesces
 * concurrent cold-cache callers (e.g. two chat turns in the same workspace
 * racing on a just-expired token) onto ONE mint round-trip rather than each
 * firing its own. A failed mint rejects all waiters and is removed (never
 * cached), so the next call retries. Concurrent callers share the first
 * caller's `deps` — safe because the App credentials, the part of `deps` that
 * decides WHICH token comes back, are in the key they coalesced on.
 */
const inFlight = new Map<string, Promise<string>>();

/** @internal Test-only — drops every cached + in-flight installation token. */
export function __resetInstallationTokenCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/** Minimal subset of GitHub's access-token response we consume. */
interface AccessTokenResponse {
  readonly token?: string;
  readonly expires_at?: string;
}

/**
 * Get a valid installation access token for `installationId`, minting (or
 * re-minting) via the App JWT when the cache is empty or near expiry. Throws
 * {@link GitHubInstallationTokenError} on any failure.
 */
export async function getGitHubInstallationToken(
  installationId: string,
  deps: InstallationTokenDeps = {},
): Promise<string> {
  if (!INSTALLATION_ID_RE.test(installationId)) {
    // Guard before the value reaches a URL path — our own config should never
    // hold a non-integer id, but fail loud rather than build an injecting URL.
    throw new GitHubInstallationTokenError(
      "invalid_installation_id",
      "GitHub installation id is not a positive integer — refusing to mint a token.",
    );
  }

  // Resolve the App credentials BEFORE the cache lookup: they are half the
  // cache key, so a hit cannot be established without them (see `cacheKey`).
  // This is why "not configured" is now reported even when a token for this
  // installation happens to be cached — that entry belongs to whichever
  // credentials minted it, and this caller has none to match it with.
  const appId = deps.appId ?? process.env.GITHUB_APP_ID;
  const privateKey = deps.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new GitHubInstallationTokenError(
      "missing_app_config",
      "GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset) — cannot mint an installation token.",
    );
  }

  const key = cacheKey(installationId, appId, privateKey);
  const now = deps.now ?? (() => Date.now());
  const cached = cache.get(key);
  if (cached && now() < cached.refreshAtMs) {
    return cached.token;
  }

  // Single-flight: a concurrent caller already minting for this installation
  // WITH THE SAME CREDENTIALS shares that promise instead of issuing a
  // duplicate mint. Keyed the same way as the cache, so two tiers minting for
  // one installation never share a flight either.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const minting = mintAndCache(installationId, key, appId, privateKey, deps, now);
  inFlight.set(key, minting);
  try {
    return await minting;
  } finally {
    inFlight.delete(key);
  }
}

/** Sign the App JWT, exchange it for an installation token, and cache the result. */
async function mintAndCache(
  installationId: string,
  key: string,
  appId: string,
  privateKey: string,
  deps: InstallationTokenDeps,
  now: () => number,
): Promise<string> {
  // Snapshot the clock once so the JWT claims, the expiry-cap fallback, and the
  // debug log all share one timestamp.
  const nowMs = now();
  const appJwt = await signAppJwt(appId, privateKey, nowMs);
  const minted = await mintInstallationToken(installationId, appJwt, deps.fetchImpl, nowMs);

  const refreshAtMs = minted.expiresAtMs - TOKEN_REFRESH_MARGIN_MS;

  // Opportunistic sweep of spent entries, on the rare path (a mint happens
  // about hourly per credential set). Keying by credentials rather than by
  // installation id alone removed the in-place overwrite that used to bound
  // this map: a rotated key now leaves behind an entry nothing will ever
  // replace. Dropping entries already past their refresh point bounds the map
  // by LIVE credentials instead of by every credential the process has seen.
  //
  // Deliberately not "evict the other entries for this installation": the two
  // tiers legitimately hold concurrent entries for one installation, so that
  // rule would have each mint evict the other's and make both re-mint every
  // call.
  for (const [existingKey, entry] of cache) {
    if (nowMs >= entry.refreshAtMs) cache.delete(existingKey);
  }

  cache.set(key, { token: minted.token, refreshAtMs });
  log.debug(
    { installationIdTail: installationId.slice(-4), refreshInSeconds: Math.round((refreshAtMs - nowMs) / 1000) },
    "Minted GitHub installation token",
  );
  return minted.token;
}

/**
 * Sign the short-lived App JWT (RS256). Throws on a malformed private key.
 *
 * ── Why neither catch here interpolates the caught message ────────────────
 *
 * Both used to. That was defensible while `GITHUB_APP_PRIVATE_KEY` was the
 * only key this module ever saw: the message went to an operator reading
 * their own logs. It stopped being defensible when the per-workspace `github`
 * action target started passing a TENANT's key (#5555), because a
 * `GitHubInstallationTokenError` raised on that path is caught by the action
 * handler, written to `action_log.error`, and handed back to the model — so a
 * parser message that quotes its input would publish tenant key bytes to
 * three places at once.
 *
 * The reachable case is not hypothetical: `normalizeAppPrivateKey` in
 * `lib/tools/actions/github.ts` validates via `createPrivateKey`, which
 * accepts an EC or Ed25519 key and re-exports it as valid PKCS#8 — and then
 * `importPKCS8(pem, "RS256")` rejects it here, with a message derived from
 * that key.
 *
 * The message also names no env var. This module now serves two tiers with
 * two different field names (`GITHUB_APP_PRIVATE_KEY` for Atlas's own App,
 * `GITHUB_ACTION_PRIVATE_KEY` for the workspace target), and naming either
 * one sends half its callers to a variable they cannot set.
 */
async function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(privateKeyPem, JWT_ALG);
  } catch (err) {
    // Logs and rethrows, so it takes no `intentionally ignored` marker — the
    // dropped detail is a secrecy decision, explained above. `err.name` is a
    // class name and carries nothing derived from the key.
    log.error(
      { reason: err instanceof Error ? err.name : "unknown" },
      "GitHub App private key is not a usable RS256 signing key",
    );
    throw new GitHubInstallationTokenError(
      "invalid_private_key",
      "The GitHub App private key is not a usable RS256 signing key. GitHub App keys are RSA — " +
        "re-enter the App's private key, the whole PEM including its BEGIN and END lines.",
    );
  }
  const nowS = Math.floor(nowMs / 1000);
  try {
    return await new SignJWT({})
      .setProtectedHeader({ alg: JWT_ALG, typ: "JWT" })
      .setIssuer(appId)
      .setIssuedAt(nowS - APP_JWT_BACKDATE_SECONDS)
      .setExpirationTime(nowS + APP_JWT_TTL_SECONDS)
      .sign(key);
  } catch (err) {
    // Same reasoning as the import catch above: this message can reach a
    // tenant-visible surface, and the signer holds the key.
    log.error(
      { reason: err instanceof Error ? err.name : "unknown" },
      "Failed to sign the GitHub App JWT",
    );
    throw new GitHubInstallationTokenError(
      "jwt_sign_failed",
      "Failed to sign the GitHub App JWT with the configured private key.",
    );
  }
}

/** POST the App JWT to mint an installation token; parse `{ token, expires_at }`. */
async function mintInstallationToken(
  installationId: string,
  appJwt: string,
  fetchImpl: typeof globalThis.fetch | undefined,
  nowMs: number,
): Promise<{ token: string; expiresAtMs: number }> {
  const fetcher = fetchImpl ?? globalThis.fetch;
  const url = `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`;

  let resp: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_FETCH_TIMEOUT_MS);
  try {
    resp = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    log.warn(
      { installationIdTail: installationId.slice(-4), timedOut: isAbort },
      isAbort ? "GitHub installation-token mint timed out" : "GitHub installation-token mint unreachable",
    );
    throw new GitHubInstallationTokenError(
      isAbort ? "timeout" : "network",
      isAbort
        ? "GitHub timed out while minting an installation token."
        : `Could not reach GitHub to mint an installation token: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    log.warn(
      { installationIdTail: installationId.slice(-4), status: resp.status },
      "GitHub rejected the installation-token mint",
    );
    throw new GitHubInstallationTokenError(
      `http_${resp.status}`,
      // Tier-neutral: a workspace admin hitting this through the `github`
      // action target has no datasource to reconnect, and telling them to
      // find one is the kind of unactionable message CLAUDE.md rules out.
      `GitHub rejected the installation-token request (HTTP ${resp.status}). The App may have been uninstalled, or its installation id or access revoked — re-check the App's installation and its credentials.`,
    );
  }

  let parsed: AccessTokenResponse;
  try {
    parsed = (await resp.json()) as AccessTokenResponse;
  } catch (err) {
    throw new GitHubInstallationTokenError(
      "unparseable_response",
      `GitHub returned an unparseable installation-token response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new GitHubInstallationTokenError(
      "missing_token",
      "GitHub's installation-token response did not include a token.",
    );
  }

  const expiresAtMs =
    typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : NaN;
  if (!Number.isFinite(expiresAtMs)) {
    // No (or unparseable) expiry — treat the token as valid only for the safety
    // margin so we re-mint promptly rather than caching an unbounded credential.
    // Log it: GitHub always sends `expires_at`, so a miss signals an upstream
    // contract change / a proxy stripping the field, and the cap silently ~12×es
    // mint traffic otherwise. Use the injected clock (not wall-clock) so the
    // capped expiry stays consistent with the cache check in the caller.
    log.warn(
      { installationIdTail: installationId.slice(-4) },
      "GitHub installation-token response had no parseable expires_at — capping validity to the safety margin",
    );
    return { token: parsed.token, expiresAtMs: nowMs + TOKEN_REFRESH_MARGIN_MS * 2 };
  }
  return { token: parsed.token, expiresAtMs };
}
