/**
 * Admin semantic entity editor routes.
 *
 * Registered directly on the admin router (not as a subrouter) to avoid
 * middleware conflicts with existing /semantic/* routes. Provides structured
 * JSON endpoints for creating, updating, and deleting semantic entities
 * from the web editor.
 *
 * These complement the existing raw-YAML endpoints at /semantic/org/entities/
 * by accepting structured JSON (for the form-based editor) rather than
 * raw YAML strings.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { connections } from "@atlas/api/lib/db/connection";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";

const log = createLogger("admin-semantic-editor");

// ---------------------------------------------------------------------------
// Zod schemas — column metadata
// ---------------------------------------------------------------------------

const ColumnInfoSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean(),
});

const ColumnsResponseSchema = z.object({
  columns: z.array(ColumnInfoSchema),
});

// ---------------------------------------------------------------------------
// Zod schemas — structured entity data
// ---------------------------------------------------------------------------

const DimensionSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  type: z.enum(["string", "number", "date", "boolean", "timestamp"]),
  description: z.string().optional().default(""),
  sample_values: z.array(z.string()).optional().default([]),
  primary_key: z.boolean().optional(),
  foreign_key: z.boolean().optional(),
});

const MeasureSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  type: z.enum(["count", "sum", "avg", "count_distinct", "min", "max"]),
  description: z.string().optional().default(""),
});

const JoinSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  description: z.string().optional().default(""),
});

const QueryPatternSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  sql: z.string().min(1),
});

const EntityBodySchema = z.object({
  table: z.string().min(1),
  description: z.string().optional().default(""),
  dimensions: z.array(DimensionSchema).optional().default([]),
  measures: z.array(MeasureSchema).optional().default([]),
  joins: z.array(JoinSchema).optional().default([]),
  query_patterns: z.array(QueryPatternSchema).optional().default([]),
  connectionId: z.string().optional(),
});

export type EntityBody = z.infer<typeof EntityBodySchema>;

const EntityResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  entityType: z.string(),
});

// ---------------------------------------------------------------------------
// Zod schemas — version history
// ---------------------------------------------------------------------------

const VersionSummarySchema = z.object({
  id: z.string(),
  versionNumber: z.number(),
  changeSummary: z.string().nullable(),
  authorId: z.string().nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.string(),
});

const VersionListResponseSchema = z.object({
  versions: z.array(VersionSummarySchema),
  total: z.number(),
});

const VersionDetailSchema = VersionSummarySchema.extend({
  name: z.string(),
  entityType: z.string(),
  yamlContent: z.string(),
});

const VersionDetailResponseSchema = z.object({
  version: VersionDetailSchema,
});

const RollbackBodySchema = z.object({
  versionId: z.string().uuid(),
});

const RollbackResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  versionNumber: z.number(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert structured entity data to YAML string.
 * Uses js-yaml's dump() for reliable serialization.
 */
async function entityToYaml(entity: EntityBody): Promise<string> {
  const yaml = await import("js-yaml");

  // Build the object in the canonical YAML order
  const obj: Record<string, unknown> = {
    table: entity.table,
  };
  if (entity.description) {
    obj.description = entity.description;
  }
  if (entity.dimensions.length > 0) {
    obj.dimensions = entity.dimensions.map((d) => {
      const dim: Record<string, unknown> = {
        name: d.name,
        sql: d.sql,
        type: d.type,
      };
      if (d.description) dim.description = d.description;
      if (d.sample_values && d.sample_values.length > 0) dim.sample_values = d.sample_values;
      if (d.primary_key) dim.primary_key = true;
      if (d.foreign_key) dim.foreign_key = true;
      return dim;
    });
  }
  if (entity.measures.length > 0) {
    obj.measures = entity.measures.map((m) => {
      const measure: Record<string, unknown> = {
        name: m.name,
        sql: m.sql,
        type: m.type,
      };
      if (m.description) measure.description = m.description;
      return measure;
    });
  }
  if (entity.joins.length > 0) {
    obj.joins = entity.joins.map((j) => {
      const join: Record<string, unknown> = {
        name: j.name,
        sql: j.sql,
      };
      if (j.description) join.description = j.description;
      return join;
    });
  }
  if (entity.query_patterns.length > 0) {
    obj.query_patterns = entity.query_patterns.map((p) => {
      const pattern: Record<string, unknown> = {
        name: p.name,
        sql: p.sql,
      };
      if (p.description) pattern.description = p.description;
      return pattern;
    });
  }

  return yaml.dump(obj, { lineWidth: 120, noRefs: true });
}

