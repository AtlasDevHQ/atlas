/**
 * `.well-known` endpoints served by the API origin: the OAuth 2.1 / OIDC
 * provider and MCP resource-server discovery documents (#2024), plus the
 * other per-origin `.well-known` surfaces — `/agent-configuration` (#4409)
 * and `/security.txt` (#4467), documented at their routes below.
 *
 * The three OAuth/MCP discovery routes:
 *
 *   /.well-known/oauth-authorization-server/api/auth
 *     RFC 8414 — published by the authorization server. Tells clients
 *     where the token / authorize / register / introspect / revoke
 *     endpoints live, what scopes are supported, what grant types and
 *     PKCE methods are allowed, etc.
 *
 *   /.well-known/openid-configuration/api/auth
 *     OIDC discovery — published when the `openid` scope is supported.
 *     Superset of the OAuth metadata above; OIDC clients (Claude
 *     Desktop, ChatGPT, Cursor) read this one.
 *
 *   /.well-known/oauth-protected-resource/mcp/{workspace_id}
 *     RFC 9728 — the *resource* server (us, mounted under /mcp) advertises
 *     which authorization server can issue tokens for it. The MCP
 *     authorization spec (2025-03-26) requires this for clients to
 *     bootstrap discovery: hit the resource URL, get a 401 with a
 *     resource-metadata pointer, fetch this document, then redirect to
 *     the auth server's /oauth2/authorize.
 *
 * The metadata endpoints are mounted under the issuer path because the
 * OAuth 2.1 spec mandates `path appending` (OIDC) and `path insertion`
 * (RFC 8414) for non-root issuers. Atlas's auth server lives at
 * `/api/auth`, so the canonical metadata locations include that suffix.
 *
 * CORS: every endpoint here returns `Access-Control-Allow-Origin: *`
 * because MCP clients (and the MCP Inspector debug tool) load these
 * documents from front-ends that aren't same-origin with our API. The
 * outer security middleware in api/index.ts overrides this for
 * authenticated routes; these are public-discovery endpoints by design.
 */

import { Hono, type Context } from "hono";
import type { ATLAS_OAUTH_SCOPES } from "@atlas/api/lib/auth/oauth-scopes";
import { createLogger } from "@atlas/api/lib/logger";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";

const log = createLogger("well-known");

// ---------------------------------------------------------------------------
// Audience derivation for the protected-resource metadata
// ---------------------------------------------------------------------------

/**
 * Build the resource-server audience URI for the hosted MCP endpoint.
 * One audience per *region* — not per workspace — because:
 *
 *   - The MCP authorization spec lets the resource server advertise a
 *     single resource that scopes the JWT's `aud` claim. Per-workspace
 *     audiences would require either (a) RFC 8707 with workspace ids
 *     pre-populated in the issuer's `validAudiences` (impossible —
 *     workspace ids are dynamic), or (b) a wildcard audience accept
 *     scheme that `oauthProvider` doesn't support today.
 *   - Workspace isolation is enforced one layer up via the custom
 *     `ATLAS_OAUTH_WORKSPACE_CLAIM`: `verifyMcpBearer` checks the path
 *     `{workspace_id}` matches the JWT claim. A leaked region-scoped
 *     token still can't pivot to a different workspace.
 *
 * Three sites must derive the same value:
 *   - `well-known.ts` (here) — advertised in the protected-resource doc
 *   - `hosted.ts:resourceAudience()` — passed to `verifyAccessToken`
 *   - `oauth-audiences.ts:resolveOAuthValidAudiences()` — added to the
 *     issuer's `validAudiences` allow-list so the token endpoint accepts it
 *
 * Resolution priority is identical across all three:
 *   1. ATLAS_PUBLIC_API_URL (per-region API host, e.g.
 *      `https://api.useatlas.dev` or `https://api-eu.useatlas.dev`)
 *   2. BETTER_AUTH_URL (the auth server's own base — same as #1 in
 *      single-region deployments)
 *   3. The request's URL origin — last-resort fallback for local dev
 *      where neither env var is set.
 *
 * #2068 — when the resolved base is one of the canonical SaaS regional
 * `api*.useatlas.dev` hosts, the doc advertises the brand-mirror
 * `mcp*.useatlas.dev/mcp` instead so clients reading discovery bind
 * tokens to the brand audience rather than the regional infra. The
 * issuer keeps accepting BOTH (`resolveOAuthValidAudiences`) so a
 * pre-cutover token bound to the regional host still verifies; this
 * function intentionally stops naming the regional surface so new
 * clients walk forward, not back.
 */
