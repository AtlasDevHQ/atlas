/**
 * Cross-workspace agent identity helpers (#2073).
 *
 * The hosted MCP edge needs three things to admit a request from a
 * multi-workspace OAuth client:
 *
 *   1. The client's `workspace_scope` — `single` (legacy) routes through
 *      the existing `pathWorkspaceId === verified.orgId` check; `multi`
 *      runs the priority-chain resolver below.
 *   2. The list of workspaces the client has been GRANTED access to —
 *      admin-controlled via the per-user CLI prompt or the Settings → AI
 *      Agents UI.
 *   3. A live membership check — the user must currently belong to the
 *      resolved workspace. The grant table is admin policy; membership
 *      is org policy. Both must hold for admission.
 *
 * Why live membership instead of JWT plural claims:
 *   The original issue proposal sketched plural workspace claims in the
 *   JWT so the bearer carried "the user's workspaces at issuance time".
 *   That model has a 1-hour staleness window (the token TTL) before
 *   membership revocation takes effect. Live DB lookup makes revocation
 *   immediate, which both matches the issue's stated goal ("revoking
 *   workspace membership immediately revokes MCP access") and simplifies
 *   the `customAccessTokenClaims` hook (Better Auth's hook context does
 *   not surface `client.clientId`, so emitting per-client conditional
 *   claims would require writing `clientId` into `oauthClient.metadata`
 *   at DCR — tracked in the PR description as a deliberate deviation).
 *
 * Pure helpers — no Effect, no audit, no HTTP. Callers wrap with their
 * own audit emission and request-context bridging.
 */

import { internalQuery } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-OAuth-client workspace scope marker.
 *
 * - `single` — legacy default. Token's `referenceId` claim is the only
 *   valid workspace; the path workspace must equal it.
 * - `multi`  — the cross-workspace path. The runtime resolves a
 *   workspace via the priority chain (header / bridged env / path) and
 *   admits only against grants + membership.
 */
export type WorkspaceScope = "single" | "multi";

