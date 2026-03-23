/**
 * Public prompt library API routes.
 *
 * Mounted at /api/v1/prompts. Available to all authenticated users (not admin-gated).
 * Provides read-only access to prompt collections and items, enabling the
 * prompt library UI. Returns built-in collections plus any belonging to the
 * user's organization.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import type { PromptCollection, PromptItem } from "@useatlas/types";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

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
// Schemas
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listCollectionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Prompts"],
  summary: "List prompt collections",
  description:
    "Returns prompt collections available to the current user: built-in collections plus any belonging to the user's organization.",
  responses: {
    200: {
      description: "List of prompt collections",
      content: {
        "application/json": {
          schema: z.object({ collections: z.array(z.record(z.string(), z.unknown())) }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getCollectionRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Prompts"],
  summary: "Get prompt collection with items",
  description:
    "Returns a single prompt collection with all its items, ordered by sort_order.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "collection-id" }),
    }),
  },
  responses: {
    200: {
      description: "Collection with items",
      content: {
        "application/json": {
          schema: z.object({
            collection: z.record(z.string(), z.unknown()),
            items: z.array(z.record(z.string(), z.unknown())),
          }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Prompt collection not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

export const prompts = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

prompts.use(standardAuth);
prompts.use(requestContext);

// ---------------------------------------------------------------------------
// GET / — list collections (built-in + user's org)
// ---------------------------------------------------------------------------

prompts.openapi(listCollectionsRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ collections: [] }, 200);
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
        `SELECT * FROM prompt_collections WHERE org_id IS NULL ORDER BY sort_order ASC, created_at ASC`,
      );
    }

    return c.json({ collections: rows.map(toPromptCollection) }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list prompt collections");
    return c.json({ error: "internal_error", message: "Failed to list prompt collections.", requestId }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — collection detail with items
// ---------------------------------------------------------------------------

prompts.openapi(getCollectionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_found", message: "Prompt collection not found." }, 404);
  }

  try {
    const { id } = c.req.valid("param");
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
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to get prompt collection");
    return c.json({ error: "internal_error", message: "Failed to get prompt collection.", requestId }, 500);
  }
});
