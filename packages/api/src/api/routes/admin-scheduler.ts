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
import { createLogger } from "@atlas/api/lib/logger";
import {
  isByotCatalogRefreshSchedulerRunning,
  triggerByotCatalogRefreshCycle,
  BYOT_CATALOG_REFRESH_ACTOR,
} from "@atlas/api/lib/scheduler/byot-catalog-refresh";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requirePermission } from "./admin-router";

const log = createLogger("admin-scheduler");

// ---------------------------------------------------------------------------
// Schemas
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
  inspected: z.number().int().nonnegative(),
  refreshed: z.number().int().nonnegative(),
  skippedDecryptFailed: z.number().int().nonnegative(),
  skippedInBackoff: z.number().int().nonnegative(),
  skippedMissingKey: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

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
    "actor `system:byot-catalog-refresh`.",
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
      const result = yield* Effect.tryPromise({
        try: () => triggerByotCatalogRefreshCycle(),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      return c.json(result, 200);
    }),
    { label: "trigger byot catalog refresh" },
  );
});

export { adminScheduler };
