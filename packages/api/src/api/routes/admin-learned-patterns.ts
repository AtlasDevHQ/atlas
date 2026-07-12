/**
 * Admin learned-patterns CRUD routes.
 *
 * Mounted under /api/v1/admin/learned-patterns. All routes require admin role.
 * Provides list, get, update, delete, and bulk status change for learned query patterns.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery, queryEffect } from "@atlas/api/lib/db/internal";
import { LEARNED_PATTERN_STATUSES, type LearnedPattern } from "@useatlas/types";
import {
  LearnedPatternSchema,
  LearnedPatternsListResponseSchema,
  LEARNED_PATTERN_SORT_DIRECTIONS,
  type LearnedPatternSortKey,
} from "@useatlas/schemas";
import { invalidatePatternCache } from "@atlas/api/lib/learn/pattern-cache";
import { ErrorSchema, AuthErrorSchema, parsePagination, createIdParamSchema, DeletedResponseSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-learned-patterns");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLearnedPattern(row: Record<string, unknown>): LearnedPattern {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    patternSql: row.pattern_sql as string,
    description: (row.description as string) ?? null,
    sourceEntity: (row.source_entity as string) ?? null,
    sourceQueries: row.source_queries
      ? (() => {
          try {
            return (typeof row.source_queries === "string"
              ? JSON.parse(row.source_queries)
              : row.source_queries) as string[];
          } catch {
            log.warn({ rowId: row.id }, "Corrupt source_queries JSON in learned_patterns row — returning null");
            return null;
          }
        })()
      : null,
    confidence: row.confidence as number,
    repetitionCount: row.repetition_count as number,
    // This route only ever reads `type = 'query_pattern'` rows (#4569), which
    // never carry the amendment-only `applying` claim state — so `status` maps
    // straight to the wire status.
    status: row.status as LearnedPattern["status"],
    proposedBy: (row.proposed_by as LearnedPattern["proposedBy"]) ?? null,
    reviewedBy: (row.reviewed_by as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at as string) : null,
    type: (row.type as LearnedPattern["type"]) ?? "query_pattern",
    amendmentPayload: row.amendment_payload
      ? (() => {
          try {
            return (typeof row.amendment_payload === "string"
              ? JSON.parse(row.amendment_payload)
              : row.amendment_payload) as LearnedPattern["amendmentPayload"];
          } catch {
            log.warn({ rowId: row.id }, "Corrupt amendment_payload JSON in learned_patterns row — returning null");
            return null;
          }
        })()
      : null,
    autoPromoted: Boolean(row.auto_promoted),
    avgDurationMs:
      row.avg_duration_ms === null || row.avg_duration_ms === undefined
        ? null
        : Number(row.avg_duration_ms),
  };
}

function orgFilter(
  orgId: string | null | undefined,
  params: unknown[],
  paramIdx: number,
): { clause: string; nextIdx: number } {
  if (orgId) {
    params.push(orgId);
    return { clause: `org_id = $${paramIdx}`, nextIdx: paramIdx + 1 };
  }
  return { clause: `org_id IS NULL`, nextIdx: paramIdx };
}

const VALID_STATUSES = new Set<string>(LEARNED_PATTERN_STATUSES);

// Whitelisted sort key (from the shared `LEARNED_PATTERN_SORT_KEYS` wire
// vocabulary) → real DB column. The ORDER BY column name is only ever taken
// from this whitelist — via `SORT_COLUMNS.get()`, which is
// prototype-pollution-safe and returns `undefined` for anything unknown — never
// from the raw `sort=` value, so a non-whitelisted sort key is rejected with
// 400 and can never be interpolated into SQL. `avg_duration_ms` is nullable, so
// the query sorts NULLS LAST in
// both directions (rows without a latency measurement sink to the bottom rather
// than jumping to the top), with a stable `id DESC` tiebreaker so pagination is
// deterministic when the primary sort ties. The `satisfies Record<...>` makes a
// missing/typo'd key a compile error; the cockpit binds the *other* side (its
// map's values are typed `LearnedPatternSortKey`), so the two can't drift.
const SORT_COLUMN_BY_KEY = {
  confidence: "confidence",
  repetition: "repetition_count",
  latency: "avg_duration_ms",
  created: "created_at",
} as const satisfies Record<LearnedPatternSortKey, string>;
const SORT_COLUMNS = new Map<string, string>(Object.entries(SORT_COLUMN_BY_KEY));
const SORT_DIRECTIONS = new Map<string, "ASC" | "DESC">(
  LEARNED_PATTERN_SORT_DIRECTIONS.map((d) => [d, d.toUpperCase() as "ASC" | "DESC"]),
);

// This route governs `type = 'query_pattern'` rows ONLY (#4569). Every handler
// scopes its reads and writes to this predicate, so `semantic_amendment` rows
// are invisible and untouchable here — their sole decide door is the improve
// surface's seam (#4506). Making the scope structural (a WHERE clause on every
// query) is what makes #4506's "the seam is the only writer of `approved`"
// invariant true for amendment rows.
const QUERY_PATTERN_SCOPE = "type = 'query_pattern'";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
//
// The learned-pattern wire shape (`LearnedPatternSchema`) and its list
// envelope (`LearnedPatternsListResponseSchema`) live in `@useatlas/schemas`
// — one source of truth shared with the cockpit page's response parsing, so a
// field rename can't silently drift between route and web (#4579). The enum
// tuples come from `@useatlas/types`, and `satisfies z.ZodType<LearnedPattern>`
// pins the schema to the wire type at compile time. Route-local schemas below
// are the ones that describe route-only responses (bulk / deleted).

const BulkResponseSchema = z.object({
  updated: z.array(z.string()),
  notFound: z.array(z.string()),
  errors: z.array(z.object({ id: z.string(), error: z.string() })).optional(),
});

const DeletedSchema = DeletedResponseSchema;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listPatternsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Learned Patterns"],
  summary: "List learned patterns",
  description:
    "Returns a paginated list of learned query patterns. Supports filtering by status, source entity, and confidence range. Semantic amendments are governed by the improve surface and never appear here (#4569).",
  request: {
    query: z.object({
      status: z.string().optional().openapi({ description: "Filter by status: pending, approved, rejected" }),
      source_entity: z.string().optional().openapi({ description: "Filter by source entity name" }),
      min_confidence: z.string().optional().openapi({ description: "Minimum confidence (0–1)" }),
      max_confidence: z.string().optional().openapi({ description: "Maximum confidence (0–1)" }),
      sort: z.string().optional().openapi({ description: "Sort field: confidence, repetition, latency, created (default created). Non-whitelisted values are rejected with 400." }),
      dir: z.string().optional().openapi({ description: "Sort direction: asc or desc (default desc)" }),
      limit: z.string().optional().openapi({ description: "Maximum results (default 50, max 200)" }),
      offset: z.string().optional().openapi({ description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of learned patterns",
      content: { "application/json": { schema: LearnedPatternsListResponseSchema } },
    },
    400: {
      description: "Invalid filter parameters",
      content: { "application/json": { schema: ErrorSchema } },
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

const getPatternRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Learned Patterns"],
  summary: "Get a learned pattern",
  description: "Returns a single learned pattern by ID.",
  request: {
    params: createIdParamSchema(),
  },
  responses: {
    200: {
      description: "Learned pattern details",
      content: { "application/json": { schema: LearnedPatternSchema } },
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
      description: "Pattern not found or internal database not configured",
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

const updatePatternRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Learned Patterns"],
  summary: "Update a learned pattern",
  description: "Updates a learned pattern's description and/or status. Setting a status records the reviewer and review timestamp.",
  request: {
    params: createIdParamSchema(),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            description: z.string().optional().openapi({ description: "New description for the pattern" }),
            status: z.enum(["pending", "approved", "rejected"]).optional().openapi({ description: "New status" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated learned pattern",
      content: { "application/json": { schema: LearnedPatternSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorSchema } },
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
      description: "Pattern not found or internal database not configured",
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

const deletePatternRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Learned Patterns"],
  summary: "Delete a learned pattern",
  description: "Permanently removes a learned pattern by ID and invalidates the pattern cache.",
  request: {
    params: createIdParamSchema(),
  },
  responses: {
    200: {
      description: "Pattern deleted",
      content: { "application/json": { schema: DeletedSchema } },
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
      description: "Pattern not found or internal database not configured",
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

const bulkStatusRoute = createRoute({
  method: "post",
  path: "/bulk",
  tags: ["Admin — Learned Patterns"],
  summary: "Bulk status change",
  description: "Updates the status of multiple learned patterns at once. Maximum 100 IDs per request. Only 'approved' and 'rejected' statuses are allowed.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string()).openapi({ description: "Pattern IDs to update (max 100)" }),
            status: z.enum(["approved", "rejected"]).openapi({ description: "Target status" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Bulk operation result",
      content: { "application/json": { schema: BulkResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorSchema } },
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminLearnedPatterns = createAdminRouter();

adminLearnedPatterns.use(requireOrgContext());

adminLearnedPatterns.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Our thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      // Distinguish Zod validation errors (rich detail) from malformed JSON (generic)
      const cause = err.cause;
      if (cause && typeof cause === "object" && "issues" in cause) {
        const issues = (cause as { issues: Array<{ message: string }> }).issues;
        const detail = issues.map((i) => i.message).join("; ");
        return c.json({ error: "validation_error", message: detail || "Request body validation failed." }, 400);
      }
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET / — list with filters
// ---------------------------------------------------------------------------

adminLearnedPatterns.openapi(listPatternsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const url = new URL(c.req.raw.url);
    const status = url.searchParams.get("status");
    const sourceEntity = url.searchParams.get("source_entity");
    const minConfidence = url.searchParams.get("min_confidence");
    const maxConfidence = url.searchParams.get("max_confidence");
    const sort = url.searchParams.get("sort");
    const dir = url.searchParams.get("dir");
    const { limit, offset } = parsePagination(c);

    if (status && !VALID_STATUSES.has(status)) return c.json({ error: "bad_request", message: `Invalid status filter. Must be one of: pending, approved, rejected.` }, 400);
    if (minConfidence !== null) { const val = parseFloat(minConfidence); if (!Number.isFinite(val) || val < 0 || val > 1) return c.json({ error: "bad_request", message: "min_confidence must be a number between 0 and 1." }, 400); }
    if (maxConfidence !== null) { const val = parseFloat(maxConfidence); if (!Number.isFinite(val) || val < 0 || val > 1) return c.json({ error: "bad_request", message: "max_confidence must be a number between 0 and 1." }, 400); }
    if (minConfidence !== null && maxConfidence !== null) { if (parseFloat(minConfidence) > parseFloat(maxConfidence)) return c.json({ error: "bad_request", message: "min_confidence must be less than or equal to max_confidence." }, 400); }

    // Sort is whitelisted: the ORDER BY column/direction comes only from the
    // SORT_COLUMNS/SORT_DIRECTIONS maps, never from the raw value — an unknown
    // `sort`/`dir` is a 400, never interpolated. Absent params default to
    // newest-first (now with a deterministic `id` tiebreaker, so pagination is
    // stable even without an explicit sort).
    let orderColumn = "created_at";
    if (sort !== null) {
      const mapped = SORT_COLUMNS.get(sort);
      if (mapped === undefined) return c.json({ error: "bad_request", message: `Invalid sort field. Must be one of: ${[...SORT_COLUMNS.keys()].join(", ")}.` }, 400);
      orderColumn = mapped;
    }
    let orderDir: "ASC" | "DESC" = "DESC";
    if (dir !== null) {
      const mapped = SORT_DIRECTIONS.get(dir);
      if (mapped === undefined) return c.json({ error: "bad_request", message: "Invalid sort direction. Must be one of: asc, desc." }, 400);
      orderDir = mapped;
    }
    const orderByClause = `ORDER BY ${orderColumn} ${orderDir} NULLS LAST, id DESC`;

    const whereParts: string[] = [];
    const params: unknown[] = [];
    const org = orgFilter(orgId, params, params.length + 1);
    whereParts.push(org.clause);
    whereParts.push(QUERY_PATTERN_SCOPE);
    let nextIdx = org.nextIdx;

    if (status) { params.push(status); whereParts.push(`status = $${nextIdx}`); nextIdx++; }
    if (sourceEntity) { params.push(sourceEntity); whereParts.push(`source_entity = $${nextIdx}`); nextIdx++; }
    if (minConfidence !== null) { params.push(parseFloat(minConfidence)); whereParts.push(`confidence >= $${nextIdx}`); nextIdx++; }
    if (maxConfidence !== null) { params.push(parseFloat(maxConfidence)); whereParts.push(`confidence <= $${nextIdx}`); nextIdx++; }

    const whereClause = `WHERE ${whereParts.join(" AND ")}`;
    const countParams = [...params];
    const countRows = yield* queryEffect<{ count: string }>(`SELECT COUNT(*) as count FROM learned_patterns ${whereClause}`, countParams);
    const total = parseInt(countRows[0]?.count ?? "0", 10);

    const selectParams = [...params];
    selectParams.push(limit);
    const limitIdx = nextIdx;
    selectParams.push(offset);
    const offsetIdx = limitIdx + 1;
    const rows = yield* queryEffect<Record<string, unknown>>(`SELECT * FROM learned_patterns ${whereClause} ${orderByClause} LIMIT $${limitIdx} OFFSET $${offsetIdx}`, selectParams);

    return c.json({ patterns: rows.map(toLearnedPattern), total, limit, offset }, 200);
  }), { label: "list learned patterns" });
});

// ---------------------------------------------------------------------------
// GET /:id — single pattern
// ---------------------------------------------------------------------------

adminLearnedPatterns.openapi(getPatternRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    const params: unknown[] = [id];
    const org = orgFilter(orgId, params, params.length + 1);
    const rows = yield* queryEffect<Record<string, unknown>>(`SELECT * FROM learned_patterns WHERE id = $1 AND ${QUERY_PATTERN_SCOPE} AND ${org.clause}`, params);
    if (rows.length === 0) return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);
    return c.json(toLearnedPattern(rows[0]), 200);
  }), { label: "get learned pattern" });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update
// ---------------------------------------------------------------------------

adminLearnedPatterns.openapi(updatePatternRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    const { description, status } = c.req.valid("json");
    if (description === undefined && status === undefined) return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: description, status." }, 400);

    // Scoped to query_pattern rows (#4569): an amendment id falls through to
    // 404 here — its status is never writable through this route, so #4506's
    // "the seam is the only writer of `approved`" holds by construction.
    const checkParams: unknown[] = [id];
    const org = orgFilter(orgId, checkParams, checkParams.length + 1);
    const existing = yield* queryEffect<Record<string, unknown>>(`SELECT id FROM learned_patterns WHERE id = $1 AND ${QUERY_PATTERN_SCOPE} AND ${org.clause}`, checkParams);
    if (existing.length === 0) return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);

    const setClauses: string[] = ["updated_at = now()"];
    const updateParams: unknown[] = [];
    let paramIdx = 1;
    if (description !== undefined) { updateParams.push(description); setClauses.push(`description = $${paramIdx}`); paramIdx++; }
    // A human status change re-attributes the row to that human: clear
    // `auto_promoted` so a row the nightly job promoted (then perhaps decayed to
    // pending) no longer renders the machine "Auto-approved" badge once a person
    // reviews it, and so decay never demotes it out from under the admin (#3636).
    if (status !== undefined) { updateParams.push(status); setClauses.push(`status = $${paramIdx}`); paramIdx++; updateParams.push(user?.id ?? null); setClauses.push(`reviewed_by = $${paramIdx}`); paramIdx++; setClauses.push(`reviewed_at = now()`); setClauses.push(`auto_promoted = false`); }

    updateParams.push(id);
    const idIdx = paramIdx;
    paramIdx++;
    const updateOrg = orgFilter(orgId, updateParams, paramIdx);
    const updated = yield* queryEffect<Record<string, unknown>>(`UPDATE learned_patterns SET ${setClauses.join(", ")} WHERE id = $${idIdx} AND ${QUERY_PATTERN_SCOPE} AND ${updateOrg.clause} RETURNING *`, updateParams);
    if (updated.length === 0) return c.json({ error: "not_found", message: "Pattern was deleted before update completed." }, 404);

    // Any status flip changes which patterns the agent sees: the approved set
    // is `status = 'approved'` (db/internal.ts getApprovedPatterns), so approve
    // adds to it and reject OR un-approve (back to pending) removes from it.
    // Evict the org's cached patterns so the next agent turn reads fresh data
    // instead of the stale 5-min TTL copy (#3612). Description-only edits leave
    // `status` undefined and don't touch the approved set, so skip those.
    if (status !== undefined) {
      invalidatePatternCache(orgId ?? null);
    }

    if (status === "approved") {
      logAdminAction({
        actionType: ADMIN_ACTIONS.pattern.approve,
        targetType: "pattern",
        targetId: id,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { patternId: id },
      });
    } else if (status === "rejected") {
      logAdminAction({
        actionType: ADMIN_ACTIONS.pattern.reject,
        targetType: "pattern",
        targetId: id,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { patternId: id },
      });
    }

    return c.json(toLearnedPattern(updated[0]), 200);
  }), { label: "update learned pattern" });
});

// ---------------------------------------------------------------------------
// DELETE /:id — hard delete
// ---------------------------------------------------------------------------

adminLearnedPatterns.openapi(deletePatternRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    // Scoped to query_pattern rows (#4569): an amendment id is a 404 here.
    const checkParams: unknown[] = [id];
    const org = orgFilter(orgId, checkParams, checkParams.length + 1);
    const existing = yield* queryEffect<Record<string, unknown>>(`SELECT id FROM learned_patterns WHERE id = $1 AND ${QUERY_PATTERN_SCOPE} AND ${org.clause}`, checkParams);
    if (existing.length === 0) return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);

    const deleteParams: unknown[] = [id];
    const deleteOrg = orgFilter(orgId, deleteParams, deleteParams.length + 1);
    yield* queryEffect(`DELETE FROM learned_patterns WHERE id = $1 AND ${QUERY_PATTERN_SCOPE} AND ${deleteOrg.clause}`, deleteParams);
    invalidatePatternCache(orgId ?? null);

    logAdminAction({
      actionType: ADMIN_ACTIONS.pattern.delete,
      targetType: "pattern",
      targetId: id,
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      metadata: { patternId: id },
    });

    return c.json({ deleted: true }, 200);
  }), { label: "delete learned pattern" });
});

// ---------------------------------------------------------------------------
// POST /bulk — bulk status change
// ---------------------------------------------------------------------------

adminLearnedPatterns.openapi(bulkStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;

    const { ids, status } = c.req.valid("json");
    if (ids.length === 0) return c.json({ error: "bad_request", message: "ids must be a non-empty array." }, 400);
    if (ids.length > 100) return c.json({ error: "bad_request", message: "Maximum 100 ids per bulk operation." }, 400);

    const updated: string[] = [];
    const notFound: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      const itemResult = yield* Effect.tryPromise({
        try: async () => {
          // Scoped to query_pattern rows (#4569): an amendment id resolves to
          // `not_found` here — the bulk path can never stamp an amendment's
          // status, so #4506's "the seam is the only writer of `approved`"
          // holds for amendment rows.
          const checkParams: unknown[] = [id];
          const org = orgFilter(orgId, checkParams, checkParams.length + 1);
          const existing = await internalQuery<Record<string, unknown>>(`SELECT id FROM learned_patterns WHERE id = $1 AND ${QUERY_PATTERN_SCOPE} AND ${org.clause}`, checkParams);
          if (existing.length === 0) return "not_found" as const;

          const updateParams: unknown[] = [status, user?.id ?? null, id];
          const updateOrg = orgFilter(orgId, updateParams, updateParams.length + 1);
          // Clear auto_promoted on a human review (see single-update path, #3636).
          await internalQuery(`UPDATE learned_patterns SET status = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now(), auto_promoted = false WHERE id = $3 AND ${QUERY_PATTERN_SCOPE} AND ${updateOrg.clause}`, updateParams);
          return "updated" as const;
        },
        catch: (err) => err instanceof Error ? err : new Error(String(err)),
      }).pipe(Effect.either);
      if (itemResult._tag === "Left") {
        const itemErr = itemResult.left;
        log.warn({ err: itemErr.message, requestId, patternId: id }, "Failed to update pattern in bulk operation");
        errors.push({ id, error: itemErr.message });
      } else if (itemResult.right === "not_found") {
        notFound.push(id);
      } else {
        updated.push(id);
      }
    }

    // Bulk approve/reject flips the approved set for this org. Evict once after
    // the loop (the handler is org-scoped) so the agent stops serving the stale
    // 5-min TTL cache — only when at least one row actually changed (#3612).
    if (updated.length > 0) {
      invalidatePatternCache(orgId ?? null);
    }

    return c.json({ updated, notFound, ...(errors.length > 0 ? { errors } : {}) }, 200);
  }), { label: "bulk update learned patterns" });
});

export { adminLearnedPatterns };
