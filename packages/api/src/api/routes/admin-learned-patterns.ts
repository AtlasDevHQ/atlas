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
import { invalidatePatternCache } from "@atlas/api/lib/learn/pattern-cache";
import { ErrorSchema, AuthErrorSchema, parsePagination, createIdParamSchema, createListResponseSchema, DeletedResponseSchema } from "./shared-schemas";
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
    // `applying` is the decide seam's transient claim state (#4506), not a
    // wire status — present it as `pending` (the row is still undecided; a
    // stale claim resurfaces as claimable).
    status: (row.status === "applying" ? "pending" : row.status) as LearnedPattern["status"],
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

/**
 * Route a `semantic_amendment` row's status decision through the decide seam
 * (#4506) — the ONLY code path that stamps `approved` on an amendment.
 *
 * The seam owns `pending → approved | rejected` with claim-then-apply
 * ordering: `approved` is stamped only after a successful YAML apply +
 * version snapshot, and a failed apply compensates the row back to `pending`
 * with a visible reason (the error still propagates so the handler surfaces
 * it). A rejected row being re-approved is atomically reopened
 * (`rejected → pending`, the reconsider arm) before the seam decides it.
 *
 * Returns `"decided"` on success; `"conflict"` with a truthful message when
 * the row was already reviewed / is being applied by a concurrent request.
 * Throws when the apply itself fails.
 */
async function decideAmendmentRow(params: {
  id: string;
  rowStatus: string;
  decision: "approved" | "rejected";
  orgId: string | null | undefined;
  userId: string | null;
  requestId: string;
}): Promise<{ kind: "decided" } | { kind: "conflict"; message: string }> {
  const { id, rowStatus, decision, orgId, userId, requestId } = params;

  if (rowStatus === "approved") {
    return {
      kind: "conflict",
      message:
        "This amendment is already approved and applied to the semantic layer. Use the entity's version history to roll it back instead of re-reviewing it.",
    };
  }
  if (rowStatus === "rejected") {
    if (decision === "rejected") {
      return { kind: "conflict", message: "This amendment is already rejected." };
    }
    // Reconsider: atomically reopen the rejected row, then let the seam decide
    // it. A concurrent decision between the reopen and the claim just makes
    // the claim lose — truthful conflict, never a double apply.
    const reopenParams: unknown[] = [id];
    const reopenOrg = orgFilter(orgId, reopenParams, reopenParams.length + 1);
    const reopened = await internalQuery<{ id: string }>(
      `UPDATE learned_patterns SET status = 'pending', updated_at = now()
       WHERE id = $1 AND type = 'semantic_amendment' AND status = 'rejected' AND ${reopenOrg.clause}
       RETURNING id`,
      reopenParams,
    );
    if (reopened.length === 0) {
      return {
        kind: "conflict",
        message: "Amendment was reviewed by another request. Refresh and retry.",
      };
    }
  }

  const { decideAmendment } = await import("@atlas/api/lib/semantic/expert/decide");
  const outcome = await decideAmendment({
    id,
    orgId: orgId ?? null,
    decision,
    reviewedBy: userId ?? "admin",
    requestId,
  });
  if (outcome.kind === "not_pending") {
    return {
      kind: "conflict",
      message: "Amendment was already reviewed or is being applied by another request.",
    };
  }
  return { kind: "decided" };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const LearnedPatternSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  patternSql: z.string(),
  description: z.string().nullable(),
  sourceEntity: z.string().nullable(),
  sourceQueries: z.array(z.string()).nullable(),
  confidence: z.number(),
  repetitionCount: z.number(),
  status: z.enum(["pending", "approved", "rejected"]),
  proposedBy: z.enum(["agent", "atlas-learn", "expert-agent"]).nullable(),
  reviewedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reviewedAt: z.string().nullable(),
  type: z.enum(["query_pattern", "semantic_amendment"]),
  amendmentPayload: z.record(z.string(), z.unknown()).nullable(),
  autoPromoted: z.boolean(),
  avgDurationMs: z.number().nullable(),
});

