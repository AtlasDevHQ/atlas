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

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  getSuggestionsByTables,
  getPopularSuggestions,
  incrementSuggestionClick,
} from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";
import { authPreamble } from "./auth-preamble";

const log = createLogger("suggestions");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SuggestionsResponseSchema = z.object({
  suggestions: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int(),
});

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSuggestionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Suggestions"],
  summary: "Get contextual suggestions",
  description:
    "Returns query suggestions for one or more tables, ordered by score. Requires at least one 'table' query parameter.",
  request: {
    query: z.object({
      // `table` is intentionally omitted — it's a repeatable array param (?table=a&table=b)
      // that Zod's string() can't validate. Parsed manually via c.req.queries("table").
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of suggestions to return (1-50, default 10).",
        example: "10",
      }),
    }),
  },
  responses: {
    200: {
      description: "List of suggestions",
      content: { "application/json": { schema: SuggestionsResponseSchema } },
    },
    400: {
      description: "Missing table parameter",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

const listPopularRoute = createRoute({
  method: "get",
  path: "/popular",
  tags: ["Suggestions"],
  summary: "Get popular suggestions",
  description:
    "Returns the top query suggestions across all tables, ordered by score.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({
        param: { name: "limit", in: "query" },
        description: "Maximum number of suggestions to return (1-50, default 10).",
        example: "10",
      }),
    }),
  },
  responses: {
    200: {
      description: "List of popular suggestions",
      content: { "application/json": { schema: SuggestionsResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

const trackClickRoute = createRoute({
  method: "post",
  path: "/{id}/click",
  tags: ["Suggestions"],
  summary: "Track suggestion click",
  description:
    "Tracks user engagement with a suggestion. Fire-and-forget — always returns 204 on success.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "suggestion-id" }),
    }),
  },
  responses: {
    204: {
      description: "Click tracked (fire-and-forget)",
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const suggestions = new OpenAPIHono();

// GET / — contextual suggestions by table
suggestions.openapi(listSuggestionsRoute, async (c) => {
  const requestId = crypto.randomUUID();
  const req = c.req.raw;

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ suggestions: [], total: 0 }, 200);
  }

  const tables = c.req.queries("table") ?? [];
  if (tables.length === 0) {
    return c.json({ error: "At least one 'table' query parameter is required" }, { status: 400 }) as never;
  }

  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "10", 10) || 10, 1), 50);
  const orgId = authResult.user?.activeOrganizationId ?? null;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const rows = await getSuggestionsByTables(orgId, tables, limit);
      return c.json({ suggestions: rows.map(toQuerySuggestion), total: rows.length }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to fetch suggestions");
      return c.json({ error: "internal_error", message: "Failed to fetch suggestions.", requestId }, 500);
    }
  });
});

// GET /popular — top suggestions across all tables
suggestions.openapi(listPopularRoute, async (c) => {
  const requestId = crypto.randomUUID();
  const req = c.req.raw;

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ suggestions: [], total: 0 }, 200);
  }

  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "10", 10) || 10, 1), 50);
  const orgId = authResult.user?.activeOrganizationId ?? null;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const rows = await getPopularSuggestions(orgId, limit);
      return c.json({ suggestions: rows.map(toQuerySuggestion), total: rows.length }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to fetch popular suggestions");
      return c.json({ error: "internal_error", message: "Failed to fetch suggestions.", requestId }, 500);
    }
  });
});

// POST /:id/click — track engagement
suggestions.openapi(trackClickRoute, async (c) => {
  const requestId = crypto.randomUUID();
  const req = c.req.raw;

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }

  const orgId = preamble.authResult.user?.activeOrganizationId ?? null;
  const { id } = c.req.valid("param");

  // Fire-and-forget: always return 204
  try {
    incrementSuggestionClick(id, orgId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), requestId },
      "Click tracking failed",
    );
  }

  return c.body(null, 204) as never;
});
