/**
 * Admin proactive-chat public dataset routes (#2297, PRD #2291).
 *
 * Mounted at /api/v1/admin/proactive/public-dataset. Manages the
 * curated allowlist of semantic entity names that unlinked askers in
 * public chat channels can ask questions about. The HITL design
 * decisions captured on issue #2297 set the contract:
 *
 *   - Granularity: entity-level. denyMetrics is the escape hatch for
 *     "allow users but never users.email".
 *   - Defaults: empty. No auto-population, no stealth defaults.
 *   - Refusal copy: content-blind, managed by proactive.refusalCopy.
 *   - Discoverability: piggybacks on the answer meter via a new
 *     public_refused event type (see migration 0079).
 *
 * Every route yields `ProactiveGate.requireEnabled()` so
 * non-enterprise tenants see 403 enterprise_required rather than a
 * surface to twiddle. The public-dataset helpers (relocated to
 * `@atlas/ee/proactive/public-dataset` in #3999, reached via the
 * `ProactiveService` Tag) stay enterprise-agnostic so tests can
 * exercise the DB shape without booting the gate.
 *
 * Surface:
 *
 *   GET    /              list every allowlist entry for the active
 *                         workspace, ordered by entity name.
 *   POST   /              upsert one entry. Idempotent on
 *                         (workspaceId, entityName).
 *   DELETE /:entityName   remove one entry. 404 if absent.
 *   GET    /refused       30-day-by-default rollup of public_refused
 *                         meter events grouped by metadata.entityName.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { requireFeatureEntitlement } from "@atlas/api/lib/billing/feature-entitlement-guard";
import { runEffect } from "@atlas/api/lib/effect/hono";
import {
  AuthContext,
  ProactiveGate,
  ProactiveService,
  RequestContext,
} from "@atlas/api/lib/effect/services";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { AuthErrorSchema, ErrorSchema } from "./shared-schemas";
import {
  createAdminRouter,
  requireOrgContext,
  requirePermission,
} from "./admin-router";

const log = createLogger("admin-proactive-public-dataset");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EntityNameSchema = z
  .string()
  .min(1, "entityName must not be empty")
  .max(256, "entityName must be at most 256 characters");

const DenyMetricSchema = z.string().min(1).max(256);

const PublicDatasetEntrySchema = z.object({
  entityName: EntityNameSchema,
  denyMetrics: z.array(DenyMetricSchema),
});

const ListResponseSchema = z.object({
  entries: z.array(PublicDatasetEntrySchema),
});

const UpsertEntryBodySchema = z.object({
  entityName: EntityNameSchema,
  denyMetrics: z.array(DenyMetricSchema).optional(),
});

const RefusedRollupRowSchema = z.object({
  entityName: z.string(),
  count: z.number().int().nonnegative(),
});

const RefusedRollupResponseSchema = z.object({
  sinceMs: z.number().int().positive(),
  rollup: z.array(RefusedRollupRowSchema),
});

// ---------------------------------------------------------------------------
// Lookback parser (mirrors admin-proactive-analytics.ts)
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseSinceMs(raw: string | undefined): number {
  if (!raw || raw.length === 0) return DEFAULT_WINDOW_DAYS * DAY_MS;
  const match = /^(\d+)\s*([dhms]?)$/i.exec(raw.trim());
  if (!match) return DEFAULT_WINDOW_DAYS * DAY_MS;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS * DAY_MS;
  const unit = (match[2] ?? "").toLowerCase();
  let ms: number;
  switch (unit) {
    case "d":
      ms = n * DAY_MS;
      break;
    case "h":
      ms = n * 60 * 60 * 1000;
      break;
    case "m":
      ms = n * 60 * 1000;
      break;
    case "s":
    case "":
      ms = n * 1000;
      break;
    default:
      ms = DEFAULT_WINDOW_DAYS * DAY_MS;
  }
  const cap = MAX_WINDOW_DAYS * DAY_MS;
  return Math.min(ms, cap);
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listEntriesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Proactive Chat"],
  summary: "List public-dataset entries",
  description:
    "Returns the curated allowlist of semantic entity names that an unlinked asker may ask about in public channels. Ordered by entity name. Empty allowlist is the default for a freshly-enabled workspace - Atlas refuses every public-channel question until an admin opts in entity-by-entity.",
  responses: {
    200: {
      description: "Public dataset entries",
      content: { "application/json": { schema: ListResponseSchema } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden - admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const upsertEntryRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Proactive Chat"],
  summary: "Upsert a public-dataset entry",
  description:
    "Creates or replaces an allowlist entry on (workspaceId, entityName). Sending the same entityName twice replaces the persisted denyMetrics. Send denyMetrics: [] to clear the deny list on an existing entry. Idempotent.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpsertEntryBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Entry upserted",
      content: { "application/json": { schema: PublicDatasetEntrySchema } },
    },
    400: { description: "Invalid request body or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden - admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteEntryRoute = createRoute({
  method: "delete",
  path: "/{entityName}",
  tags: ["Admin — Proactive Chat"],
  summary: "Delete a public-dataset entry",
  description:
    "Removes the allowlist entry for (workspaceId, entityName). Idempotent - 404 when the row was already gone.",
  request: {
    params: z.object({
      entityName: z.string().min(1).openapi({
        param: { name: "entityName", in: "path" },
        example: "marketing.users",
      }),
    }),
  },
  responses: {
    200: {
      description: "Entry deleted",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden - admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Entry not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const refusedRollupRoute = createRoute({
  method: "get",
  path: "/refused",
  tags: ["Admin — Proactive Chat"],
  summary: "List refused-topics rollup",
  description:
    "Discoverability rollup powering the admin console's Refused topics panel: how often unlinked askers tried to ask about an entity NOT on the allowlist, grouped by entity name. Defaults to a 30-day moving window; `since=<n>[dhms]` overrides the lookback. Capped at 365 days. The admin UI pairs each row with a one-click Make-public affordance.",
  request: {
    query: z.object({
      since: z.string().min(1).optional().openapi({
        param: { name: "since", in: "query" },
        example: "30d",
      }),
    }),
  },
  responses: {
    200: {
      description: "Refused-topics rollup",
      content: { "application/json": { schema: RefusedRollupResponseSchema } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden - admin role required or enterprise not enabled", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminProactivePublicDataset = createAdminRouter();
adminProactivePublicDataset.use(requireOrgContext());
adminProactivePublicDataset.use(requirePermission("admin:settings"));

adminProactivePublicDataset.openapi(listEntriesRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      // orgId is guaranteed non-null by `requireOrgContext()` on this router (#4356).
      const { orgId } = c.get("orgContext");

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();
      // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
      // where the enterprise-license Tag above is the gate. (#4064 / #3984)
      yield* requireFeatureEntitlement(orgId, "proactive");

      if (!hasInternalDB()) {
        return c.json({ entries: [] }, 200);
      }

      const proactiveSvc = yield* ProactiveService;
      const entries = yield* proactiveSvc.getAllowlist(orgId);
      return c.json({ entries }, 200);
    }),
    { label: "list proactive public dataset" },
  ),
);

adminProactivePublicDataset.openapi(upsertEntryRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      // orgId is guaranteed non-null by `requireOrgContext()` on this router (#4356).
      const { orgId } = c.get("orgContext");
      const { user } = yield* AuthContext;

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();
      // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
      // where the enterprise-license Tag above is the gate. (#4064 / #3984)
      yield* requireFeatureEntitlement(orgId, "proactive");

      if (!hasInternalDB()) {
        return c.json(
          { error: "internal_error" as const, message: "Public dataset requires an internal database. Configure DATABASE_URL.", requestId },
          500,
        );
      }

      const body = c.req.valid("json");
      const denyMetrics = body.denyMetrics ?? [];

      const proactiveSvc = yield* ProactiveService;
      yield* proactiveSvc.addEntry(orgId, body.entityName, denyMetrics);

      log.info(
        {
          orgId,
          requestId,
          actorId: user?.id,
          entityName: body.entityName,
          denyMetricsCount: denyMetrics.length,
        },
        "Proactive public dataset entry upserted",
      );
      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.publicDatasetUpsert,
        targetType: "proactive",
        targetId: body.entityName,
        ipAddress:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          null,
        metadata: {
          entityName: body.entityName,
          denyMetrics,
        },
      });
      return c.json(
        { entityName: body.entityName, denyMetrics },
        200,
      );
    }),
    { label: "upsert proactive public dataset entry" },
  ),
);

adminProactivePublicDataset.openapi(deleteEntryRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      // orgId is guaranteed non-null by `requireOrgContext()` on this router (#4356).
      const { orgId } = c.get("orgContext");
      const { user } = yield* AuthContext;

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();
      // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
      // where the enterprise-license Tag above is the gate. (#4064 / #3984)
      yield* requireFeatureEntitlement(orgId, "proactive");

      const { entityName } = c.req.valid("param");

      if (!hasInternalDB()) {
        return c.json(
          { error: "not_found" as const, message: "Public dataset entry not found.", requestId },
          404,
        );
      }

      const proactiveSvc = yield* ProactiveService;
      const result = yield* proactiveSvc.removeEntry(orgId, entityName);
      if (!result.removed) {
        return c.json(
          { error: "not_found" as const, message: "Public dataset entry not found.", requestId },
          404,
        );
      }

      log.info(
        { orgId, requestId, actorId: user?.id, entityName },
        "Proactive public dataset entry deleted",
      );
      logAdminAction({
        actionType: ADMIN_ACTIONS.proactive.publicDatasetDelete,
        targetType: "proactive",
        targetId: entityName,
        ipAddress:
          c.req.header("x-forwarded-for") ??
          c.req.header("x-real-ip") ??
          null,
        metadata: { entityName },
      });
      return c.json({ success: true }, 200);
    }),
    { label: "delete proactive public dataset entry" },
  ),
);

adminProactivePublicDataset.openapi(refusedRollupRoute, async (c) =>
  runEffect(
    c,
    Effect.gen(function* () {
      // orgId is guaranteed non-null by `requireOrgContext()` on this router (#4356).
      const { orgId } = c.get("orgContext");

      const proactive = yield* ProactiveGate;
      yield* proactive.requireEnabled();
      // Per-tier ladder: on SaaS proactive is Business-only. No-op off-SaaS,
      // where the enterprise-license Tag above is the gate. (#4064 / #3984)
      yield* requireFeatureEntitlement(orgId, "proactive");

      const sinceMs = parseSinceMs(c.req.query("since"));
      const proactiveSvc = yield* ProactiveService;
      const rollup = yield* proactiveSvc.summarizePublicRefused(orgId, sinceMs);
      return c.json({ sinceMs, rollup }, 200);
    }),
    { label: "summarize proactive public refused" },
  ),
);

export { adminProactivePublicDataset };
