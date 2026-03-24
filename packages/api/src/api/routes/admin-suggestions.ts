/**
 * Admin query-suggestions CRUD routes.
 *
 * Mounted under /api/v1/admin/suggestions. All routes require admin role.
 * Provides list and delete for query suggestions (auto-generated from query frequency).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, deleteSuggestion } from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";
import type { QuerySuggestionRow } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("admin-suggestions");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SuggestionSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  description: z.string(),
  patternSql: z.string(),
  normalizedHash: z.string(),
  tablesInvolved: z.array(z.string()),
  primaryTable: z.string().nullable(),
  frequency: z.number(),
  clickedCount: z.number(),
  score: z.number(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ListSuggestionsResponseSchema = z.object({
  suggestions: z.array(SuggestionSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});


// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSuggestionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Suggestions"],
  summary: "List query suggestions",
  description:
    "Returns a paginated list of query suggestions for the admin's active organization. Supports filtering by table name and minimum frequency.",
  request: {
    query: z.object({
      table: z.string().optional().openapi({ description: "Filter by primary table name" }),
      min_frequency: z.string().optional().openapi({ description: "Minimum frequency threshold" }),
      limit: z.string().optional().openapi({ description: "Maximum results (default 50, max 200)" }),
      offset: z.string().optional().openapi({ description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of suggestions",
      content: { "application/json": { schema: ListSuggestionsResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteSuggestionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Suggestions"],
  summary: "Delete a query suggestion",
  description: "Permanently removes a query suggestion by ID.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "abc123" }),
    }),
  },
  responses: {
    204: {
      description: "Suggestion deleted",
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Suggestion not found or internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
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

export const adminSuggestions = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

adminSuggestions.use(adminAuth);
adminSuggestions.use(requestContext);

// GET / — list suggestions with filters
adminSuggestions.openapi(listSuggestionsRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Internal database not configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId ?? null;

  try {
    const table = c.req.query("table");
    const minFreq = parseInt(c.req.query("min_frequency") ?? "0", 10) || 0;
    const { limit, offset } = parsePagination(c);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (orgId != null) {
      conditions.push(`org_id = $${idx++}`);
      params.push(orgId);
    } else {
      conditions.push("org_id IS NULL");
    }

    if (table) {
      conditions.push(`primary_table = $${idx++}`);
      params.push(table);
    }

    if (minFreq > 0) {
      conditions.push(`frequency >= $${idx++}`);
      params.push(minFreq);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const filterParams = [...params];
    params.push(limit, offset);
    const limitIdx = idx;
    const offsetIdx = idx + 1;
    const rows = await internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions ${where} ORDER BY score DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countRows = await internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM query_suggestions ${where}`,
      filterParams
    );

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    return c.json({
      suggestions: rows.map(toQuerySuggestion),
      total,
      limit,
      offset,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list suggestions");
    return c.json({ error: "internal_error", message: "Failed to list suggestions.", requestId }, 500);
  }
});

// DELETE /:id — prune a suggestion
adminSuggestions.openapi(deleteSuggestionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Internal database not configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId ?? null;
  const { id } = c.req.valid("param");

  try {
    const deleted = await deleteSuggestion(id, orgId);
    if (!deleted) {
      return c.json({ error: "not_found", message: "Suggestion not found." }, 404);
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete suggestion");
    return c.json({ error: "internal_error", message: "Failed to delete suggestion.", requestId }, 500);
  }
});
