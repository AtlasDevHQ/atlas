/**
 * User-facing query suggestion routes.
 *
 * GET  /api/v1/suggestions?table=<name>[&table=<name>][&limit=N]
 *   — contextual suggestions for one or more tables, ordered by score DESC.
 *
 * GET  /api/v1/suggestions/popular[?limit=N]
 *   — top suggestions across all tables, ordered by score DESC.
 *
 * POST /api/v1/suggestions/:id/click
 *   — track engagement (fire-and-forget, always returns 204).
 */

import { Hono } from "hono";
import { authenticateRequest, checkRateLimit, getClientIP } from "@atlas/api/lib/auth/middleware";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  getSuggestionsByTables,
  getPopularSuggestions,
  incrementSuggestionClick,
} from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";

const log = createLogger("suggestions");

export const suggestions = new Hono();

// GET / — contextual suggestions by table
suggestions.get("/", async (c) => {
  const requestId = crypto.randomUUID();
  const req = c.req.raw;

  let authResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return c.json(
      { error: "auth_error", message: "Authentication system error", requestId },
      500,
    );
  }
  if (!authResult.authenticated) {
    return c.json(
      { error: "auth_error", message: authResult.error, requestId },
      authResult.status as 401 | 403 | 500,
    );
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      { error: "rate_limited", message: "Too many requests.", retryAfterSeconds, requestId },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  if (!hasInternalDB()) {
    return c.json({ suggestions: [], total: 0 });
  }

  const tables = c.req.queries("table") ?? [];
  if (tables.length === 0) {
    return c.json({ error: "At least one 'table' query parameter is required" }, { status: 400 });
  }

  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "10", 10) || 10, 1), 50);
  const orgId = authResult.user?.activeOrganizationId ?? null;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rows = await getSuggestionsByTables(orgId, tables, limit);
    return c.json({ suggestions: rows.map(toQuerySuggestion), total: rows.length });
  });
});

// GET /popular — top suggestions across all tables
suggestions.get("/popular", async (c) => {
  const requestId = crypto.randomUUID();
  const req = c.req.raw;

  let authResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return c.json(
      { error: "auth_error", message: "Authentication system error", requestId },
      500,
    );
  }
  if (!authResult.authenticated) {
    return c.json(
      { error: "auth_error", message: authResult.error, requestId },
      authResult.status as 401 | 403 | 500,
    );
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      { error: "rate_limited", message: "Too many requests.", retryAfterSeconds, requestId },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  if (!hasInternalDB()) {
    return c.json({ suggestions: [], total: 0 });
  }

  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "10", 10) || 10, 1), 50);
  const orgId = authResult.user?.activeOrganizationId ?? null;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const rows = await getPopularSuggestions(orgId, limit);
    return c.json({ suggestions: rows.map(toQuerySuggestion), total: rows.length });
  });
});

// POST /:id/click — track engagement
suggestions.post("/:id/click", async (c) => {
  const requestId = crypto.randomUUID();
  const req = c.req.raw;

  let authResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return c.json(
      { error: "auth_error", message: "Authentication system error", requestId },
      500,
    );
  }
  if (!authResult.authenticated) {
    return c.json(
      { error: "auth_error", message: authResult.error, requestId },
      authResult.status as 401 | 403 | 500,
    );
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return c.json(
      { error: "rate_limited", message: "Too many requests.", retryAfterSeconds, requestId },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  const orgId = authResult.user?.activeOrganizationId ?? null;
  const { id } = c.req.param();

  // Fire-and-forget: always return 204
  try {
    incrementSuggestionClick(id, orgId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), requestId },
      "Click tracking failed",
    );
  }

  return new Response(null, { status: 204 });
});
