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
 * The status-lifecycle clause (`status = 'published'` vs
 * `status IN ('published', 'draft')`) is delegated to
 * `ContentModeRegistry.readFilter` (#1515 phase 2b). The registry owns
 * the single source of truth for mode-participating tables; this
 * module only assembles the demo-industry and custom-vs-builtin
 * scoping around it.
 *
 * See: #1438, PRD #1421, #1515.
 */
import { Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { DEMO_INDUSTRY_SETTING } from "@atlas/api/lib/demo-industry";
import {
  CONTENT_MODE_TABLES,
  makeService,
} from "@atlas/api/lib/content-mode";

// Re-exported so existing importers (`resolvePromptScope` callers, tests)
// don't need to switch paths.
export { DEMO_INDUSTRY_SETTING };

/**
 * Module-level synchronous registry — the tuple is static and the
 * `readFilter` method is pure, so a single `makeService` instance
 * shared across callers is safe. No Effect layer provision needed.
 */
const contentModeRegistry = makeService(CONTENT_MODE_TABLES);

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
const LIST_ORDER_BY = "ORDER BY pc.sort_order ASC, pc.created_at ASC";

/**
 * Resolve the mode-participating status clause for `prompt_collections`
 * via the content-mode registry. The registry call is pure (no I/O,
 * no async), so `Effect.runSync` is safe — the `prompt_collections`
 * key is a known simple entry that never fails.
 */
function statusClauseFor(mode: AtlasMode): string {
  return Effect.runSync(
    contentModeRegistry.readFilter("prompt_collections", mode, "pc"),
  );
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
        sql: `SELECT pc.* FROM prompt_collections pc WHERE pc.org_id IS NULL AND ${statusClause} ${LIST_ORDER_BY}`,
        params: [],
      };
    case "org-with-demo":
      return {
        sql: `SELECT pc.* FROM prompt_collections pc
              WHERE ${statusClause}
                AND (
                  (pc.is_builtin = true AND pc.industry = $2 AND (pc.org_id IS NULL OR pc.org_id = $1))
                  OR (pc.is_builtin = false AND pc.org_id = $1)
                )
              ${LIST_ORDER_BY}`,
        params: [scope.orgId, scope.demoIndustry],
      };
    case "org-custom-only":
      return {
        sql: `SELECT pc.* FROM prompt_collections pc
              WHERE pc.org_id = $1
                AND pc.is_builtin = false
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
        sql: `SELECT pc.* FROM prompt_collections pc WHERE pc.org_id IS NULL AND ${statusClause} AND pc.id = $1`,
        params: [id],
      };
    case "org-with-demo":
      return {
        sql: `SELECT pc.* FROM prompt_collections pc
              WHERE ${statusClause}
                AND (
                  (pc.is_builtin = true AND pc.industry = $2 AND (pc.org_id IS NULL OR pc.org_id = $1))
                  OR (pc.is_builtin = false AND pc.org_id = $1)
                )
                AND pc.id = $3`,
        params: [scope.orgId, scope.demoIndustry, id],
      };
    case "org-custom-only":
      return {
        sql: `SELECT pc.* FROM prompt_collections pc
              WHERE pc.org_id = $1
                AND pc.is_builtin = false
                AND ${statusClause}
                AND pc.id = $2`,
        params: [scope.orgId, id],
      };
  }
}
