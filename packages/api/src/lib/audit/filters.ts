/**
 * Shared filter builder for admin action audit list + export endpoints.
 *
 * Used by both platform-actions.ts (cross-platform) and admin-actions.ts
 * (workspace-scoped) to build WHERE clause conditions from query params.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape ILIKE special characters so they are matched literally. */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionFilterParams {
  actor?: string;
  actionType?: string;
  targetType?: string;
  from?: string;
  to?: string;
  search?: string;
  orgId?: string;
}

export type ActionFilterResult =
  | { ok: true; conditions: string[]; params: unknown[]; paramIdx: number }
  | { ok: false; error: string; message: string; status: 400 };

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build WHERE conditions for admin action list + export endpoints.
 *
 * @param startIdx  The positional-parameter index to start at ($N).
 *                  For example, if the base query already uses $1 for org_id,
 *                  pass 2 so the first filter becomes $2.
 * @param filters   Filter values from query params.
 */
export function buildActionFilters(
  startIdx: number,
  filters: ActionFilterParams,
): ActionFilterResult {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = startIdx;

  if (filters.actor) {
    const term = `%${escapeIlike(filters.actor)}%`;
    conditions.push(`actor_email ILIKE $${paramIdx++}`);
    params.push(term);
  }

  if (filters.actionType) {
    conditions.push(`action_type = $${paramIdx++}`);
    params.push(filters.actionType);
  }

  if (filters.targetType) {
    conditions.push(`target_type = $${paramIdx++}`);
    params.push(filters.targetType);
  }

  if (filters.from) {
    if (isNaN(Date.parse(filters.from))) {
      return {
        ok: false,
        error: "invalid_request",
        message: `Invalid 'from' date format: "${filters.from}". Use ISO 8601 (e.g. 2026-01-01).`,
        status: 400,
      };
    }
    conditions.push(`timestamp >= $${paramIdx++}`);
    params.push(filters.from);
  }

  if (filters.to) {
    if (isNaN(Date.parse(filters.to))) {
      return {
        ok: false,
        error: "invalid_request",
        message: `Invalid 'to' date format: "${filters.to}". Use ISO 8601 (e.g. 2026-03-03).`,
        status: 400,
      };
    }
    conditions.push(`timestamp <= $${paramIdx++}`);
    params.push(filters.to);
  }

  if (filters.search) {
    const term = `%${escapeIlike(filters.search)}%`;
    conditions.push(`metadata::text ILIKE $${paramIdx++}`);
    params.push(term);
  }

  if (filters.orgId) {
    conditions.push(`org_id = $${paramIdx++}`);
    params.push(filters.orgId);
  }

  return { ok: true, conditions, params, paramIdx };
}
