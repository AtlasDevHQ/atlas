/**
 * Public prompt library API routes.
 *
 * Mounted at /api/v1/prompts. Available to all authenticated users (not admin-gated).
 * Provides read-only access to prompt collections and items, enabling the
 * prompt library UI. Returns built-in collections plus any belonging to the
 * user's organization.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { authPreamble } from "./auth-preamble";

const log = createLogger("prompt-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPromptCollection(row: Record<string, unknown>): PromptCollection {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    name: row.name as string,
    industry: row.industry as string,
    description: (row.description as string) ?? "",
    isBuiltin: row.is_builtin as boolean,
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toPromptItem(row: Record<string, unknown>): PromptItem {
  return {
    id: row.id as string,
    collectionId: row.collection_id as string,
    question: row.question as string,
    description: (row.description as string) ?? null,
    category: (row.category as string) ?? null,
    sortOrder: row.sort_order as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const prompts = new Hono();

// ---------------------------------------------------------------------------
// GET / — list collections (built-in + user's org)
// ---------------------------------------------------------------------------

prompts.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ collections: [] });
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const orgId = authResult.user?.activeOrganizationId;

      let rows: Record<string, unknown>[];
      if (orgId) {
        rows = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE org_id IS NULL OR org_id = $1 ORDER BY sort_order ASC, created_at ASC`,
          [orgId],
        );
      } else {
        rows = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE org_id IS NULL ORDER BY sort_order ASC, created_at ASC`,
        );
      }

      return c.json({ collections: rows.map(toPromptCollection) });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list prompt collections");
      return c.json({ error: "internal_error", message: "Failed to list prompt collections.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /:id — collection detail with items
// ---------------------------------------------------------------------------

prompts.get("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;

      let collectionRows: Record<string, unknown>[];
      if (orgId) {
        collectionRows = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [id, orgId],
        );
      } else {
        collectionRows = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND org_id IS NULL`,
          [id],
        );
      }

      if (collectionRows.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      const items = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM prompt_items WHERE collection_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [id],
      );

      return c.json({
        collection: toPromptCollection(collectionRows[0]),
        items: items.map(toPromptItem),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to get prompt collection");
      return c.json({ error: "internal_error", message: "Failed to get prompt collection.", requestId }, 500);
    }
  });
});