export function buildResourceUri(req: Request): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  const trimmed = base.replace(/\/+$/, "");
  return `${brandedMcpHost(trimmed) ?? trimmed}/mcp`;
}

/**
 * Map a SaaS regional API base (`api*.useatlas.dev`) to its
 * `mcp*.useatlas.dev` brand counterpart. Returns null for any host
 * outside the regional pattern — including the brand hosts themselves,
 * which already are the canonical surface and need no rewrite. The
 * caller falls back to the trimmed base in that case, so an operator
 * who already runs with `ATLAS_PUBLIC_API_URL=https://mcp.useatlas.dev`
 * still sees the brand advertised.
 *
 * Asymmetric on purpose: this is the "always advertise the brand"
 * helper. The audience-accept-list helper in
 * `server.ts:brandMcpAudience` is symmetric because the issuer must
 * keep accepting BOTH directions for backward compatibility; this
 * function only ever emits the brand-side URL.
 */
function brandedMcpHost(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // intentionally ignored: a non-URL base falls through to the
    // trimmed-string branch one frame up; logging here would double
    // up on every well-known request when the env var is misset.
    return null;
  }
  const matched = url.hostname.match(/^api(-[a-z0-9]+)?\.useatlas\.dev$/);
  if (!matched) return null;
  const regionSuffix = matched[1] ?? "";
  return `https://mcp${regionSuffix}.useatlas.dev`;
}

/**
 * Resolve the public API base the auth server (and the `.well-known`
 * discovery documents) are served from, e.g. `https://api.useatlas.dev`.
 * Same resolution precedence as `buildResourceUri` / `buildAuthServerUri`.
 *
 * Exported so the `/auth.md` route (#3824) can name the discovery-document
 * URLs at exactly the host the metadata is served from, without re-deriving
 * the base by string-stripping the issuer URI.
 */
export function buildIssuerBaseUri(req: Request): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  return base.replace(/\/+$/, "");
}

/**
 * Build the authorization server URI — the issuer the protected-resource
 * metadata points at. Atlas's auth server lives at `${baseURL}/api/auth`
 * so we append that suffix to the resolved base.
 *
 * Exported (alongside `buildResourceUri` / `buildIssuerBaseUri`) so the
 * `/auth.md` discovery route (#3824) feeds its prose builder the SAME
 * resolved hosts this router advertises — the human-readable file then
 * cannot drift from machine discovery.
 */
