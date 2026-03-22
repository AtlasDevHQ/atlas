/**
 * Admin prompt library CRUD routes.
 *
 * Mounted under /api/v1/admin/prompts. All routes require admin role.
 * Provides full CRUD for prompt collections and items. Built-in collections
 * (is_builtin = true) are read-only — mutations return 403.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { adminAuthPreamble } from "./admin-auth";

const log = createLogger("admin-prompts");

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

export const adminPrompts = new Hono();

// ---------------------------------------------------------------------------
// GET / — list all collections (admin view)
// ---------------------------------------------------------------------------

adminPrompts.get("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
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
          `SELECT * FROM prompt_collections ORDER BY sort_order ASC, created_at ASC`,
        );
      }

      return c.json({ collections: rows.map(toPromptCollection), total: rows.length });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list prompt collections");
      return c.json({ error: "internal_error", message: "Failed to list prompt collections.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST / — create collection
// ---------------------------------------------------------------------------

adminPrompts.post("/", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
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

      const name = body.name as string | undefined;
      const industry = body.industry as string | undefined;
      const description = (body.description as string) ?? "";

      if (!name || typeof name !== "string") {
        return c.json({ error: "bad_request", message: "name is required and must be a string." }, 400);
      }
      if (!industry || typeof industry !== "string") {
        return c.json({ error: "bad_request", message: "industry is required and must be a string." }, 400);
      }

      const orgId = authResult.user?.activeOrganizationId ?? null;

      const rows = await internalQuery<Record<string, unknown>>(
        `INSERT INTO prompt_collections (org_id, name, industry, description, is_builtin) VALUES ($1, $2, $3, $4, false) RETURNING *`,
        [orgId, name, industry, description],
      );

      return c.json(toPromptCollection(rows[0]), 201);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to create prompt collection");
      return c.json({ error: "internal_error", message: "Failed to create prompt collection.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update collection
// ---------------------------------------------------------------------------

adminPrompts.patch("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;

      // Lookup collection with org check
      let existing: Record<string, unknown>[];
      if (orgId) {
        existing = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [id, orgId],
        );
      } else {
        existing = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1`,
          [id],
        );
      }

      if (existing.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      if (existing[0].is_builtin === true) {
        return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);
      }

      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body");
        return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
      }

      const name = body.name as string | undefined;
      const industry = body.industry as string | undefined;
      const description = body.description as string | undefined;

      if (name === undefined && industry === undefined && description === undefined) {
        return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: name, industry, description." }, 400);
      }

      // Build dynamic UPDATE
      const setClauses: string[] = ["updated_at = now()"];
      const updateParams: unknown[] = [];
      let paramIdx = 1;

      if (name !== undefined) {
        updateParams.push(name);
        setClauses.push(`name = $${paramIdx}`);
        paramIdx++;
      }

      if (industry !== undefined) {
        updateParams.push(industry);
        setClauses.push(`industry = $${paramIdx}`);
        paramIdx++;
      }

      if (description !== undefined) {
        updateParams.push(description);
        setClauses.push(`description = $${paramIdx}`);
        paramIdx++;
      }

      updateParams.push(id);
      const idIdx = paramIdx;

      const updated = await internalQuery<Record<string, unknown>>(
        `UPDATE prompt_collections SET ${setClauses.join(", ")} WHERE id = $${idIdx} RETURNING *`,
        updateParams,
      );

      if (updated.length === 0) {
        return c.json({ error: "not_found", message: "Collection was deleted before update completed." }, 404);
      }

      return c.json(toPromptCollection(updated[0]));
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update prompt collection");
      return c.json({ error: "internal_error", message: "Failed to update prompt collection.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete collection (cascades to items)
// ---------------------------------------------------------------------------

adminPrompts.delete("/:id", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const id = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;

      // Lookup collection with org check
      let existing: Record<string, unknown>[];
      if (orgId) {
        existing = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [id, orgId],
        );
      } else {
        existing = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1`,
          [id],
        );
      }

      if (existing.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      if (existing[0].is_builtin === true) {
        return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);
      }

      await internalQuery(
        `DELETE FROM prompt_collections WHERE id = $1`,
        [id],
      );

      return c.json({ deleted: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete prompt collection");
      return c.json({ error: "internal_error", message: "Failed to delete prompt collection.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /:id/items — add item to collection
// ---------------------------------------------------------------------------

adminPrompts.post("/:id/items", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const collectionId = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;

      // Verify collection exists and ownership
      let collection: Record<string, unknown>[];
      if (orgId) {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [collectionId, orgId],
        );
      } else {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1`,
          [collectionId],
        );
      }

      if (collection.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      if (collection[0].is_builtin === true) {
        return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);
      }

      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body");
        return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
      }

      const question = body.question as string | undefined;
      const description = (body.description as string) ?? null;
      const category = (body.category as string) ?? null;

      if (!question || typeof question !== "string") {
        return c.json({ error: "bad_request", message: "question is required and must be a string." }, 400);
      }

      // Determine sort_order: use provided value or MAX + 1
      let sortOrder: number;
      if (typeof body.sort_order === "number") {
        sortOrder = body.sort_order;
      } else {
        const maxRows = await internalQuery<{ max: number | null }>(
          `SELECT MAX(sort_order) as max FROM prompt_items WHERE collection_id = $1`,
          [collectionId],
        );
        sortOrder = (maxRows[0]?.max ?? -1) + 1;
      }

      const rows = await internalQuery<Record<string, unknown>>(
        `INSERT INTO prompt_items (collection_id, question, description, category, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [collectionId, question, description, category, sortOrder],
      );

      return c.json(toPromptItem(rows[0]), 201);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to create prompt item");
      return c.json({ error: "internal_error", message: "Failed to create prompt item.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /:collectionId/items/:itemId — update item
// ---------------------------------------------------------------------------

adminPrompts.patch("/:collectionId/items/:itemId", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const collectionId = c.req.param("collectionId");
      const itemId = c.req.param("itemId");
      const orgId = authResult.user?.activeOrganizationId;

      // Verify collection ownership + not built-in
      let collection: Record<string, unknown>[];
      if (orgId) {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [collectionId, orgId],
        );
      } else {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1`,
          [collectionId],
        );
      }

      if (collection.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      if (collection[0].is_builtin === true) {
        return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);
      }

      // Verify item exists and belongs to collection
      const existingItem = await internalQuery<Record<string, unknown>>(
        `SELECT * FROM prompt_items WHERE id = $1 AND collection_id = $2`,
        [itemId, collectionId],
      );

      if (existingItem.length === 0) {
        return c.json({ error: "not_found", message: "Prompt item not found." }, 404);
      }

      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body");
        return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
      }

      const question = body.question as string | undefined;
      const description = body.description as string | undefined;
      const category = body.category as string | undefined;

      if (question === undefined && description === undefined && category === undefined) {
        return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: question, description, category." }, 400);
      }

      // Build dynamic UPDATE
      const setClauses: string[] = ["updated_at = now()"];
      const updateParams: unknown[] = [];
      let paramIdx = 1;

      if (question !== undefined) {
        updateParams.push(question);
        setClauses.push(`question = $${paramIdx}`);
        paramIdx++;
      }

      if (description !== undefined) {
        updateParams.push(description);
        setClauses.push(`description = $${paramIdx}`);
        paramIdx++;
      }

      if (category !== undefined) {
        updateParams.push(category);
        setClauses.push(`category = $${paramIdx}`);
        paramIdx++;
      }

      updateParams.push(itemId);
      const idIdx = paramIdx;

      const updated = await internalQuery<Record<string, unknown>>(
        `UPDATE prompt_items SET ${setClauses.join(", ")} WHERE id = $${idIdx} RETURNING *`,
        updateParams,
      );

      if (updated.length === 0) {
        return c.json({ error: "not_found", message: "Item was deleted before update completed." }, 404);
      }

      return c.json(toPromptItem(updated[0]));
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update prompt item");
      return c.json({ error: "internal_error", message: "Failed to update prompt item.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /:collectionId/items/:itemId — delete item
// ---------------------------------------------------------------------------

adminPrompts.delete("/:collectionId/items/:itemId", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const collectionId = c.req.param("collectionId");
      const itemId = c.req.param("itemId");
      const orgId = authResult.user?.activeOrganizationId;

      // Verify collection ownership + not built-in
      let collection: Record<string, unknown>[];
      if (orgId) {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [collectionId, orgId],
        );
      } else {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1`,
          [collectionId],
        );
      }

      if (collection.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      if (collection[0].is_builtin === true) {
        return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);
      }

      // Verify item exists
      const existingItem = await internalQuery<Record<string, unknown>>(
        `SELECT id FROM prompt_items WHERE id = $1 AND collection_id = $2`,
        [itemId, collectionId],
      );

      if (existingItem.length === 0) {
        return c.json({ error: "not_found", message: "Prompt item not found." }, 404);
      }

      await internalQuery(
        `DELETE FROM prompt_items WHERE id = $1`,
        [itemId],
      );

      return c.json({ deleted: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete prompt item");
      return c.json({ error: "internal_error", message: "Failed to delete prompt item.", requestId }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/reorder — reorder items within a collection
// ---------------------------------------------------------------------------

adminPrompts.put("/:id/reorder", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: (preamble as { headers?: Record<string, string> }).headers });
  }
  const { authResult } = preamble;

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    try {
      const collectionId = c.req.param("id");
      const orgId = authResult.user?.activeOrganizationId;

      // Verify collection ownership + not built-in
      let collection: Record<string, unknown>[];
      if (orgId) {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`,
          [collectionId, orgId],
        );
      } else {
        collection = await internalQuery<Record<string, unknown>>(
          `SELECT * FROM prompt_collections WHERE id = $1`,
          [collectionId],
        );
      }

      if (collection.length === 0) {
        return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
      }

      if (collection[0].is_builtin === true) {
        return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);
      }

      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse JSON body");
        return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
      }

      const itemIds = body.itemIds as string[] | undefined;

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return c.json({ error: "bad_request", message: "itemIds must be a non-empty array of item IDs." }, 400);
      }

      // Fetch all item IDs for the collection
      const existingItems = await internalQuery<{ id: string }>(
        `SELECT id FROM prompt_items WHERE collection_id = $1`,
        [collectionId],
      );

      const existingIds = new Set(existingItems.map((r) => r.id));
      const providedIds = new Set(itemIds);

      // Verify exact match: same count, same set
      if (existingIds.size !== providedIds.size) {
        return c.json({
          error: "bad_request",
          message: `itemIds count (${providedIds.size}) does not match existing items count (${existingIds.size}). All items must be included.`,
        }, 400);
      }

      for (const id of itemIds) {
        if (!existingIds.has(id)) {
          return c.json({
            error: "bad_request",
            message: `Item ID "${id}" does not belong to this collection.`,
          }, 400);
        }
      }

      // Execute updates sequentially — each UPDATE is individually atomic.
      // No transaction needed: validation above ensures all itemIds are valid,
      // and partial reorder is recoverable (admin can retry).
      for (let i = 0; i < itemIds.length; i++) {
        await internalQuery(
          `UPDATE prompt_items SET sort_order = $1, updated_at = now() WHERE id = $2`,
          [i, itemIds[i]],
        );
      }

      return c.json({ reordered: true });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to reorder prompt items");
      return c.json({ error: "internal_error", message: "Failed to reorder prompt items.", requestId }, 500);
    }
  });
});