const ListResponseSchema = createListResponseSchema("patterns", LearnedPatternSchema, {
  limit: z.number(),
  offset: z.number(),
});

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
    "Returns a paginated list of learned query patterns. Supports filtering by status, type, source entity, and confidence range.",
  request: {
    query: z.object({
      status: z.string().optional().openapi({ description: "Filter by status: pending, approved, rejected" }),
      source_entity: z.string().optional().openapi({ description: "Filter by source entity name" }),
      type: z.string().optional().openapi({ description: "Filter by type: query_pattern, semantic_amendment" }),
      min_confidence: z.string().optional().openapi({ description: "Minimum confidence (0–1)" }),
      max_confidence: z.string().optional().openapi({ description: "Maximum confidence (0–1)" }),
      limit: z.string().optional().openapi({ description: "Maximum results (default 50, max 200)" }),
      offset: z.string().optional().openapi({ description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of learned patterns",
      content: { "application/json": { schema: ListResponseSchema } },
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
    409: {
      description:
        "Semantic amendment already reviewed, applied, or claimed by a concurrent request (#4506) — amendment status transitions are owned by the decide seam",
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
    const patternType = url.searchParams.get("type");
    const minConfidence = url.searchParams.get("min_confidence");
    const maxConfidence = url.searchParams.get("max_confidence");
    const { limit, offset } = parsePagination(c);

    if (status && !VALID_STATUSES.has(status)) return c.json({ error: "bad_request", message: `Invalid status filter. Must be one of: pending, approved, rejected.` }, 400);
    if (minConfidence !== null) { const val = parseFloat(minConfidence); if (!Number.isFinite(val) || val < 0 || val > 1) return c.json({ error: "bad_request", message: "min_confidence must be a number between 0 and 1." }, 400); }
    if (maxConfidence !== null) { const val = parseFloat(maxConfidence); if (!Number.isFinite(val) || val < 0 || val > 1) return c.json({ error: "bad_request", message: "max_confidence must be a number between 0 and 1." }, 400); }
    if (minConfidence !== null && maxConfidence !== null) { if (parseFloat(minConfidence) > parseFloat(maxConfidence)) return c.json({ error: "bad_request", message: "min_confidence must be less than or equal to max_confidence." }, 400); }

    const whereParts: string[] = [];
    const params: unknown[] = [];
    const org = orgFilter(orgId, params, params.length + 1);
    whereParts.push(org.clause);
    let nextIdx = org.nextIdx;

    if (status === "pending") {
      // `applying` is the decide seam's transient claim state, presented as
      // `pending` on the wire (see toLearnedPattern, #4506) — the filter must
      // match the presentation, or a crash-stranded claim becomes invisible
      // under the one filter admins use to find pending work.
      whereParts.push(`status IN ('pending', 'applying')`);
    } else if (status) { params.push(status); whereParts.push(`status = $${nextIdx}`); nextIdx++; }
    if (patternType) { params.push(patternType); whereParts.push(`type = $${nextIdx}`); nextIdx++; }
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
    const rows = yield* queryEffect<Record<string, unknown>>(`SELECT * FROM learned_patterns ${whereClause} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, selectParams);

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
    const rows = yield* queryEffect<Record<string, unknown>>(`SELECT * FROM learned_patterns WHERE id = $1 AND ${org.clause}`, params);
    if (rows.length === 0) return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);
    return c.json(toLearnedPattern(rows[0]), 200);
  }), { label: "get learned pattern" });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update
// ---------------------------------------------------------------------------

adminLearnedPatterns.openapi(updatePatternRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;

    const { id } = c.req.valid("param");
    const { description, status } = c.req.valid("json");
    if (description === undefined && status === undefined) return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: description, status." }, 400);

    const checkParams: unknown[] = [id];
    const org = orgFilter(orgId, checkParams, checkParams.length + 1);
    const existing = yield* queryEffect<Record<string, unknown>>(`SELECT * FROM learned_patterns WHERE id = $1 AND ${org.clause}`, checkParams);
    if (existing.length === 0) return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);

    // Semantic-amendment status decisions are seam-owned (#4506): the decide
    // seam claims the pending row, applies the YAML + version snapshot, and
    // only then stamps `approved` — this handler must never write an
    // amendment's approved/rejected status itself. A failed apply (incl. an
    // AmbiguousEntityError → 409) aborts the request with the row already
    // compensated back to pending. `seamDecided` suppresses the generic
    // status SET below so the seam's stamp is never overwritten.
    let seamDecided = false;
    if (
      (status === "approved" || status === "rejected") &&
      existing[0].type === "semantic_amendment"
    ) {
      const decided = yield* Effect.tryPromise({
        try: () =>
          decideAmendmentRow({
            id,
            rowStatus: String(existing[0].status),
            decision: status,
            orgId,
            userId: user?.id ?? null,
            requestId,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      if (decided.kind === "conflict") {
        return c.json({ error: "conflict", message: decided.message, requestId }, 409);
      }
      seamDecided = true;
    } else if (
      status === "pending" &&
      existing[0].type === "semantic_amendment" &&
      (existing[0].status === "approved" || existing[0].status === "applying")
    ) {
      // Un-approving an applied amendment would leave the row claiming
      // "pending" while its YAML change is live — the same class of lie the
      // decide seam exists to prevent (roll back via version history instead).
      // Likewise a row mid-claim (`applying`) belongs to the in-flight
      // decision, not this handler.
      return c.json(
        {
          error: "conflict",
          message:
            existing[0].status === "applying"
              ? "This amendment is currently being applied by another request."
              : "This amendment is already approved and applied to the semantic layer. Use the entity's version history to roll it back instead of re-reviewing it.",
          requestId,
        },
        409,
      );
    }

    const setClauses: string[] = ["updated_at = now()"];
    const updateParams: unknown[] = [];
    let paramIdx = 1;
    if (description !== undefined) { updateParams.push(description); setClauses.push(`description = $${paramIdx}`); paramIdx++; }
    // A human status change re-attributes the row to that human: clear
    // `auto_promoted` so a row the nightly job promoted (then perhaps decayed to
    // pending) no longer renders the machine "Auto-approved" badge once a person
    // reviews it, and so decay never demotes it out from under the admin (#3636).
    // Seam-decided amendment statuses are excluded: the seam already stamped
    // status + reviewer, and amendments are never auto-promoted (#3636 scopes
    // promote-decay to query_pattern rows).
    if (status !== undefined && !seamDecided) { updateParams.push(status); setClauses.push(`status = $${paramIdx}`); paramIdx++; updateParams.push(user?.id ?? null); setClauses.push(`reviewed_by = $${paramIdx}`); paramIdx++; setClauses.push(`reviewed_at = now()`); setClauses.push(`auto_promoted = false`); }

    updateParams.push(id);
    const idIdx = paramIdx;
    paramIdx++;
    const updateOrg = orgFilter(orgId, updateParams, paramIdx);
    const updated = yield* queryEffect<Record<string, unknown>>(`UPDATE learned_patterns SET ${setClauses.join(", ")} WHERE id = $${idIdx} AND ${updateOrg.clause} RETURNING *`, updateParams);
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
    const checkParams: unknown[] = [id];
    const org = orgFilter(orgId, checkParams, checkParams.length + 1);
    const existing = yield* queryEffect<Record<string, unknown>>(`SELECT id FROM learned_patterns WHERE id = $1 AND ${org.clause}`, checkParams);
    if (existing.length === 0) return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);

    const deleteParams: unknown[] = [id];
    const deleteOrg = orgFilter(orgId, deleteParams, deleteParams.length + 1);
    yield* queryEffect(`DELETE FROM learned_patterns WHERE id = $1 AND ${deleteOrg.clause}`, deleteParams);
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
          const checkParams: unknown[] = [id];
          const org = orgFilter(orgId, checkParams, checkParams.length + 1);
          const existing = await internalQuery<Record<string, unknown>>(`SELECT id, type, status, source_entity, amendment_payload, connection_group_id FROM learned_patterns WHERE id = $1 AND ${org.clause}`, checkParams);
          if (existing.length === 0) return "not_found" as const;

          // Semantic-amendment decisions are seam-owned (#4506): the decide
          // seam claims the pending row, applies YAML + version snapshot, and
          // stamps `approved` only on success — this handler never writes an
          // amendment's status itself. A conflict (already reviewed / claimed
          // by a concurrent request) is recorded per-id in `errors`; a failed
          // apply throws with the row already compensated back to pending.
          if (existing[0].type === "semantic_amendment") {
            const decided = await decideAmendmentRow({
              id,
              rowStatus: String(existing[0].status),
              decision: status,
              orgId,
              userId: user?.id ?? null,
              requestId,
            });
            if (decided.kind === "conflict") throw new Error(decided.message);
            return "updated" as const;
          }

          const updateParams: unknown[] = [status, user?.id ?? null, id];
          const updateOrg = orgFilter(orgId, updateParams, updateParams.length + 1);
          // Clear auto_promoted on a human review (see single-update path, #3636).
          await internalQuery(`UPDATE learned_patterns SET status = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now(), auto_promoted = false WHERE id = $3 AND ${updateOrg.clause}`, updateParams);
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