export function buildAuthServerUri(req: Request): string {
  return `${buildIssuerBaseUri(req)}/api/auth`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const wellKnown = new Hono();

interface OAuthHelpers {
  auth: Awaited<ReturnType<typeof import("@atlas/api/lib/auth/server").getAuthInstance>>;
  oauthProviderAuthServerMetadata: typeof import("@better-auth/oauth-provider").oauthProviderAuthServerMetadata;
  oauthProviderOpenIdConfigMetadata: typeof import("@better-auth/oauth-provider").oauthProviderOpenIdConfigMetadata;
  oauthProviderResourceClient: typeof import("@better-auth/oauth-provider/resource-client").oauthProviderResourceClient;
}

/**
 * Tagged outcome for the helper-load step. Three cases the route can
 * map to distinct responses:
 *
 *   - `managed` — `detectAuthMode() === "managed"` and helpers loaded.
 *     Serve the metadata.
 *   - `not-managed` — `detectAuthMode()` is anything else (none, byot,
 *     simple-key). The OAuth provider doesn't run there, so we 404
 *     without leaking that managed mode is unconfigured.
 *   - `load-failed` — managed auth IS configured but the helpers
 *     couldn't be loaded (missing `@better-auth/oauth-provider`,
 *     getAuthInstance crashed, etc.). Return 503 with a `requestId`
 *     and the underlying reason. This is a server outage, not a
 *     client problem; collapsing it to 404 (the prior behavior) hid
 *     real boot failures behind an irrelevant copy.
 */
type HelpersOutcome =
  | { kind: "managed"; helpers: OAuthHelpers }
  | { kind: "not-managed" }
  | { kind: "load-failed"; reason: string };

async function loadAuthAndHelpers(): Promise<HelpersOutcome> {
  if (detectAuthMode() !== "managed") return { kind: "not-managed" };
  try {
    const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
    const oauthProvider = await import("@better-auth/oauth-provider");
    const resourceClient = await import("@better-auth/oauth-provider/resource-client");
    return {
      kind: "managed",
      helpers: {
        auth: getAuthInstance(),
        oauthProviderAuthServerMetadata: oauthProvider.oauthProviderAuthServerMetadata,
        oauthProviderOpenIdConfigMetadata: oauthProvider.oauthProviderOpenIdConfigMetadata,
        oauthProviderResourceClient: resourceClient.oauthProviderResourceClient,
      },
    };
  } catch (err) {
    const reason = errorMessage(err);
    log.error(
      { err: reason },
      "Failed to load OAuth metadata helpers — well-known endpoints will 503",
    );
    return { kind: "load-failed", reason };
  }
}

/**
 * Standard CORS + cache headers for every metadata response. RFC 8414
 * recommends caching is on by default; our values mirror what the MCP
 * Inspector and the better-auth examples ship.
 *
 * `stale-while-revalidate=15` keeps clients from coordinating thundering-
 * herd refetches against our auth server when discovery info hasn't
 * changed.
 */
const METADATA_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control":
    "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
} as const;

/**
 * Wrap a Response from a Better Auth helper to guarantee our standard
 * metadata headers are on it. The helper takes a `headers` option but
 * its application is plugin-version-dependent and shouldn't be relied
 * on — we'd rather pay the small clone cost than ship a metadata
 * document without the CORS headers MCP Inspector and browser-based
 * MCP clients require.
 *
 * `Response.headers` is constructed-immutable in some runtimes, so the
 * safest path is `new Response(body, { ...res, headers: merged })`.
 */
async function withMetadataHeaders(res: Response): Promise<Response> {
  const merged = new Headers(res.headers);
  for (const [name, value] of Object.entries(METADATA_HEADERS)) {
    merged.set(name, value);
  }
  // Body must be re-constructed because `Response` body streams can
  // only be consumed once.
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: merged,
  });
}

function notManagedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "not_found",
      message:
        "OAuth metadata endpoints are only available when managed auth is enabled.",
    }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * 503 response for the `load-failed` outcome of `loadAuthAndHelpers`.
 * Distinct from `notManagedResponse` because the failure mode is
 * "managed auth is configured but the OAuth machinery did not boot",
 * not "this deployment is non-managed". Carries a `requestId` so a
 * customer escalation can be correlated to a log line.
 */
function loadFailedResponse(requestId: string, reason: string): Response {
  return new Response(
    JSON.stringify({
      error: "metadata_unavailable",
      message:
        "OAuth metadata helpers failed to load. Check server logs and the @better-auth/oauth-provider install.",
      reason,
      requestId,
    }),
    {
      status: 503,
      headers: METADATA_HEADERS,
    },
  );
}

