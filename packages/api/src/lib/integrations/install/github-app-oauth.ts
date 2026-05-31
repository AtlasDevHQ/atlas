/**
 * Shared GitHub App OAuth credential-acquisition primitives (extracted in
 * v0.0.2 slice 6c, #3030).
 *
 * The GitHub App install dance (`github.com/apps/<slug>/installations/new` →
 * callback with `?code=&installation_id=`) is identical whether the resulting
 * install is an **action** (`GitHubOAuthInstallHandler`, pillar=action) or a
 * **datasource** (`OAuthDatasourceInstallHandler`, pillar=datasource). Both must:
 *
 *   1. exchange the user-OAuth `code` for a user access token, and
 *   2. verify the supplied `installation_id` is one the authenticating user
 *      actually has access to (`GET /user/installations`).
 *
 * Step 2 is the load-bearing defense against cross-tenant binding: the state
 * token gates only the *workspace* binding, not the *installation* binding — a
 * tampered callback URL could substitute an `installation_id` the attacker
 * doesn't own. Centralising the verification here means the github-data
 * datasource install (#3030) inherits the exact same threat-model coverage the
 * action install (#2751) already has, rather than re-deriving it.
 *
 * Both helpers take a `platform` slug (so the {@link PlatformOAuthExchangeError}
 * attributes the right catalog row) and an optional `fetchImpl` resolved at call
 * time (so tests inject a stub; production reads the live `globalThis.fetch`).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";

const log = createLogger("integrations.install.github-app-oauth");

const USER_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_INSTALLATIONS_URL = "https://api.github.com/user/installations";

/** Hard timeout on install-time GitHub round-trips. */
const INSTALL_FETCH_TIMEOUT_MS = 15_000;

/** Cap on `/user/installations` pages we'll walk before giving up. */
const MAX_INSTALLATIONS_PAGES = 10;

// ---------------------------------------------------------------------------
// GitHub API response shapes (narrow subsets we consume)
// ---------------------------------------------------------------------------

interface UserTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface UserInstallationsResponse {
  readonly total_count?: number;
  readonly installations?: ReadonlyArray<{
    readonly id?: number;
    readonly account?: {
      readonly login?: string;
      readonly type?: string;
    };
  }>;
}

