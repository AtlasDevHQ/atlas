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

/** The `mcp:*` subset of the canonical scope union. */
type McpScope = Extract<(typeof ATLAS_OAUTH_SCOPES)[number], `mcp:${string}`>;

/**
 * The scopes /auth.md documents: the `mcp:*` set plus `offline_access`.
 * `offline_access` is included because the protected-resource metadata must
 * advertise it (DCR clients register with exactly the advertised list, and
 * the authorize endpoint validates against the client row's scopes — see
 * `well-known.ts`), and the parity gate requires the doc and the metadata to
 * name the same set.
 *
 * The `offline_access` arm is derived via `Extract` rather than hardcoded so it
 * stays tethered to the canonical union: rename or drop `offline_access` in
 * `ATLAS_OAUTH_SCOPES` and this narrows to just `McpScope`, turning the
 * `SCOPE_GRANTS` key and the `documentedScopes()` array into compile errors —
 * the guard that stops #4728 (a DCR scope silently missing from a surface) from
 * reappearing.
 */
type DocumentedScope =
  | McpScope
  | Extract<(typeof ATLAS_OAUTH_SCOPES)[number], "offline_access">;

export const authMd = new Hono();

/** Public docs base an integrator can follow to go deeper. */
const ATLAS_DOCS_URL = "https://docs.useatlas.dev";

/**
 * Path of the unauthenticated onboarding MCP endpoint hosting `start_trial`.
 * The canonical Streamable HTTP path — no `/sse` suffix, which would connote
 * the deprecated HTTP+SSE transport this endpoint does NOT speak (#3886). The
 * legacy `/mcp/onboarding/sse` alias still resolves; auth.md advertises the
 * canonical one.
 */
const ONBOARDING_MCP_PATH = "/mcp/onboarding";

/**
 * Human-readable grants for the documented scopes, keyed off the canonical
 * scope token. The `mcp:*` scopes plus `offline_access` are documented in
 * `/auth.md` — the file is about connecting an MCP actor, not the OIDC
 * sign-in scopes. Deriving the *set* from `ATLAS_OAUTH_SCOPES` (rather than
 * re-listing the scopes by hand) is what makes a newly-added `mcp:*` scope
 * surface automatically; a scope without a grant blurb here still appears,
 * with a generic line.
 */
const SCOPE_GRANTS: Partial<Record<DocumentedScope, string>> = {
  "mcp:read": "query workspace data through the hosted MCP endpoint",
  "mcp:write":
    "perform write operations (reserved for future mutation tools)",
  offline_access:
    "receive a refresh token so the connection survives access-token expiry",
};

/**
 * The scope set /auth.md documents. Exported so the discovery-parity gate
 * (`scripts/check-auth-md-discovery-parity.ts`) drives the SAME derivation the
 * live route serves rather than hand-mirroring it — a copy would be its own
 * drift vector.
 */
export function documentedScopes(): AuthMdScope[] {
  const mcp = ATLAS_OAUTH_SCOPES.filter((s): s is McpScope =>
    s.startsWith("mcp:"),
  );
  // mcp:* first (they are what the doc is about), offline_access last. Typed as
  // DocumentedScope[] so dropping/renaming `offline_access` in the canonical
  // union is a compile error here, not a silent surface divergence.
  const documented: DocumentedScope[] = [...mcp, "offline_access"];
  return documented.map((name) => ({
    name,
    grants: SCOPE_GRANTS[name] ?? "an Atlas MCP capability",
  }));
}

/**
 * Render the `/auth.md` document body for a request. The single source of
 * truth for the file's content: the live route handler below serves this, and
 * the apex-discovery generator (`packages/api/scripts/generate-apex-discovery.ts`)
 * renders the SAME function against the canonical `api.useatlas.dev` base to
 * emit the static `useatlas.dev/auth.md` mirror. Sharing one renderer (rather
 * than a second hand-written copy on www) is what keeps the apex snapshot from
 * drifting from what the API serves — a drift gate re-runs the generator and
 * fails on any diff. Hosts and scopes resolve from the same shared helpers +
 * canonical scope constant the `.well-known` router uses, so machine discovery
 * and this prose can't disagree.
 */
export function renderAuthMd(req: Request): string {
  return buildAuthMd({
    authServerUri: buildAuthServerUri(req),
    issuerBaseUri: buildIssuerBaseUri(req),
    resourceUri: buildResourceUri(req),
    scopes: documentedScopes(),
    onboardingPath: ONBOARDING_MCP_PATH,
    docsUrl: ATLAS_DOCS_URL,
  });
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

  return new Response(renderAuthMd(c.req.raw), {
    status: 200,
    headers: AUTH_MD_HEADERS,
  });
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
