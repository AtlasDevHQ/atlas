/**
 * GitHub App installation-token minting (v0.0.2 slice 6c, #3030).
 *
 * GitHub Apps don't carry a long-lived bearer credential. Atlas persists only
 * the `installation_id`; the executable credential is a short-lived
 * **installation access token** (~1hr) minted on demand:
 *
 *   1. Sign a short App JWT (RS256) with the App's private key
 *      (`GITHUB_APP_PRIVATE_KEY`, operator env) — `iss = appId`, back-dated `iat`
 *      for clock skew, ≤10min `exp`.
 *   2. POST it (as `Authorization: Bearer <jwt>`) to
 *      `/app/installations/<installation_id>/access_tokens`.
 *   3. GitHub returns `{ token, expires_at }`. We cache the token in-process
 *      until shortly before `expires_at` ({@link TOKEN_REFRESH_MARGIN_MS}) and
 *      re-mint transparently afterward.
 *
 * This is the OQ5 "refresh" path: installation-token re-minting, NOT
 * refresh-token rotation (the App private key never reaches the DB; only the
 * installation_id does). Two call sites depend on it:
 *
 *   - the install handler (`oauth-datasource-handler.ts`) mints once at install
 *     as a credential health-check (a failure flips the install to
 *     "reconnect needed"), and
 *   - the workspace REST datasource resolver (`workspace-datasource.ts`) mints
 *     (or serves the cache) per chat turn to bake a `bearer` credential for the
 *     github-data datasource — "cache the shape, mint the secret".
 *
 * The cache is process-local and best-effort: a miss/expiry just re-mints. A
 * mint failure throws {@link GitHubInstallationTokenError} (never cached, so the
 * next call retries) — callers decide whether that's fatal (install) or
 * fail-soft skip (resolver).
 */

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

/** Process-local cache keyed by installation id. */
const cache = new Map<string, CacheEntry>();

/**
 * In-flight mints keyed by installation id. Coalesces concurrent cold-cache
 * callers (e.g. two chat turns in the same workspace racing on a just-expired
 * token) onto ONE mint round-trip rather than each firing its own. A failed
 * mint rejects all waiters and is removed (never cached), so the next call
 * retries. Concurrent callers share the first caller's `deps` — fine in
 * production where deps are env-derived and identical.
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

  const now = deps.now ?? (() => Date.now());
  const cached = cache.get(installationId);
  if (cached && now() < cached.refreshAtMs) {
    return cached.token;
  }

  // Single-flight: a concurrent caller already minting for this installation
  // shares that promise instead of issuing a duplicate mint.
  const existing = inFlight.get(installationId);
  if (existing) return existing;

  const minting = mintAndCache(installationId, deps, now);
  inFlight.set(installationId, minting);
  try {
    return await minting;
  } finally {
    inFlight.delete(installationId);
  }
}

/** Sign the App JWT, exchange it for an installation token, and cache the result. */
async function mintAndCache(
  installationId: string,
  deps: InstallationTokenDeps,
  now: () => number,
): Promise<string> {
  const appId = deps.appId ?? process.env.GITHUB_APP_ID;
  const privateKey = deps.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new GitHubInstallationTokenError(
      "missing_app_config",
      "GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset) — cannot mint an installation token.",
    );
  }

  // Snapshot the clock once so the JWT claims, the expiry-cap fallback, and the
  // debug log all share one timestamp.
  const nowMs = now();
  const appJwt = await signAppJwt(appId, privateKey, nowMs);
  const minted = await mintInstallationToken(installationId, appJwt, deps.fetchImpl, nowMs);

  const refreshAtMs = minted.expiresAtMs - TOKEN_REFRESH_MARGIN_MS;
  cache.set(installationId, { token: minted.token, refreshAtMs });
  log.debug(
    { installationIdTail: installationId.slice(-4), refreshInSeconds: Math.round((refreshAtMs - nowMs) / 1000) },
    "Minted GitHub installation token",
  );
  return minted.token;
}

/** Sign the short-lived App JWT (RS256). Throws on a malformed private key. */
async function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(privateKeyPem, JWT_ALG);
  } catch (err) {
    throw new GitHubInstallationTokenError(
      "invalid_private_key",
      `GITHUB_APP_PRIVATE_KEY is not a valid PKCS8 RSA key: ${err instanceof Error ? err.message : String(err)}`,
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
    throw new GitHubInstallationTokenError(
      "jwt_sign_failed",
      `Failed to sign the GitHub App JWT: ${err instanceof Error ? err.message : String(err)}`,
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
      `GitHub rejected the installation-token request (HTTP ${resp.status}). The App may have been uninstalled or its access revoked — reconnect the datasource.`,
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