// ---------------------------------------------------------------------------
// Route definitions (exported for registration on parent admin router)
// ---------------------------------------------------------------------------

export const putStructuredEntityRoute = createRoute({
  method: "put",
  path: "/semantic/entities/edit/{name}",
  tags: ["Admin — Semantic"],
  summary: "Create or update a semantic entity (structured)",
  description:
    "Accepts structured entity JSON (table, dimensions, measures, joins, query_patterns), " +
    "converts to YAML, and stores in the org-scoped semantic_entities table. " +
    "Triggers semantic index rebuild for the workspace.",
  request: {
    params: createParamSchema("name", "users"),
    body: {
      content: {
        "application/json": { schema: EntityBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Entity created or updated",
      content: { "application/json": { schema: EntityResponseSchema } },
    },
    400: {
      description: "Invalid request body or entity name",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const deleteStructuredEntityRoute = createRoute({
  method: "delete",
  path: "/semantic/entities/edit/{name}",
  tags: ["Admin — Semantic"],
  summary: "Delete a semantic entity",
  description: "Deletes the named entity from the org-scoped semantic_entities table and disk.",
  request: {
    params: createParamSchema("name", "users"),
  },
  responses: {
    200: {
      description: "Entity deleted",
      content: { "application/json": { schema: EntityResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Entity not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const getColumnsRoute = createRoute({
  method: "get",
  path: "/semantic/columns/{tableName}",
  tags: ["Admin — Semantic"],
  summary: "Get column metadata for a datasource table",
  description:
    "Queries the connected analytics datasource's information_schema to return " +
    "column names, types, and nullability for the given table. Org-scoped.",
  request: {
    params: createParamSchema("tableName", "users"),
  },
  responses: {
    200: {
      description: "Column metadata",
      content: { "application/json": { schema: ColumnsResponseSchema } },
    },
    400: {
      description: "Invalid table name",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Table not found in datasource",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Route definitions — version history
// ---------------------------------------------------------------------------

export const getEntityVersionsRoute = createRoute({
  method: "get",
  path: "/semantic/entities/{name}/versions",
  tags: ["Admin — Semantic"],
  summary: "List versions for a semantic entity",
  description: "Returns paginated version history for the named entity, ordered newest first.",
  request: {
    params: createParamSchema("name", "users"),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }),
  },
  responses: {
    200: {
      description: "Version list",
      content: { "application/json": { schema: VersionListResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const getVersionDetailRoute = createRoute({
  method: "get",
  path: "/semantic/entities/versions/{versionId}",
  tags: ["Admin — Semantic"],
  summary: "Get a single version with full YAML content",
  request: {
    params: createParamSchema("versionId", "550e8400-e29b-41d4-a716-446655440000"),
  },
  responses: {
    200: {
      description: "Version detail",
      content: { "application/json": { schema: VersionDetailResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Version not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const postRollbackRoute = createRoute({
  method: "post",
  path: "/semantic/entities/{name}/rollback",
  tags: ["Admin — Semantic"],
  summary: "Rollback an entity to a previous version",
  description:
    "Restores the entity's YAML content from the specified version. " +
    "Creates a new version snapshot recording the rollback.",
  request: {
    params: createParamSchema("name", "users"),
    body: {
      content: {
        "application/json": { schema: RollbackBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Entity rolled back",
      content: { "application/json": { schema: RollbackResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Version or entity not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description: "Internal database not available",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Auth function type
// ---------------------------------------------------------------------------

type AdminAuthFn = (c: { req: { raw: Request }; get(key: string): unknown }) => Promise<{
  authResult: AuthResult & { authenticated: true };
  requestId: string;
}>;

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register structured semantic entity editor routes on the admin router.
 *
 * Registered directly (not as subrouter) to avoid middleware conflicts
 * with existing /semantic/* routes. Uses `runHandler` + `adminAuthAndContext`
 * to match the admin.ts handler pattern (the main admin router doesn't
 * use the createAdminRouter middleware chain).
 *
 * @param admin - The main admin OpenAPIHono router
 * @param authFn - The `adminAuthAndContext` function from admin.ts
 */
export function registerSemanticEditorRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- admin.ts uses untyped OpenAPIHono; typed generics would require matching the exact Env
  admin: OpenAPIHono<any>,
  authFn: AdminAuthFn,
): void {
  // PUT /semantic/entities/edit/{name} — structured entity create/update
  admin.openapi(putStructuredEntityRoute, async (c) =>
    runHandler(c, "save structured semantic entity", async () => {
      const { name } = c.req.valid("param");
      const body = c.req.valid("json");
      const { authResult, requestId } = await authFn(c);

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Semantic entity editor requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      // Convert structured data to YAML
      const yamlContent = await entityToYaml(body);

      // Store in DB
      const { upsertEntity, getEntity, createVersion, generateChangeSummary } = await import("@atlas/api/lib/semantic/entities");

      // Fetch previous version for change summary (before upsert overwrites it)
      const previousEntity = await getEntity(orgId, "entity", name);
      const oldYaml = previousEntity?.yaml_content ?? null;

      await upsertEntity(orgId, "entity", name, yamlContent, body.connectionId);

      // Create version snapshot — non-fatal
      try {
        const entity = await getEntity(orgId, "entity", name);
        if (entity) {
          const changeSummary = await generateChangeSummary(oldYaml, yamlContent);
          await createVersion(
            entity.id, orgId, "entity", name, yamlContent, changeSummary,
            authResult.user?.id ?? null, authResult.user?.label ?? null,
          );
        }
      } catch (versionErr) {
        log.warn(
          { err: versionErr instanceof Error ? versionErr.message : String(versionErr), requestId, orgId, name },
          "Entity saved but version snapshot failed — version history may be incomplete",
        );
      }

      // Invalidate caches
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      invalidateOrgWhitelist(orgId);

      // Sync to disk — non-fatal; DB is authoritative
      try {
        const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
        await syncEntityToDisk(orgId, name, "entity", yamlContent);
      } catch (syncErr) {
        log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, name },
          "Entity saved to DB but disk sync failed — will be synced on next restart",
        );
      }

      log.info({ requestId, orgId, name }, "Semantic entity upserted via editor");

      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.updateEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, source: "editor" },
      });

      return c.json({ ok: true, name, entityType: "entity" }, 200);
    }),
  );

  // DELETE /semantic/entities/edit/{name} — entity delete
  admin.openapi(deleteStructuredEntityRoute, async (c) =>
    runHandler(c, "delete semantic entity", async () => {
      const { name } = c.req.valid("param");
      const { authResult, requestId } = await authFn(c);

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Semantic entity editor requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const { deleteEntity } = await import("@atlas/api/lib/semantic/entities");
      const deleted = await deleteEntity(orgId, "entity", name);

      if (!deleted) {
        return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
      }

      // Invalidate caches
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      invalidateOrgWhitelist(orgId);

      // Sync deletion to disk — non-fatal; DB is authoritative
      try {
        const { syncEntityDeleteFromDisk } = await import("@atlas/api/lib/semantic/sync");
        await syncEntityDeleteFromDisk(orgId, name, "entity");
      } catch (syncErr) {
        log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, name },
          "Entity deleted from DB but disk sync failed — will be cleaned on next restart",
        );
      }

      log.info({ requestId, orgId, name }, "Semantic entity deleted via editor");

      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.deleteEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, source: "editor" },
      });

      return c.json({ ok: true, name, entityType: "entity" }, 200);
    }),
  );

  // GET /semantic/columns/{tableName} — column metadata from analytics datasource
  admin.openapi(getColumnsRoute, async (c) =>
    runHandler(c, "get table columns", async () => {
      const { tableName } = c.req.valid("param");
      const { authResult, requestId } = await authFn(c);

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
      }

      // Validate table name as a SQL identifier to prevent injection.
      // Only letters, digits, underscores, and dots (for schema.table) are allowed.
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(tableName)) {
        return c.json({ error: "invalid_table_name", message: "Table name must be a valid SQL identifier (letters, digits, underscores)." }, 400);
      }

      // Get the org-scoped connection from the singleton registry
      let conn;
      let dbType;
      try {
        conn = connections.getForOrg(orgId, "default");
        dbType = connections.getDBType("default");
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), requestId, orgId },
          "Failed to get datasource connection for column metadata",
        );
        return c.json({ error: "datasource_unavailable", message: "No analytics datasource is connected. Configure a datasource to enable column autocomplete.", requestId }, 500);
      }

      // Split schema-qualified names (e.g. "public.users" → schema="public", table="users")
      // and escape single quotes for the WHERE clause string literal
      const parts = tableName.split(".");
      const rawTable = parts.length > 1 ? parts[parts.length - 1] : tableName;
      const rawSchema = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
      const escapedTable = rawTable.replace(/'/g, "''");
      const escapedSchema = rawSchema?.replace(/'/g, "''") ?? null;

      try {
        let queryResult;
        if (dbType === "mysql") {
          const schemaClause = escapedSchema
            ? `TABLE_SCHEMA = '${escapedSchema}'`
            : "TABLE_SCHEMA = DATABASE()";
          queryResult = await conn.query(
            `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE ${schemaClause} AND TABLE_NAME = '${escapedTable}' ORDER BY ORDINAL_POSITION`,
            10000,
          );
        } else {
          const schemaClause = escapedSchema
            ? `table_schema = '${escapedSchema}'`
            : "table_schema = current_schema()";
          queryResult = await conn.query(
            `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_name = '${escapedTable}' AND ${schemaClause} ORDER BY ordinal_position`,
            10000,
          );
        }

        if (queryResult.rows.length === 0) {
          return c.json({ error: "not_found", message: `Table "${tableName}" not found in the connected datasource.` }, 404);
        }

        const columns = queryResult.rows.map((row) => ({
          name: String(row.name ?? ""),
          type: String(row.type ?? ""),
          nullable: String(row.nullable ?? "YES").toUpperCase() === "YES",
        }));

        return c.json({ columns }, 200);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), requestId, orgId, tableName },
          "Failed to query column metadata",
        );
        return c.json({ error: "query_failed", message: `Failed to query column metadata for "${tableName}". The table may not exist or the datasource may be unavailable.`, requestId }, 500);
      }
    }),
  );

  // ---------------------------------------------------------------------------
  // Version history routes
  // ---------------------------------------------------------------------------

  // GET /semantic/entities/{name}/versions — list versions
  admin.openapi(getEntityVersionsRoute, async (c) =>
    runHandler(c, "list entity versions", async () => {
      const { name } = c.req.valid("param");
      const { limit, offset } = c.req.valid("query");
      const { authResult, requestId } = await authFn(c);

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Version history requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const { listVersions } = await import("@atlas/api/lib/semantic/entities");
      const { versions, total } = await listVersions(orgId, "entity", name, limit, offset);

      return c.json({
        versions: versions.map((v) => ({
          id: String(v.id),
          versionNumber: Number(v.version_number),
          changeSummary: v.change_summary as string | null,
          authorId: v.author_id as string | null,
          authorLabel: v.author_label as string | null,
          createdAt: String(v.created_at),
        })),
        total,
      }, 200);
    }),
  );

  // GET /semantic/entities/versions/{versionId} — version detail
  admin.openapi(getVersionDetailRoute, async (c) =>
    runHandler(c, "get entity version detail", async () => {
      const { versionId } = c.req.valid("param");
      const { authResult, requestId } = await authFn(c);

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Version history requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const { getVersion } = await import("@atlas/api/lib/semantic/entities");
      const version = await getVersion(versionId, orgId);

      if (!version) {
        return c.json({ error: "not_found", message: `Version "${versionId}" not found.` }, 404);
      }

      return c.json({
        version: {
          id: String(version.id),
          versionNumber: Number(version.version_number),
          name: String(version.name),
          entityType: String(version.entity_type),
          yamlContent: String(version.yaml_content),
          changeSummary: version.change_summary as string | null,
          authorId: version.author_id as string | null,
          authorLabel: version.author_label as string | null,
          createdAt: String(version.created_at),
        },
      }, 200);
    }),
  );

  // POST /semantic/entities/{name}/rollback — rollback to version
  admin.openapi(postRollbackRoute, async (c) =>
    runHandler(c, "rollback semantic entity", async () => {
      const { name } = c.req.valid("param");
      const { versionId } = c.req.valid("json");
      const { authResult, requestId } = await authFn(c);

      const orgId = authResult.user?.activeOrganizationId;
      if (!orgId) {
        return c.json({ error: "org_not_found", message: "No active organization. Select an organization and try again." }, 400);
      }

      if (!hasInternalDB()) {
        return c.json({ error: "not_available", message: "Rollback requires an internal database (DATABASE_URL).", requestId }, 501);
      }

      const { getVersion, getEntity, upsertEntity, createVersion, generateChangeSummary } = await import("@atlas/api/lib/semantic/entities");

      // Fetch the target version
      const targetVersion = await getVersion(versionId, orgId);
      if (!targetVersion || targetVersion.name !== name) {
        return c.json({ error: "not_found", message: `Version "${versionId}" not found for entity "${name}".` }, 404);
      }

      // Get current entity for change summary
      const currentEntity = await getEntity(orgId, "entity", name);
      const currentYaml = currentEntity?.yaml_content ?? null;

      // Upsert entity with the target version's YAML
      await upsertEntity(orgId, "entity", name, targetVersion.yaml_content, currentEntity?.connection_id ?? undefined);

      // Create a new version snapshot for the rollback
      let newVersionNumber = 0;
      try {
        const entity = await getEntity(orgId, "entity", name);
        if (entity) {
          const changeSummary = await generateChangeSummary(currentYaml, targetVersion.yaml_content);
          const rollbackSummary = `Rolled back to v${targetVersion.version_number}${changeSummary ? ` (${changeSummary})` : ""}`;
          const vid = await createVersion(
            entity.id, orgId, "entity", name, targetVersion.yaml_content, rollbackSummary,
            authResult.user?.id ?? null, authResult.user?.label ?? null,
          );
          // Fetch the version we just created to get its number
          const newVersion = await getVersion(vid, orgId);
          newVersionNumber = newVersion?.version_number ?? 0;
        }
      } catch (versionErr) {
        log.warn(
          { err: versionErr instanceof Error ? versionErr.message : String(versionErr), requestId, orgId, name },
          "Rollback succeeded but version snapshot failed",
        );
      }

      // Invalidate caches
      const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");
      invalidateOrgWhitelist(orgId);

      // Sync to disk — non-fatal
      try {
        const { syncEntityToDisk } = await import("@atlas/api/lib/semantic/sync");
        await syncEntityToDisk(orgId, name, "entity", targetVersion.yaml_content);
      } catch (syncErr) {
        log.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr), requestId, orgId, name },
          "Rollback succeeded but disk sync failed — will be synced on next restart",
        );
      }

      log.info({ requestId, orgId, name, targetVersion: targetVersion.version_number }, "Semantic entity rolled back");

      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.updateEntity,
        targetType: "semantic",
        targetId: name,
        ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
        metadata: { name, action: "rollback", targetVersion: targetVersion.version_number },
      });

      return c.json({ ok: true, name, versionNumber: newVersionNumber }, 200);
    }),
  );
}