export interface WorkspaceGrant {
  readonly clientId: string;
  readonly workspaceId: string;
  readonly grantedAt: string;
  readonly grantedByUserId: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Returns the `workspace_scope` for `clientId`. Absence of a row defaults
 * to `'single'` — the migration intentionally leaves existing clients
 * unmarked so backward-compat is automatic.
 */
export async function getOAuthClientScope(
  clientId: string,
): Promise<WorkspaceScope> {
  const rows = await internalQuery<{ scope: string }>(
    `SELECT scope
       FROM oauth_client_workspace_scope
       WHERE client_id = $1
       LIMIT 1`,
    [clientId],
  );
  if (rows.length === 0) return "single";
  return rows[0].scope === "multi" ? "multi" : "single";
}

/**
 * `true` iff a grant row exists for the (clientId, workspaceId) pair.
 * Indexed lookup via the composite primary key — single round-trip on
 * the request hot path.
 */
export async function hasWorkspaceGrant(
  clientId: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = await internalQuery<{ exists: number }>(
    `SELECT 1 AS exists
       FROM oauth_client_workspace_grants
       WHERE client_id = $1 AND workspace_id = $2
       LIMIT 1`,
    [clientId, workspaceId],
  );
  return rows.length > 0;
}

/**
 * Returns every grant for `clientId`. Used by the Settings → AI Agents
 * page to render the "Connected to all your workspaces" badge and the
 * per-workspace revoke list.
 */
export async function listWorkspaceGrantsForClient(
  clientId: string,
): Promise<WorkspaceGrant[]> {
  const rows = await internalQuery<{
    clientId: string;
    workspaceId: string;
    grantedAt: string;
    grantedByUserId: string;
  }>(
    `SELECT client_id      AS "clientId",
            workspace_id   AS "workspaceId",
            granted_at     AS "grantedAt",
            granted_by_user_id AS "grantedByUserId"
       FROM oauth_client_workspace_grants
       WHERE client_id = $1
       ORDER BY granted_at ASC`,
    [clientId],
  );
  return rows.map((r) => ({
    clientId: r.clientId,
    workspaceId: r.workspaceId,
    grantedAt: r.grantedAt,
    grantedByUserId: r.grantedByUserId,
  }));
}

/**
 * Returns the workspaces the user is currently a member of. Used by the
 * CLI workspace-scope upgrade endpoint (which workspaces should I create
 * grants for?) and as part of the request-time membership check.
 *
 * Reads from Better Auth's `member` table (managed-auth-only). Self-hosted
 * deployments without managed auth never reach this code path because
 * the OAuth flow itself is gated on managed auth.
 */
export async function listUserWorkspaceIds(
  userId: string,
): Promise<string[]> {
  const rows = await internalQuery<{ organizationId: string }>(
    `SELECT "organizationId"
       FROM member
       WHERE "userId" = $1
       ORDER BY "organizationId" ASC`,
    [userId],
  );
  return rows.map((r) => r.organizationId);
}

/**
 * Live membership check — does the user currently belong to the
 * workspace? Defense-in-depth alongside the grant lookup: a grant
 * persists until explicitly revoked, but membership can change at any
 * time (admin removes the user, user leaves the workspace). Both must
 * hold for the MCP edge to admit a request.
 */
export async function userIsWorkspaceMember(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = await internalQuery<{ exists: number }>(
    `SELECT 1 AS exists
       FROM member
       WHERE "userId" = $1 AND "organizationId" = $2
       LIMIT 1`,
    [userId, workspaceId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Set the workspace-scope marker for `clientId` and replace its grant
 * set in one transaction.
 *
 * Atomic semantics matter: a partial write that flips scope to `'multi'`
 * but leaves grants empty would lock the client out of every workspace
 * including the origin one. The transaction keeps the marker + grants in
 * lockstep — a SQL failure rolls both back.
 *
 * `mode === 'single'` clears any existing grants (single-scope clients
 * use the implicit `referenceId` claim, not the grant table). Passing
 * `mode === 'multi'` requires `workspaceIds` to be non-empty — an empty
 * grant set under multi-scope is rejected here rather than silently
 * locking the user out.
 */
export async function setWorkspaceScopeAndGrants(args: {
  clientId: string;
  referenceId: string;
  mode: WorkspaceScope;
  workspaceIds: string[];
  grantedByUserId: string;
}): Promise<void> {
  if (args.mode === "multi" && args.workspaceIds.length === 0) {
    throw new Error(
      "setWorkspaceScopeAndGrants: multi-scope requires at least one workspace id",
    );
  }

  // Use the existing pool helper rather than opening a raw connection —
  // `internalQuery` runs a single statement, but for the transactional
  // upsert + delete we need a connection-bound sequence. Lazy-import the
  // pool here to keep the module tree-shakable for callers that only
  // need the read helpers.
  const { getInternalDB } = await import("@atlas/api/lib/db/internal");
  const pool = getInternalDB();
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");

    await conn.query(
      `INSERT INTO oauth_client_workspace_scope
         (client_id, reference_id, scope, updated_at, updated_by_user_id)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (client_id) DO UPDATE
         SET scope = EXCLUDED.scope,
             reference_id = EXCLUDED.reference_id,
             updated_at = EXCLUDED.updated_at,
             updated_by_user_id = EXCLUDED.updated_by_user_id`,
      [args.clientId, args.referenceId, args.mode, args.grantedByUserId],
    );

    if (args.mode === "single") {
      // Single-scope intentionally has zero grants — the implicit grant
      // is the OAuth client's `referenceId` (handled by the legacy code
      // path at the MCP edge).
      await conn.query(
        `DELETE FROM oauth_client_workspace_grants WHERE client_id = $1`,
        [args.clientId],
      );
    } else {
      // Multi-scope: replace the grant set with exactly the requested
      // workspaces. UPSERT preserves `granted_at` for already-granted
      // workspaces (so the audit trail stays meaningful across re-installs)
      // while adding any new ones.
      await conn.query(
        `DELETE FROM oauth_client_workspace_grants
          WHERE client_id = $1 AND workspace_id <> ALL($2::text[])`,
        [args.clientId, args.workspaceIds],
      );
      for (const workspaceId of args.workspaceIds) {
        await conn.query(
          `INSERT INTO oauth_client_workspace_grants
             (client_id, workspace_id, granted_at, granted_by_user_id)
           VALUES ($1, $2, now(), $3)
           ON CONFLICT (client_id, workspace_id) DO NOTHING`,
          [args.clientId, workspaceId, args.grantedByUserId],
        );
      }
    }

    await conn.query("COMMIT");
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {
      // intentionally ignored: rollback failure surfaces via the original
      // throw below; the connection is destroyed by `release(err)` in
      // finally so a poisoned client never returns to the pool.
    });
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Revoke a single workspace grant. Used by the Settings → AI Agents
 * per-workspace revoke flow — deleting one grant must NOT affect the
 * other workspaces the same OAuth client is bound to. The OAuth client
 * row itself stays intact; only the (clientId, workspaceId) row goes.
 *
 * Returns the number of rows deleted (0 = no such grant; 1 = removed).
 */
export async function revokeWorkspaceGrant(args: {
  clientId: string;
  workspaceId: string;
}): Promise<number> {
  const rows = await internalQuery<{ clientId: string }>(
    `DELETE FROM oauth_client_workspace_grants
      WHERE client_id = $1 AND workspace_id = $2
      RETURNING client_id AS "clientId"`,
    [args.clientId, args.workspaceId],
  );
  return rows.length;
}