/** Surface a metadata-generation failure with a correlatable requestId. */
function metadataUnavailableResponse(requestId: string): Response {
  return new Response(
    JSON.stringify({ error: "metadata_unavailable", requestId }),
    { status: 503, headers: METADATA_HEADERS },
  );
}

// The Better Auth metadata helpers each declare a structural generic
// constraint requiring the auth instance's `api` to expose plugin-
// extended methods (e.g. `getOAuthServerConfig`, `getOpenIdConfig`).
// Our `getAuthInstance()` returns a Better Auth instance typed at the
// base shape (server.ts deliberately erases plugin generics — see the
// `as unknown as AuthInstance` cast there). At runtime the methods
// exist; at compile time we widen with `as never` so the structural
// constraint resolves. This is the same shape Better Auth's own
// example code uses.
type AuthForHelper = Parameters<
  typeof import("@better-auth/oauth-provider").oauthProviderAuthServerMetadata
>[0];
type AuthForOidc = Parameters<
  typeof import("@better-auth/oauth-provider").oauthProviderOpenIdConfigMetadata
>[0];

// ── /.well-known/oauth-authorization-server/api/auth ────────────────
// RFC 8414. Path-insertion form: the issuer's path (`/api/auth`) is
// appended *after* the well-known segment.
wellKnown.get("/oauth-authorization-server/api/auth", async (c) => {
  const requestId = crypto.randomUUID();
  const outcome = await loadAuthAndHelpers();
  if (outcome.kind === "not-managed") return notManagedResponse();
  if (outcome.kind === "load-failed") {
    return loadFailedResponse(requestId, outcome.reason);
  }
  try {
    const handler = outcome.helpers.oauthProviderAuthServerMetadata(
      outcome.helpers.auth as unknown as AuthForHelper,
      { headers: METADATA_HEADERS },
    );
    return await withMetadataHeaders(await handler(c.req.raw));
  } catch (err) {
    log.error(
      { err: errorMessage(err), requestId },
      "oauth-authorization-server metadata generation failed",
    );
    return metadataUnavailableResponse(requestId);
  }
});

// ── /.well-known/openid-configuration/api/auth ──────────────────────
// OIDC discovery. Path-appending form. Same content as the OAuth
// metadata above plus OIDC-specific fields.
wellKnown.get("/openid-configuration/api/auth", async (c) => {
  const requestId = crypto.randomUUID();
  const outcome = await loadAuthAndHelpers();
  if (outcome.kind === "not-managed") return notManagedResponse();
  if (outcome.kind === "load-failed") {
    return loadFailedResponse(requestId, outcome.reason);
  }
  try {
    const handler = outcome.helpers.oauthProviderOpenIdConfigMetadata(
      outcome.helpers.auth as unknown as AuthForOidc,
      { headers: METADATA_HEADERS },
    );
    return await withMetadataHeaders(await handler(c.req.raw));
  } catch (err) {
    log.error(
      { err: errorMessage(err), requestId },
      "openid-configuration metadata generation failed",
    );
    return metadataUnavailableResponse(requestId);
  }
});

