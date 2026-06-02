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

/**
 * Anthropic ephemeral (5-min TTL) prompt-cache pricing, expressed relative to
 * the fresh-input token price (#3106):
 *   - cache READ  ≈ 0.10× — context replayed from cache is ~90% cheaper
 *   - cache WRITE ≈ 1.25× — seeding the cache carries a ~25% premium
 * Source: migration 0114 + reference_gateway_anthropic_caching.
 */
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

/**
 * Convert gross token counts into a single billed/effective token-equivalent.
 *
 * `promptTokens` is the GROSS input total — cache read/write are *subsets* of
 * it (the AI SDK reports `inputTokens = noCache + cacheRead + cacheWrite`, and
 * agent.ts persists that total to `token_usage.prompt_tokens`). So the fresh
 * (full-price) input is `prompt − cacheRead − cacheWrite`, and the effective
 * figure re-prices the two cache buckets at their discounted rates. Output
 * tokens carry no cache discount. Kept in token units (not dollars) to stay
 * comparable with the gross figure shown alongside it.
 */
function effectiveTokens(
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const freshInput = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const billed =
    freshInput +
    cacheReadTokens * CACHE_READ_FACTOR +
    cacheWriteTokens * CACHE_WRITE_FACTOR +
    completionTokens;
  return Math.max(0, Math.round(billed));
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

    // Two parallel reads: the period totals, and a per-model breakdown so an
    // operator can see WHICH model burned the tokens (#3098). The model
    // dimension lives on token_usage but was previously aggregated away.
    const [rows, modelRows] = yield* Effect.tryPromise({
      try: () => Promise.all([
        internalQuery<{
          total_prompt: string;
          total_completion: string;
          total_cache_read: string;
          total_cache_write: string;
          total_requests: string;
        }>(
          `SELECT
             COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
             COALESCE(SUM(completion_tokens), 0) AS total_completion,
             COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
             COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
             COUNT(*) AS total_requests
           FROM token_usage
           WHERE created_at >= $1 AND created_at <= $2 AND org_id = $3`,
          [fromDate, toDate, orgId!],
        ),
        internalQuery<{
          model: string | null;
          provider: string | null;
          total_prompt: string;
          total_completion: string;
          total_cache_read: string;
          total_cache_write: string;
          request_count: string;
        }>(
          `SELECT
             model,
             provider,
             COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
             COALESCE(SUM(completion_tokens), 0) AS total_completion,
             COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
             COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
             COUNT(*) AS request_count
           FROM token_usage
           WHERE created_at >= $1 AND created_at <= $2 AND org_id = $3
           GROUP BY model, provider
           ORDER BY (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0)) DESC`,
          [fromDate, toDate, orgId!],
        ),
      ]),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    });

    const row = rows[0];
    const totalPromptTokens = parseInt(row?.total_prompt ?? "0", 10);
    const totalCompletionTokens = parseInt(row?.total_completion ?? "0", 10);
    const totalCacheReadTokens = parseInt(row?.total_cache_read ?? "0", 10);
    const totalCacheWriteTokens = parseInt(row?.total_cache_write ?? "0", 10);
    return c.json({
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      // Prompt-cache split (#3106): both are subsets of totalPromptTokens.
      totalCacheReadTokens,
      totalCacheWriteTokens,
      // Billed/effective token-equivalent after prompt-cache discounts — the
      // figure the gross totals overstate (cache reads are ~90% cheaper).
      effectiveTokens: effectiveTokens(
        totalPromptTokens,
        totalCompletionTokens,
        totalCacheReadTokens,
        totalCacheWriteTokens,
      ),
      totalRequests: parseInt(row?.total_requests ?? "0", 10),
      // Rows with a NULL model/provider (older usage records written before the
      // column existed) surface as "unknown" rather than being dropped.
      byModel: modelRows.map((m) => {
        const promptTokens = parseInt(m.total_prompt ?? "0", 10);
        const completionTokens = parseInt(m.total_completion ?? "0", 10);
        const cacheReadTokens = parseInt(m.total_cache_read ?? "0", 10);
        const cacheWriteTokens = parseInt(m.total_cache_write ?? "0", 10);
        return {
          model: m.model ?? "unknown",
          provider: m.provider ?? "unknown",
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
          effectiveTokens: effectiveTokens(promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens),
          requestCount: parseInt(m.request_count ?? "0", 10),
        };
      }),
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
