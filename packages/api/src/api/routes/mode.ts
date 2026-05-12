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

// "Demo is active for this org" if either:
//   1. The org owns a published `__demo__` row (legacy pre-#2304 onboarding), OR
//   2. The canonical `__global__/__demo__` exists AND the org hasn't
//      tombstoned it (no per-org row of any status — matches the
//      shadow-check semantics in `getVisibleConnectionIds`).
const DEMO_ACTIVE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM connections
    WHERE id = '__demo__' AND status = 'published'
      AND (
        org_id = $1
        OR (
          org_id = '__global__'
          AND NOT EXISTS (
            SELECT 1 FROM connections c2 WHERE c2.org_id = $1 AND c2.id = '__demo__'
          )
        )
      )
  ) AS active
`;

function totalDrafts(counts: ModeDraftCounts): number {
  return (
    counts.connections +
    counts.entities +
    counts.entityEdits +
    counts.entityDeletes +
    counts.prompts +
    counts.starterPrompts
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
  SELECT 'connections' AS key, MAX(updated_at) AS at FROM connections
   WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'entities' AS key, MAX(updated_at) AS at FROM semantic_entities
   WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'entityEdits' AS key, MAX(d.updated_at) AS at FROM semantic_entities d
    INNER JOIN semantic_entities pub
      ON d.org_id = pub.org_id
     AND d.name = pub.name
     AND COALESCE(d.connection_id, '__default__') = COALESCE(pub.connection_id, '__default__')
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
`;

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
] as const satisfies ReadonlyArray<keyof ModeDraftActivity>;

function buildDraftActivity(
  rows: ReadonlyArray<{ key: string; at: unknown }>,
): ModeDraftActivity {
  const result: Record<string, { lastEditedAt: string | null }> = {};
  for (const k of ACTIVITY_SURFACE_KEYS) result[k] = { lastEditedAt: null };
  const allowed = new Set<string>(ACTIVITY_SURFACE_KEYS);
  for (const row of rows) {
    if (!allowed.has(row.key)) continue;
    result[row.key] = { lastEditedAt: toIsoOrNull(row.at) };
  }
  return result as unknown as ModeDraftActivity;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const mode = new OpenAPIHono<AuthEnv>();

mode.use("/", standardAuth);
mode.use("/", requestContext);

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
