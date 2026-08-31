/**
 * Action approval REST routes — list, get, approve, deny, re-dispatch, rollback.
 *
 * Middleware stack follows the same auth → rate limit → withRequestContext
 * pattern as conversations.ts.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  getAction,
  approveActionAsUser,
  denyActionAsUser,
  redispatchActionAsUser,
  rollbackAction,
  listPendingActions,
  getActionConfig,
} from "@atlas/api/lib/tools/actions/handler";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import {
  bulkApproveActions,
  bulkDenyActions,
  BULK_ACTIONS_MAX,
} from "@atlas/api/lib/tools/actions/bulk";
import { ACTION_STATUSES, type ActionStatus } from "@atlas/api/lib/action-types";
import { canApprove } from "@atlas/api/lib/auth/permissions";
import { ErrorSchema, parsePagination } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";
// Imported for its SIDE EFFECT: loading the action barrel runs each built-in
// module's top-level `defineActionExecutor` call (#5570), so this process can
// execute any approved row from the moment this router exists.
//
// ⚠️ Load-bearing, and easy to mistake for a stray import. Nothing else pulls
// these modules in eagerly — `buildRegistry({ includeActions: true })` reaches
// them through a lazy `await import("./actions")` that only runs inside a chat
// turn. Without this line a process that restarted and received an approve
// BEFORE serving an action-enabled turn would find an empty registry and
// strand the row at `approved`: the exact failure the type-keyed registry
// replaced, reintroduced as a load-order accident. The router that serves
// approve / deny / re-dispatch is where the guarantee belongs, so no mount
// site has to remember it — and this file is itself imported only when
// `ATLAS_ACTIONS_ENABLED` is set, so a deploy without actions pays nothing.
// `actions-executor-boot.test.ts` fails if this line goes.
import "@atlas/api/lib/tools/actions/index";

const log = createLogger("actions");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listActionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Actions"],
  summary: "List actions",
  description:
    "Returns actions filtered by status. Requires ATLAS_ACTIONS_ENABLED=true and an internal database.",
  request: {
    query: z.object({
      status: z.string().optional().openapi({
        param: { name: "status", in: "query" },
        description: "Filter by action status (default: pending).",
        example: "pending",
      }),
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of actions to return (1-100, default 50).",
        example: "50",
      }),
    }),
  },
  responses: {
    200: {
      description: "List of actions",
      content: {
        "application/json": {
          schema: z.object({ actions: z.array(z.record(z.string(), z.unknown())) }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Actions not available (no internal database or feature disabled)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getActionRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Actions"],
  summary: "Get action by ID",
  description: "Returns a single action. Only returns actions requested by the authenticated user.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Action details",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const approveActionRoute = createRoute({
  method: "post",
  path: "/{id}/approve",
  tags: ["Actions"],
  summary: "Approve a pending action",
  description:
    "Approves a pending action and triggers execution. Returns the updated action with results. " +
    "For admin-only approval mode, the requester cannot approve their own action (separation of duties).",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Action approved and execution result",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Action has already been resolved",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const denyActionRoute = createRoute({
  method: "post",
  path: "/{id}/deny",
  tags: ["Actions"],
  summary: "Deny a pending action",
  description:
    "Denies a pending action. Optionally provide a reason in the request body. " +
    "For admin-only approval mode, the requester cannot deny their own action.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().optional() }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Action denied",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID or request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Action has already been resolved",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const BulkActionsResponseSchema = z.object({
  updated: z.array(z.string()),
  notFound: z.array(z.string()),
  forbidden: z.array(z.string()),
  errors: z.array(z.object({ id: z.string(), error: z.string() })),
});

const BULK_REASON_MAX = 1000;

const BulkActionsRequestSchema = z.object({
  ids: z
    .array(z.string().uuid("Each id must be a UUID"))
    .min(1, "ids must be a non-empty array")
    .max(BULK_ACTIONS_MAX, `Maximum ${BULK_ACTIONS_MAX} ids per bulk operation`),
  action: z.enum(["approve", "deny"]),
  reason: z.string().max(BULK_REASON_MAX).optional(),
});

const bulkActionsRoute = createRoute({
  method: "post",
  path: "/bulk",
  tags: ["Actions"],
  summary: "Bulk approve or deny pending actions",
  description:
    "Resolves many pending actions in a single request. Each id is pre-classified as eligible, " +
    "not found, or forbidden; eligible ids are then approved or denied. Rows that race a " +
    "conflicting resolution land in `errors`. Maximum 100 ids per request. Permission rules match " +
    "the single-action endpoints: admin-only actions cannot be resolved by the requester.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: BulkActionsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Bulk result — each id appears in exactly one bucket",
      content: { "application/json": { schema: BulkActionsResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Actions not available (no internal database or feature disabled)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const redispatchActionRoute = createRoute({
  method: "post",
  path: "/{id}/redispatch",
  tags: ["Actions"],
  summary: "Run an action that was approved but never executed",
  description:
    "Executes an action whose row is stuck at `approved` — the approval landed, but nothing ran. Since the executor registry is keyed by action type and populated at boot, the only way to reach that state is an instance that does not have the action's type loaded (actions disabled on this deploy, or a plugin declaring the type that is not wired). " +
    "⚠️ There is no workspace-wide listing of stranded rows on this router: `GET /?status=approved` is scoped to actions the CALLER requested, so an admin clearing someone else's stranded action reaches it by id — from the approval response that reported it, or from the `action_approved` / `approved_not_executed` error line in the logs. " +
    "Requires the same permissions as approving, separation of duties included: re-dispatch IS the execution half of an approval, so for an admin-only action the requester cannot trigger it. " +
    "⚠️ This fires the real side effect — the ticket is created, the email is sent — against the workspace that REQUESTED the action, using that workspace's credentials, however long ago the approval was given. There is deliberately no automatic sweep of stranded rows: an approval is a human decision about someone else's system, and firing it hours later with nobody watching is the failure mode this verb exists to avoid. " +
    "The dispatch is claimed atomically before it runs, so two admins re-dispatching the same action at once execute it once; the loser gets 409. " +
    "⚠️ An action that failed or timed out is NOT re-dispatchable — it already ran. This verb only moves rows that never ran at all.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description:
        "The action was dispatched. The entry's own status carries the result — `executed`, or `failed` / `timed_out` if the dispatch ran and the target rejected it",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "The action is not awaiting dispatch — it is still pending, already ran, or another re-dispatch claimed it first",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description:
        "This instance cannot execute the action's type. The row is untouched and stays re-dispatchable from an instance that has the type loaded",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const rollbackActionRoute = createRoute({
  method: "post",
  path: "/{id}/rollback",
  tags: ["Actions"],
  summary: "Rollback an executed action",
  description:
    "Rolls back an executed action using stored rollback information. Requires the same approval permissions as the original action.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: {
      description: "Action rolled back",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: {
      description: "Invalid action ID format",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Action not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Action cannot be rolled back",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

const actions = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

actions.use(standardAuth);
actions.use(requestContext);

// Normalize JSON parse errors. Only catch SyntaxError (malformed JSON); let
// other 400s (e.g. Zod query/path param validation) propagate with their message.
actions.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      if (err.cause instanceof SyntaxError) {
        log.warn("Malformed JSON body in request");
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
      return c.json({ error: "invalid_request", message: err.message || "Bad request." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list actions (default: pending)
// ---------------------------------------------------------------------------

actions.openapi(listActionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const rawStatus = c.req.query("status") ?? "pending";
    const status: ActionStatus | undefined = (ACTION_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as ActionStatus)
      : undefined;
    const { limit } = parsePagination(c, { limit: 50, maxLimit: 100 });

    const items = yield* Effect.promise(() => listPendingActions({
      ...(status !== undefined ? { status } : {}),
      ...(user?.id !== undefined ? { userId: user?.id } : {}),
      ...(user?.activeOrganizationId !== undefined ? { orgId: user?.activeOrganizationId } : {}),
      limit,
    }));
    return c.json({ actions: items }, 200);
  }), { label: "list actions" });
});

// ---------------------------------------------------------------------------
// GET /:id — get single action
// ---------------------------------------------------------------------------

actions.openapi(getActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const action = yield* Effect.promise(() => getAction(id, user?.activeOrganizationId));
    if (!action || action.requested_by !== user?.id) {
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    }
    return c.json(action, 200);
  }), { label: "retrieve action" });
});

/**
 * One HTTP mapping for the three refusal kinds both resolution verbs share
 * — the same body shapes and statuses the pre-refactor handlers produced,
 * with only the verb word ("approve"/"deny") varying. Success arms stay in
 * each handler; they are the two routes' genuinely different halves.
 */
