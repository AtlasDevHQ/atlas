/**
 * Public tables API route.
 *
 * Mounted at /api/v1/tables. Available to all authenticated users (not admin-gated).
 * Returns a simplified view of semantic layer entities with column details,
 * enabling SDK consumers to discover queryable tables.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import { getSemanticRoot, discoverTables } from "@atlas/api/lib/semantic-files";

const log = createLogger("tables-route");

export const tables = new Hono();

// GET / — list all tables with columns
tables.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  // Auth preamble (same pattern as semantic.ts)
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return c.json({ error: "auth_error", message: "Authentication system error" }, 500);
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return c.json(
      { error: "auth_error", message: authResult.error },
      { status: authResult.status as 401 | 403 | 500 },
    );
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    try {
      const tableList = discoverTables(root);
      return c.json({ tables: tableList });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to discover tables");
      return c.json({ error: "internal_error", message: "Failed to load table list." }, 500);
    }
  });
});
