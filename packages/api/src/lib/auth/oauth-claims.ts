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
 * standard JWT claim. NOTE: the URN literal is duplicated in
 * `plugins/mcp/src/init/hosted.ts` (the CLI cannot import from
 * `@atlas/api`), so a domain migration requires a `grep` for the literal
 * across both packages — bumping this constant alone will silently
 * downgrade the CLI's plural-claim detection to "no claim found" rather
 * than fail loudly. Tracked in the duplicated `WORKSPACE_CLAIM` /
 * `WORKSPACES_CLAIM` consts on the plugin side.
 */

/**
 * The workspace-id custom claim. `verifyMcpBearer` rejects tokens that
 * don't carry this — see hosted.ts for the missing_workspace_claim
 * branch and the corresponding `missing_subject` adjacent path.
 */
export const ATLAS_OAUTH_WORKSPACE_CLAIM =
  "https://atlas.useatlas.dev/workspace_id";

/**
 * The plural workspace-ids claim (#2073). Emitted alongside the singular
 * claim above for tokens issued to users who belong to more than one
 * workspace, so the CLI can detect multi-workspace setup at write time
 * without a follow-up server call. The runtime authorization layer in
 * the hosted MCP edge does NOT rely on this claim — it does a live DB
 * lookup against `member` + `oauth_client_workspace_grants` so
 * membership revocation takes effect immediately rather than waiting
 * for token refresh. The claim is informational; the grants table is
 * authoritative.
 *
 * Privacy note: this claim leaks the user's full workspace membership
 * to whichever OAuth client received the token. Acceptable because
 * (a) the user explicitly authorized this client, (b) the JWT is a
 * user-bound credential the client already holds, and (c) the workspace
 * IDs are opaque UUIDs without org-name leakage.
 */
export const ATLAS_OAUTH_WORKSPACES_CLAIM =
  "https://atlas.useatlas.dev/workspace_ids";

/**
 * Read the active workspace id off a Better Auth session. The
 * `activeOrganizationId` field is contributed by the organization
 * plugin and is not part of the base session type the `oauthProvider`
 * hooks see — every consumer either casts inline or calls this helper.
 *
 * Returns `undefined` when the session has no active workspace OR the
 * field is empty: a token issued without a real workspace binding must
 * not carry the URN claim, and the empty string is never a valid
 * workspace identifier downstream.
 *
 * Three sites read this:
 *   1. `oauthProvider.clientReference` — DCR client ownership.
 *   2. `oauthProvider.postLogin.consentReferenceId` — the value
 *      stamped onto issued JWTs as the workspace claim.
 *   3. The canonical MCP eval's parallel `oauthProvider` config — so
 *      the eval and production share one source of truth and a
 *      regression in one site shows up in the other.
 */
export function readActiveOrgId(
  session: { activeOrganizationId?: string | null } | null | undefined,
): string | undefined {
  const orgId = session?.activeOrganizationId;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
}
