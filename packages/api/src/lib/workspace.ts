/**
 * Workspace status enforcement.
 *
 * Checks the workspace_status of the authenticated user's organization
 * and blocks requests when the workspace is suspended or deleted.
 * Called after authentication in request-processing routes (chat, query).
 *
 * Uses the cached workspace data from the plan enforcement module so
 * that workspace status checks don't trigger a separate DB query.
 *
 * - Suspended workspaces: 403 with clear reactivation message
 * - Deleted workspaces: 404 (workspace no longer exists)
 * - Active or no org: pass through
 * - Pre-migration orgs (no workspace_status column): pass through
 * - DB errors: fail closed (block request with 503)
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, type WorkspaceStatus } from "@atlas/api/lib/db/internal";
import { getCachedWorkspace } from "@atlas/api/lib/billing/enforcement";

const log = createLogger("workspace");

export interface WorkspaceCheckResult {
  allowed: boolean;
  status?: WorkspaceStatus;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: 403 | 404 | 503;
}

/**
 * Check if the workspace is allowed to make requests.
 *
 * Uses the same cached workspace data as plan enforcement to avoid
 * a separate DB query per request.
 *
 * Returns `{ allowed: true }` when:
 * - No internal DB is configured (self-hosted, no org management)
 * - No orgId provided (user not in an org)
 * - Workspace status is "active"
 * - Org has no workspace_status yet (pre-migration)
 *
 * Returns `{ allowed: false, ... }` when suspended, deleted, or on DB error.
 */
export async function checkWorkspaceStatus(orgId: string | undefined): Promise<WorkspaceCheckResult> {
  if (!orgId || !hasInternalDB()) {
    return { allowed: true };
  }

  let status: WorkspaceStatus | null;
  try {
    const workspace = await getCachedWorkspace(orgId);
    status = workspace?.workspace_status ?? null;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Failed to check workspace status — blocking request as a precaution",
    );
    return {
      allowed: false,
      errorCode: "workspace_check_failed",
      errorMessage: "Unable to verify workspace status. Please try again.",
      httpStatus: 503,
    };
  }

  // Org exists but has no workspace_status column yet (pre-migration) — allow
  if (!status) {
    return { allowed: true };
  }

  switch (status) {
    case "active":
      return { allowed: true, status };

    case "suspended":
      log.warn({ orgId }, "Request blocked: workspace is suspended");
      return {
        allowed: false,
        status,
        errorCode: "workspace_suspended",
        errorMessage: "This workspace has been suspended. Please update your payment method or contact support.",
        httpStatus: 403,
      };

    case "deleted":
      log.warn({ orgId }, "Request blocked: workspace is deleted");
      return {
        allowed: false,
        status,
        errorCode: "workspace_deleted",
        errorMessage: "This workspace has been deleted.",
        httpStatus: 404,
      };
  }
}
