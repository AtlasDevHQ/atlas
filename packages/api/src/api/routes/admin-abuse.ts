/**
 * Admin abuse prevention routes.
 *
 * Mounted under /api/v1/admin/abuse. Platform-admin only (see
 * createPlatformRouter): every route takes a :workspaceId path param and acts
 * cross-tenant, so workspace-scoped admins must not reach these handlers.
 * Provides listing of flagged workspaces, reinstatement, and threshold config.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import {
  listFlaggedWorkspaces,
  reinstateWorkspace,
  getAbuseEvents,
  getAbuseConfig,
  getAbuseDetail,
} from "@atlas/api/lib/security/abuse";
import { getWorkspaceNamesByIds, hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";

const log = createLogger("admin-abuse");
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import {
  AbuseStatusSchema,
  AbuseDetailSchema,
  AbuseThresholdConfigSchema,
} from "@useatlas/schemas";
import { ErrorSchema, AuthErrorSchema, createListResponseSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
//
// Wire-format schemas (AbuseStatus / AbuseDetail / AbuseThresholdConfig /
// nested Event/Instance/Counters) live in `@useatlas/schemas` — one source
// shared with the web client so renames can't silently drift. Route-local
// schemas below are the ones that wrap the shared shapes (list envelope)
// or describe route-only responses (reinstate).

// List/detail responses carry an optional `warnings[]` channel so the admin
// UI can surface partial-failure state (e.g. workspace-name resolution fell
// back to opaque ids because the internal DB hiccuped). Without it, a
// platform admin reinstating a flagged workspace off the list can't tell
// "the real name is missing" from "this row is just an id we can't render,"
// which is an active wrong-row-selection hazard for a cross-tenant action.
// Same shape as admin-orgs.ts DELETE /:id (PR #1762 follow-up commit).
const ListResponseSchema = createListResponseSchema("workspaces", AbuseStatusSchema).extend({
  warnings: z.array(z.string()).optional(),
});

const DetailResponseSchema = AbuseDetailSchema.extend({
  warnings: z.array(z.string()).optional(),
});

const ReinstateResponseSchema = z.object({
  success: z.boolean(),
  workspaceId: z.string(),
  message: z.string(),
  /**
   * First-class flag (F-33 follow-up) indicating whether the
   * `admin_action_log` row was attempted against a real internal DB.
   * `false` when `!hasInternalDB()` (self-hosted without `DATABASE_URL`) —
   * `logAdminAction` still emits a pino line but the SQL row is skipped.
   * Always present in the response so non-UI clients (CLI, integrations,
   * smoke tests) can trust a single boolean without parsing
   * `warnings[]` strings.
   */
  auditPersisted: z.boolean(),
  warnings: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listFlaggedRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Abuse Prevention"],
  summary: "List flagged workspaces",
  description: "SaaS only. Returns all workspaces with active abuse flags (warning, throttled, or suspended).",
  responses: {
    200: {
      description: "Flagged workspaces",
      content: { "application/json": { schema: ListResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const reinstateRoute = createRoute({
  method: "post",
  path: "/{workspaceId}/reinstate",
  tags: ["Admin — Abuse Prevention"],
  summary: "Reinstate a suspended workspace",
  description: "SaaS only. Manually re-enable a workspace that was suspended or throttled due to abuse detection.",
  request: {
    params: z.object({
      workspaceId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Workspace reinstated",
      content: { "application/json": { schema: ReinstateResponseSchema } },
    },
    400: {
      description: "Workspace not flagged",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getDetailRoute = createRoute({
  method: "get",
  path: "/{workspaceId}/detail",
  tags: ["Admin — Abuse Prevention"],
  summary: "Investigation detail for a flagged workspace",
  description:
    "SaaS only. Returns live counters, thresholds, the current flag instance, and up to 5 prior flag instances so operators can investigate without leaving the page.",
  request: {
    params: z.object({
      workspaceId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Investigation detail",
      content: { "application/json": { schema: DetailResponseSchema } },
    },
    404: {
      description: "Workspace not flagged",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Admin — Abuse Prevention"],
  summary: "Current abuse threshold configuration",
  description: "SaaS only. Returns the current abuse detection thresholds (from env vars or defaults).",
  responses: {
    200: {
      description: "Threshold configuration",
      content: { "application/json": { schema: AbuseThresholdConfigSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — platform admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminAbuse = createPlatformRouter();

// GET / — list flagged workspaces
adminAbuse.openapi(listFlaggedRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const workspaces = listFlaggedWorkspaces();

    // Enrich with recent events from DB + resolve workspace names so the
    // admin table shows "Acme Corp" instead of "org_01K...". Names are a
    // batch fetch to avoid N+1; missing/deleted orgs fall back to null.
    // If the name lookup itself fails, we still render the page (opaque
    // ids beat a 500) but push a `warnings[]` entry so the UI can show a
    // banner — without it a platform admin could mis-identify a row and
    // reinstate the wrong tenant.
    const warnings: string[] = [];
    const enriched = yield* Effect.promise(async () => {
      const orgIds = workspaces.map((ws) => ws.workspaceId);
      const [eventResults, names] = await Promise.all([
        Promise.all(workspaces.map((ws) => getAbuseEvents(ws.workspaceId, 10))),
        getWorkspaceNamesByIds(orgIds).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error(
            {
              err: err instanceof Error
                ? { message: err.message, stack: err.stack }
                : String(err),
              orgIdCount: orgIds.length,
              // First 5 ids for on-call correlation without flooding logs.
              sampleOrgIds: orgIds.slice(0, 5),
              requestId,
            },
            "abuse list: workspace name resolution failed",
          );
          warnings.push(`name_resolution_failed: ${message}`);
          return new Map<string, string | null>();
        }),
      ]);
      return workspaces.map((ws, i) => {
        // Promise.all preserves order, so `eventResults[i]` always exists —
        // but optional chaining + nullish fallback is the CLAUDE.md-preferred
        // shape ("minimize non-null assertions") and it also gracefully
        // degrades if a future refactor changes the upstream shape.
        const result = eventResults[i] ?? { events: [], status: "load_failed" as const };
        return {
          ...ws,
          workspaceName: names.get(ws.workspaceId) ?? null,
          // Surface the per-workspace load status on the list row too — a
          // future list consumer that filters / sorts by "has history"
          // now has an explicit signal instead of inferring from an
          // empty `events` array, which would reintroduce the #1682 bug
          // class at the list boundary.
          events: result.events,
          eventsStatus: result.status,
        };
      });
    });

    return c.json({
      workspaces: enriched,
      total: enriched.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    }, 200);
  }), { label: "list flagged workspaces" });
});

// POST /:workspaceId/reinstate — reinstate a workspace
adminAbuse.openapi(reinstateRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { workspaceId } = c.req.valid("param");
    const actorId = user?.id ?? "unknown";

    const previousLevel = reinstateWorkspace(workspaceId, actorId);
    // `== null` on purpose: the contract is `ReinstatedLevel | null` so only
    // `null` is reachable today, but `== null` also catches an `undefined`
    // that would slip in if a future refactor ever returns a bare `return`.
    // Without this guard a contract drift silently audits with
    // `previousLevel: undefined` — a ghost `workspace.reinstate_abuse` row
    // for an org that was never actually flagged.
    if (previousLevel == null) {
      return c.json(
        { error: "not_flagged", message: "Workspace is not currently flagged for abuse.", requestId },
        400,
      );
    }

    // Dual-write the audit trail (F-33). `reinstateWorkspace` persists to
    // `abuse_events` via `persistAbuseEvent`; `logAdminAction` persists to
    // `admin_action_log` so compliance queries filtering by
    // `action_type = 'workspace.reinstate_abuse'` see every reinstate
    // without joining a second table. `previousLevel` on the metadata
    // lets reviewers distinguish a low-impact un-warn from lifting a full
    // suspension at read time.
    logAdminAction({
      actionType: ADMIN_ACTIONS.workspace.reinstateAbuse,
      targetType: "workspace",
      targetId: workspaceId,
      scope: "platform",
      metadata: { previousLevel },
    });

    // In-memory throttling is lifted by this point — customer queries are
    // already flowing. On the no-internal-DB path the two sinks degrade
    // asymmetrically: `logAdminAction` always emits a pino line (that is
    // the only surviving audit artifact without a DB), while
    // `persistAbuseEvent` short-circuits with no pino trail at all. Both
    // DB rows are skipped, so the warning below + the first-class
    // `auditPersisted: false` flag on the response let machine clients and
    // UIs alike spot the degradation without having to parse `warnings[]`.
    const warnings: string[] = [];
    const auditPersisted = hasInternalDB();
    if (!auditPersisted) {
      log.error(
        { workspaceId, actorId, requestId },
        "reinstate: audit row not persisted — no internal DB configured",
      );
      warnings.push(
        "audit_persist_skipped: no internal DB configured; reinstate has no audit trail",
      );
    }

    return c.json({
      success: true,
      workspaceId,
      auditPersisted,
      message: auditPersisted
        ? "Workspace reinstated successfully."
        : "Workspace reinstated, but audit trail could not be written — see warnings.",
      ...(warnings.length > 0 ? { warnings } : {}),
    }, 200);
  }), { label: "reinstate workspace" });
});

// GET /:workspaceId/detail — investigation detail for a flagged workspace
adminAbuse.openapi(getDetailRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { workspaceId } = c.req.valid("param");

    const detail = yield* Effect.promise(() => getAbuseDetail(workspaceId));
    if (!detail) {
      return c.json(
        {
          error: "not_flagged",
          message: "Workspace is not currently flagged for abuse.",
          requestId,
        },
        404,
      );
    }

    // Resolve the workspace display name. Advisory — see list route above.
    // Surface a `warnings[]` entry on failure so the admin isn't flying
    // blind on identity when about to reinstate a cross-tenant workspace.
    const warnings: string[] = [];
    const nameMap = yield* Effect.promise(() =>
      getWorkspaceNamesByIds([workspaceId]).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          {
            err: err instanceof Error
              ? { message: err.message, stack: err.stack }
              : String(err),
            workspaceId,
            requestId,
          },
          "abuse detail: workspace name resolution failed",
        );
        warnings.push(`name_resolution_failed: ${message}`);
        return new Map<string, string | null>();
      }),
    );
    const enriched = {
      ...detail,
      workspaceName: nameMap.get(workspaceId) ?? null,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    return c.json(enriched, 200);
  }), { label: "read abuse detail" });
});

// GET /config — current threshold configuration
adminAbuse.openapi(getConfigRoute, async (c) => {
  return runEffect(c, Effect.sync(() => {
    return c.json(getAbuseConfig(), 200);
  }), { label: "read abuse config" });
});

export { adminAbuse };
