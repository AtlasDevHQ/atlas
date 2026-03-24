/**
 * Admin prompt library CRUD routes.
 *
 * Mounted under /api/v1/admin/prompts. All routes require admin role.
 * Provides full CRUD for prompt collections and items. Built-in collections
 * (is_builtin = true) are read-only — mutations return 403.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter } from "./admin-router";

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
// Schemas
// ---------------------------------------------------------------------------

const PromptCollectionSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  name: z.string(),
  industry: z.string(),
  description: z.string(),
  isBuiltin: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const PromptItemSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  question: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ListCollectionsResponseSchema = z.object({
  collections: z.array(PromptCollectionSchema),
  total: z.number(),
});

const DeletedSchema = z.object({
  deleted: z.boolean(),
});

const ReorderedSchema = z.object({
  reordered: z.boolean(),
});


// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listCollectionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Prompts"],
  summary: "List prompt collections",
  description:
    "Returns all prompt collections for the admin's active organization, including built-in collections. Ordered by sort_order then created_at.",
  responses: {
    200: {
      description: "List of prompt collections",
      content: { "application/json": { schema: ListCollectionsResponseSchema } },
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

const createCollectionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Prompts"],
  summary: "Create a prompt collection",
  description:
    "Creates a new prompt collection. The handler validates that name and industry are present. The collection is always created as non-built-in.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional().openapi({ description: "Collection name" }),
            industry: z.string().optional().openapi({ description: "Industry category" }),
            description: z.string().optional().openapi({ description: "Optional description" }),
          }).passthrough(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created prompt collection",
      content: { "application/json": { schema: PromptCollectionSchema } },
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
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateCollectionRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Prompts"],
  summary: "Update a prompt collection",
  description:
    "Updates a prompt collection's name, industry, and/or description. Built-in collections cannot be modified.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "abc123" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional().openapi({ description: "New collection name" }),
            industry: z.string().optional().openapi({ description: "New industry category" }),
            description: z.string().optional().openapi({ description: "New description" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated prompt collection",
      content: { "application/json": { schema: PromptCollectionSchema } },
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
      description: "Forbidden — admin role required or built-in collection",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Collection not found or internal database not configured",
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

const deleteCollectionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Prompts"],
  summary: "Delete a prompt collection",
  description:
    "Permanently deletes a prompt collection and cascades to its items. Built-in collections cannot be deleted.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "abc123" }),
    }),
  },
  responses: {
    200: {
      description: "Collection deleted",
      content: { "application/json": { schema: DeletedSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required or built-in collection",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Collection not found or internal database not configured",
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

const createItemRoute = createRoute({
  method: "post",
  path: "/{id}/items",
  tags: ["Admin — Prompts"],
  summary: "Create a prompt item",
  description:
    "Adds a new prompt item to a collection. The collection must not be built-in. Sort order defaults to MAX + 1 if not provided.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, description: "Collection ID", example: "abc123" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            question: z.string().openapi({ description: "Prompt question text" }),
            description: z.string().optional().openapi({ description: "Optional description" }),
            category: z.string().optional().openapi({ description: "Optional category" }),
            sort_order: z.number().optional().openapi({ description: "Sort position (defaults to end)" }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created prompt item",
      content: { "application/json": { schema: PromptItemSchema } },
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
      description: "Forbidden — admin role required or built-in collection",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Collection not found or internal database not configured",
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

const updateItemRoute = createRoute({
  method: "patch",
  path: "/{collectionId}/items/{itemId}",
  tags: ["Admin — Prompts"],
  summary: "Update a prompt item",
  description:
    "Updates a prompt item's question, description, and/or category. The parent collection must not be built-in.",
  request: {
    params: z.object({
      collectionId: z.string().openapi({ param: { name: "collectionId", in: "path" }, example: "abc123" }),
      itemId: z.string().openapi({ param: { name: "itemId", in: "path" }, example: "def456" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            question: z.string().optional().openapi({ description: "New question text" }),
            description: z.string().optional().openapi({ description: "New description" }),
            category: z.string().optional().openapi({ description: "New category" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated prompt item",
      content: { "application/json": { schema: PromptItemSchema } },
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
      description: "Forbidden — admin role required or built-in collection",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Collection or item not found, or internal database not configured",
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

const deleteItemRoute = createRoute({
  method: "delete",
  path: "/{collectionId}/items/{itemId}",
  tags: ["Admin — Prompts"],
  summary: "Delete a prompt item",
  description:
    "Permanently removes a prompt item. The parent collection must not be built-in.",
  request: {
    params: z.object({
      collectionId: z.string().openapi({ param: { name: "collectionId", in: "path" }, example: "abc123" }),
      itemId: z.string().openapi({ param: { name: "itemId", in: "path" }, example: "def456" }),
    }),
  },
  responses: {
    200: {
      description: "Item deleted",
      content: { "application/json": { schema: DeletedSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required or built-in collection",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Collection or item not found, or internal database not configured",
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

const reorderItemsRoute = createRoute({
  method: "put",
  path: "/{id}/reorder",
  tags: ["Admin — Prompts"],
  summary: "Reorder prompt items",
  description:
    "Reorders all items within a collection. The itemIds array must contain every item ID in the collection exactly once.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, description: "Collection ID", example: "abc123" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            itemIds: z.array(z.string()).openapi({ description: "Ordered array of all item IDs in the collection" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Items reordered",
      content: { "application/json": { schema: ReorderedSchema } },
    },
    400: {
      description: "Invalid request body or item ID mismatch",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required or built-in collection",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Collection not found or internal database not configured",
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

export const adminPrompts = createAdminRouter();

// ---------------------------------------------------------------------------
// GET / — list all collections (admin view)
// ---------------------------------------------------------------------------

adminPrompts.openapi(listCollectionsRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

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

    return c.json({ collections: rows.map(toPromptCollection), total: rows.length }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list prompt collections");
    return c.json({ error: "internal_error", message: "Failed to list prompt collections.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST / — create collection
// ---------------------------------------------------------------------------

adminPrompts.openapi(createCollectionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

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

// ---------------------------------------------------------------------------
// PATCH /:id — update collection
// ---------------------------------------------------------------------------

adminPrompts.openapi(updateCollectionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  try {
    const { id } = c.req.valid("param");
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

    return c.json(toPromptCollection(updated[0]), 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update prompt collection");
    return c.json({ error: "internal_error", message: "Failed to update prompt collection.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete collection (cascades to items)
// ---------------------------------------------------------------------------

adminPrompts.openapi(deleteCollectionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt collections requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  try {
    const { id } = c.req.valid("param");
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

    return c.json({ deleted: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete prompt collection");
    return c.json({ error: "internal_error", message: "Failed to delete prompt collection.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/items — add item to collection
// ---------------------------------------------------------------------------

adminPrompts.openapi(createItemRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  try {
    const { id: collectionId } = c.req.valid("param");
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

// ---------------------------------------------------------------------------
// PATCH /:collectionId/items/:itemId — update item
// ---------------------------------------------------------------------------

adminPrompts.openapi(updateItemRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  try {
    const { collectionId, itemId } = c.req.valid("param");
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

    return c.json(toPromptItem(updated[0]), 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update prompt item");
    return c.json({ error: "internal_error", message: "Failed to update prompt item.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:collectionId/items/:itemId — delete item
// ---------------------------------------------------------------------------

adminPrompts.openapi(deleteItemRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  try {
    const { collectionId, itemId } = c.req.valid("param");
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

    return c.json({ deleted: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete prompt item");
    return c.json({ error: "internal_error", message: "Failed to delete prompt item.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /:id/reorder — reorder items within a collection
// ---------------------------------------------------------------------------

adminPrompts.openapi(reorderItemsRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    log.debug({ requestId }, "Prompt items requested but no internal DB configured");
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  try {
    const { id: collectionId } = c.req.valid("param");
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

    return c.json({ reordered: true }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to reorder prompt items");
    return c.json({ error: "internal_error", message: "Failed to reorder prompt items.", requestId }, 500);
  }
});
