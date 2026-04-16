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
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AtlasMode } from "@useatlas/types/auth";
import type { ModeStatusResponse, ModeDraftCounts } from "@useatlas/types/mode";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
} from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
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
});

const ModeStatusSchema = z.object({
  mode: z.enum(["developer", "published"]),
  canToggle: z.boolean(),
  demoIndustry: z.string().nullable(),
  demoConnectionActive: z.boolean(),
  hasDrafts: z.boolean(),
  draftCounts: DraftCountsSchema.nullable(),
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

// ---------------------------------------------------------------------------
// Combined draft counts query
//
// One round-trip via UNION ALL keeps the response cheap. Each branch is a
// single COUNT(*) over an indexed (org_id, status) pair, except entityEdits
// which joins drafts to their published counterpart on the same key the
// partial unique indexes use (org_id, name, COALESCE(connection_id, sentinel)).
// ---------------------------------------------------------------------------

const DRAFT_COUNTS_SQL = `
  SELECT 'connections'::text   AS k, COUNT(*)::int AS v
    FROM connections
    WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'entities'::text,            COUNT(*)::int
    FROM semantic_entities
    WHERE org_id = $1 AND status = 'draft'
  UNION ALL
  SELECT 'entityEdits'::text,         COUNT(*)::int
    FROM semantic_entities d
    INNER JOIN semantic_entities p
      ON d.org_id = p.org_id
     AND d.name = p.name
     AND COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id, '__default__')
    WHERE d.org_id = $1
      AND d.status = 'draft'
      AND p.status = 'published'
  UNION ALL
  SELECT 'entityDeletes'::text,       COUNT(*)::int
    FROM semantic_entities
    WHERE org_id = $1 AND status = 'draft_delete'
  UNION ALL
  SELECT 'prompts'::text,             COUNT(*)::int
    FROM prompt_collections
    WHERE org_id = $1 AND status = 'draft'
`;

const DEMO_ACTIVE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM connections
    WHERE id = '__demo__' AND org_id = $1 AND status = 'published'
  ) AS active
`;

type DraftKey = keyof ModeDraftCounts;
const ZERO_COUNTS: ModeDraftCounts = {
  connections: 0,
  entities: 0,
  entityEdits: 0,
  entityDeletes: 0,
  prompts: 0,
};

function rowsToCounts(rows: ReadonlyArray<{ k: string; v: number }>): ModeDraftCounts {
  const counts: Record<DraftKey, number> = { ...ZERO_COUNTS };
  for (const { k, v } of rows) {
    if (k in counts) {
      counts[k as DraftKey] = Number(v) || 0;
    }
  }
  return counts;
}

function totalDrafts(counts: ModeDraftCounts): number {
  return (
    counts.connections +
    counts.entities +
    counts.entityEdits +
    counts.entityDeletes +
    counts.prompts
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const mode = new OpenAPIHono<AuthEnv>();

mode.use("/", standardAuth);
mode.use("/", requestContext);

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
      } satisfies ModeStatusResponse;
    }

    const demoIndustry = getSettingAuto(DEMO_INDUSTRY_SETTING, orgId) ?? null;

    const [demoRows, draftRows] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          internalQuery<{ active: boolean }>(DEMO_ACTIVE_SQL, [orgId]),
          internalQuery<{ k: string; v: number }>(DRAFT_COUNTS_SQL, [orgId]),
        ]),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    const demoConnectionActive = demoRows[0]?.active === true;
    const counts = rowsToCounts(draftRows);
    const hasDrafts = totalDrafts(counts) > 0;

    return {
      mode: atlasMode satisfies AtlasMode,
      canToggle,
      demoIndustry,
      demoConnectionActive,
      hasDrafts,
      draftCounts: hasDrafts ? counts : null,
    } satisfies ModeStatusResponse;
  });

  const body = await runEffect(c, program, { label: "fetch mode status" });
  return c.json(body, 200);
});

export { mode };
