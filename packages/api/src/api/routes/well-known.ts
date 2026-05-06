/**
 * `.well-known` metadata endpoints for the OAuth 2.1 / OIDC provider and
 * the MCP resource server (#2024).
 *
 * Three routes live here:
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

import { Hono } from "hono";
import { createLogger } from "@atlas/api/lib/logger";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";

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
 *   - `server.ts:resolveOAuthValidAudiences()` — added to the issuer's
 *     `validAudiences` allow-list so the token endpoint accepts it
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
function buildResourceUri(req: Request): string {
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
 * Build the authorization server URI — the issuer the protected-resource
 * metadata points at. Atlas's auth server lives at `${baseURL}/api/auth`
 * so we append that suffix to the resolved base.
 */
function buildAuthServerUri(req: Request): string {
  const base =
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(req.url).origin;
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/api/auth`;
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

// ── /.well-known/oauth-protected-resource/mcp/:workspace_id ─────────
// RFC 9728. Per the MCP authorization spec, the resource server (us)
// publishes one document per protected resource so the client can
// discover the auth server before making an authenticated request.
//
// `workspace_id` in the path is the resource identifier — clients
// reading this document learn that token audience must match the
// returned `resource` URI exactly. `bearer_methods_supported: ["header"]`
// reflects what the hosted MCP path accepts (no body / query bearers).
wellKnown.get("/oauth-protected-resource/mcp/:workspace_id", async (c) => {
  const requestId = crypto.randomUUID();
  const outcome = await loadAuthAndHelpers();
  if (outcome.kind === "not-managed") return notManagedResponse();
  if (outcome.kind === "load-failed") {
    return loadFailedResponse(requestId, outcome.reason);
  }

  const workspaceId = c.req.param("workspace_id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "bad_request", message: "Missing workspace_id", requestId }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

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
        scopes_supported: ["mcp:read", "mcp:write"],
      },
      // Silence the OIDC-scopes warning — the MCP resource server
      // intentionally lists `mcp:*` only. The auth server still
      // advertises openid/profile/email separately.
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
