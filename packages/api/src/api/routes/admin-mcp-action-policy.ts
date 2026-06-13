/**
 * Customer-admin MCP action policy routes (#3509, ADR-0016 gate 1).
 *
 * Mounted under /api/v1/admin/mcp/action-policy. The per-workspace kill-switch
 * over MCP action *categories* — a customer admin can disable whole categories
 * (e.g. "no datasource creation via MCP at all"); gate 1 of the dispatch order
 * short-circuits a blocked category before scope / RBAC / approval.
 *
 * This is a Customer activation concern, NOT operator/env (ADR-0016 SaaS-first
 * principle), so it lives behind the workspace-admin perimeter (`admin:settings`)
 * and is available in both deploy modes — core, not EE.
 *
 *   GET / — list every category with its current status (drives the dashboard)
 *   PUT / — set one category's status (allowed | blocked)
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  getMcpActionPolicyEntries,
  setMcpActionCategoryStatus,
  isMcpActionCategory,
  MCP_ACTION_CATEGORIES,
} from "@atlas/api/lib/mcp/action-policy";
import { logAdminActionAwait, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-mcp-action-policy");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PolicyEntrySchema = z.object({
  category: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.enum(["allowed", "blocked"]),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const PolicyResponseSchema = z.object({
  entries: z.array(PolicyEntrySchema),
});

const UpdateBodySchema = z.object({
  category: z
    .enum([...MCP_ACTION_CATEGORIES] as [string, ...string[]])
    .openapi({ example: "datasource", description: "MCP action category to toggle" }),
  status: z
    .enum(["allowed", "blocked"])
    .openapi({ example: "blocked", description: "New status for the category" }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getPolicyRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — MCP Action Policy"],
  summary: "List MCP action policy categories",
  description:
    "Returns every MCP action category with its current per-workspace status. Default posture is 'allowed'; a category is 'blocked' once a workspace admin disables it.",
  responses: {
    200: {
      description: "Per-category MCP action policy",
      content: { "application/json": { schema: PolicyResponseSchema } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updatePolicyRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — MCP Action Policy"],
  summary: "Set an MCP action category status",
  description:
    "Sets one MCP action category to 'allowed' or 'blocked' for the workspace. A blocked category short-circuits matching MCP tool dispatches before scope / RBAC / approval. MCP can only ever tighten governance — this control never lowers the non-configurable origin ceiling.",
  request: {
    body: { required: true, content: { "application/json": { schema: UpdateBodySchema } } },
  },
  responses: {
    200: {
      description: "Updated per-category MCP action policy",
      content: { "application/json": { schema: PolicyResponseSchema } },
    },
    400: { description: "Invalid category/status or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminMcpActionPolicy = createAdminRouter();

adminMcpActionPolicy.use(requireOrgContext());
// The action policy is a workspace security configuration surface — gate it on
// the same flag as the rest of the settings surface.
adminMcpActionPolicy.use(requirePermission("admin:settings"));

adminMcpActionPolicy.openapi(getPolicyRoute, async (c) => {
  const { orgId, requestId } = c.get("orgContext");
  try {
    const entries = await getMcpActionPolicyEntries(orgId);
    return c.json({ entries }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, requestId },
      "Failed to read MCP action policy",
    );
    return c.json(
      { error: "internal_error", message: "Failed to read MCP action policy.", requestId },
      500,
    );
  }
});

adminMcpActionPolicy.openapi(updatePolicyRoute, async (c) => {
  const { orgId, requestId } = c.get("orgContext");
  const user = c.get("authResult").user;
  const body = c.req.valid("json");

  // Zod's enum already constrained `category`; the guard narrows the string to
  // the `McpActionCategory` union for the typed store call (and is a belt-and-
  // braces check against a schema/registry drift).
  if (!isMcpActionCategory(body.category)) {
    return c.json(
      { error: "bad_request", message: `Unknown MCP action category: "${body.category}".`, requestId },
      400,
    );
  }
  const category = body.category;
  const status = body.status;

  try {
    // Snapshot the prior status for the audit delta (the threat is silently
    // re-enabling a category a prior admin disabled).
    const before = await getMcpActionPolicyEntries(orgId);
    const previousStatus = before.find((e) => e.category === category)?.status ?? "allowed";

    await setMcpActionCategoryStatus(orgId, category, status, user?.id ?? null);

    await logAdminActionAwait({
      actionType: ADMIN_ACTIONS.mcpActionPolicy.update,
      targetType: "mcpActionPolicy",
      targetId: orgId,
      metadata: { category, status, previousStatus },
    });

    const entries = await getMcpActionPolicyEntries(orgId);
    return c.json({ entries }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), orgId, requestId, category, status },
      "Failed to update MCP action policy",
    );
    return c.json(
      { error: "internal_error", message: "Failed to update MCP action policy.", requestId },
      500,
    );
  }
});

export { adminMcpActionPolicy };
