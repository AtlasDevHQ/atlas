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
import type { ModeStatusResponse, ModeDraftCounts } from "@useatlas/types/mode";
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

const DEMO_ACTIVE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM connections
    WHERE id = '__demo__' AND org_id = $1 AND status = 'published'
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
      } satisfies ModeStatusResponse;
    }

    const demoIndustry = getSettingAuto(DEMO_INDUSTRY_SETTING, orgId) ?? null;
    const registry = yield* ContentModeRegistry;

    const [demoRows, counts] = yield* Effect.all(
      [queryEffect<{ active: boolean }>(DEMO_ACTIVE_SQL, [orgId]), registry.countAllDrafts(orgId)],
      { concurrency: "unbounded" },
    );

    const demoConnectionActive = demoRows[0]?.active === true;
    const hasDrafts = totalDrafts(counts) > 0;

    return {
      mode: atlasMode satisfies AtlasMode,
      canToggle,
      demoIndustry,
      demoConnectionActive,
      hasDrafts,
      draftCounts: hasDrafts ? counts : null,
    } satisfies ModeStatusResponse;
  }).pipe(Effect.provide(modeRouteLayer));

  const body = await runEffect(c, program, { label: "fetch mode status" });
  return c.json(body, 200);
});

export { mode };