// ── /.well-known/oauth-protected-resource/mcp[/:workspace_id] ───────
// RFC 9728. Per the MCP authorization spec, the resource server (us)
// publishes a document for the protected resource so the client can
// discover the auth server before making an authenticated request.
//
// Two routes, one handler:
//   - `/oauth-protected-resource/mcp/:workspace_id` — the canonical path
//     the 401 `WWW-Authenticate: … resource_metadata=…` pointer hands out
//     (see hosted.ts `wwwAuthenticateHeader`). Spec-compliant clients
//     follow the pointer and land here.
//   - `/oauth-protected-resource/mcp` — a workspace-less alias. RFC 9728
//     §3.1 says a client MAY *construct* the metadata URL from the resource
//     (`https://mcp.useatlas.dev/mcp`) by path-insertion — which yields
//     exactly this segment, with NO workspace suffix. A client that skips
//     the `WWW-Authenticate` pointer and builds the default URL would
//     otherwise 404. Serving identical metadata here is a defensive hedge.
//
// `bearer_methods_supported: ["header"]` reflects what the hosted MCP path
// accepts (no body / query bearers). The metadata itself is region-scoped,
// not workspace-scoped (see the `resource` comment below), so both routes
// return the same document — `workspace_id` is used only for log correlation.
const handleProtectedResourceMetadata = async (c: Context): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const outcome = await loadAuthAndHelpers();
  if (outcome.kind === "not-managed") return notManagedResponse();
  if (outcome.kind === "load-failed") {
    return loadFailedResponse(requestId, outcome.reason);
  }

  const workspaceId = c.req.param("workspace_id");

  try {
    // Same structural-cast pattern as the auth-server / openid handlers
    // above — the resource client's generic ties to the plugin-extended
    // Auth shape that we erase at the singleton boundary.
    const client = outcome.helpers.oauthProviderResourceClient(
      outcome.helpers.auth as unknown as Parameters<
        typeof outcome.helpers.oauthProviderResourceClient
      >[0],
    );
    // The resource is region-scoped (one audience per API region), not
    // workspace-scoped. Workspace isolation is enforced at the verifier
    // via the `ATLAS_OAUTH_WORKSPACE_CLAIM` custom claim (see
    // `buildResourceUri` doc + hosted.ts). The path still segments by
    // `{workspace_id}` so a future per-workspace metadata extension
    // (e.g. policy URLs, contact info) has somewhere to land without
    // breaking clients hitting the canonical region resource.
    const metadata = await client.getActions().getProtectedResourceMetadata(
      {
        resource: buildResourceUri(c.req.raw),
        authorization_servers: [buildAuthServerUri(c.req.raw)],
        bearer_methods_supported: ["header"],
        // `offline_access` must be advertised alongside the `mcp:*` scopes:
        // DCR clients (Claude Code among them) register with exactly this
        // list, and `@better-auth/oauth-provider` validates authorize-time
        // scope requests against the CLIENT row's scopes (`client.scopes ??
        // opts.scopes`), not the server's. Omitting it makes every client
        // that wants a refresh token fail authorize with `invalid_scope`.
        // `satisfies` tethers each literal to the canonical scope union so a
        // rename there (e.g. of `offline_access`) is a compile error, not a
        // silent advertise-a-scope-the-server-can't-issue drift (#4728).
        scopes_supported: [
          "mcp:read",
          "mcp:write",
          "offline_access",
        ] satisfies readonly (typeof ATLAS_OAUTH_SCOPES)[number][],
      },
      // Silence the OIDC-scopes warning — the MCP resource server
      // intentionally omits the sign-in scopes (openid/profile/email);
      // the auth server advertises those separately.
      { silenceWarnings: { oidcScopes: true } },
    );

    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: METADATA_HEADERS,
    });
  } catch (err) {
    log.error(
      { err: errorMessage(err), workspaceId, requestId },
      "oauth-protected-resource metadata generation failed",
    );
    return metadataUnavailableResponse(requestId);
  }
};

wellKnown.get("/oauth-protected-resource/mcp/:workspace_id", handleProtectedResourceMetadata);
// RFC 9728 §3.1 path-insertion default (no workspace suffix) — see the
// handler doc above for why this alias exists.
wellKnown.get("/oauth-protected-resource/mcp", handleProtectedResourceMetadata);