/**
 * The verbs this mapping serves, each with the past participle its
 * self-approval message needs. A table rather than a ternary because
 * re-dispatch made it three (#5570), and a nested ternary is where the
 * "re-dispatch" arm would have quietly inherited "denied".
 */
const REFUSAL_VERBS = {
  approve: "approved",
  deny: "denied",
  "re-dispatch": "re-dispatched",
} as const;

function refusalResponse(
  c: Parameters<Parameters<typeof actions.openapi>[1]>[0],
  refusal: import("@atlas/api/lib/tools/actions/handler").ActionResolutionRefusal,
  verb: keyof typeof REFUSAL_VERBS,
  requestId: string,
) {
  switch (refusal.kind) {
    case "not_found":
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    case "forbidden":
      return c.json(
        {
          error: "forbidden",
          message:
            refusal.reason === "self_approval"
              ? `admin-only actions cannot be ${REFUSAL_VERBS[verb]} by the requester`
              : `Insufficient role to ${verb} this action.`,
          requestId,
        },
        403,
      );
    case "conflict":
      // "Resolved" reads oddly for a re-dispatch, where the row may be
      // pending (never resolved) or claimed by a concurrent dispatcher. Its
      // own sentence, because "already resolved" would send an admin looking
      // for a resolution that has not happened.
      return c.json(
        verb === "re-dispatch"
          ? {
              error: "conflict",
              message:
                "Action is not awaiting dispatch — it is still pending approval, it already ran, " +
                "or another re-dispatch claimed it first. Read the action to see which.",
            }
          : { error: "conflict", message: "Action has already been resolved." },
        409,
      );
  }
}

