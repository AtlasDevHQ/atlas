/**
 * Admin query-suggestions CRUD routes.
 *
 * Mounted under /api/v1/admin/suggestions. All routes require admin role.
 * Provides list and delete for query suggestions (auto-generated from query frequency).
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery, deleteSuggestion } from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";
import type { QuerySuggestionRow } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema, parsePagination, createIdParamSchema, createListResponseSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

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

const ListSuggestionsResponseSchema = createListResponseSchema("suggestions", SuggestionSchema, {
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
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteSuggestionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Suggestions"],
  summary: "Delete a query suggestion",
  description: "Permanently removes a query suggestion by ID.",
  request: {
    params: createIdParamSchema(),
  },
  responses: {
    204: { description: "Suggestion deleted" },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Suggestion not found or internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminSuggestions = createAdminRouter();

adminSuggestions.use(requireOrgContext());

// GET / — list suggestions with filters
adminSuggestions.openapi(listSuggestionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const orgIdVal = orgId ?? null;

    const table = c.req.query("table");
    const minFreq = parseInt(c.req.query("min_frequency") ?? "0", 10) || 0;
    const { limit, offset } = parsePagination(c);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (orgIdVal != null) {
      conditions.push(`org_id = $${idx++}`);
      params.push(orgIdVal);
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
    const rows = yield* Effect.promise(() => internalQuery<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions ${where} ORDER BY score DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ));

    const countRows = yield* Effect.promise(() => internalQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM query_suggestions ${where}`,
      filterParams
    ));

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    return c.json({
      suggestions: rows.map(toQuerySuggestion),
      total,
      limit,
      offset,
    }, 200);
  }), { label: "list suggestions" });
});

// DELETE /:id — prune a suggestion
adminSuggestions.openapi(deleteSuggestionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const orgIdVal = orgId ?? null;
    const { id } = c.req.valid("param");

    const deleted = yield* Effect.promise(() => deleteSuggestion(id, orgIdVal));
    if (!deleted) {
      return c.json({ error: "not_found", message: "Suggestion not found." }, 404);
    }
    return new Response(null, { status: 204 });
  }), { label: "delete suggestion" });
});
