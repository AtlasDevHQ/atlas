/**
 * Bulk approve / deny for the action approval queue.
 *
 * Pre-classifies each requested id into one of four buckets — updated,
 * notFound, forbidden, or errors — before delegating the actual state
 * transition to the existing single-action approveAction / denyAction
 * helpers. Each inner call already performs CAS (WHERE status = 'pending'
 * RETURNING *) for row-level atomicity; aggregated response shape is what
 * replaces the web client's Promise.allSettled pattern.
 *
 * Per-action permission is enforced via canApprove() with the same role
 * rules as the single-action routes, plus admin-only separation-of-duties
 * (requester cannot resolve their own admin-only action).
 *
 * Org-scoped: ids belonging to a different org are returned as notFound so
 * cross-org identifiers never surface as forbidden or leak action metadata.
 */

import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { canApprove } from "@atlas/api/lib/auth/permissions";
import { createLogger } from "@atlas/api/lib/logger";
import {
  approveAction,
  denyAction,
  getAction,
  getActionConfig,
  getActionExecutor,
} from "./handler";

const log = createLogger("action-bulk");

// ── Limits ──────────────────────────────────────────────────────────

/** Hard cap matches learned-patterns bulk ceiling (#1590). */
export const BULK_ACTIONS_MAX = 100;

// ── Result shape ────────────────────────────────────────────────────

export interface BulkActionError {
  readonly id: string;
  readonly error: string;
}

/**
 * Aligned with the web client's `bulkPartialSummary` contract (learned-patterns
 * reuse) plus a `forbidden` bucket specific to the action queue's per-row
 * permission model. `updated` + `notFound` + `forbidden` + `errors` covers every
 * requested id exactly once.
 */
export interface BulkActionsResult {
  readonly updated: string[];
  readonly notFound: string[];
  readonly forbidden: string[];
  readonly errors: BulkActionError[];
}

// ── Input shape ─────────────────────────────────────────────────────

export interface BulkApproveInput {
  readonly ids: readonly string[];
  readonly user: AtlasUser | undefined;
  readonly orgId?: string | null;
}

export interface BulkDenyInput extends BulkApproveInput {
  readonly reason?: string;
}

// ── Classification ──────────────────────────────────────────────────

type PreClassification = {
  eligible: string[];
  notFound: string[];
  forbidden: string[];
};

/**
 * Resolve each id to { eligible, notFound, forbidden } before the write loop.
 * Eligible = exists, caller has the right role, and (for admin-only actions)
 * caller is not the requester.
 */
async function preClassify(
  ids: readonly string[],
  user: AtlasUser | undefined,
  orgId: string | null | undefined,
): Promise<PreClassification> {
  const eligible: string[] = [];
  const notFound: string[] = [];
  const forbidden: string[] = [];

  for (const id of ids) {
    const action = await getAction(id);
    if (!action) {
      notFound.push(id);
      continue;
    }
    // Org scope: a row belonging to a different org must look like "not found"
    // rather than "forbidden" so cross-org ids never leak existence or type.
    // `org_id` is present on the action_log row (schema.ts) but not yet
    // surfaced in ActionLogEntry; read defensively via record access.
    const rowOrgId = (action as unknown as Record<string, unknown>).org_id;
    if (orgId && typeof rowOrgId === "string" && rowOrgId !== orgId) {
      notFound.push(id);
      continue;
    }

    const cfg = getActionConfig(action.action_type);
    if (!canApprove(user, cfg.approval, cfg.requiredRole)) {
      forbidden.push(id);
      continue;
    }
    if (cfg.approval === "admin-only" && user?.id === action.requested_by) {
      forbidden.push(id);
      continue;
    }
    eligible.push(id);
  }

  return { eligible, notFound, forbidden };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Approve many pending actions. For each eligible id, delegates to
 * approveAction() which performs the CAS write and runs the registered
 * executor. Ids that race a conflicting resolve land in `errors` with
 * "Action has already been resolved."
 */
export async function bulkApproveActions(
  input: BulkApproveInput,
): Promise<BulkActionsResult> {
  const { ids, user, orgId } = input;
  const approverId = user?.id ?? "anonymous";

  const { eligible, notFound, forbidden } = await preClassify(ids, user, orgId);

  const updated: string[] = [];
  const errors: BulkActionError[] = [];

  for (const id of eligible) {
    try {
      const executor = getActionExecutor(id);
      const result = await approveAction(id, approverId, executor);
      if (result === null) {
        errors.push({ id, error: "Action has already been resolved." });
      } else {
        updated.push(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, actionId: id }, "Bulk approve failed for action");
      errors.push({ id, error: message });
    }
  }

  return { updated, notFound, forbidden, errors };
}

/**
 * Deny many pending actions. Reason (if supplied) is recorded on every
 * denied row — callers must enforce reason-presence policy at the route
 * layer if required.
 */
export async function bulkDenyActions(
  input: BulkDenyInput,
): Promise<BulkActionsResult> {
  const { ids, user, orgId, reason } = input;
  const denierId = user?.id ?? "anonymous";

  const { eligible, notFound, forbidden } = await preClassify(ids, user, orgId);

  const updated: string[] = [];
  const errors: BulkActionError[] = [];

  for (const id of eligible) {
    try {
      const result = await denyAction(id, denierId, reason);
      if (result === null) {
        errors.push({ id, error: "Action has already been resolved." });
      } else {
        updated.push(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, actionId: id }, "Bulk deny failed for action");
      errors.push({ id, error: message });
    }
  }

  return { updated, notFound, forbidden, errors };
}
