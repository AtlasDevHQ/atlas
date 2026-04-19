/**
 * Bulk approve / deny for the action approval queue.
 *
 * Org scope: rows belonging to a different org surface as `notFound`, never
 * `forbidden` — cross-org identifiers must not leak existence or type.
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

export const BULK_ACTIONS_MAX = 100;

/**
 * Client-facing message returned when an unexpected error is caught. Raw
 * `err.message` values from `pg` / downstream services can contain schema
 * names or parameter values, so callers get this generic string and the
 * real message goes only to the log.
 */
const GENERIC_RESOLVE_ERROR = "Failed to resolve action.";

export interface BulkActionError {
  readonly id: string;
  readonly error: string;
}

/**
 * `updated` + `notFound` + `forbidden` + `errors.map(e => e.id)` partition every
 * requested id exactly once. Invariant holds by construction because
 * `preClassify` dedups inputs and each id takes exactly one branch.
 */
export interface BulkActionsResult {
  updated: string[];
  notFound: string[];
  forbidden: string[];
  errors: BulkActionError[];
}

export interface BulkApproveInput {
  readonly ids: readonly string[];
  readonly user: AtlasUser | undefined;
  readonly orgId: string | null;
  /** Forwarded to logs so per-row failures correlate with the originating HTTP request. */
  readonly requestId?: string;
}

export interface BulkDenyInput {
  readonly ids: readonly string[];
  readonly user: AtlasUser | undefined;
  readonly orgId: string | null;
  readonly reason?: string;
  readonly requestId?: string;
}

type PreClassification = {
  eligible: string[];
  notFound: string[];
  forbidden: string[];
  /** Errors captured during pre-classification (getAction throws). */
  errors: BulkActionError[];
};

/**
 * Resolve each id into one of eligible / notFound / forbidden / errors.
 * Eligible = exists in the caller's org, caller has the right role, and
 * (for admin-only actions) caller is not the requester.
 *
 * Dedup is applied up front so the partition invariant holds by construction
 * even when callers pass duplicate ids.
 */
async function preClassify(
  ids: readonly string[],
  user: AtlasUser | undefined,
  orgId: string | null,
  requestId: string | undefined,
): Promise<PreClassification> {
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  const eligible: string[] = [];
  const notFound: string[] = [];
  const forbidden: string[] = [];
  const errors: BulkActionError[] = [];

  for (const id of uniqueIds) {
    let action;
    try {
      action = await getAction(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err: message, actionId: id, orgId, userId: user?.id, requestId },
        "Bulk preClassify failed to read action",
      );
      errors.push({ id, error: GENERIC_RESOLVE_ERROR });
      continue;
    }
    if (!action) {
      notFound.push(id);
      continue;
    }
    // `org_id` is present on the action_log row (schema.ts) but not yet
    // surfaced on `ActionLogEntry`; read defensively via record access.
    // Missing / null org_id disables the filter — matches the single-action
    // endpoints' behavior for rows written before org-scoping existed.
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

  return { eligible, notFound, forbidden, errors };
}

export async function bulkApproveActions(
  input: BulkApproveInput,
): Promise<BulkActionsResult> {
  const { ids, user, orgId, requestId } = input;
  const approverId = user?.id ?? "anonymous";

  const { eligible, notFound, forbidden, errors: preErrors } = await preClassify(
    ids,
    user,
    orgId,
    requestId,
  );

  const updated: string[] = [];
  const errors: BulkActionError[] = [...preErrors];

  for (const id of eligible) {
    try {
      const executor = getActionExecutor(id);
      const result = await approveAction(id, approverId, executor);
      if (result === null) {
        log.warn(
          { actionId: id, orgId, userId: user?.id, requestId },
          "Bulk approve lost CAS race — action already resolved",
        );
        errors.push({ id, error: "Action has already been resolved." });
      } else {
        updated.push(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err: message, actionId: id, orgId, userId: user?.id, requestId },
        "Bulk approve threw for action",
      );
      errors.push({ id, error: GENERIC_RESOLVE_ERROR });
    }
  }

  return { updated, notFound, forbidden, errors };
}

export async function bulkDenyActions(
  input: BulkDenyInput,
): Promise<BulkActionsResult> {
  const { ids, user, orgId, reason, requestId } = input;
  const denierId = user?.id ?? "anonymous";

  const { eligible, notFound, forbidden, errors: preErrors } = await preClassify(
    ids,
    user,
    orgId,
    requestId,
  );

  const updated: string[] = [];
  const errors: BulkActionError[] = [...preErrors];

  for (const id of eligible) {
    try {
      const result = await denyAction(id, denierId, reason);
      if (result === null) {
        log.warn(
          { actionId: id, orgId, userId: user?.id, requestId },
          "Bulk deny lost CAS race — action already resolved",
        );
        errors.push({ id, error: "Action has already been resolved." });
      } else {
        updated.push(id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err: message, actionId: id, orgId, userId: user?.id, requestId },
        "Bulk deny threw for action",
      );
      errors.push({ id, error: GENERIC_RESOLVE_ERROR });
    }
  }

  return { updated, notFound, forbidden, errors };
}
