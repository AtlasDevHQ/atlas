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
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";

const log = createLogger("admin-semantic-editor");

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
      const { upsertEntity } = await import("@atlas/api/lib/semantic/entities");
      await upsertEntity(orgId, "entity", name, yamlContent, body.connectionId);

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
      return c.json({ ok: true, name, entityType: "entity" }, 200);
    }),
  );
}
