/**
 * Admin learned-patterns CRUD routes.
 *
 * Mounted under /api/v1/admin/learned-patterns. All routes require admin role.
 * Provides list, get, update, delete, and bulk status change for learned query patterns.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { LEARNED_PATTERN_STATUSES, type LearnedPattern } from "@useatlas/types";
import { adminAuthPreamble } from "./admin-auth";
import { invalidatePatternCache } from "@atlas/api/lib/learn/pattern-cache";

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
    status: row.status as LearnedPattern["status"],
    proposedBy: (row.proposed_by as LearnedPattern["proposedBy"]) ?? null,
    reviewedBy: (row.reviewed_by as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
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
const BULK_STATUSES = new Set(["approved", "rejected"]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminLearnedPatterns = new Hono();

// ---------------------------------------------------------------------------
// GET / — list with filters
// ---------------------------------------------------------------------------

adminLearnedPatterns.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Learned patterns requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const url = new URL(req.url);
      const status = url.searchParams.get("status");
      const sourceEntity = url.searchParams.get("source_entity");
      const minConfidence = url.searchParams.get("min_confidence");
      const maxConfidence = url.searchParams.get("max_confidence");
      let limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      let offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

      if (status && !VALID_STATUSES.has(status)) {
        return c.json({ error: "bad_request", message: `Invalid status filter. Must be one of: pending, approved, rejected.` }, 400);
      }

      if (minConfidence !== null) {
        const val = parseFloat(minConfidence);
        if (!Number.isFinite(val) || val < 0 || val > 1) {
          return c.json({ error: "bad_request", message: "min_confidence must be a number between 0 and 1." }, 400);
        }
      }

      if (maxConfidence !== null) {
        const val = parseFloat(maxConfidence);
        if (!Number.isFinite(val) || val < 0 || val > 1) {
          return c.json({ error: "bad_request", message: "max_confidence must be a number between 0 and 1." }, 400);
        }
      }

      if (minConfidence !== null && maxConfidence !== null) {
        if (parseFloat(minConfidence) > parseFloat(maxConfidence)) {
          return c.json({ error: "bad_request", message: "min_confidence must be less than or equal to max_confidence." }, 400);
        }
      }

      if (isNaN(limit) || limit < 1) limit = 50;
      if (limit > 200) limit = 200;
      if (isNaN(offset) || offset < 0) offset = 0;

      const orgId = authResult.user?.activeOrganizationId;
      const whereParts: string[] = [];
      const params: unknown[] = [];

      const org = orgFilter(orgId, params, params.length + 1);
      whereParts.push(org.clause);
      let nextIdx = org.nextIdx;

      if (status) {
        params.push(status);
        whereParts.push(`status = $${nextIdx}`);
        nextIdx++;
      }

      if (sourceEntity) {
        params.push(sourceEntity);
        whereParts.push(`source_entity = $${nextIdx}`);
        nextIdx++;
      }

      if (minConfidence !== null) {
        params.push(parseFloat(minConfidence));
        whereParts.push(`confidence >= $${nextIdx}`);
        nextIdx++;
      }

      if (maxConfidence !== null) {
        params.push(parseFloat(maxConfidence));
        whereParts.push(`confidence <= $${nextIdx}`);
        nextIdx++;
      }

      const whereClause = `WHERE ${whereParts.join(" AND ")}`;

      const countParams = [...params];
      const countRows = await internalQuery<{ count: string }>(
        `SELECT COUNT(*) as count FROM learned_patterns ${whereClause}`,
        countParams,
      );
      const total = parseInt(countRows[0]?.count ?? "0", 10);

      const selectParams = [...params];
      selectParams.push(limit);
      const limitIdx = nextIdx;
      selectParams.push(offset);
      const offsetIdx = limitIdx + 1;

      const rows = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM learned_patterns ${whereClause} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        selectParams,
      );

      return c.json({
        patterns: rows.map(toLearnedPattern),
        total,
        limit,
        offset,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list learned patterns");
      return c.json({ error: "internal_error", message: "Failed to list learned patterns.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id — single pattern
// ---------------------------------------------------------------------------

adminLearnedPatterns.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Learned patterns requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;
      const params: unknown[] = [id];
      const org = orgFilter(orgId, params, params.length + 1);

      const rows = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM learned_patterns WHERE id = $1 AND ${org.clause}`,
        params,
      );

      if (rows.length === 0) {
        return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);
      }

      return c.json(toLearnedPattern(rows[0]));
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to get learned pattern");
      return c.json({ error: "internal_error", message: "Failed to get learned pattern.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update
// ---------------------------------------------------------------------------

adminLearnedPatterns.patch("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Learned patterns requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");

      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body");
        return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
      }

      const description = body.description as string | undefined;
      const status = body.status as string | undefined;

      if (description === undefined && status === undefined) {
        return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: description, status." }, 400);
      }

      if (status !== undefined && !VALID_STATUSES.has(status)) {
        return c.json({ error: "bad_request", message: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}` }, 400);
      }

      const orgId = authResult.user?.activeOrganizationId;
      const checkParams: unknown[] = [id];
      const org = orgFilter(orgId, checkParams, checkParams.length + 1);

      const existing = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM learned_patterns WHERE id = $1 AND ${org.clause}`,
        checkParams,
      );

      if (existing.length === 0) {
        return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);
      }

      // Build dynamic UPDATE
      const setClauses: string[] = ["updated_at = now()"];
      const updateParams: unknown[] = [];
      let paramIdx = 1;

      if (description !== undefined) {
        updateParams.push(description);
        setClauses.push(`description = $${paramIdx}`);
        paramIdx++;
      }

      if (status !== undefined) {
        updateParams.push(status);
        setClauses.push(`status = $${paramIdx}`);
        paramIdx++;

        updateParams.push(authResult.user?.id ?? null);
        setClauses.push(`reviewed_by = $${paramIdx}`);
        paramIdx++;

        setClauses.push(`reviewed_at = now()`);
      }

      updateParams.push(id);
      const idIdx = paramIdx;
      paramIdx++;

      const updateOrg = orgFilter(orgId, updateParams, paramIdx);
      const updated = await internalQuery<Record<string, unknown>>(
        `UPDATE learned_patterns SET ${setClauses.join(", ")} WHERE id = $${idIdx} AND ${updateOrg.clause} RETURNING *`,
        updateParams,
      );

      if (updated.length === 0) {
        return c.json({ error: "not_found", message: "Pattern was deleted before update completed." }, 404);
      }
      return c.json(toLearnedPattern(updated[0]));
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update learned pattern");
      return c.json({ error: "internal_error", message: "Failed to update learned pattern.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — hard delete
// ---------------------------------------------------------------------------

adminLearnedPatterns.delete("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Learned patterns requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;
      const checkParams: unknown[] = [id];
      const org = orgFilter(orgId, checkParams, checkParams.length + 1);

      const existing = await internalQuery<Record<string, unknown>>(
        `SELECT id FROM learned_patterns WHERE id = $1 AND ${org.clause}`,
        checkParams,
      );

      if (existing.length === 0) {
        return c.json({ error: "not_found", message: "Learned pattern not found." }, 404);
      }

      const deleteParams: unknown[] = [id];
      const deleteOrg = orgFilter(orgId, deleteParams, deleteParams.length + 1);
      await internalQuery(
        `DELETE FROM learned_patterns WHERE id = $1 AND ${deleteOrg.clause}`,
        deleteParams,
      );

      invalidatePatternCache(orgId ?? null);

      return c.json({ deleted: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete learned pattern");
      return c.json({ error: "internal_error", message: "Failed to delete learned pattern.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /bulk — bulk status change
// ---------------------------------------------------------------------------

adminLearnedPatterns.post("/bulk", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Learned patterns requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body");
        return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
      }

      const ids = body.ids as string[] | undefined;
      const status = body.status as string | undefined;

      if (!Array.isArray(ids) || ids.length === 0) {
        return c.json({ error: "bad_request", message: "ids must be a non-empty array." }, 400);
      }

      if (ids.length > 100) {
        return c.json({ error: "bad_request", message: "Maximum 100 ids per bulk operation." }, 400);
      }

      if (!status || !BULK_STATUSES.has(status)) {
        return c.json({ error: "bad_request", message: `Invalid status. Must be one of: ${[...BULK_STATUSES].join(", ")}` }, 400);
      }

      const orgId = authResult.user?.activeOrganizationId;
      const updated: string[] = [];
      const notFound: string[] = [];
      const errors: Array<{ id: string; error: string }> = [];

      for (const id of ids) {
        try {
          const checkParams: unknown[] = [id];
          const org = orgFilter(orgId, checkParams, checkParams.length + 1);

          const existing = await internalQuery<Record<string, unknown>>(
            `SELECT id FROM learned_patterns WHERE id = $1 AND ${org.clause}`,
            checkParams,
          );

          if (existing.length === 0) {
            notFound.push(id);
            continue;
          }

          const updateParams: unknown[] = [status, authResult.user?.id ?? null, id];
          const updateOrg = orgFilter(orgId, updateParams, updateParams.length + 1);
          await internalQuery(
            `UPDATE learned_patterns SET status = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now() WHERE id = $3 AND ${updateOrg.clause}`,
            updateParams,
          );

          updated.push(id);
        } catch (itemErr) {
          log.warn(
            { err: itemErr instanceof Error ? itemErr.message : String(itemErr), requestId, patternId: id },
            "Failed to update pattern in bulk operation",
          );
          errors.push({ id, error: itemErr instanceof Error ? itemErr.message : "Update failed" });
        }
      }

      return c.json({ updated, notFound, ...(errors.length > 0 ? { errors } : {}) });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to bulk update learned patterns");
      return c.json({ error: "internal_error", message: "Failed to bulk update learned patterns.", requestId }, 500);
    }
  });
});

export { adminLearnedPatterns };
