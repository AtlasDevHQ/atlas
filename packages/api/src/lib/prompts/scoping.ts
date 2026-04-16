/**
 * Mode-aware prompt collection scoping (#1438).
 *
 * Builds SQL + params for the user- and admin-facing prompt list / get
 * endpoints so visibility depends on:
 * - atlasMode (published | developer)
 * - whether the org's demo connection is active
 * - the org's demo_industry setting
 *
 * Visibility rules (see PRD #1421 user stories 3 + 8):
 * - Published mode + active `__demo__` + industry set: return built-in
 *   collections matching the demo industry *plus* custom published collections.
 * - Published mode + demo archived (or no industry): hide all built-ins,
 *   return only custom published collections.
 * - Developer mode: same as published for the built-in/custom split, but
 *   expand the status filter to include draft rows.
 * - No `orgId` (single-tenant, no active org): fall back to global built-ins
 *   (`org_id IS NULL`) — there is no org-scoped demo setting to consult.
 *
 * Built-in demo archival is already handled by the publish flow
 * (`admin-publish.ts`): when `__demo__` is archived, org-scoped built-ins
 * for the matching industry flip to `archived`. This helper's filter on
 * `status` already excludes those. The explicit `demoConnectionActive`
 * check is a belt-and-suspenders guard for global built-ins and for orgs
 * whose archival race left them out of sync with the industry filter.
 */
import type { AtlasMode } from "@useatlas/types/auth";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";

export const DEMO_INDUSTRY_SETTING = "ATLAS_DEMO_INDUSTRY";

/**
 * Inputs required to scope a prompt-collections query. Callers fetch
 * `demoIndustry` + `demoConnectionActive` via `resolvePromptDemoContext`
 * (or pass explicit values in tests).
 */
export interface PromptScope {
  /** Active org. `undefined` = single-tenant / no active org selected. */
  orgId: string | undefined;
  /** Resolved atlas mode from RequestContext. `undefined` → published. */
  mode: AtlasMode | undefined;
  /** Demo industry from the `ATLAS_DEMO_INDUSTRY` workspace setting. */
  demoIndustry: string | null;
  /** Whether the `__demo__` connection exists for this org and is published. */
  demoConnectionActive: boolean;
}

export interface PromptCollectionQuery {
  sql: string;
  params: unknown[];
}

/** Ordering shared across both list shapes. */
const LIST_ORDER_BY = "ORDER BY sort_order ASC, created_at ASC";

function statusClauseFor(mode: AtlasMode | undefined): string {
  return mode === "developer"
    ? "status IN ('published', 'draft')"
    : "status = 'published'";
}

/**
 * Build the SQL + params for the prompt collections list endpoint.
 * Never includes archived rows.
 */
export function buildCollectionsListQuery(
  scope: PromptScope,
): PromptCollectionQuery {
  const statusClause = statusClauseFor(scope.mode);

  if (!scope.orgId) {
    return {
      sql: `SELECT * FROM prompt_collections WHERE org_id IS NULL AND ${statusClause} ${LIST_ORDER_BY}`,
      params: [],
    };
  }

  if (scope.demoConnectionActive && scope.demoIndustry) {
    return {
      sql: `SELECT * FROM prompt_collections
            WHERE ${statusClause}
              AND (
                (is_builtin = true AND industry = $2 AND (org_id IS NULL OR org_id = $1))
                OR (is_builtin = false AND org_id = $1)
              )
            ${LIST_ORDER_BY}`,
      params: [scope.orgId, scope.demoIndustry],
    };
  }

  return {
    sql: `SELECT * FROM prompt_collections
          WHERE org_id = $1
            AND is_builtin = false
            AND ${statusClause}
          ${LIST_ORDER_BY}`,
    params: [scope.orgId],
  };
}

/**
 * Build the SQL + params to fetch a single collection by id with the same
 * mode/demo scoping. Reuses the list query's WHERE clause and appends
 * `AND id = $N`.
 */
export function buildCollectionGetQuery(
  scope: PromptScope,
  id: string,
): PromptCollectionQuery {
  const list = buildCollectionsListQuery(scope);
  // Strip the shared ORDER BY — get-by-id returns at most one row.
  const whereOnly = list.sql.replace(/\s*ORDER BY[\s\S]*$/i, "");
  const idIdx = list.params.length + 1;
  return {
    sql: `${whereOnly} AND id = $${idIdx}`,
    params: [...list.params, id],
  };
}

/**
 * Resolve `demoIndustry` + `demoConnectionActive` for an org from the
 * settings cache + connections table. Returns safe defaults when no orgId
 * or when the internal DB is unavailable.
 */
export async function resolvePromptDemoContext(
  orgId: string | undefined,
): Promise<{ demoIndustry: string | null; demoConnectionActive: boolean }> {
  if (!orgId || !hasInternalDB()) {
    return { demoIndustry: null, demoConnectionActive: false };
  }

  const demoIndustry = getSettingAuto(DEMO_INDUSTRY_SETTING, orgId) ?? null;
  const rows = await internalQuery<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM connections
       WHERE id = '__demo__' AND org_id = $1 AND status = 'published'
     ) AS active`,
    [orgId],
  );
  return {
    demoIndustry,
    demoConnectionActive: rows[0]?.active === true,
  };
}
