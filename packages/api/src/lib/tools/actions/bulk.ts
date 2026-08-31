/**
 * Bulk approve / deny for the action approval queue.
 *
 * Org scope: rows belonging to a different org surface as `notFound`, never
 * `forbidden` — cross-org identifiers must not leak existence or type.
 *
 * Each id resolves through `approveActionAsUser` / `denyActionAsUser`, the
 * same authorized verbs the single-action endpoints use, so the two surfaces
 * cannot diverge on authorization. This module used to carry its own
 * `preClassify` copy of that preamble — and it HAD diverged: the bulk lookup
 * fetched actions unscoped and re-applied the org filter by hand, the exact
 * omission the handler's `@security` note on `orgScopeClause` warns about.
 * Folding authorization into the verb also closed the TOCTOU window between
 * classification and the CAS that the old two-step needed a defense-in-depth
 * note for: there is no separate classification step left to race.
 */

import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { createLogger } from "@atlas/api/lib/logger";
import {
  approveActionAsUser,
  denyActionAsUser,
  type ApproveActionOutcome,
  type DenyActionOutcome,
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
 * requested id exactly once. Invariant holds by construction: ids are deduped
 * up front and every resolution outcome kind maps to exactly one bucket.
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

/** Dedup while preserving first-seen order, so the partition invariant holds
 * even when callers pass duplicate ids. */
function dedupe(ids: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}

/** Route one resolution outcome into its result bucket. */
function bucketOutcome(
  id: string,
  outcome: ApproveActionOutcome | DenyActionOutcome,
  result: BulkActionsResult,
  input: { orgId: string | null; userId: string | undefined; requestId?: string },
): void {
  switch (outcome.kind) {
    case "not_found":
      result.notFound.push(id);
      return;
    case "forbidden":
      result.forbidden.push(id);
      return;
    case "conflict":
      log.warn(
        { actionId: id, orgId: input.orgId, userId: input.userId, requestId: input.requestId },
        "Bulk resolution lost CAS race — action already resolved",
      );
      result.errors.push({ id, error: "Action has already been resolved." });
      return;
    case "approved":
    case "approved_not_executed":
    case "denied":
      // `approved_not_executed` still counts as updated on the wire (the row
      // IS approved; the entry's status says nothing ran) — the verb logs it
      // at error level, and the distinct kind exists so this mapping is a
      // visible decision rather than a conflation.
      result.updated.push(id);
      return;
  }
}

export async function bulkApproveActions(
  input: BulkApproveInput,
): Promise<BulkActionsResult> {
  const { ids, user, orgId, requestId } = input;
  const result: BulkActionsResult = { updated: [], notFound: [], forbidden: [], errors: [] };

  for (const id of dedupe(ids)) {
    try {
      const outcome = await approveActionAsUser(id, { user, orgId });
      bucketOutcome(id, outcome, result, { orgId, userId: user?.id, requestId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err: message, actionId: id, orgId, userId: user?.id, requestId },
        "Bulk approve threw for action",
      );
      result.errors.push({ id, error: GENERIC_RESOLVE_ERROR });
    }
  }

  return result;
}

export async function bulkDenyActions(
  input: BulkDenyInput,
): Promise<BulkActionsResult> {
  const { ids, user, orgId, reason, requestId } = input;
  const result: BulkActionsResult = { updated: [], notFound: [], forbidden: [], errors: [] };

  for (const id of dedupe(ids)) {
    try {
      const outcome = await denyActionAsUser(id, { user, orgId }, reason);
      bucketOutcome(id, outcome, result, { orgId, userId: user?.id, requestId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err: message, actionId: id, orgId, userId: user?.id, requestId },
        "Bulk deny threw for action",
      );
      result.errors.push({ id, error: GENERIC_RESOLVE_ERROR });
    }
  }

  return result;
}