/** The owning account of a verified installation, surfaced for admin-UI display. */
export interface InstallationOwnership {
  readonly login: string | null;
  readonly type: string | null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch | undefined,
): Promise<Response> {
  const fetcher = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange the user OAuth `code` for a user access token. GitHub's
 * OAuth-during-install flow uses the standard
 * `https://github.com/login/oauth/access_token` endpoint with
 * `client_id` + `client_secret` + `code`. Returns the parsed
 * `access_token`; throws {@link PlatformOAuthExchangeError} on any non-success
 * path. The error is attributed to `platform` so the route surfaces the right
 * catalog row.
 */
export async function exchangeUserCodeForToken(args: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly platform: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}): Promise<string> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      USER_OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: args.clientId,
          client_secret: args.clientSecret,
          code: args.code,
          redirect_uri: args.redirectUri,
        }).toString(),
      },
      INSTALL_FETCH_TIMEOUT_MS,
      args.fetchImpl,
    );
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    log.warn(
      { err: err instanceof Error ? err.message : String(err), timedOut: isAbort },
      isAbort
        ? "GitHub user-OAuth token endpoint timed out"
        : "GitHub user-OAuth token endpoint unreachable",
    );
    throw new PlatformOAuthExchangeError({
      message: isAbort
        ? "GitHub token endpoint timed out. Restart the install."
        : "Failed to reach GitHub token endpoint. Restart the install.",
      platform: args.platform,
      upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: UserTokenResponse;
  try {
    parsed = (await resp.json()) as UserTokenResponse;
  } catch {
    throw new PlatformOAuthExchangeError({
      message: "GitHub returned an unparseable token response. Restart the install.",
      platform: args.platform,
      upstreamError: `non-json ${resp.status}`,
    });
  }

  if (!resp.ok || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new PlatformOAuthExchangeError({
      message: "GitHub rejected the OAuth code. Restart the install.",
      platform: args.platform,
      upstreamError: parsed.error ?? `http_${resp.status}`,
    });
  }
  return parsed.access_token;
}

/**
 * Walk `/user/installations` looking for `targetInstallationId`. Returns the
 * matching installation's account info when found, or `null` when the user does
 * NOT have access to that installation — the signal that the callback was
 * tampered.
 *
 * GitHub paginates this endpoint; we follow the `Link: <…>; rel="next"` header
 * up to {@link MAX_INSTALLATIONS_PAGES}. A user with more installations than
 * that and the target in a later page fails closed — acceptable; the operator
 * can raise the cap if needed.
 */
export async function findUserInstallation(
  userAccessToken: string,
  targetInstallationId: string,
  opts: { readonly platform: string; readonly fetchImpl?: typeof globalThis.fetch },
): Promise<InstallationOwnership | null> {
  let url: string | null = `${USER_INSTALLATIONS_URL}?per_page=100`;
  let page = 0;
  while (url !== null && page < MAX_INSTALLATIONS_PAGES) {
    page++;
    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${userAccessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        INSTALL_FETCH_TIMEOUT_MS,
        opts.fetchImpl,
      );
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      throw new PlatformOAuthExchangeError({
        message: isAbort
          ? "GitHub API timed out while verifying installation ownership. Restart the install."
          : "Failed to reach GitHub API while verifying installation ownership. Restart the install.",
        platform: opts.platform,
        upstreamError: isAbort ? "timeout" : err instanceof Error ? err.message : String(err),
      });
    }

    if (!resp.ok) {
      throw new PlatformOAuthExchangeError({
        message: "GitHub rejected the user-installations lookup. Restart the install.",
        platform: opts.platform,
        upstreamError: `user_installations_http_${resp.status}`,
      });
    }

    let parsed: UserInstallationsResponse;
    try {
      parsed = (await resp.json()) as UserInstallationsResponse;
    } catch (err) {
      throw new PlatformOAuthExchangeError({
        message: "GitHub returned an unparseable user-installations response. Restart the install.",
        platform: opts.platform,
        upstreamError: err instanceof Error ? err.message : String(err),
      });
    }

    const match = parsed.installations?.find(
      (i) => typeof i.id === "number" && String(i.id) === targetInstallationId,
    );
    if (match) {
      return {
        login: typeof match.account?.login === "string" ? match.account.login : null,
        type: typeof match.account?.type === "string" ? match.account.type : null,
      };
    }
    url = parseNextLinkHeader(resp.headers.get("link"));
  }
  // Two ways out of the loop, with very different meanings — log the cap-hit so
  // a legitimate user whose target sits past the cap (whom we fail closed below,
  // surfacing the same "not owned" error as a genuine cross-tenant tamper) is
  // diagnosable from logs rather than from a confused operator. `url !== null`
  // means we stopped because we hit MAX_INSTALLATIONS_PAGES with more pages left.
  if (url !== null) {
    log.warn(
      { platform: opts.platform, pagesWalked: page, installationIdTail: targetInstallationId.slice(-4) },
      "Installation-ownership walk hit the page cap without matching — failing closed. " +
        "If a legitimate user owns many installations, raise MAX_INSTALLATIONS_PAGES.",
    );
  }
  return null;
}

/**
 * Parse the `Link` header per RFC 5988 / GitHub pagination — extracts the
 * `rel="next"` URL or returns null when absent. Permissive parser: any malformed
 * segment is silently skipped, since GitHub's emitter is standardized but
 * downstream proxies sometimes mangle whitespace.
 */
function parseNextLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const segment of header.split(",")) {
    const match = segment.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match && typeof match[1] === "string") return match[1];
  }
  return null;
}
