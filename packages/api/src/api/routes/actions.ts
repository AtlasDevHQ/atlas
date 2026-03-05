/**
 * Action approval REST routes — list, get, approve, deny.
 *
 * Middleware stack follows the same auth → rate limit → withRequestContext
 * pattern as conversations.ts.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  getAction,
  approveAction,
  denyAction,
  listPendingActions,
  getActionExecutor,
  getActionConfig,
} from "@atlas/api/lib/tools/actions/handler";
import { ACTION_STATUSES, type ActionStatus } from "@atlas/api/lib/action-types";
import { canApprove } from "@atlas/api/lib/auth/permissions";

const log = createLogger("actions");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const actions = new Hono();

// ---------------------------------------------------------------------------
// Shared auth + rate-limit preamble
// ---------------------------------------------------------------------------

async function authPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error" }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return { error: { error: "auth_error", message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}

// ---------------------------------------------------------------------------
// GET / — list actions (default: pending)
// ---------------------------------------------------------------------------

actions.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const rawStatus = c.req.query("status") ?? "pending";
      const status: ActionStatus | undefined = (ACTION_STATUSES as readonly string[]).includes(rawStatus)
        ? (rawStatus as ActionStatus)
        : undefined;
      const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;

      const result = await listPendingActions({
        status,
        userId: authResult.user?.id,
        limit,
      });
      return c.json({ actions: result });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId, op: "listActions" }, "Failed to list actions");
      return c.json({ error: "internal_error", message: "Failed to list actions." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get single action
// ---------------------------------------------------------------------------

actions.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const action = await getAction(id);
      if (!action || action.requested_by !== authResult.user?.id) {
        return c.json({ error: "not_found", message: "Action not found." }, 404);
      }
      return c.json(action);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId, op: "getAction" }, "Failed to get action");
      return c.json({ error: "internal_error", message: "Failed to retrieve action." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:id/approve — approve a pending action
// ---------------------------------------------------------------------------

actions.post("/:id/approve", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const approverId = authResult.user?.id ?? "anonymous";

      // Look up action and executor
      const action = await getAction(id);
      if (!action) {
        return c.json({ error: "not_found", message: "Action not found." }, 404);
      }

      const cfg = getActionConfig(action.action_type);

      if (!canApprove(authResult.user, cfg.approval, cfg.requiredRole)) {
        return c.json({ error: "forbidden", message: "Insufficient role to approve this action." }, 403);
      }

      // Enforce admin-only separation of duties: requester cannot approve their own admin-only action
      if (cfg.approval === "admin-only" && authResult.user?.id === action.requested_by) {
        return c.json({ error: "forbidden", message: "admin-only actions cannot be approved by the requester" }, 403);
      }

      const executor = getActionExecutor(id);

      const result = await approveAction(id, approverId, executor);
      if (!result) {
        return c.json({ error: "conflict", message: "Action has already been resolved." }, 409);
      }
      return c.json(result);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId, op: "approveAction" }, "Failed to approve action");
      return c.json({ error: "internal_error", message: "Failed to approve action." }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:id/deny — deny a pending action
// ---------------------------------------------------------------------------

actions.post("/:id/deny", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Action tracking is not available (no internal database configured)." }, 404);
  }

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  const id = c.req.param("id");
  if (!UUID_RE.test(id)) {
    return c.json({ error: "invalid_request", message: "Invalid action ID format." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const denierId = authResult.user?.id ?? "anonymous";

      // Look up action for permission enforcement
      const action = await getAction(id);
      if (!action) {
        return c.json({ error: "not_found", message: "Action not found." }, 404);
      }

      const cfg = getActionConfig(action.action_type);

      // Deny requires the same minimum role as approve — consistent permission model for all action operations.
      if (!canApprove(authResult.user, cfg.approval, cfg.requiredRole)) {
        return c.json({ error: "forbidden", message: "Insufficient role to deny this action." }, 403);
      }

      // Enforce admin-only separation of duties: requester cannot deny their own admin-only action
      if (cfg.approval === "admin-only" && authResult.user?.id === action.requested_by) {
        return c.json({ error: "forbidden", message: "admin-only actions cannot be denied by the requester" }, 403);
      }

      let reason: string | undefined;
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          const body = await c.req.json();
          if (body && typeof body.reason === "string") {
            reason = body.reason;
          }
        } catch {
          return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
        }
      }

      const result = await denyAction(id, denierId, reason);
      if (!result) {
        return c.json({ error: "conflict", message: "Action has already been resolved." }, 409);
      }
      return c.json(result);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId, op: "denyAction" }, "Failed to deny action");
      return c.json({ error: "internal_error", message: "Failed to deny action." }, 500);
    }
  });
});

export { actions };
