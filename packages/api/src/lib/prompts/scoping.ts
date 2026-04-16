/**
 * Mode-aware prompt collection scoping.
 *
 * Builds SQL + params for the user- and admin-facing prompt list / get
 * endpoints so visibility depends on:
 * - atlasMode (published | developer)
 * - whether the org's `__demo__` connection is active
 * - the org's `ATLAS_DEMO_INDUSTRY` setting
 *
 * Visibility rules (see PRD #1421 user stories 3 + 8):
 * - Published + active `__demo__` + industry set: return built-in
 *   collections matching the demo industry *plus* custom published
 *   collections.
 * - Published + demo archived (or no industry): hide all built-ins,
 *   return only custom published collections.
 * - Developer mode: same as published for the built-in/custom split,
 *   but expand the status filter to include draft rows.
 * - No `orgId` (single-tenant): fall back to global built-ins
 *   (`org_id IS NULL`) — there is no org-scoped demo setting to consult.
 *
 * The scope is modeled as a tagged union so illegal combinations
 * (e.g. `demoConnectionActive=true` with `orgId=undefined`) cannot be
 * expressed. `resolvePromptScope` is the single entry point that
 * inspects settings + connections and narrows to the right variant.
 *
 * Built-in demo archival is handled by the publish flow
 * (`admin-publish.ts` phase 4b): when `__demo__` is archived, org-scoped
 * built-ins for the matching industry flip to `archived`. The `status`
 * filter built here excludes those. The explicit `org-with-demo` guard
 * is a belt-and-suspenders second check for global built-ins and for
 * orgs whose archival race left them out of sync with the industry
 * filter.
 *
 * See: #1438, PRD #1421.
 */
import type { AtlasMode } from "@useatlas/types/auth";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";

export const DEMO_INDUSTRY_SETTING = "ATLAS_DEMO_INDUSTRY";

/**
 * Tagged union of the three prompt-scoping scenarios.
 *
 * - `global`: single-tenant / no active org — only `org_id IS NULL`
 *   built-ins are visible. Demo settings are not consulted.
 * - `org-custom-only`: org context is known but demo is archived or has
 *   no industry set — all built-ins hidden, only custom rows returned.
 * - `org-with-demo`: org has an active demo connection + an industry —
 *   built-ins matching the industry are visible alongside custom rows.
 */
export type PromptScope =
  | { readonly kind: "global"; readonly mode: AtlasMode }
  | {
      readonly kind: "org-custom-only";
      readonly orgId: string;
      readonly mode: AtlasMode;
    }
  | {
      readonly kind: "org-with-demo";
      readonly orgId: string;
      readonly mode: AtlasMode;
      readonly demoIndustry: string;
    };

export interface PromptCollectionQuery {
  sql: string;
  params: unknown[];
}

/** Ordering shared across list queries (get queries don't need it). */
const LIST_ORDER_BY = "ORDER BY sort_order ASC, created_at ASC";

function statusClauseFor(mode: AtlasMode): string {
  return mode === "developer"
    ? "status IN ('published', 'draft')"
    : "status = 'published'";
}

/**
 * Inspect the org's settings + connections table to resolve the
 * right `PromptScope` variant for this request. `mode === undefined`
 * defaults to `published` so non-admin requests (which never see
 * drafts) get safe defaults.
 */
export async function resolvePromptScope(opts: {
  orgId: string | undefined;
  mode: AtlasMode | undefined;
}): Promise<PromptScope> {
  const mode: AtlasMode = opts.mode ?? "published";

  if (!opts.orgId || !hasInternalDB()) {
    return { kind: "global", mode };
  }

  const demoIndustry =
    getSettingAuto(DEMO_INDUSTRY_SETTING, opts.orgId) ?? null;
  const rows = await internalQuery<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM connections
       WHERE id = '__demo__' AND org_id = $1 AND status = 'published'
     ) AS active`,
    [opts.orgId],
  );
  const demoConnectionActive = rows[0]?.active === true;

  if (demoConnectionActive && demoIndustry) {
    return {
      kind: "org-with-demo",
      orgId: opts.orgId,
      mode,
      demoIndustry,
    };
  }

  return { kind: "org-custom-only", orgId: opts.orgId, mode };
}

/**
 * Build the SQL + params for the prompt collections list endpoint.
 * Never includes archived rows.
 */
export function buildCollectionsListQuery(
  scope: PromptScope,
): PromptCollectionQuery {
  const statusClause = statusClauseFor(scope.mode);

  switch (scope.kind) {
    case "global":
      return {
        sql: `SELECT * FROM prompt_collections WHERE org_id IS NULL AND ${statusClause} ${LIST_ORDER_BY}`,
        params: [],
      };
    case "org-with-demo":
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
    case "org-custom-only":
      return {
        sql: `SELECT * FROM prompt_collections
              WHERE org_id = $1
                AND is_builtin = false
                AND ${statusClause}
              ${LIST_ORDER_BY}`,
        params: [scope.orgId],
      };
  }
}

/**
 * Build the SQL + params to fetch a single collection by id with the
 * same mode + demo scoping as the list query. Dedicated SQL per
 * variant (not regex-stripped from the list query) so the two queries
 * can evolve independently.
 */
export function buildCollectionGetQuery(
  scope: PromptScope,
  id: string,
): PromptCollectionQuery {
  const statusClause = statusClauseFor(scope.mode);

  switch (scope.kind) {
    case "global":
      return {
        sql: `SELECT * FROM prompt_collections WHERE org_id IS NULL AND ${statusClause} AND id = $1`,
        params: [id],
      };
    case "org-with-demo":
      return {
        sql: `SELECT * FROM prompt_collections
              WHERE ${statusClause}
                AND (
                  (is_builtin = true AND industry = $2 AND (org_id IS NULL OR org_id = $1))
                  OR (is_builtin = false AND org_id = $1)
                )
                AND id = $3`,
        params: [scope.orgId, scope.demoIndustry, id],
      };
    case "org-custom-only":
      return {
        sql: `SELECT * FROM prompt_collections
              WHERE org_id = $1
                AND is_builtin = false
                AND ${statusClause}
                AND id = $2`,
        params: [scope.orgId, id],
      };
  }
}