// ---------------------------------------------------------------------------
// POST /:id/approve — approve a pending action
// ---------------------------------------------------------------------------

actions.openapi(approveActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const orgId = user?.activeOrganizationId;

    // Authorization (org-scoped lookup so cross-org surfaces as 404, role
    // check, self-approval separation), the CAS and the executor lookup all
    // live behind `approveActionAsUser` — this handler keeps only the
    // HTTP mapping.
    const outcome = yield* Effect.promise(() => approveActionAsUser(id, { user, orgId }));
    if (outcome.kind === "approved" || outcome.kind === "approved_not_executed") {
      // Same wire shape for both: the entry's own status says whether it
      // ran. The split kind exists so no CALLER can conflate them; the
      // not-executed arm is logged at error level by the verb.
      return c.json(outcome.entry, 200);
    }
    return refusalResponse(c, outcome, "approve", requestId);
  }), { label: "approve action" });
});

// ---------------------------------------------------------------------------
// POST /:id/deny — deny a pending action
// ---------------------------------------------------------------------------

actions.openapi(
  denyActionRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user } = yield* AuthContext;

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
      }

      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
      }

      const orgId = user?.activeOrganizationId;

      // Body is optional — extract reason if provided. (A malformed JSON body
      // never reaches this handler: the route schema's validation answers 400
      // first, in this and every prior version — so refusal statuses need no
      // special ordering here.)
      let reason: string | undefined;
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const bodyResult = yield* Effect.tryPromise({
          try: () => c.req.json(),
          catch: (err) => err instanceof Error ? err : new Error(String(err)),
        }).pipe(Effect.either);
        if (bodyResult._tag === "Left") {
          const err = bodyResult.left;
          log.warn({ err: err.message, requestId }, "Failed to parse deny action request body");
          return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
        }
        const body = bodyResult.right;
        if (body && typeof body.reason === "string") {
          reason = body.reason;
        }
      }

      const outcome = yield* Effect.promise(() => denyActionAsUser(id, { user, orgId }, reason));
      if (outcome.kind === "denied") {
        return c.json(outcome.entry, 200);
      }
      return refusalResponse(c, outcome, "deny", requestId);
    }), { label: "deny action" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        400,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /bulk — mounted before /:id/* so Hono matches the literal segment.
// ---------------------------------------------------------------------------

actions.openapi(
  bulkActionsRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { user } = yield* AuthContext;

      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_available",
            message: "Action tracking is not available (no internal database configured).",
            requestId,
          },
          404,
        );
      }

      const { ids, action, reason } = c.req.valid("json");
      const orgId = user?.activeOrganizationId ?? null;

      const result = action === "approve"
        ? yield* Effect.tryPromise({
            try: () => bulkApproveActions({ ids, user, orgId, requestId }),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          })
        : yield* Effect.tryPromise({
            try: () => bulkDenyActions({ ids, user, orgId, ...(reason !== undefined ? { reason } : {}), requestId }),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          });

      return c.json(result, 200);
    }), { label: "bulk actions" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "validation_error",
          message: "Invalid request body.",
          details: result.error.issues,
        },
        400,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /:id/redispatch — run an approved action that never executed (#5570)
// ---------------------------------------------------------------------------

actions.openapi(redispatchActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const orgId = user?.activeOrganizationId;

    // Authorization (org-scoped lookup, the approve bar including
    // self-approval separation), the atomic claim, and the execution all live
    // behind `redispatchActionAsUser` — this handler keeps the HTTP mapping
    // and the admin-action audit row.
    const outcome = yield* Effect.promise(() => redispatchActionAsUser(id, { user, orgId }));

    if (outcome.kind === "unregistered_type") {
      // 503, not 409: nothing about the request is wrong and the row is
      // untouched — this DEPLOY cannot run this action type. Retrying against
      // an instance that has it loaded is the fix, so the message says so.
      log.error(
        { actionId: id, actionType: outcome.entry.action_type, orgId, requestId },
        "Action re-dispatch declined — no executor registered for this action type on this instance",
      );
      return c.json(
        {
          error: "action_type_unavailable",
          message:
            `This deployment cannot execute action type "${outcome.entry.action_type}". ` +
            "The action is unchanged and still awaiting dispatch — retry once an instance with that " +
            "action type loaded is serving (check that actions are enabled on this deploy, and that " +
            "any plugin declaring the type is healthy and wired).",
          requestId,
        },
        503,
      );
    }

    if (outcome.kind !== "redispatched") {
      // `conflict` covers both "not stranded" (still pending, or already ran)
      // and "another dispatcher claimed it first". Deliberately one answer:
      // distinguishing them would mean reporting the row's state to a caller
      // who just lost a race for it, and `GET /:id` is the surface for that.
      return refusalResponse(c, outcome, "re-dispatch", requestId);
    }

    // AWAITED, on `admin-brain-triage.ts`'s reasoning: the action log records
    // that the action executed and names its ORIGINAL approver, so without
    // this row nothing anywhere says who set it in motion later, or that a
    // re-dispatch happened at all. Emitted for a failed dispatch too — "an
    // admin re-dispatched and it failed again" is what stops the next admin
    // repeating it.
    const audited = yield* Effect.tryPromise({
      try: () =>
        logAdminActionAwait({
          actionType: ADMIN_ACTIONS.approval.redispatch,
          // The `approval` domain's own target type, as `admin-approval.ts`
          // uses for approve/deny — this act is a third verb on an approval,
          // not a new kind of target.
          targetType: "approval",
          targetId: id,
          // Recorded like `admin-approval.ts` records it for approve/deny. It
          // matters more here than there: this is the verb that fires a real
          // side effect against someone else's workspace, potentially hours
          // after the approval, so "which client set it in motion" is exactly
          // what an auditor reconstructing the event reaches for.
          ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
          metadata: {
            actionType: outcome.entry.action_type,
            // The workspace the action FIRED AGAINST (ADR-0046), which is not
            // necessarily the re-dispatcher's — the whole point of recording it.
            actionOrgId: outcome.entry.org_id,
            originalApprover: outcome.entry.approved_by,
            resultStatus: outcome.entry.status,
          },
          ...(outcome.entry.status === "executed" ? {} : { status: "failure" as const }),
        }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.as(true as const),
      Effect.catchAll((err) => {
        log.error(
          { actionId: id, actionType: outcome.entry.action_type, requestId, err: err.message },
          "Action re-dispatch EXECUTED but its admin-action audit row failed to write",
        );
        return Effect.succeed(false as const);
      }),
    );

    if (!audited) {
      // 500 with the outcome in the message, not a bare error: the side effect
      // ALREADY HAPPENED and a retry would be refused as a conflict, so the
      // one thing the caller must not conclude is "it didn't run". The action
      // row is correct and readable at `GET /:id`; only the admin-action row
      // is missing.
      return c.json(
        {
          error: "audit_write_failed",
          message:
            `The action was re-dispatched and is now "${outcome.entry.status}", but the admin-action ` +
            "audit row could not be written. Do NOT retry — the dispatch already ran and a second " +
            `attempt is refused. Read GET /api/v1/actions/${id} for the outcome and record this ` +
            "re-dispatch by hand.",
          requestId,
        },
        500,
      );
    }

    return c.json(outcome.entry, 200);
  }), { label: "re-dispatch action" });
});

// ---------------------------------------------------------------------------
// POST /:id/rollback — rollback an executed action
// ---------------------------------------------------------------------------

actions.openapi(rollbackActionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured).", requestId }, 404);
    }

    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
    }

    const orgId = user?.activeOrganizationId;
    const action = yield* Effect.promise(() => getAction(id, orgId));
    if (!action) {
      return c.json({ error: "not_found", message: "Action not found." }, 404);
    }

    const cfg = getActionConfig(action.action_type);

    if (!canApprove(user, cfg.approval, cfg.requiredRole)) {
      return c.json({ error: "forbidden", message: "Insufficient role to rollback this action.", requestId }, 403);
    }

    if (!action.rollback_info) {
      return c.json({ error: "conflict", message: "Action does not have rollback information." }, 409);
    }

    const rollbackerId = user?.id ?? "anonymous";
    const rollbackResult = yield* Effect.promise(() => rollbackAction(id, rollbackerId, orgId));
    if (!rollbackResult) {
      return c.json({ error: "conflict", message: "Action cannot be rolled back. It may have been rolled back already or changed state." }, 409);
    }
    if (rollbackResult.error) {
      return c.json({ ...rollbackResult, warning: "Rollback status updated but the rollback handler reported an error. The side-effect may not have been reversed." }, 200);
    }
    return c.json(rollbackResult, 200);
  }), { label: "rollback action" });
});

export { actions };
