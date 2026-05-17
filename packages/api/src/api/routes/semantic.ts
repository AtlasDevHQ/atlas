/**
 * Public semantic layer API routes.
 *
 * Mounted at /api/v1/semantic. Available to all authenticated users (not admin-gated).
 * Provides read-only access to entity metadata, enabling the schema explorer UI.
 *
 * Reads via `listAdminEntities` / `getAdminEntity` so the file-tree, the
 * `/admin/semantic` editor, and the chat schema explorer all stay in
 * lockstep on what counts as a queryable entity. Both orchestrators
 * follow the source rule documented in `admin-source.ts`: the internal
 * DB is canonical when present; the per-org disk mirror is the fallback
 * exclusively for pure-YAML self-hosted (no internal DB).
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  listAdminEntities,
  getAdminEntity,
  AdminEntityYamlParseError,
  AdminEntityYamlShapeError,
} from "@atlas/api/lib/semantic/admin-source";
// Import from the effect/errors barrel (where the class is defined), not
// from the `entities.ts` re-export. Partial-mock tests in adjacent test
// files already cover the effect/errors path; importing from entities would
// require every one of those tests to add an `AmbiguousEntityError` stub.
import { AmbiguousEntityError } from "@atlas/api/lib/effect/errors";
import { isValidEntityName } from "@atlas/api/lib/semantic/files";
import { validationHook } from "./validation-hook";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("semantic-routes");

/**
 * Effective mode for the public route. Mirrors admin.ts's reader: defaults
 * to `published` when the middleware-published value is absent, and lets
 * admins/owners read drafts when their session has elected developer mode.
 * Non-admin requests resolve to `published` regardless of cookie/header
 * (enforced by `resolveMode` in middleware.ts).
 */
const getAtlasMode = (c: { get(key: string): unknown }): "developer" | "published" => {
  const raw = c.get("atlasMode") as string | undefined;
  return raw === "developer" ? "developer" : "published";
};

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

const AmbiguousEntityResponseSchema = z.object({
  error: z.literal("entity_ambiguous"),
  message: z.string(),
  groups: z.array(z.string().nullable()),
  requestId: z.string(),
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
    "Returns a summary of all entity definitions visible to the workspace — DB-overlay rows merged with on-disk YAML files. DB rows shadow disk entries on name collision. Each entity includes table name, description, column count, join count, and type.",
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
    "Returns the full parsed YAML content for a single semantic entity, including all dimensions, measures, joins, and query patterns. Resolves through the same overlay-aware path as the list endpoint — DB rows shadow disk entries on name collision.",
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
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Access denied (path traversal attempt)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Entity not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "Entity name exists in multiple connection groups — disambiguation is not yet exposed on the public route; use /admin/semantic to resolve.",
      content: { "application/json": { schema: AmbiguousEntityResponseSchema } },
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
  const authResult = c.get("authResult");
  const orgId = authResult?.user?.activeOrganizationId;
  const mode = getAtlasMode(c);

  try {
    const result = await listAdminEntities({ orgId, mode });
    const entities = result.entities.map(({ table, description, columnCount, joinCount, type }) => ({
      table,
      description,
      columnCount,
      joinCount,
      type: type ?? "",
    }));
    return c.json({
      entities,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), orgId, mode, requestId },
      "Failed to list semantic entities",
    );
    return c.json({ error: "internal_error", message: "Failed to load entity list.", requestId }, 500);
  }
});

// GET /entities/{name} — full entity detail
semantic.openapi(getEntityRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");
  const orgId = authResult?.user?.activeOrganizationId;
  const { name } = c.req.valid("param");

  if (!isValidEntityName(name)) {
    log.warn({ requestId, name }, "Rejected invalid entity name");
    return c.json({ error: "invalid_request", message: "Invalid entity name.", requestId }, 400);
  }

  try {
    // Thread mode through so non-admin callers in `published` mode can't
    // see drafts when an admin is mid-edit on the same entity (#2481).
    const result = await getAdminEntity({ name, orgId, requestId, mode: getAtlasMode(c) });
    if (!result) {
      return c.json({ error: "not_found", message: `Entity "${name}" not found.`, requestId }, 404);
    }
    return c.json({ entity: result.entity }, 200);
  } catch (err) {
    if (err instanceof AmbiguousEntityError) {
      // Multi-group orgs need to disambiguate via the admin endpoint — the
      // public surface intentionally doesn't carry a `connectionGroupId`
      // param. Surface 409 with the same shape the admin route uses so a
      // future schema-explorer enhancement can react.
      return c.json(
        {
          error: "entity_ambiguous" as const,
          message: err.message,
          groups: [...err.groups],
          requestId,
        },
        409,
      );
    }
    if (err instanceof AdminEntityYamlParseError || err instanceof AdminEntityYamlShapeError) {
      const message = err instanceof AdminEntityYamlParseError
        ? (err.entitySource === "db"
            ? `Failed to parse entity content for "${name}".`
            : `Failed to parse entity file for "${name}".`)
        : `Entity content for "${name}" is malformed.`;
      log.error(
        { err, entityName: name, source: err.entitySource, requestId },
        "Public detail: admin entity yaml error",
      );
      return c.json({ error: "internal_error", message, requestId }, 500);
    }
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), entityName: name, orgId, requestId },
      "Failed to resolve entity",
    );
    return c.json({ error: "internal_error", message: `Failed to load entity "${name}".`, requestId }, 500);
  }
});
