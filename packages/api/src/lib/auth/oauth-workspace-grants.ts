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

import {
  internalQuery,
  getInternalDB,
  hasInternalDB,
} from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("oauth-workspace-grants");

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
  // No internal DB → no `oauth_client_workspace_scope` table to query.
  // Treat as legacy single-scope. This is the right default for:
  //   - self-hosted setups without `DATABASE_URL` configured
  //   - the canonical-mcp-eval (#2125) which intentionally runs without
  //     an internal DB to keep the eval pool-free
  //   - bootstrap before migrations have applied
  // Any caller that needs the multi-scope path must have an internal DB
  // — that's the precondition for the migration to have run at all.
  if (!hasInternalDB()) return "single";
  const rows = await internalQuery<{ scope: string }>(
    `SELECT scope
       FROM oauth_client_workspace_scope
       WHERE client_id = $1
       LIMIT 1`,
    [clientId],
  );
  if (rows.length === 0) return "single";
  const raw = rows[0].scope;
  if (raw === "multi") return "multi";
  if (raw !== "single") {
    // The DB CHECK constraint at migration 0053 forbids this; if we see
    // an unknown value, schema drift or a direct SQL write bypassed the
    // constraint. Surfacing at warn rather than throw so the request
    // path stays available — but make the drift visible to operators
    // rather than silently treating an unknown scope as legacy.
    log.warn(
      { clientId, rawScope: raw },
      "oauth_client_workspace_scope row carries unknown scope value — coercing to 'single'",
    );
  }
  return "single";
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
  // No internal DB → no grants table; only the legacy single-scope path
  // is reachable in this configuration, and `getOAuthClientScope` short-
  // circuits there before this function gets called. Returning `false`
  // is a defensive safety net for any callsite that bypasses the scope
  // check.
  if (!hasInternalDB()) return false;
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
  // No internal DB → no `member` table; the user has no workspaces this
  // surface knows about. Empty array short-circuits the
  // `customAccessTokenClaims` plural-claim path (length > 1 guard) and
  // the per-user CLI prompt (length > 1 guard).
  if (!hasInternalDB()) return [];
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
  // No internal DB → no `member` table. Same defensive default as
  // `hasWorkspaceGrant`: only the legacy single-scope path is
  // reachable, which doesn't call this function.
  if (!hasInternalDB()) return false;
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

  const pool = getInternalDB();
  const conn = await pool.connect();
  let rollbackErr: Error | null = null;
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
    // Mirrors `revokeOAuthClient`'s rollback handling. ROLLBACK can itself
    // fail (TCP reset between BEGIN and ROLLBACK); capture that error so
    // the `finally` block can pass it to `release(err)` — pg destroys the
    // socket when `release` receives a truthy arg, ensuring a poisoned
    // client (mid-transaction) never returns to the pool to corrupt the
    // next borrower. The original throw below carries the user-visible
    // failure; the rollback warn captures the recovery-path drift.
    await conn.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        {
          err: rollbackErr.message,
          clientId: args.clientId,
          mode: args.mode,
        },
        "ROLLBACK failed after setWorkspaceScopeAndGrants error — client will be destroyed",
      );
    });
    throw err;
  } finally {
    conn.release(rollbackErr ?? undefined);
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
