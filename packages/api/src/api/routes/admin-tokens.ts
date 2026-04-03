/**
 * Admin token usage routes.
 *
 * Mounted under /api/v1/admin/tokens via admin.route().
 * Org-scoped: all queries filter on token_usage.org_id matching the caller's
 * active organization.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema, parsePagination } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse and validate ISO date strings for token usage queries. */
function parseDateRange(
  from?: string,
  to?: string,
): { fromDate: string; toDate: string } | { error: string } {
  if (from && isNaN(Date.parse(from))) {
    return { error: `Invalid 'from' date format: "${from}". Use ISO 8601 (e.g. 2026-01-01).` };
  }
  if (to && isNaN(Date.parse(to))) {
    return { error: `Invalid 'to' date format: "${to}". Use ISO 8601 (e.g. 2026-01-01).` };
  }
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = from || defaultFrom.toISOString();
  const toDate = to || now.toISOString();
  return { fromDate, toDate };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getTokenSummaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Admin — Tokens"],
  summary: "Token usage summary",
  description:
    "Returns total token consumption with prompt/completion breakdown over a date range. Scoped to active organization.",
  responses: {
    200: {
      description: "Token summary",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTokensByUserRoute = createRoute({
  method: "get",
  path: "/by-user",
  tags: ["Admin — Tokens"],
  summary: "Token usage by user",
  description:
    "Returns top N users by token consumption over a date range. Scoped to active organization.",
  responses: {
    200: {
      description: "Token usage by user",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getTokenTrendsRoute = createRoute({
  method: "get",
  path: "/trends",
  tags: ["Admin — Tokens"],
  summary: "Token usage trends",
  description:
    "Returns time-series token usage data for charting. Scoped to active organization.",
  responses: {
    200: {
      description: "Token trends",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: "Invalid date format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminTokens = createAdminRouter();
adminTokens.use(requireOrgContext());

// GET /summary — token usage summary scoped to active org
adminTokens.openapi(getTokenSummaryRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const requestId = c.get("requestId") as string;

    const range = parseDateRange(c.req.query("from"), c.req.query("to"));
    if ("error" in range) {
      return c.json({ error: "invalid_request", message: range.error, requestId }, 400);
    }
    const { fromDate, toDate } = range;

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<{
        total_prompt: string;
        total_completion: string;
        total_requests: string;
      }>(
        `SELECT
           COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
           COALESCE(SUM(completion_tokens), 0) AS total_completion,
           COUNT(*) AS total_requests
         FROM token_usage
         WHERE created_at >= $1 AND created_at <= $2 AND org_id = $3`,
        [fromDate, toDate, orgId!],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const row = rows[0];
    return c.json({
      totalPromptTokens: parseInt(row?.total_prompt ?? "0", 10),
      totalCompletionTokens: parseInt(row?.total_completion ?? "0", 10),
      totalTokens: parseInt(row?.total_prompt ?? "0", 10) + parseInt(row?.total_completion ?? "0", 10),
      totalRequests: parseInt(row?.total_requests ?? "0", 10),
      from: fromDate,
      to: toDate,
    }, 200);
  }), { label: "fetch token usage summary" });
});

// GET /by-user — token usage by user scoped to active org
adminTokens.openapi(getTokensByUserRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const requestId = c.get("requestId") as string;

    const range = parseDateRange(c.req.query("from"), c.req.query("to"));
    if ("error" in range) {
      return c.json({ error: "invalid_request", message: range.error, requestId }, 400);
    }
    const { fromDate, toDate } = range;
    const { limit } = parsePagination(c, { limit: 20, maxLimit: 100 });

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<{
        user_id: string;
        user_email: string | null;
        total_prompt: string;
        total_completion: string;
        total_tokens: string;
        request_count: string;
      }>(
        `SELECT
           COALESCE(t.user_id, 'anonymous') AS user_id,
           u.email AS user_email,
           SUM(t.prompt_tokens) AS total_prompt,
           SUM(t.completion_tokens) AS total_completion,
           SUM(t.prompt_tokens + t.completion_tokens) AS total_tokens,
           COUNT(*) AS request_count
         FROM token_usage t
         LEFT JOIN "user" u ON t.user_id = u.id
         WHERE t.created_at >= $1 AND t.created_at <= $2 AND t.org_id = $3
         GROUP BY t.user_id, u.email
         ORDER BY total_tokens DESC
         LIMIT $4`,
        [fromDate, toDate, orgId!, limit],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    return c.json({
      users: rows.map((r) => ({
        userId: r.user_id,
        userEmail: r.user_email,
        promptTokens: parseInt(r.total_prompt, 10),
        completionTokens: parseInt(r.total_completion, 10),
        totalTokens: parseInt(r.total_tokens, 10),
        requestCount: parseInt(r.request_count, 10),
      })),
      from: fromDate,
      to: toDate,
    }, 200);
  }), { label: "fetch token usage by user" });
});

// GET /trends — token usage trends scoped to active org
adminTokens.openapi(getTokenTrendsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const requestId = c.get("requestId") as string;

    const range = parseDateRange(c.req.query("from"), c.req.query("to"));
    if ("error" in range) {
      return c.json({ error: "invalid_request", message: range.error, requestId }, 400);
    }
    const { fromDate, toDate } = range;

    const rows = yield* Effect.tryPromise({
      try: () => internalQuery<{
        day: string;
        prompt_tokens: string;
        completion_tokens: string;
        request_count: string;
      }>(
        `SELECT
           DATE(created_at) AS day,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           COUNT(*) AS request_count
         FROM token_usage
         WHERE created_at >= $1 AND created_at <= $2 AND org_id = $3
         GROUP BY DATE(created_at)
         ORDER BY day ASC`,
        [fromDate, toDate, orgId!],
      ),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    return c.json({
      trends: rows.map((r) => ({
        day: r.day,
        promptTokens: parseInt(r.prompt_tokens, 10),
        completionTokens: parseInt(r.completion_tokens, 10),
        totalTokens: parseInt(r.prompt_tokens, 10) + parseInt(r.completion_tokens, 10),
        requestCount: parseInt(r.request_count, 10),
      })),
      from: fromDate,
      to: toDate,
    }, 200);
  }), { label: "fetch token usage trends" });
});

export { adminTokens };
