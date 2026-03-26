/**
 * Public semantic layer API routes.
 *
 * Mounted at /api/v1/semantic. Available to all authenticated users (not admin-gated).
 * Provides read-only access to entity metadata, enabling the schema explorer UI.
 * Returns all entities defined in the semantic layer YAML files on disk.
 */

import * as path from "path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
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
  return runEffect(c, Effect.sync(() => {
    const root = getSemanticRoot();
    const discovered = discoverEntities(root);
    const entities = discovered.entities.map(({ table, description, columnCount, joinCount, type }) => ({
      table, description, columnCount, joinCount, type: type ?? "",
    }));
    return c.json({
      entities,
      ...(discovered.warnings.length > 0 && { warnings: discovered.warnings }),
    }, 200);
  }), { label: "load entity list" });
});

// GET /entities/{name} — full entity detail
semantic.openapi(getEntityRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

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

    const raw = readYamlFile(filePath);
    return c.json({ entity: raw }, 200);
  }), { label: "parse entity file" });
});
