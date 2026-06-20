/**
 * Canonical OAuth scope list for the Atlas authorization server.
 *
 * Extracted from `auth/server.ts` (#3824) so consumers that only need the
 * scope SSOT — notably the `/auth.md` discovery route (`api/routes/auth-md.ts`),
 * which is pulled into the app's import graph — can read it WITHOUT pulling
 * the 3k-line Better Auth static graph into their path. Same wall-off
 * discipline as the `oauth-audiences.ts` extraction (#3687). `auth/server.ts`
 * re-exports this so the Better Auth `scopes` config and every other consumer
 * keep a single source of truth.
 *
 * Pure value — no imports, no env, no I/O.
 */

/**
 * Scopes advertised by the OAuth 2.1 authorization server. Standard OIDC
 * scopes plus Atlas-specific MCP scopes for the hosted MCP endpoint.
 *
 * The MCP authorization spec (2025-03-26) requires the resource server to
 * declare scopes in `/.well-known/oauth-protected-resource`; the `mcp:*`
 * scopes here are the ones Atlas-shaped MCP clients (Claude Desktop,
 * ChatGPT, Cursor, etc.) request when connecting to a hosted MCP endpoint.
 *
 * Order matters for the consent UI — declare the high-frequency scopes
 * first so the rendered list matches user expectations.
 */
export const ATLAS_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  // mcp:read = query workspace data through the MCP endpoint. Required
  // for any agent that wants to use Atlas as a data source.
  "mcp:read",
  // mcp:write = reserved for future write paths (run mutations, edit
  // semantic layer). Currently the hosted MCP surface is read-only, so
  // a token without mcp:write still works for every shipping MCP tool.
  // Declared so clients can request it now and the gate flips when we
  // add write tools.
  "mcp:write",
] as const;
