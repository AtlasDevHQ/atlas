/**
 * Public semantic layer API routes.
 *
 * Mounted at /api/v1/semantic. Available to all authenticated users (not admin-gated).
 * Provides read-only access to entity metadata, enabling the schema explorer UI.
 * Returns all entities defined in the semantic layer YAML files on disk.
 */

import * as path from "path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import {
  getSemanticRoot,
  isValidEntityName,
  readYamlFile,
  discoverEntities,
  findEntityFile,
} from "@atlas/api/lib/semantic/files";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("semantic-routes");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EntitiesListResponseSchema = z.object({
  entities: z.array(z.object({
    table: z.string(),
    description: z.string(),
    columnCount: z.number(),
    joinCount: z.number(),
    type: z.string(),
  })),
  warnings: z.array(z.string()).optional(),
});

const EntityDetailResponseSchema = z.object({
  entity: z.unknown(),
});


// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/entities",
  tags: ["Semantic"],
  summary: "List semantic entities",
  description:
    "Returns a summary of all entity definitions from the semantic layer YAML files. Each entity includes table name, description, column count, join count, and type.",
  responses: {
    200: {
      description: "List of entity summaries",
      content: { "application/json": { schema: EntitiesListResponseSchema } },
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

const getEntityRoute = createRoute({
  method: "get",
  path: "/entities/{name}",
  tags: ["Semantic"],
  summary: "Get entity details",
  description:
    "Returns the full parsed YAML content for a single semantic entity, including all dimensions, measures, joins, and query patterns.",
  request: {
    params: z.object({
      name: z.string().openapi({ param: { name: "name", in: "path" }, example: "orders" }),
    }),
  },
  responses: {
    200: {
      description: "Full entity content",
      content: { "application/json": { schema: EntityDetailResponseSchema } },
    },
    400: {
      description: "Invalid entity name",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Access denied (path traversal attempt)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Entity not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const semantic = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

semantic.use(standardAuth);
semantic.use(requestContext);

// GET /entities — list all entities (public summary: drops measureCount, connection, source)
semantic.openapi(listEntitiesRoute, async (c) => {
  const requestId = c.get("requestId");

  const root = getSemanticRoot();
  try {
    const result = discoverEntities(root);
    const entities = result.entities.map(({ table, description, columnCount, joinCount, type }) => ({
      table, description, columnCount, joinCount, type: type ?? "",
    }));
    return c.json({
      entities,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to discover entities");
    return c.json({ error: "internal_error", message: "Failed to load entity list.", requestId }, 500);
  }
});

// GET /entities/{name} — full entity detail
semantic.openapi(getEntityRoute, async (c) => {
  const requestId = c.get("requestId");

  const { name } = c.req.valid("param");

  if (!isValidEntityName(name)) {
    log.warn({ requestId, name }, "Rejected invalid entity name");
    return c.json({ error: "invalid_request", message: "Invalid entity name." }, 400);
  }

  const root = getSemanticRoot();
  const filePath = findEntityFile(root, name);
  if (!filePath) {
    return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
  }

  // Defense-in-depth: verify resolved path is within semantic root
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root))) {
    log.error({ requestId, name, resolved, root }, "Resolved entity path escaped semantic root");
    return c.json({ error: "forbidden", message: "Access denied.", requestId }, 403);
  }

  try {
    const raw = readYamlFile(filePath);
    return c.json({ entity: raw }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath, entityName: name }, "Failed to parse entity YAML file");
    return c.json({ error: "internal_error", message: `Failed to parse entity file for "${name}".`, requestId }, 500);
  }
});
