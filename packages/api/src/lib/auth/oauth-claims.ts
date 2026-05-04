/**
 * Atlas-namespaced OAuth claim keys (#2024 PR C).
 *
 * Single source of truth for the custom JWT claims our `@better-auth/
 * oauth-provider` server stamps onto issued access tokens. Three sites
 * read this constant:
 *
 *   1. `packages/api/src/lib/auth/server.ts` — `customAccessTokenClaims`
 *      stamps the workspace_id onto outgoing JWTs.
 *   2. `packages/mcp/src/hosted.ts` — `verifyMcpBearer` reads the claim
 *      back out to resolve the authenticated workspace.
 *   3. `packages/mcp/src/__tests__/hosted.test.ts` — fixture payloads use
 *      the same key so the test can't drift from the production claim.
 *
 * The string itself is URN-shaped so it cannot collide with any future
 * standard JWT claim. If we ever migrate domains (e.g. `useatlas.dev` →
 * `useatlas.com`), bumping this constant is a single edit and every
 * downstream verifier breaks loudly until they pick up the change.
 */

/**
 * The workspace-id custom claim. `verifyMcpBearer` rejects tokens that
 * don't carry this — see hosted.ts for the missing_workspace_claim
 * branch and the corresponding `missing_subject` adjacent path.
 */
export const ATLAS_OAUTH_WORKSPACE_CLAIM =
  "https://atlas.useatlas.dev/workspace_id";
