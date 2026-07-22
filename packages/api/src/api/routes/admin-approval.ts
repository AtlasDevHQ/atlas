/**
 * Admin approval workflow routes.
 *
 * Mounted under /api/v1/admin/approval. All routes require admin role AND
 * enterprise license (enforced within the approval service layer).
 *
 * Provides:
 * - GET    /rules          — list approval rules
 * - POST   /rules          — create approval rule
 * - PUT    /rules/:id      — update approval rule
 * - DELETE /rules/:id      — delete approval rule
 * - GET    /queue          — list approval requests (filterable by status)
 * - GET    /queue/:id      — get single approval request
 * - POST   /queue/:id      — approve or deny a request
 * - POST   /expire         — manually expire stale requests
 * - GET    /pending-count  — count of pending requests
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { APPROVAL_STATUSES, APPROVAL_RULE_ORIGINS } from "@useatlas/types";
import { ApprovalRuleSchema, ApprovalRequestSchema } from "@useatlas/schemas";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { resolveApprovalPark } from "@atlas/api/lib/durable-resume";
import { deliverChatResumeIfPending } from "@atlas/api/lib/chat-plugin/resume-delivery";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import {
  RequestContext,
  AuthContext,
  ApprovalGate,
} from "@atlas/api/lib/effect/services";
import { requireFeatureEntitlement } from "@atlas/api/lib/billing/feature-entitlement-guard";
import { ApprovalError } from "@atlas/api/lib/governance/errors";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, noActiveOrgBody } from "./admin-router";

const approvalDomainError = domainError(ApprovalError, { validation: 400, not_found: 404, conflict: 409, expired: 410 });

const log = createLogger("admin-approval");

// ---------------------------------------------------------------------------
// Request body schemas — response shapes live in @useatlas/schemas.
// ---------------------------------------------------------------------------

// #2072 — agent origin scope is shared across rule types. `'any'` (default)
// preserves pre-2072 fires-everywhere semantics; the others pin a rule
// to a single transport. The field is `.optional()` because the EE
// layer applies the `'any'` default — the strict `z.enum(...)` on the
// inner type still rejects typos at the route boundary as a 400
// rather than letting them land in `validateRuleInput` as a 500.
const OriginField = z.enum(APPROVAL_RULE_ORIGINS).optional().openapi({
  description:
    "Agent origin this rule applies to. 'any' (default) fires for every request; the others pin to a single transport. See #2072 / ADR-0015.",
  example: "any",
});

// Discriminated on `ruleType` (#1660) — encodes "cost needs threshold;
// table/column need pattern" at the wire layer. A cost body missing
// `threshold`, or a table body missing `pattern`, is now a 400 from the
// Zod parser, not a runtime error from `validateRuleInput`.
const CostRuleBodySchema = z.object({
  name: z.string().min(1).openapi({
    description: "Human-readable rule name.",
    example: "Flag expensive queries",
  }),
  ruleType: z.literal("cost").openapi({
    description: "Type of rule: cost threshold.",
    example: "cost",
  }),
  threshold: z.number().positive().openapi({
    description: "Cost threshold (positive integer — estimated row count).",
    example: 1000,
  }),
  pattern: z.literal("").optional().openapi({ description: "Unused for cost rules." }),
  enabled: z.boolean().optional().openapi({
    description: "Whether the rule is active. Defaults to true.",
    example: true,
  }),
  origin: OriginField,
});

const NamedRuleBodySchema = z.object({
  name: z.string().min(1).openapi({
    description: "Human-readable rule name.",
    example: "Require approval for PII tables",
  }),
  ruleType: z.enum(["table", "column", "datasource"]).openapi({
    description: "Type of rule: table name match, column name match, or datasource id match (#3573 — gates MCP datasource mutations).",
    example: "table",
  }),
  pattern: z.string().min(1).openapi({
    description: "Pattern to match. Table/column name.",
    example: "users",
  }),
  threshold: z.null().optional().openapi({
    description: "Unused for table/column rules — must be null.",
    example: null,
  }),
  enabled: z.boolean().optional().openapi({
    description: "Whether the rule is active. Defaults to true.",
    example: true,
  }),
  origin: OriginField,
});

const CreateRuleBodySchema = z.discriminatedUnion("ruleType", [
  CostRuleBodySchema,
  NamedRuleBodySchema,
]);

const UpdateRuleBodySchema = z.object({
  name: z.string().min(1).optional(),
  pattern: z.string().optional(),
  threshold: z.number().nullable().optional(),
  enabled: z.boolean().optional(),
  origin: OriginField,
});

const ReviewBodySchema = z.object({
  action: z.enum(["approve", "deny"]).openapi({
    description: "Whether to approve or deny the request.",
    example: "approve",
  }),
  comment: z.string().optional().openapi({
    description: "Optional comment from the reviewer.",
    example: "Approved for quarterly audit.",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRulesRoute = createRoute({
  method: "get",
  path: "/rules",
  tags: ["Admin — Approval Workflows"],
  summary: "List approval rules",
  description: "Returns all approval rules for the current organization.",
  responses: {
    200: {
      description: "Approval rules list",
      content: { "application/json": { schema: z.object({ rules: z.array(ApprovalRuleSchema) }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/rules",
  tags: ["Admin — Approval Workflows"],
  summary: "Create approval rule",
  description: "Create a new approval rule for the organization.",
  request: { body: { required: true, content: { "application/json": { schema: CreateRuleBodySchema } } } },
  responses: {
    201: { description: "Rule created", content: { "application/json": { schema: z.object({ rule: ApprovalRuleSchema }) } } },
    400: { description: "Invalid input or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateRuleRoute = createRoute({
  method: "put",
  path: "/rules/{id}",
  tags: ["Admin — Approval Workflows"],
  summary: "Update approval rule",
  description: "Update an existing approval rule.",
  request: { body: { required: true, content: { "application/json": { schema: UpdateRuleBodySchema } } } },
  responses: {
    200: { description: "Rule updated", content: { "application/json": { schema: z.object({ rule: ApprovalRuleSchema }) } } },
    400: { description: "Invalid input", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Rule not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/rules/{id}",
  tags: ["Admin — Approval Workflows"],
  summary: "Delete approval rule",
  description: "Delete an approval rule. Pending requests referencing this rule are not affected.",
  responses: {
    200: { description: "Rule deleted", content: { "application/json": { schema: z.object({ message: z.string() }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Rule not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const ListQueueQuerySchema = z.object({
  status: z
    .enum(APPROVAL_STATUSES)
    .optional()
    .openapi({
      description: "Filter requests by status.",
      example: "pending",
      param: { name: "status", in: "query" },
    }),
});

const listQueueRoute = createRoute({
  method: "get",
  path: "/queue",
  tags: ["Admin — Approval Workflows"],
  summary: "List approval requests",
  description: "Returns approval requests for the organization. Filterable by status via query parameter.",
  request: { query: ListQueueQuerySchema },
  responses: {
    200: {
      description: "Approval requests list",
      content: { "application/json": { schema: z.object({ requests: z.array(ApprovalRequestSchema) }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid query parameters", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getQueueItemRoute = createRoute({
  method: "get",
  path: "/queue/{id}",
  tags: ["Admin — Approval Workflows"],
  summary: "Get approval request",
  description: "Returns a single approval request by ID.",
  responses: {
    200: {
      description: "Approval request details",
      content: { "application/json": { schema: z.object({ request: ApprovalRequestSchema }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Request not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const reviewRoute = createRoute({
  method: "post",
  path: "/queue/{id}",
  tags: ["Admin — Approval Workflows"],
  summary: "Review approval request",
  description: "Approve or deny a pending approval request.",
  request: { body: { required: true, content: { "application/json": { schema: ReviewBodySchema } } } },
  responses: {
    200: { description: "Request reviewed", content: { "application/json": { schema: z.object({ request: ApprovalRequestSchema }) } } },
    400: { description: "Invalid input", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Request not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Request already reviewed", content: { "application/json": { schema: ErrorSchema } } },
    410: { description: "Request expired", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const expireRoute = createRoute({
  method: "post",
  path: "/expire",
  tags: ["Admin — Approval Workflows"],
  summary: "Expire stale requests",
  description: "Manually expire all pending approval requests past their expiry time.",
  responses: {
    200: { description: "Expiry result", content: { "application/json": { schema: z.object({ expired: z.number() }) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const pendingCountRoute = createRoute({
  method: "get",
  path: "/pending-count",
  tags: ["Admin — Approval Workflows"],
  summary: "Get pending approval count",
  description: "Returns the count of pending (non-expired) approval requests for the organization.",
  responses: {
    200: { description: "Pending count", content: { "application/json": { schema: z.object({ count: z.number() }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminApproval = createAdminRouter();

// ── Handlers WITHOUT requireOrgContext ────────────────────────────────
// Registered before requireOrgContext() so the middleware does not apply.
// Only endpoints that are intentionally org-less should live here.

// GET /pending-count — count of pending requests (needs orgId, not hasInternalDB)
adminApproval.openapi(pendingCountRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    if (!orgId) {
      return c.json(noActiveOrgBody(requestId), 400);
    }
    yield* requireFeatureEntitlement(orgId, "approvals");

    const count = yield* (yield* ApprovalGate).getPendingCount(orgId);
    return c.json({ count }, 200);
  }), { label: "get pending approval count", domainErrors: [approvalDomainError] });
});

// ── Handlers WITH requireOrgContext ───────────────────────────────────
adminApproval.use(requireOrgContext());

// POST /expire — expire stale requests for the caller's active org. Scoped
// via requireOrgContext + `orgId` arg so workspace admins can only clear
// their own queue (F-13, 1.2.3 phase 2).
adminApproval.openapi(expireRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");
    const expired = yield* (yield* ApprovalGate).expireStaleRequests(orgId!);

    // Manual sweep that flips pending requests to expired. An admin
    // invoking this post-hoc on a queue they're about to approve/deny
    // is a red flag; `expireSweep` sits alongside `approve` / `deny` so
    // compliance queries see the full decision chain. See F-29.
    logAdminAction({
      actionType: ADMIN_ACTIONS.approval.expireSweep,
      targetType: "approval",
      targetId: orgId!,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { expiredCount: expired },
    });

    return c.json({ expired }, 200);
  }), { label: "expire stale requests", domainErrors: [approvalDomainError] });
});

// GET /rules — list approval rules
adminApproval.openapi(listRulesRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");

    const rules = yield* (yield* ApprovalGate).listApprovalRules(orgId!);
    return c.json({ rules }, 200);
  }), { label: "list approval rules", domainErrors: [approvalDomainError] });
});

// POST /rules — create approval rule
adminApproval.openapi(createRuleRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");
    const body = c.req.valid("json");

    // `body` is narrowed by the discriminated union (#1660); pass it
    // through as the matching CreateApprovalRuleRequest variant.
    // #2072 — origin (optional) flows on every variant.
    const input = body.ruleType === "cost"
      ? { ruleType: "cost" as const, name: body.name, threshold: body.threshold, enabled: body.enabled, origin: body.origin }
      : { ruleType: body.ruleType, name: body.name, pattern: body.pattern, enabled: body.enabled, origin: body.origin };

    const rule = yield* (yield* ApprovalGate).createApprovalRule(orgId!, input);

    // Rule CRUD is the mechanism behind every approval gate. Silent
    // rule changes let an admin disable the gate, run the action it
    // was protecting, and re-enable — end-to-end invisible. Metadata
    // captures `name` + `ruleType` on create; richer diff-style metadata
    // lives on `ruleUpdate` where it has a before/after story. See F-29.
    logAdminAction({
      actionType: ADMIN_ACTIONS.approval.ruleCreate,
      targetType: "approval",
      targetId: rule.id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      // #2072 — origin stamped in admin-action metadata so /admin/audit
      // shows the new dimension on rule-creation events.
      metadata: { name: body.name, ruleType: body.ruleType, origin: rule.origin },
    });

    return c.json({ rule }, 201);
  }), { label: "create approval rule", domainErrors: [approvalDomainError] });
});

// PUT /rules/:id — update approval rule
adminApproval.openapi(updateRuleRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");
    const ruleId = c.req.param("id");
    const body = c.req.valid("json");

    const rule = yield* (yield* ApprovalGate).updateApprovalRule(orgId!, ruleId, body);

    // See `ruleCreate` above for the threat model. `keysChanged` is the
    // semantic-diff signal — records WHICH fields the admin touched
    // without recording the values, since pattern/threshold may
    // themselves be sensitive shape data for a compromised admin
    // mapping the approval gate.
    logAdminAction({
      actionType: ADMIN_ACTIONS.approval.ruleUpdate,
      targetType: "approval",
      targetId: ruleId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      // #2072 — record the post-update origin alongside the keysChanged
      // diff so a compliance reviewer can see when a rule was rescoped
      // (e.g. mcp-only → any) without having to cross-reference the rule
      // table at the timestamp.
      metadata: { keysChanged: Object.keys(body), origin: rule.origin },
    });

    return c.json({ rule }, 200);
  }), { label: "update approval rule", domainErrors: [approvalDomainError] });
});

// DELETE /rules/:id — delete approval rule
adminApproval.openapi(deleteRuleRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");
    const ruleId = c.req.param("id");

    const deleted = yield* (yield* ApprovalGate).deleteApprovalRule(orgId!, ruleId);
    if (!deleted) {
      return c.json({ error: "not_found", message: "Approval rule not found." }, 404);
    }

    // Emitted only when the delete succeeded (404 short-circuits above).
    // Metadata holds the ruleId alone so compliance reviewers can
    // cross-reference the prior `ruleCreate` / `ruleUpdate` rows.
    logAdminAction({
      actionType: ADMIN_ACTIONS.approval.ruleDelete,
      targetType: "approval",
      targetId: ruleId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { ruleId },
    });

    return c.json({ message: "Approval rule deleted." }, 200);
  }), { label: "delete approval rule", domainErrors: [approvalDomainError] });
});

// GET /queue — list approval requests
adminApproval.openapi(listQueueRoute, async (c) => {
  const { status } = c.req.valid("query");
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");
    const requests = yield* (yield* ApprovalGate).listApprovalRequests(orgId!, status);
    return c.json({ requests }, 200);
  }), { label: "list approval requests", domainErrors: [approvalDomainError] });
});

// GET /queue/:id — get single approval request
adminApproval.openapi(getQueueItemRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");
    const itemId = c.req.param("id");

    const item = yield* (yield* ApprovalGate).getApprovalRequest(orgId!, itemId);
    if (!item) {
      return c.json({ error: "not_found", message: "Approval request not found." }, 404);
    }
    return c.json({ request: item }, 200);
  }), { label: "get approval request", domainErrors: [approvalDomainError] });
});

// POST /queue/:id — review (approve/deny) an approval request
adminApproval.openapi(reviewRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;
    yield* requireFeatureEntitlement(orgId, "approvals");

    const itemId = c.req.param("id");
    const body = c.req.valid("json");
    const reviewerId = user?.id;
    const reviewerEmail = user?.label ?? null;

    if (!reviewerId) {
      return c.json({ error: "bad_request", message: "Reviewer user ID unavailable." }, 400);
    }

    const result = yield* (yield* ApprovalGate).reviewApprovalRequest(
      orgId!,
      itemId,
      reviewerId,
      reviewerEmail,
      body.action,
      body.comment,
    );

    logAdminAction({
      actionType: body.action === "approve" ? ADMIN_ACTIONS.approval.approve : ADMIN_ACTIONS.approval.deny,
      targetType: "approval",
      targetId: itemId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      // #2072 — origin comes from the queued row (stamped at request
      // creation by lib/tools/sql.ts). NULL on the queue row means
      // either a legacy pre-2072 request or a route that didn't stamp
      // an origin; record those distinctly as "unknown_origin" rather
      // than a literal null so compliance reviewers can tell them
      // apart from a forensics query that explicitly wrote null.
      metadata: { requestId: itemId, origin: result.origin ?? "unknown_origin" },
    });

    // #3748 — if a turn parked on this request (durable-sessions approval-park),
    // resolve it: rewrite the parked transcript with the decision and re-arm the
    // run for resume. Fail-soft and decoupled from the review — the decision is
    // already recorded + audited on the queue above, so the review ALWAYS returns
    // 200. The resolver returns a three-way outcome we act on rather than discard:
    // `resumed`/`none` are benign, but `failed` means a parked turn could not be
    // re-armed (stale transcript or DB blip) and a recorded decision will never
    // resume unless an operator intervenes — so it is logged at error severity,
    // not swallowed. The `.catch` is a belt-and-suspenders guard so even an
    // UNEXPECTED throw can never turn a recorded decision into a 500. The gated
    // query is NOT executed here; execution happens on resume in the requester's
    // live security context (ADR-0020).
    const armOutcome = yield* Effect.promise(() =>
      resolveApprovalPark(itemId, body.action, {
        reviewerLabel: reviewerEmail,
        comment: body.comment ?? null,
      }).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), itemId, action: body.action },
          "approval-park resolution threw after review was recorded (resume not armed)",
        );
        return { status: "failed" as const, runId: "unknown" };
      }),
    );
    if (armOutcome.status === "failed") {
      log.error(
        { itemId, action: body.action, runId: armOutcome.runId },
        "approval-park: decision recorded but the parked turn was NOT re-armed — it will stay parked until the max-park sweep fails it; investigate",
      );
    }

    // #3750 — if the re-armed turn originated from a chat thread (Slack/
    // Telegram/…), resume it and post the continued answer back in-thread. The
    // resume-pending store carries the platform + thread coordinates written at
    // park time; the registered chat deliverer re-enters the agent loop (under
    // the original chat actor, re-resolving auth/scoping LIVE — ADR-0020) and
    // posts the answer. Fail-soft and fully decoupled from the review: the
    // decision is already recorded + audited, so any delivery problem is logged
    // (not 500'd) and the user can fall back to the admin console / a re-ask.
    // `none`/`no_deliverer` are benign (web turn, self-hosted w/o chat, or the
    // user already re-asked); only a genuine `failed` is surfaced.
    if (armOutcome.status === "resumed") {
      yield* Effect.promise(() =>
        deliverChatResumeIfPending(armOutcome.conversationId, body.action).catch((err) => {
          log.error(
            {
              err: err instanceof Error ? err.message : String(err),
              itemId,
              conversationId: armOutcome.conversationId,
            },
            "approval-park: chat resume delivery threw after review was recorded",
          );
        }),
      );
    }

    return c.json({ request: result }, 200);
  }), { label: "review approval request", domainErrors: [approvalDomainError] });
});

export { adminApproval };
