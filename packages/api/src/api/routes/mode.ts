/**
 * GET /api/v1/mode — effective developer/published mode for the current user/org (#1439).
 *
 * Returns the resolved mode, role-based toggle permission, demo workspace state,
 * and per-table draft counts. The frontend uses this to render the mode banner,
 * draft badges, the publish button, and the pending-changes summary.
 *
 * Mode resolution happens upstream in the auth middleware (#1424). This route
 * just reads the resolved mode from RequestContext and adds the role + draft
 * metadata the UI needs to decide what to show.
 *
 * Draft counts are delegated to `ContentModeRegistry.countAllDrafts` (#1515).
 * The UNION ALL query is derived from the static `CONTENT_MODE_TABLES` tuple;
 * adding a new mode-participating table automatically extends this response.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect, Layer } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import type {
  ModeStatusResponse,
  ModeDraftCounts,
  ModeDraftActivity,
} from "@useatlas/types/mode";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import {
  hasInternalDB,
  makeInternalDBShimLayer,
  queryEffect,
} from "@atlas/api/lib/db/internal";
import { matchScopeAcrossAliases } from "@atlas/api/lib/db/with-group-scope";
import { demoInstallActiveSql } from "@atlas/api/lib/integrations/installed-connection";
import {
  ContentModeRegistry,
  ContentModeRegistryLive,
} from "@atlas/api/lib/content-mode";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

/**
 * Admin-level roles permitted to toggle into developer mode.
 *
 * Duplicated literal (not imported from `@useatlas/types/auth`) so this route
 * builds against older published versions of `@useatlas/types` that don't yet
 * export `ADMIN_ROLES`. Remove once the types package with `ADMIN_ROLES` ships.
 */
const ADMIN_ROLE_SET: ReadonlySet<string> = new Set(["admin", "owner", "platform_admin"]);

/** Setting key holding the demo industry chosen during onboarding. */
const DEMO_INDUSTRY_SETTING = "ATLAS_DEMO_INDUSTRY";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DraftCountsSchema = z.object({
  connections: z.number().int().nonnegative(),
  entities: z.number().int().nonnegative(),
  entityEdits: z.number().int().nonnegative(),
  entityDeletes: z.number().int().nonnegative(),
  prompts: z.number().int().nonnegative(),
  starterPrompts: z.number().int().nonnegative(),
  knowledgeDocuments: z.number().int().nonnegative(),
  brainFacts: z.number().int().nonnegative(),
});

const DraftSurfaceActivitySchema = z.object({
  lastEditedAt: z.string().datetime().nullable(),
});

const DraftActivitySchema = z.object({
  connections: DraftSurfaceActivitySchema,
  entities: DraftSurfaceActivitySchema,
  entityEdits: DraftSurfaceActivitySchema,
  entityDeletes: DraftSurfaceActivitySchema,
  prompts: DraftSurfaceActivitySchema,
  starterPrompts: DraftSurfaceActivitySchema,
  knowledgeDocuments: DraftSurfaceActivitySchema,
  brainFacts: DraftSurfaceActivitySchema,
});

const ModeStatusSchema = z.object({
  mode: z.enum(["developer", "published"]),
  canToggle: z.boolean(),
  demoIndustry: z.string().nullable(),
  demoConnectionActive: z.boolean(),
  hasDrafts: z.boolean(),
  draftCounts: DraftCountsSchema.nullable(),
  draftActivity: DraftActivitySchema.nullable(),
});

const getModeRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Mode"],
  summary: "Get effective developer/published mode state",
  description:
    "Returns the resolved mode for the current request, whether the user can toggle it, " +
    "demo workspace state, and per-table draft counts. The frontend uses this to render " +
    "banners, badges, the publish button, and the pending-changes summary. " +
    "Non-admin users always receive `mode: 'published'` and `canToggle: false` regardless " +
    "of the `atlas-mode` cookie or `X-Atlas-Mode` header.",
  responses: {
    200: {
      description: "Effective mode state",
      content: { "application/json": { schema: ModeStatusSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// "Demo is active for this org" post-0096 cutover: every workspace
// owns its own per-workspace `demo-postgres` install row, archived
// per-workspace to hide. So "active" is simply "the demo row is
// published for this workspace". The probe SQL is stated once in the
// installed-connection lib seam (#4194); this route runs it through
// `queryEffect` so failures land in the Effect error channel.
const DEMO_ACTIVE_SQL = demoInstallActiveSql(["published"]);

/**
 * Total drafts across every segment `countAllDrafts` returned.
 *
 * Sums `Object.values` rather than a hand-listed field chain. `counts` is
 * derived from the registry tuple via `InferDraftCounts`, so a newly-registered
 * surface widens it automatically — and a hand-listed sum would silently omit
 * the new segment, leaving `hasDrafts: false` (no banner, no publish button)
 * for a workspace whose ONLY drafts are on the new surface. Every value is a
 * number by construction; the guard is for a driver returning a numeric as a
 * string, which would otherwise concatenate.
 */
function totalDrafts(counts: ModeDraftCounts): number {
  return Object.values(counts).reduce<number>(
    (sum, v) => sum + (typeof v === "number" && Number.isFinite(v) ? v : 0),
    0,
  );
}

/**
 * Per-surface `MAX(updated_at)` for draft rows. One UNION ALL query so
 * the pending-changes pill can render a relative "Last edited 5m ago"
 * per surface without a fan-out (#2177).
 *
 * Mirrors the surface keys used by {@link ModeDraftCounts}; segment
 * semantics for `entities` / `entityEdits` / `entityDeletes` match the
 * exotic `semantic_entities` adapter's `countSegments`. Wrapped in a
 * single round-trip so it cost-matches the existing `countAllDrafts`.
 */
const DRAFT_ACTIVITY_SQL = `
  SELECT 'connections' AS key, MAX(updated_at) AS at FROM workspace_plugins
   WHERE workspace_id = $1 AND pillar = 'datasource' AND status = 'draft'
  UNION ALL
  SELECT 'entities' AS key, MAX(updated_at) AS at FROM semantic_entities
   WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'entityEdits' AS key, MAX(d.updated_at) AS at FROM semantic_entities d
    INNER JOIN semantic_entities pub
      ON d.org_id = pub.org_id
     AND d.entity_type = pub.entity_type
     AND d.name = pub.name
     AND ${matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "pub", column: "connection_group_id" })}
   WHERE d.org_id = $1 AND d.status = 'draft' AND pub.status = 'published'
  UNION ALL
  SELECT 'entityDeletes' AS key, MAX(updated_at) AS at FROM semantic_entities
   WHERE org_id = $1 AND status = 'draft_delete'
  UNION ALL
  SELECT 'prompts' AS key, MAX(updated_at) AS at FROM prompt_collections
   WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'starterPrompts' AS key, MAX(updated_at) AS at FROM query_suggestions
   WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'knowledgeDocuments' AS key, MAX(updated_at) AS at FROM knowledge_documents
   WHERE workspace_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'brainFacts' AS key, MAX(updated_at) AS at FROM brain_facts
   WHERE workspace_id = $1 AND status = 'draft' AND invalidated_at IS NULL
`;

// `invalidated_at IS NULL` above is NOT optional polish: `brainFactsCountSql`,
// the publish preview, and the promote UPDATE all exclude retracted facts
// (#4769), so omitting it here would make a workspace whose only remaining
// drafts are retracted report `brainFacts: 0` with a real `lastEditedAt` —
// the two halves of one display surface (`content-surfaces.ts` folds them into
// a single descriptor) disagreeing about whether anything is pending.

/**
 * Coerce a pg `timestamptz` value to an ISO-8601 string. `pg` returns
 * timestamps as `Date` by default; some drivers return them as strings.
 * Returns null for invalid or missing values so the pill popover degrades
 * gracefully to "Pending" without a relative time.
 */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

const ACTIVITY_SURFACE_KEYS = [
  "connections",
  "entities",
  "entityEdits",
  "entityDeletes",
  "prompts",
  "starterPrompts",
  "knowledgeDocuments",
  "brainFacts",
] as const satisfies ReadonlyArray<keyof ModeDraftActivity>;

// `satisfies` alone catches a TYPO but permits an OMISSION — a subset still
// satisfies `ReadonlyArray<keyof …>`. Hono does not validate responses, so a
// forgotten key would ship a missing required field with every test green.
// This gate makes the omission a compile error, mirroring `_AllCountKeysClaimed`
// in `web/src/ui/lib/content-surfaces.ts`.
//
// What it does NOT prove: that `DRAFT_ACTIVITY_SQL` emits a UNION arm per key.
// Add a key here and to the type but forget the SQL and you ship a well-formed
// response whose `lastEditedAt` is permanently null — quieter than a missing
// field, not louder. That half is covered by the per-segment route tests in
// `__tests__/mode.test.ts`, which assert the arm's table and scope column.
type _AllActivityKeysCovered = [keyof ModeDraftActivity] extends [
  (typeof ACTIVITY_SURFACE_KEYS)[number],
]
  ? true
  : never;
const _allActivityKeysCovered: _AllActivityKeysCovered = true;
void _allActivityKeysCovered;

function buildDraftActivity(
  rows: ReadonlyArray<{ key: string; at: unknown }>,
): ModeDraftActivity {
  // Keyed by the surface union rather than `string`, so the single cast on the
  // return is a widening of a fully-populated record — not the `as unknown as`
  // double cast this replaced, which erased whatever `_AllActivityKeysCovered`
  // above had just proved.
  type ActivityKey = (typeof ACTIVITY_SURFACE_KEYS)[number];
  const result = {} as Record<ActivityKey, { lastEditedAt: string | null }>;
  for (const k of ACTIVITY_SURFACE_KEYS) result[k] = { lastEditedAt: null };
  const allowed = new Set<string>(ACTIVITY_SURFACE_KEYS);
  for (const row of rows) {
    if (!allowed.has(row.key)) continue;
    result[row.key as ActivityKey] = { lastEditedAt: toIsoOrNull(row.at) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const mode = new OpenAPIHono<AuthEnv>();

mode.use("/", standardAuth);
mode.use("/", requestContext);

// #3764 — accepted: this layer is provided at the route boundary (per call,
// below) rather than via the app ManagedRuntime. The route is its own small
// composition root; the merged Live layers are dependency-free/finalizer-free.
const modeRouteLayer = Layer.merge(ContentModeRegistryLive, makeInternalDBShimLayer());

mode.openapi(getModeRoute, async (c) => {
  const program = Effect.gen(function* () {
    const { atlasMode } = yield* RequestContext;
    const { mode: authMode, user, orgId } = yield* AuthContext;

    // Local-dev "none" auth is an implicit admin; otherwise gate by role.
    const canToggle =
      authMode === "none" ||
      (typeof user?.role === "string" && ADMIN_ROLE_SET.has(user.role));

    // Without an org or internal DB we have nothing org-scoped to read.
    if (!orgId || !hasInternalDB()) {
      return {
        mode: atlasMode satisfies AtlasMode,
        canToggle,
        demoIndustry: null,
        demoConnectionActive: false,
        hasDrafts: false,
        draftCounts: null,
        draftActivity: null,
      } satisfies ModeStatusResponse;
    }

    const demoIndustry = getSettingAuto(DEMO_INDUSTRY_SETTING, orgId) ?? null;
    const registry = yield* ContentModeRegistry;

    const [demoRows, counts, activityRows] = yield* Effect.all(
      [
        queryEffect<{ active: boolean }>(DEMO_ACTIVE_SQL, [orgId]),
        registry.countAllDrafts(orgId),
        queryEffect<{ key: string; at: unknown }>(DRAFT_ACTIVITY_SQL, [orgId]),
      ],
      { concurrency: "unbounded" },
    );

    const demoConnectionActive = demoRows[0]?.active === true;
    const hasDrafts = totalDrafts(counts) > 0;
    const activity = hasDrafts ? buildDraftActivity(activityRows) : null;

    return {
      mode: atlasMode satisfies AtlasMode,
      canToggle,
      demoIndustry,
      demoConnectionActive,
      hasDrafts,
      draftCounts: hasDrafts ? counts : null,
      draftActivity: activity,
    } satisfies ModeStatusResponse;
  }).pipe(Effect.provide(modeRouteLayer));

  const body = await runEffect(c, program, { label: "fetch mode status" });
  return c.json(body, 200);
});

export { mode };
