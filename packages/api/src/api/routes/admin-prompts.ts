/**
 * Admin prompt library CRUD routes.
 *
 * Mounted under /api/v1/admin/prompts. All routes require admin role.
 * Provides full CRUD for prompt collections and items. Built-in collections
 * (is_builtin = true) are read-only — mutations return 403.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema, createIdParamSchema, createParamSchema, createListResponseSchema, DeletedResponseSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

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
    status: (() => {
      const s = row.status as PromptCollection["status"] | undefined;
      if (s === undefined) {
        log.warn({ collectionId: row.id }, "Prompt collection missing status column — defaulting to published");
        return "published" as const;
      }
      return s;
    })(),
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
  status: z.string(),
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

const ListCollectionsResponseSchema = createListResponseSchema("collections", PromptCollectionSchema);

const DeletedSchema = DeletedResponseSchema;

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
    params: createIdParamSchema(),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            industry: z.string().optional(),
            description: z.string().optional(),
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
    params: createIdParamSchema(),
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
    params: createIdParamSchema(),
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
    params: createParamSchema("collectionId").merge(createParamSchema("itemId", "def456")),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            question: z.string().optional(),
            description: z.string().optional(),
            category: z.string().optional(),
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
    params: createParamSchema("collectionId").merge(createParamSchema("itemId", "def456")),
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
    params: createIdParamSchema(),
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

adminPrompts.use(requireOrgContext());

// Helper to look up collection with org scoping
async function findCollection(orgId: string | undefined, collectionId: string) {
  if (orgId) {
    return internalQuery<Record<string, unknown>>(`SELECT * FROM prompt_collections WHERE id = $1 AND (org_id IS NULL OR org_id = $2)`, [collectionId, orgId]);
  }
  return internalQuery<Record<string, unknown>>(`SELECT * FROM prompt_collections WHERE id = $1`, [collectionId]);
}

// GET / — list all collections
adminPrompts.openapi(listCollectionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { atlasMode } = yield* RequestContext;

    const statusClause = atlasMode === "published" ? " AND status = 'published'" : "";

    let rows: Record<string, unknown>[];
    if (orgId) {
      rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`SELECT * FROM prompt_collections WHERE (org_id IS NULL OR org_id = $1)${statusClause} ORDER BY sort_order ASC, created_at ASC`, [orgId]));
    } else {
      rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`SELECT * FROM prompt_collections WHERE 1=1${statusClause} ORDER BY sort_order ASC, created_at ASC`));
    }
    return c.json({ collections: rows.map(toPromptCollection), total: rows.length }, 200);
  }), { label: "list prompt collections" });
});

// POST / — create collection
adminPrompts.openapi(createCollectionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const bodyResult = yield* Effect.tryPromise({
      try: () => c.req.json() as Promise<Record<string, unknown>>,
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") { log.warn({ err: bodyResult.left.message, requestId }, "Failed to parse JSON body"); return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400); }
    const body = bodyResult.right;

    const name = body.name as string | undefined;
    const industry = body.industry as string | undefined;
    const description = (body.description as string) ?? "";
    if (!name || typeof name !== "string") return c.json({ error: "bad_request", message: "name is required and must be a string." }, 400);
    if (!industry || typeof industry !== "string") return c.json({ error: "bad_request", message: "industry is required and must be a string." }, 400);

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`INSERT INTO prompt_collections (org_id, name, industry, description, is_builtin) VALUES ($1, $2, $3, $4, false) RETURNING *`, [orgId ?? null, name, industry, description]));
    return c.json(toPromptCollection(rows[0]), 201);
  }), { label: "create prompt collection" });
});

// PATCH /:id — update collection
adminPrompts.openapi(updateCollectionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    const existing = yield* Effect.promise(() => findCollection(orgId, id));
    if (existing.length === 0) return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
    if (existing[0].is_builtin === true) return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);

    const bodyResult = yield* Effect.tryPromise({
      try: () => c.req.json() as Promise<Record<string, unknown>>,
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") { log.warn({ err: bodyResult.left.message, requestId }, "Failed to parse JSON body"); return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400); }
    const body = bodyResult.right;

    const name = body.name as string | undefined;
    const industry = body.industry as string | undefined;
    const description = body.description as string | undefined;
    if (name === undefined && industry === undefined && description === undefined) return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: name, industry, description." }, 400);

    const setClauses: string[] = ["updated_at = now()"];
    const updateParams: unknown[] = [];
    let paramIdx = 1;
    if (name !== undefined) { updateParams.push(name); setClauses.push(`name = $${paramIdx}`); paramIdx++; }
    if (industry !== undefined) { updateParams.push(industry); setClauses.push(`industry = $${paramIdx}`); paramIdx++; }
    if (description !== undefined) { updateParams.push(description); setClauses.push(`description = $${paramIdx}`); paramIdx++; }
    updateParams.push(id);
    const idIdx = paramIdx;

    const updated = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`UPDATE prompt_collections SET ${setClauses.join(", ")} WHERE id = $${idIdx} RETURNING *`, updateParams));
    if (updated.length === 0) return c.json({ error: "not_found", message: "Collection was deleted before update completed." }, 404);
    return c.json(toPromptCollection(updated[0]), 200);
  }), { label: "update prompt collection" });
});

// DELETE /:id — delete collection
adminPrompts.openapi(deleteCollectionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id } = c.req.valid("param");
    const existing = yield* Effect.promise(() => findCollection(orgId, id));
    if (existing.length === 0) return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
    if (existing[0].is_builtin === true) return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);

    yield* Effect.promise(() => internalQuery(`DELETE FROM prompt_collections WHERE id = $1`, [id]));
    return c.json({ deleted: true }, 200);
  }), { label: "delete prompt collection" });
});

// POST /:id/items — add item
adminPrompts.openapi(createItemRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id: collectionId } = c.req.valid("param");
    const collection = yield* Effect.promise(() => findCollection(orgId, collectionId));
    if (collection.length === 0) return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
    if (collection[0].is_builtin === true) return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);

    const bodyResult = yield* Effect.tryPromise({
      try: () => c.req.json() as Promise<Record<string, unknown>>,
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") { log.warn({ err: bodyResult.left.message, requestId }, "Failed to parse JSON body"); return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400); }
    const body = bodyResult.right;

    const question = body.question as string | undefined;
    const description = (body.description as string) ?? null;
    const category = (body.category as string) ?? null;
    if (!question || typeof question !== "string") return c.json({ error: "bad_request", message: "question is required and must be a string." }, 400);

    let sortOrder: number;
    if (typeof body.sort_order === "number") { sortOrder = body.sort_order; } else {
      const maxRows = yield* Effect.promise(() => internalQuery<{ max: number | null }>(`SELECT MAX(sort_order) as max FROM prompt_items WHERE collection_id = $1`, [collectionId]));
      sortOrder = (maxRows[0]?.max ?? -1) + 1;
    }

    const rows = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`INSERT INTO prompt_items (collection_id, question, description, category, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [collectionId, question, description, category, sortOrder]));
    return c.json(toPromptItem(rows[0]), 201);
  }), { label: "create prompt item" });
});

// PATCH /:collectionId/items/:itemId — update item
adminPrompts.openapi(updateItemRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { collectionId, itemId } = c.req.valid("param");
    const collection = yield* Effect.promise(() => findCollection(orgId, collectionId));
    if (collection.length === 0) return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
    if (collection[0].is_builtin === true) return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);

    const existingItem = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`SELECT * FROM prompt_items WHERE id = $1 AND collection_id = $2`, [itemId, collectionId]));
    if (existingItem.length === 0) return c.json({ error: "not_found", message: "Prompt item not found." }, 404);

    const bodyResult = yield* Effect.tryPromise({
      try: () => c.req.json() as Promise<Record<string, unknown>>,
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") { log.warn({ err: bodyResult.left.message, requestId }, "Failed to parse JSON body"); return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400); }
    const body = bodyResult.right;

    const question = body.question as string | undefined;
    const description = body.description as string | undefined;
    const category = body.category as string | undefined;
    if (question === undefined && description === undefined && category === undefined) return c.json({ error: "bad_request", message: "No recognized fields to update. Supported: question, description, category." }, 400);

    const setClauses: string[] = ["updated_at = now()"];
    const updateParams: unknown[] = [];
    let paramIdx = 1;
    if (question !== undefined) { updateParams.push(question); setClauses.push(`question = $${paramIdx}`); paramIdx++; }
    if (description !== undefined) { updateParams.push(description); setClauses.push(`description = $${paramIdx}`); paramIdx++; }
    if (category !== undefined) { updateParams.push(category); setClauses.push(`category = $${paramIdx}`); paramIdx++; }
    updateParams.push(itemId);
    const idIdx = paramIdx;

    const updated = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`UPDATE prompt_items SET ${setClauses.join(", ")} WHERE id = $${idIdx} RETURNING *`, updateParams));
    if (updated.length === 0) return c.json({ error: "not_found", message: "Item was deleted before update completed." }, 404);
    return c.json(toPromptItem(updated[0]), 200);
  }), { label: "update prompt item" });
});

// DELETE /:collectionId/items/:itemId — delete item
adminPrompts.openapi(deleteItemRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { collectionId, itemId } = c.req.valid("param");
    const collection = yield* Effect.promise(() => findCollection(orgId, collectionId));
    if (collection.length === 0) return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
    if (collection[0].is_builtin === true) return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);

    const existingItem = yield* Effect.promise(() => internalQuery<Record<string, unknown>>(`SELECT id FROM prompt_items WHERE id = $1 AND collection_id = $2`, [itemId, collectionId]));
    if (existingItem.length === 0) return c.json({ error: "not_found", message: "Prompt item not found." }, 404);

    yield* Effect.promise(() => internalQuery(`DELETE FROM prompt_items WHERE id = $1`, [itemId]));
    return c.json({ deleted: true }, 200);
  }), { label: "delete prompt item" });
});

// PUT /:id/reorder — reorder items
adminPrompts.openapi(reorderItemsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;

    const { id: collectionId } = c.req.valid("param");
    const collection = yield* Effect.promise(() => findCollection(orgId, collectionId));
    if (collection.length === 0) return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
    if (collection[0].is_builtin === true) return c.json({ error: "forbidden", message: "Built-in collections cannot be modified.", requestId }, 403);

    const bodyResult = yield* Effect.tryPromise({
      try: () => c.req.json() as Promise<Record<string, unknown>>,
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.either);
    if (bodyResult._tag === "Left") { log.warn({ err: bodyResult.left.message, requestId }, "Failed to parse JSON body"); return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400); }
    const body = bodyResult.right;

    const itemIds = body.itemIds as string[] | undefined;
    if (!Array.isArray(itemIds) || itemIds.length === 0) return c.json({ error: "bad_request", message: "itemIds must be a non-empty array of item IDs." }, 400);

    const existingItems = yield* Effect.promise(() => internalQuery<{ id: string }>(`SELECT id FROM prompt_items WHERE collection_id = $1`, [collectionId]));
    const existingIds = new Set(existingItems.map((r) => r.id));
    const providedIds = new Set(itemIds);

    if (existingIds.size !== providedIds.size) return c.json({ error: "bad_request", message: `itemIds count (${providedIds.size}) does not match existing items count (${existingIds.size}). All items must be included.` }, 400);
    for (const id of itemIds) { if (!existingIds.has(id)) return c.json({ error: "bad_request", message: `Item ID "${id}" does not belong to this collection.` }, 400); }

    for (let i = 0; i < itemIds.length; i++) {
      yield* Effect.promise(() => internalQuery(`UPDATE prompt_items SET sort_order = $1, updated_at = now() WHERE id = $2`, [i, itemIds[i]]));
    }
    return c.json({ reordered: true }, 200);
  }), { label: "reorder prompt items" });
});
