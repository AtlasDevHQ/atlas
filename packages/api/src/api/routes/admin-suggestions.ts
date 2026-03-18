/**
 * Admin query-suggestions CRUD routes.
 *
 * Mounted under /api/v1/admin/suggestions. All routes require admin role.
 * Provides list and delete for query suggestions (learned query patterns).
 */

import { Hono } from "hono";
import { adminAuthPreamble } from "./admin-auth";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery, deleteSuggestion } from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";
import type { QuerySuggestionRow } from "@atlas/api/lib/db/internal";

const log = createLogger("admin-suggestions");

export const adminSuggestions = new Hono();

// GET / — list suggestions with filters
adminSuggestions.get("/", async (c) => {
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "Internal database not configured" }, { status: 404 });
  }

  const orgId = authResult.user?.activeOrganizationId ?? null;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const table = c.req.query("table");
      const minFreq = parseInt(c.req.query("min_frequency") ?? "0", 10) || 0;
      const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
      const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list suggestions");
      return c.json({ error: "internal_error", message: "Failed to list suggestions.", requestId }, 500);
    }
  });
});

// DELETE /:id — prune a suggestion
adminSuggestions.delete("/:id", async (c) => {
  const requestId = crypto.randomUUID();
  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "Internal database not configured" }, { status: 404 });
  }

  const orgId = authResult.user?.activeOrganizationId ?? null;
  const { id } = c.req.param();

  return withRequestContext({ requestId, user: authResult.user }, async () => {
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
});
