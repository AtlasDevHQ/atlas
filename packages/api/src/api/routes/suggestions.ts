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
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { validationHook } from "./validation-hook";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import {
  hasInternalDB,
  getSuggestionsByTables,
  getPopularSuggestions,
  incrementSuggestionClick,
} from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";
import { ErrorSchema, parsePagination } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("suggestions");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SuggestionsResponseSchema = z.object({
  suggestions: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int(),
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

export const suggestions = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

suggestions.use(standardAuth);
suggestions.use(requestContext);

// GET / — contextual suggestions by table
suggestions.openapi(listSuggestionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ suggestions: [], total: 0 }, 200);
    }

    const tables = c.req.queries("table") ?? [];
    if (tables.length === 0) {
      return c.json({ error: "At least one 'table' query parameter is required" }, { status: 400 });
    }

    const { limit } = parsePagination(c, { limit: 10, maxLimit: 50 });
    const resolvedOrgId = orgId ?? null;

    const rows = yield* Effect.promise(() => getSuggestionsByTables(resolvedOrgId, tables, limit));
    return c.json({ suggestions: rows.map(toQuerySuggestion), total: rows.length }, 200);
  }), { label: "fetch suggestions" });
});

// GET /popular — top suggestions across all tables
suggestions.openapi(listPopularRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    if (!hasInternalDB()) {
      return c.json({ suggestions: [], total: 0 }, 200);
    }

    const { limit } = parsePagination(c, { limit: 10, maxLimit: 50 });
    const resolvedOrgId = orgId ?? null;

    const rows = yield* Effect.promise(() => getPopularSuggestions(resolvedOrgId, limit));
    return c.json({ suggestions: rows.map(toQuerySuggestion), total: rows.length }, 200);
  }), { label: "fetch suggestions" });
});

// POST /:id/click — track engagement
suggestions.openapi(trackClickRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;

    const resolvedOrgId = orgId ?? null;
    const resolvedUserId = user?.id ?? null;
    const { id } = c.req.valid("param");

    // Fire-and-forget: always return 204
    try {
      incrementSuggestionClick(id, resolvedOrgId, resolvedUserId);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), requestId },
        "Click tracking failed",
      );
    }

    return c.body(null, 204);
  }), { label: "track suggestion click" });
});
