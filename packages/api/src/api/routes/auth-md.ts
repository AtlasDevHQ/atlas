/**
 * `GET /auth.md` — the agent-onboarding discovery document (#3824).
 *
 * A static-prose Markdown file hosted at the conventional `/auth.md` path
 * (e.g. `https://mcp.useatlas.dev/auth.md`) that doubles as human integrator
 * documentation and a discoverable runtime artifact an `auth.md`-aware agent
 * can read to self-navigate Atlas's registration flow. It narrates the
 * "provision a trial, then connect" journey in one place — tying together
 * the OAuth 2.1 + DCR + PKCE machinery, the RFC 9728/8414 discovery
 * documents, and the `start_trial` self-serve provisioning path Atlas
 * already serves. See `lib/mcp/auth-md.ts` for the pure builder.
 *
 * Mounted alongside the `.well-known` discovery router and gated the same
 * way:
 *   - SaaS/managed-only: returns 404 when `detectAuthMode() !== "managed"`,
 *     with the same shape the metadata routes use. Off-SaaS there is no
 *     self-serve onboarding endpoint, so the file must not advertise one.
 *   - CORS-permissive (`Access-Control-Allow-Origin: *`) + the same cache
 *     headers, because MCP clients load discovery documents from front-ends
 *     that aren't same-origin with our API.
 *
 * Drift safety: the document's hosts and scopes are resolved from the SAME
 * helpers that back the `.well-known` router (`buildAuthServerUri` /
 * `buildResourceUri`, including the `api*.useatlas.dev` → `mcp*.useatlas.dev`
 * regional brand-mirror) and the canonical `ATLAS_OAUTH_SCOPES` constant.
 * Sharing the source of truth is what keeps `/auth.md` from advertising
 * endpoints, hosts, or scopes that disagree with machine discovery.
 */

import { Hono } from "hono";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { ATLAS_OAUTH_SCOPES } from "@atlas/api/lib/auth/oauth-scopes";
import { buildAuthMd, type AuthMdScope } from "@atlas/api/lib/mcp/auth-md";
import {
  buildAuthServerUri,
  buildIssuerBaseUri,
  buildResourceUri,
} from "./well-known";

/** The `mcp:*` subset of the canonical scope union — the scopes /auth.md documents. */
type McpScope = Extract<(typeof ATLAS_OAUTH_SCOPES)[number], `mcp:${string}`>;

export const authMd = new Hono();

/** Public docs base an integrator can follow to go deeper. */
const ATLAS_DOCS_URL = "https://docs.useatlas.dev";

/** Path of the unauthenticated onboarding MCP endpoint hosting `start_trial`. */
const ONBOARDING_MCP_PATH = "/mcp/onboarding/sse";

/**
 * Human-readable grants for the MCP scopes, keyed off the canonical scope
 * token. Only the `mcp:*` scopes are documented in `/auth.md` — the file is
 * about connecting an MCP actor, not the OIDC sign-in scopes. Deriving the
 * *set* from `ATLAS_OAUTH_SCOPES` (rather than re-listing the scopes by
 * hand) is what makes a newly-added `mcp:*` scope surface automatically; a
 * scope without a grant blurb here still appears, with a generic line.
 */
const MCP_SCOPE_GRANTS: Partial<Record<McpScope, string>> = {
  "mcp:read": "query workspace data through the hosted MCP endpoint",
  "mcp:write":
    "perform write operations (reserved for future mutation tools)",
};

function mcpScopes(): AuthMdScope[] {
  return ATLAS_OAUTH_SCOPES.filter(
    (s): s is McpScope => s.startsWith("mcp:"),
  ).map((name) => ({
    name,
    grants: MCP_SCOPE_GRANTS[name] ?? "an Atlas MCP capability",
  }));
}

/**
 * CORS + cache headers for the markdown response. Mirrors the
 * `.well-known` router's `METADATA_HEADERS` (same CORS + cache policy) but
 * with the `text/markdown` content type the file is served as.
 */
const AUTH_MD_HEADERS = {
  "Content-Type": "text/markdown; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control":
    "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
} as const;

/**
 * 404 for non-managed deployments. Same shape the `.well-known` metadata
 * routes use so a self-hosted operator sees one consistent "discovery
 * surface absent off managed auth" story. Off-SaaS there is no onboarding
 * endpoint, so the file must not exist.
 */
function notManagedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "not_found",
      message:
        "The /auth.md onboarding discovery file is only available when managed auth is enabled.",
    }),
    {
      status: 404,
      headers: { "Content-Type": "application/json" },
    },
  );
}

authMd.get("/", (c) => {
  if (detectAuthMode() !== "managed") return notManagedResponse();

  const body = buildAuthMd({
    authServerUri: buildAuthServerUri(c.req.raw),
    issuerBaseUri: buildIssuerBaseUri(c.req.raw),
    resourceUri: buildResourceUri(c.req.raw),
    scopes: mcpScopes(),
    onboardingPath: ONBOARDING_MCP_PATH,
    docsUrl: ATLAS_DOCS_URL,
  });

  return new Response(body, { status: 200, headers: AUTH_MD_HEADERS });
});

// CORS preflight — same shape as the sibling `.well-known` discovery routes.
authMd.options("/", (c) => {
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  });
});
