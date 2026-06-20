/**
 * Admin durable session-memory routes (#3758, ADR-0020).
 *
 * Mounted under /api/v1/admin/session-memory. Org-scoped (an admin only sees +
 * resets their own workspace's sessions). Durable working memory is a CORE
 * feature (not enterprise-gated): these routes need only the admin role +
 * `requireOrgContext` — no EE license. Backed by the plain (non-Effect) helpers
 * in `lib/durable-state.ts` via `runHandler`, since the work is straight
 * tenant-scoped SQL, not an Effect service.
 *
 * Provides:
 * - GET    /                     — list this org's sessions that have memory
 * - DELETE /{conversationId}     — clear a session's slots (all, or `?namespace=`)
 *
 * Tenant scoping is enforced in the helper SQL by JOINing to `conversations`
 * with a strict `org_id` match, so a forged conversationId from another org
 * clears nothing (returns `{ cleared: 0 }`). With no internal DB,
 * `requireOrgContext` returns the standard 404 envelope before the handler runs.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { SessionMemoryViewSchema } from "@useatlas/schemas";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { listSessionMemory, resetSessionMemory } from "@atlas/api/lib/durable-state";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Session Memory"],
  summary: "List sessions with durable memory",
  description:
    "Returns the sessions (conversations) in the current organization that have accumulated durable working-memory slots, each with its slots. Tenant-scoped.",
  responses: {
    200: {
      description: "Sessions with memory",
      content: { "application/json": { schema: z.object({ sessions: z.array(SessionMemoryViewSchema) }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const ResetQuerySchema = z.object({
  namespace: z
    .string()
    .min(1)
    .optional()
    .openapi({
      description: "When set, clear only this one slot; otherwise clear every slot in the session.",
      example: "analyst.lastTable",
      param: { name: "namespace", in: "query" },
    }),
});

const resetRoute = createRoute({
  method: "delete",
  path: "/{conversationId}",
  tags: ["Admin — Session Memory"],
  summary: "Reset a session's durable memory",
  description:
    "Clears a session's durable working-memory slots (all, or a single slot via the `namespace` query param). Idempotent and tenant-scoped — a conversation outside the caller's organization clears nothing. The next turn threads no stale value.",
  request: {
    params: z.object({
      conversationId: z.string().openapi({
        param: { name: "conversationId", in: "path" },
        example: "8c4f2b1e-1d2a-4e3b-9c0d-1a2b3c4d5e6f",
      }),
    }),
    query: ResetQuerySchema,
  },
  responses: {
    200: {
      description: "Slots cleared (count)",
      content: { "application/json": { schema: z.object({ cleared: z.number().int().nonnegative() }) } },
    },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Invalid query parameters", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminSessionMemory = createAdminRouter();
adminSessionMemory.use(requireOrgContext());

// GET / — list the org's sessions with memory
adminSessionMemory.openapi(listRoute, async (c) => {
  const { orgId } = c.get("orgContext");
  return runHandler(c, "list session memory", async () => {
    const sessions = await listSessionMemory(orgId);
    return c.json({ sessions }, 200);
  });
});

// DELETE /{conversationId} — reset a session's memory (all, or one namespace)
adminSessionMemory.openapi(resetRoute, async (c) => {
  const { orgId } = c.get("orgContext");
  const conversationId = c.req.param("conversationId");
  const { namespace } = c.req.valid("query");
  return runHandler(c, "reset session memory", async () => {
    // Admin scope: org-only (no userId) → strict org match in the helper, so a
    // forged conversationId from another org clears nothing.
    const cleared = await resetSessionMemory({
      conversationId,
      orgId,
      namespace,
    });

    // A reset is a destructive admin action on another user's accumulated
    // agent state — record it (count + scope) so a compliance reviewer can
    // see who cleared which session's memory. `namespace` distinguishes a
    // single-slot clear from a full wipe.
    logAdminAction({
      actionType: ADMIN_ACTIONS.conversation.memoryReset,
      targetType: "conversation",
      targetId: conversationId,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { cleared, namespace: namespace ?? null },
    });

    return c.json({ cleared }, 200);
  });
});

export { adminSessionMemory };