// ── /.well-known/agent-configuration ────────────────────────────────
// Agent Auth Protocol discovery document (§6.1), gated by #4409's
// hot-reloadable `ATLAS_AGENT_AUTH_ENABLED` setting. Served FROM THE API
// (not a packages/web Next.js route) precisely because the gate decision
// needs `getSettingLive`, which a web route can't reach (#2058 §5's
// web-route sketch is stale).
//
// The document itself is the `agentAuth()` plugin's own canonical
// `/api/auth/agent-configuration` output, proxied through the Better Auth
// handler so the discovery doc can never drift from the endpoints the plugin
// actually serves. When the setting is off (default) — or managed auth is not
// configured — this returns 404, exactly like every other agent-auth path.
//
// Fail-closed: the gate resolves to off on any settings error, and a
// handler/proxy failure surfaces as 503 with a requestId rather than a
// misleading 404.
wellKnown.get("/agent-configuration", async (c) => {
  const requestId = crypto.randomUUID();

  // Gate first — when off, the surface does not exist. Checked before auth-mode
  // detection so an off deployment reveals nothing about managed-auth state.
  const { isAgentAuthEnabled } = await import("@atlas/api/lib/auth/agent-auth-gate");
  if (!(await isAgentAuthEnabled())) return notFoundAgentConfig();

  const outcome = await loadAuthAndHelpers();
  if (outcome.kind === "not-managed") return notFoundAgentConfig();
  if (outcome.kind === "load-failed") {
    return loadFailedResponse(requestId, outcome.reason);
  }

  try {
    // Proxy the plugin's own discovery endpoint. The agent-auth before-hook
    // only fires for `/agent/ /capability/ /host/` paths carrying a bearer, so
    // this bare GET reaches the discovery handler directly (public, no auth).
    const origin = new URL(c.req.url).origin;
    const upstream = await outcome.helpers.auth.handler(
      new Request(`${origin}/api/auth/agent-configuration`, { method: "GET" }),
    );
    if (!upstream.ok) {
      log.error(
        { requestId, status: upstream.status },
        "agent-configuration proxy returned non-2xx",
      );
      return metadataUnavailableResponse(requestId);
    }
    return await withMetadataHeaders(upstream);
  } catch (err) {
    log.error(
      { err: errorMessage(err), requestId },
      "agent-configuration discovery generation failed",
    );
    return metadataUnavailableResponse(requestId);
  }
});

/** 404 for the agent-configuration surface — shape mirrors `notManagedResponse`. */
function notFoundAgentConfig(): Response {
  return new Response(
    JSON.stringify({
      error: "not_found",
      message:
        "The Agent Auth discovery document is not available on this deployment.",
    }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

// ── /.well-known/security.txt ────────────────────────────────────────
// RFC 9116 is per-origin, and the api/mcp origins are exactly where a
// researcher who found a vulnerability goes looking for a disclosure
// contact (#4467). The canonical policy lives on www
// (apps/www/public/.well-known/security.txt — the SSOT; its `Expires:`
// refresh procedure lives in docs/guides/pgp-key-procedure.md, #1923).
// Every other Atlas-hosted origin points there instead of serving a
// second copy that could drift. RFC 9116 §3 explicitly permits serving
// the file via redirect.
//
// Gated on the resolved SaaS deploy mode: on a self-hosted deployment
// Atlas's security contact is NOT the operator's, so advertising it would
// misdirect vulnerability reports — the path stays 404 there, unchanged.
const WWW_SECURITY_TXT_URL =
  "https://www.useatlas.dev/.well-known/security.txt";

wellKnown.get("/security.txt", (c) => {
  if (getConfig()?.deployMode !== "saas") {
    return c.json(
      {
        error: "not_found",
        message: "security.txt is not published on this deployment.",
      },
      404,
    );
  }
  // Modest cache so crawlers don't hammer the origin; short enough that a
  // future move of the canonical copy propagates within an hour.
  c.header("Cache-Control", "public, max-age=3600");
  return c.redirect(WWW_SECURITY_TXT_URL, 302);
});

// CORS preflight — MCP Inspector and some browser MCP UIs probe before
// fetching. Same shape as the production response, no body.
wellKnown.options("/*", (c) => {
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  });
});
