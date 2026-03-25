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

import { createRoute, z } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import {
  listApprovalRules,
  createApprovalRule,
  updateApprovalRule,
  deleteApprovalRule,
  listApprovalRequests,
  getApprovalRequest,
  reviewApprovalRequest,
  expireStaleRequests,
  getPendingCount,
  ApprovalError,
} from "@atlas/ee/governance/approval";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const APPROVAL_ERROR_STATUS = { validation: 400, not_found: 404, conflict: 409, expired: 410 } as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ApprovalRuleSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  ruleType: z.enum(["table", "column", "cost"]),
  pattern: z.string(),
  threshold: z.number().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateRuleBodySchema = z.object({
  name: z.string().min(1).openapi({
    description: "Human-readable rule name.",
    example: "Require approval for PII tables",
  }),
  ruleType: z.enum(["table", "column", "cost"]).openapi({
    description: "Type of rule: table name match, column name match, or cost threshold.",
    example: "table",
  }),
  pattern: z.string().openapi({
    description: "Pattern to match. Table/column name for table/column rules. Unused for cost rules.",
    example: "users",
  }),
  threshold: z.number().nullable().optional().openapi({
    description: "Cost threshold. Required for cost rules, ignored for table/column rules.",
    example: null,
  }),
  enabled: z.boolean().optional().openapi({
    description: "Whether the rule is active. Defaults to true.",
    example: true,
  }),
});

const UpdateRuleBodySchema = z.object({
  name: z.string().min(1).optional(),
  pattern: z.string().optional(),
  threshold: z.number().nullable().optional(),
  enabled: z.boolean().optional(),
});

const ApprovalRequestSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  requesterId: z.string(),
  requesterEmail: z.string().nullable(),
  querySql: z.string(),
  explanation: z.string().nullable(),
  connectionId: z.string(),
  tablesAccessed: z.array(z.string()),
  columnsAccessed: z.array(z.string()),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  reviewerId: z.string().nullable(),
  reviewerEmail: z.string().nullable(),
  reviewComment: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
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
  path: "/rules/:id",
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
  path: "/rules/:id",
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

const listQueueRoute = createRoute({
  method: "get",
  path: "/queue",
  tags: ["Admin — Approval Workflows"],
  summary: "List approval requests",
  description: "Returns approval requests for the organization. Filterable by status via query parameter.",
  responses: {
    200: {
      description: "Approval requests list",
      content: { "application/json": { schema: z.object({ requests: z.array(ApprovalRequestSchema) }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getQueueItemRoute = createRoute({
  method: "get",
  path: "/queue/:id",
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
  path: "/queue/:id",
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

// POST /expire — manually expire stale requests (global, no org/DB needed)
adminApproval.openapi(expireRoute, async (c) => runHandler(c, "expire stale requests", async () => {
  const expired = await expireStaleRequests();
  return c.json({ expired }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// GET /pending-count — count of pending requests (needs orgId, not hasInternalDB)
adminApproval.openapi(pendingCountRoute, async (c) => runHandler(c, "get pending approval count", async () => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first.", requestId }, 400);
  }

  const count = await getPendingCount(orgId);
  return c.json({ count }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// ── Handlers WITH requireOrgContext ───────────────────────────────────
adminApproval.use(requireOrgContext());

// GET /rules — list approval rules
adminApproval.openapi(listRulesRoute, async (c) => runHandler(c, "list approval rules", async () => {
  const { orgId } = c.get("orgContext");

  const rules = await listApprovalRules(orgId);
  return c.json({ rules }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// POST /rules — create approval rule
adminApproval.openapi(createRuleRoute, async (c) => runHandler(c, "create approval rule", async () => {
  const { orgId } = c.get("orgContext");
  const body = c.req.valid("json");

  const rule = await createApprovalRule(orgId, {
    name: body.name,
    ruleType: body.ruleType,
    pattern: body.pattern,
    threshold: body.threshold ?? null,
    enabled: body.enabled,
  });
  return c.json({ rule }, 201);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// PUT /rules/:id — update approval rule
adminApproval.openapi(updateRuleRoute, async (c) => runHandler(c, "update approval rule", async () => {
  const { orgId } = c.get("orgContext");
  const ruleId = c.req.param("id");
  const body = c.req.valid("json");

  const rule = await updateApprovalRule(orgId, ruleId, body);
  return c.json({ rule }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// DELETE /rules/:id — delete approval rule
adminApproval.openapi(deleteRuleRoute, async (c) => runHandler(c, "delete approval rule", async () => {
  const { orgId } = c.get("orgContext");
  const ruleId = c.req.param("id");

  const deleted = await deleteApprovalRule(orgId, ruleId);
  if (!deleted) {
    return c.json({ error: "not_found", message: "Approval rule not found." }, 404);
  }
  return c.json({ message: "Approval rule deleted." }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// GET /queue — list approval requests
adminApproval.openapi(listQueueRoute, async (c) => runHandler(c, "list approval requests", async () => {
  const { orgId } = c.get("orgContext");

  const statusParam = new URL(c.req.raw.url).searchParams.get("status") as import("@useatlas/types").ApprovalStatus | null;
  const validStatuses = ["pending", "approved", "denied", "expired"];
  const status = statusParam && validStatuses.includes(statusParam) ? statusParam as import("@useatlas/types").ApprovalStatus : undefined;
  const requests = await listApprovalRequests(orgId, status);
  return c.json({ requests }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// GET /queue/:id — get single approval request
adminApproval.openapi(getQueueItemRoute, async (c) => runHandler(c, "get approval request", async () => {
  const { orgId } = c.get("orgContext");
  const itemId = c.req.param("id");

  const item = await getApprovalRequest(orgId, itemId);
  if (!item) {
    return c.json({ error: "not_found", message: "Approval request not found." }, 404);
  }
  return c.json({ request: item }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

// POST /queue/:id — review (approve/deny) an approval request
adminApproval.openapi(reviewRoute, async (c) => runHandler(c, "review approval request", async () => {
  const { orgId } = c.get("orgContext");
  const authResult = c.get("authResult");

  const itemId = c.req.param("id");
  const body = c.req.valid("json");
  const reviewerId = authResult.user?.id;
  const reviewerEmail = authResult.user?.label ?? null;

  if (!reviewerId) {
    return c.json({ error: "bad_request", message: "Reviewer user ID unavailable." }, 400);
  }

  const result = await reviewApprovalRequest(
    orgId,
    itemId,
    reviewerId,
    reviewerEmail,
    body.action,
    body.comment,
  );
  return c.json({ request: result }, 200);
}, { domainErrors: [[ApprovalError, APPROVAL_ERROR_STATUS]] }));

export { adminApproval };
