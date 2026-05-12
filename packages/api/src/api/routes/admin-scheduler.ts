/**
 * Admin scheduler routes (#2284).
 *
 * Mounted under /api/v1/admin/scheduler. Exposes the system-level scheduler
 * jobs (currently only the BYOT catalog refresh) so an admin can inspect
 * status + manually trigger a refresh cycle. Distinct from
 * /api/v1/admin/scheduled-tasks, which lists user-created agent tasks.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { createLogger } from "@atlas/api/lib/logger";
import {
  isByotCatalogRefreshSchedulerRunning,
  triggerByotCatalogRefreshCycle,
  BYOT_CATALOG_REFRESH_ACTOR,
} from "@atlas/api/lib/scheduler/byot-catalog-refresh";
import type { ByotRefreshCycleResult } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requirePermission } from "./admin-router";

const log = createLogger("admin-scheduler");

// ---------------------------------------------------------------------------
// Schemas — TriggerResultSchema is checked against ByotRefreshCycleResult at
// compile time via `satisfies` so the wire shape can't drift from the type
// without breaking the build.
// ---------------------------------------------------------------------------

const SchedulerTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  running: z.boolean(),
  systemActor: z.string(),
});

const ListTasksResponseSchema = z.object({
  tasks: z.array(SchedulerTaskSchema),
});

const TriggerResultSchema = z.object({
  status: z.enum(["success", "failure"]),
  inspected: z.number().int().nonnegative(),
  refreshed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skippedDecryptFailed: z.number().int().nonnegative(),
  skippedInBackoff: z.number().int().nonnegative(),
  skippedMissingKey: z.number().int().nonnegative(),
  skippedEeUnavailable: z.number().int().nonnegative(),
  skippedMalformedBundle: z.number().int().nonnegative(),
  error: z.string().optional(),
}) satisfies z.ZodType<ByotRefreshCycleResult>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listTasksRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Admin — Scheduler"],
  summary: "List system scheduler tasks",
  description:
    "Returns the system-level scheduler jobs registered on this pod. " +
    "Distinct from user-created scheduled tasks (see /admin/scheduled-tasks).",
  responses: {
    200: {
      description: "Tasks listed",
      content: { "application/json": { schema: ListTasksResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
  },
});

const triggerByotRefreshRoute = createRoute({
  method: "post",
  path: "/tasks/byot-catalog-refresh/run",
  tags: ["Admin — Scheduler"],
  summary: "Manually trigger BYOT catalog refresh cycle",
  description:
    "Runs a single refresh cycle synchronously and returns the outcome counts. " +
    "Audited via the standard `model_config.catalog_refresh_cycle` action with " +
    "actor `system:byot-catalog-refresh`. Returns 500 with `requestId` if the " +
    "cycle failed before producing per-row counts (e.g. the stale-row query " +
    "itself threw).",
  responses: {
    200: {
      description: "Cycle complete",
      content: { "application/json": { schema: TriggerResultSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Cycle failed before producing a result",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminScheduler = createAdminRouter();

// Only platform admins should poke system-level jobs.
adminScheduler.use(requirePermission("admin:settings"));

adminScheduler.openapi(listTasksRoute, async (c) => {
  return runEffect(
    c,
    Effect.sync(() =>
      c.json(
        {
          tasks: [
            {
              id: "byot-catalog-refresh",
              name: "BYOT catalog refresh",
              description:
                "Daily refresh of BYOT model catalogs (Anthropic / OpenAI / Bedrock) " +
                "whose Postgres L2 cache row is older than the TTL.",
              running: isByotCatalogRefreshSchedulerRunning(),
              systemActor: BYOT_CATALOG_REFRESH_ACTOR,
            },
          ],
        },
        200,
      ),
    ),
    { label: "list scheduler tasks" },
  );
});

adminScheduler.openapi(triggerByotRefreshRoute, async (c) => {
  return runEffect(
    c,
    Effect.gen(function* () {
      log.info("Manual BYOT catalog refresh trigger");
      const { requestId } = yield* RequestContext;
      const result = yield* Effect.tryPromise({
        try: () => triggerByotCatalogRefreshCycle(),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      if (result.status === "failure") {
        // The cycle audited the failure already; the route's job is to surface
        // it to the admin so the "Run now" button doesn't show green on a
        // real outage.
        return c.json(
          {
            error: "cycle_failed",
            message:
              result.error ??
              "BYOT catalog refresh cycle failed before producing per-row counts. Check API logs.",
            requestId,
          },
          500,
        );
      }
      return c.json(result, 200);
    }),
    { label: "trigger byot catalog refresh" },
  );
});

export { adminScheduler };
