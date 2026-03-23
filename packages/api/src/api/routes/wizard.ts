/**
 * Semantic layer setup wizard API routes.
 *
 * Mounted at /api/v1/wizard. Requires admin role.
 * Powers the guided semantic layer setup UI — a web replacement for `atlas init`.
 *
 * Flow: profile → generate → preview → save
 *
 * 1. POST /profile — List tables/views from a connected datasource
 * 2. POST /generate — Profile selected tables + generate entity YAML
 * 3. POST /preview — Preview agent behavior with generated entities
 * 4. POST /save — Persist entities to org-scoped semantic layer
 */

import * as fs from "fs";
import * as path from "path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { validationHook } from "./validation-hook";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, decryptUrl } from "@atlas/api/lib/db/internal";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { syncEntityToDisk } from "@atlas/api/lib/semantic-sync";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import {
  type ProfilingResult,
  OBJECT_TYPES,
  FK_SOURCES,
  PARTITION_STRATEGIES,
  listPostgresObjects,
  listMySQLObjects,
  profilePostgres,
  profileMySQL,
  analyzeTableProfiles,
  generateEntityYAML,
  generateCatalogYAML,
  generateGlossaryYAML,
  generateMetricYAML,
  outputDirForDatasource,
} from "@atlas/api/lib/profiler";

const log = createLogger("wizard");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProfileRequestSchema = z.object({
  connectionId: z.string().min(1),
});

const ProfileResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  schema: z.string(),
  tables: z.array(z.record(z.string(), z.unknown())),
});

const GenerateRequestSchema = z.object({
  connectionId: z.string().min(1),
  tables: z.array(z.string()).min(1),
});

const WizardEntityColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  mappedType: z.string().optional(),
  nullable: z.boolean(),
  isPrimaryKey: z.boolean(),
  isForeignKey: z.boolean(),
  isEnumLike: z.boolean(),
  sampleValues: z.array(z.string()),
  uniqueCount: z.number().nullable(),
  nullCount: z.number().nullable(),
});

const WizardForeignKeySchema = z.object({
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
  source: z.enum(FK_SOURCES),
});

const WizardInferredForeignKeySchema = z.object({
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string(),
});

const WizardEntityResultSchema = z.object({
  tableName: z.string(),
  objectType: z.enum(OBJECT_TYPES),
  rowCount: z.number(),
  columnCount: z.number(),
  yaml: z.string(),
  profile: z.object({
    columns: z.array(WizardEntityColumnSchema),
    primaryKeys: z.array(z.string()),
    foreignKeys: z.array(WizardForeignKeySchema),
    inferredForeignKeys: z.array(WizardInferredForeignKeySchema),
    flags: z.object({
      possiblyAbandoned: z.boolean(),
      possiblyDenormalized: z.boolean(),
    }),
    notes: z.array(z.string()),
  }),
});

const GenerateResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  schema: z.string(),
  entities: z.array(WizardEntityResultSchema),
  errors: z.array(z.object({ table: z.string(), error: z.string() })),
});

const PreviewRequestSchema = z.object({
  question: z.string().min(1),
  entities: z.array(z.object({ tableName: z.string(), yaml: z.string() })).min(1),
});

const PreviewResponseSchema = z.record(z.string(), z.unknown());

/**
 * Zod schema for a column profile (snake_case wire format).
 * Keep in sync with ColumnProfile from @useatlas/types.
 */
const ColumnProfileSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  unique_count: z.number().nullable(),
  null_count: z.number().nullable(),
  sample_values: z.array(z.string()),
  is_primary_key: z.boolean(),
  is_foreign_key: z.boolean(),
  fk_target_table: z.string().nullable(),
  fk_target_column: z.string().nullable(),
  is_enum_like: z.boolean(),
  profiler_notes: z.array(z.string()),
}).refine(
  (col) => !col.is_foreign_key || (col.fk_target_table !== null && col.fk_target_column !== null),
  { message: "fk_target_table and fk_target_column must be non-null when is_foreign_key is true" },
);

/**
 * Zod schema for a foreign key.
 * Keep in sync with ForeignKey from @useatlas/types.
 */
const ForeignKeySchema = z.object({
  from_column: z.string().min(1),
  to_table: z.string().min(1),
  to_column: z.string().min(1),
  source: z.enum(FK_SOURCES),
});

/**
 * Zod schema for a table profile (snake_case wire format).
 * Derived from const tuples in @useatlas/types — no manual enum sync needed.
 */
const TableProfileSchema = z.object({
  table_name: z.string(),
  object_type: z.enum(OBJECT_TYPES),
  row_count: z.number(),
  columns: z.array(ColumnProfileSchema),
  primary_key_columns: z.array(z.string()),
  foreign_keys: z.array(ForeignKeySchema),
  inferred_foreign_keys: z.array(ForeignKeySchema),
  profiler_notes: z.array(z.string()),
  table_flags: z.object({
    possibly_abandoned: z.boolean(),
    possibly_denormalized: z.boolean(),
  }),
  matview_populated: z.boolean().optional(),
  partition_info: z.object({
    strategy: z.enum(PARTITION_STRATEGIES),
    key: z.string(),
    children: z.array(z.string()),
  }).optional(),
});

const SaveRequestSchema = z.object({
  connectionId: z.string().min(1),
  entities: z.array(z.object({ tableName: z.string(), yaml: z.string() })).min(1),
  schema: z.string().optional(),
  profiles: z.array(TableProfileSchema).optional(),
});

const SaveResponseSchema = z.object({
  saved: z.boolean(),
  orgId: z.string().nullable(),
  connectionId: z.string(),
  entityCount: z.number(),
  files: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const profileRoute = createRoute({
  method: "post",
  path: "/profile",
  tags: ["Wizard"],
  summary: "List tables from a connected datasource",
  description:
    "Discovers tables, views, and materialized views in a connected database for the wizard table selection step. " +
    "Supports PostgreSQL and MySQL datasources. Requires admin role.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: ProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Table list from the connected datasource",
      content: { "application/json": { schema: ProfileResponseSchema } },
    },
    400: {
      description: "Invalid request (missing connectionId or unsupported database type)",
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
    404: {
      description: "Connection not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Connection resolution or profiling failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  tags: ["Wizard"],
  summary: "Profile tables and generate entity YAML",
  description:
    "Profiles selected tables from a connected datasource and generates entity YAML definitions " +
    "with dimensions, measures, joins, query patterns, and heuristic flags. Requires admin role.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: GenerateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Generated entity YAML definitions with profiling metadata",
      content: { "application/json": { schema: GenerateResponseSchema } },
    },
    400: {
      description: "Invalid request (missing connectionId, empty tables, or unsupported database type)",
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
    404: {
      description: "Connection not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Profiling or generation failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  tags: ["Wizard"],
  summary: "Preview agent behavior with entities",
  description:
    "Shows how the agent would interpret the semantic layer when answering a question, " +
    "given a set of candidate entity YAML definitions. Requires admin role.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: PreviewRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Preview of how the agent would see the semantic layer",
      content: { "application/json": { schema: PreviewResponseSchema } },
    },
    400: {
      description: "Invalid request (missing question or entities)",
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
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const saveRoute = createRoute({
  method: "post",
  path: "/save",
  tags: ["Wizard"],
  summary: "Save entities to org-scoped semantic layer",
  description:
    "Persists generated entity YAML files to the organization's semantic layer directory on disk. " +
    "Validates table names for path traversal, syncs to the internal database if available, " +
    "and resets the semantic whitelist cache. Requires admin role and an active organization.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SaveRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Entities saved to disk",
      content: { "application/json": { schema: SaveResponseSchema } },
    },
    400: {
      description: "Invalid request (missing connectionId, empty entities, invalid table name, or no active organization)",
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
    500: {
      description: "Failed to save entities",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const wizard = new OpenAPIHono<AuthEnv>({
  defaultHook: validationHook,
});

wizard.use(adminAuth);
wizard.use(requestContext);

wizard.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Middleware-thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// POST /profile — List tables/views from a connected datasource
// ---------------------------------------------------------------------------

wizard.openapi(profileRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  const { connectionId } = c.req.valid("json");

  // Look up the connection URL — resolveConnectionUrl throws on infrastructure errors
  let connUrl: ResolvedConnection | null;
  try {
    connUrl = await resolveConnectionUrl(connectionId, authResult.user?.activeOrganizationId);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, connectionId }, "Failed to resolve connection URL");
    return c.json({
      error: "connection_resolution_failed",
      message: "Failed to resolve connection. Check server logs for details.",
      requestId,
    }, 500);
  }
  if (!connUrl) {
    return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
  }

  const { url, dbType, schema } = connUrl;

  try {
    let objects;
    switch (dbType) {
      case "postgres":
        objects = await listPostgresObjects(url, schema, log);
        break;
      case "mysql":
        objects = await listMySQLObjects(url);
        break;
      default:
        return c.json({
          error: "unsupported_db",
          message: `Wizard profiling is currently supported for PostgreSQL and MySQL. Got: ${dbType}`,
        }, 400);
    }

    log.info({ requestId, connectionId, dbType, tableCount: objects.length }, "Wizard profile complete");

    return c.json({
      connectionId,
      dbType,
      schema,
      tables: objects.map((o) => ({
        name: o.name,
        type: o.type,
      })),
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, connectionId }, "Wizard profile failed");
    return c.json({
      error: "profile_failed",
      message: `Failed to list tables: ${err instanceof Error ? err.message : String(err)}`,
      requestId,
    }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /generate — Profile selected tables and generate entity YAML
// ---------------------------------------------------------------------------

wizard.openapi(generateRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  const { connectionId, tables: tableNames } = c.req.valid("json");

  let connUrl: ResolvedConnection | null;
  try {
    connUrl = await resolveConnectionUrl(connectionId, authResult.user?.activeOrganizationId);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, connectionId }, "Failed to resolve connection URL");
    return c.json({
      error: "connection_resolution_failed",
      message: "Failed to resolve connection. Check server logs for details.",
      requestId,
    }, 500);
  }
  if (!connUrl) {
    return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
  }

  const { url, dbType, schema } = connUrl;

  try {
    let result: ProfilingResult;
    switch (dbType) {
      case "postgres":
        result = await profilePostgres(url, tableNames, undefined, schema, undefined, log);
        break;
      case "mysql":
        result = await profileMySQL(url, tableNames, undefined, undefined, log);
        break;
      default:
        return c.json({
          error: "unsupported_db",
          message: `Wizard profiling is currently supported for PostgreSQL and MySQL. Got: ${dbType}`,
        }, 400);
    }

    // Run heuristics (returns new array — no mutation)
    const analyzedProfiles = analyzeTableProfiles(result.profiles);

    // Generate entity YAML for each profile
    const sourceId = connectionId === "default" ? undefined : connectionId;
    const entities = analyzedProfiles.map((profile) => ({
      tableName: profile.table_name,
      objectType: profile.object_type,
      rowCount: profile.row_count,
      columnCount: profile.columns.length,
      yaml: generateEntityYAML(profile, analyzedProfiles, dbType, schema, sourceId),
      profile: {
        columns: profile.columns.map((col) => ({
          name: col.name,
          type: col.type,
          mappedType: col.is_enum_like ? "enum" : undefined,
          nullable: col.nullable,
          isPrimaryKey: col.is_primary_key,
          isForeignKey: col.is_foreign_key,
          isEnumLike: col.is_enum_like,
          sampleValues: col.sample_values.slice(0, 5),
          uniqueCount: col.unique_count,
          nullCount: col.null_count,
        })),
        primaryKeys: profile.primary_key_columns,
        foreignKeys: profile.foreign_keys.map((fk) => ({
          fromColumn: fk.from_column,
          toTable: fk.to_table,
          toColumn: fk.to_column,
          source: fk.source,
        })),
        inferredForeignKeys: profile.inferred_foreign_keys.map((fk) => ({
          fromColumn: fk.from_column,
          toTable: fk.to_table,
          toColumn: fk.to_column,
        })),
        flags: {
          possiblyAbandoned: profile.table_flags.possibly_abandoned,
          possiblyDenormalized: profile.table_flags.possibly_denormalized,
        },
        notes: profile.profiler_notes,
      },
    }));

    log.info({
      requestId,
      connectionId,
      dbType,
      profiledCount: analyzedProfiles.length,
      errorCount: result.errors.length,
    }, "Wizard generate complete");

    return c.json({
      connectionId,
      dbType,
      schema,
      entities,
      errors: result.errors,
    }, 200);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, connectionId }, "Wizard generate failed");
    return c.json({
      error: "generate_failed",
      message: `Failed to profile tables: ${err instanceof Error ? err.message : String(err)}`,
      requestId,
    }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /preview — Preview agent behavior with generated entities
// ---------------------------------------------------------------------------

wizard.openapi(previewRoute, async (c) => {
  const requestId = c.get("requestId");

  const { question, entities } = c.req.valid("json");

  // Build a semantic context summary from the provided entity YAMLs
  // (Zod already validated that entities are { tableName: string; yaml: string }[])
  const entitySummaries = entities
    .map((e) => `--- ${e.tableName} ---\n${e.yaml}`)
    .join("\n\n");

  // Generate a preview response showing what the agent would see
  const preview = {
    question,
    semanticContext: `The agent would see ${entities.length} entity definitions when answering this question.`,
    availableTables: entities.map((e) => e.tableName),
    entityCount: entities.length,
    sampleEntityYaml: entitySummaries.slice(0, 2000),
  };

  log.info({ requestId, question, entityCount: entities.length }, "Wizard preview generated");

  return c.json(preview, 200);
});

// ---------------------------------------------------------------------------
// POST /save — Save entities to org-scoped semantic layer
// ---------------------------------------------------------------------------

wizard.openapi(saveRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
  }

  const body = c.req.valid("json");
  const { connectionId, entities } = body;

  // Path traversal protection: validate all table names before writing any files
  const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
  for (const entity of entities) {
    if (!SAFE_TABLE_NAME.test(entity.tableName) || entity.tableName.includes("..")) {
      return c.json({
        error: "invalid_request",
        message: `Invalid table name: "${entity.tableName}". Only letters, digits, underscores, hyphens, and dots are allowed.`,
      }, 400);
    }
  }

  try {
    // Write entities to disk (org-scoped)
    const sourceId = connectionId === "default" ? "default" : connectionId;
    const outputBase = outputDirForDatasource(sourceId, orgId);
    const entitiesDir = path.join(outputBase, "entities");
    const metricsDir = path.join(outputBase, "metrics");

    fs.mkdirSync(entitiesDir, { recursive: true });
    fs.mkdirSync(metricsDir, { recursive: true });

    const savedFiles: string[] = [];

    // Write entity YAMLs (table names already validated above)
    for (const entity of entities) {
      const safeName = path.basename(entity.tableName);
      const filePath = path.join(entitiesDir, `${safeName}.yml`);
      fs.writeFileSync(filePath, entity.yaml, "utf-8");
      savedFiles.push(`entities/${safeName}.yml`);

      // Also write to org-scoped semantic directory (semantic/.orgs/{orgId}/)
      // so the explore tool can discover this entity.
      if (hasInternalDB()) {
        await syncEntityToDisk(orgId, entity.tableName, "entity", entity.yaml).catch((err) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), tableName: entity.tableName }, "Disk sync after wizard save failed");
        });
      }
    }

    // Generate catalog, glossary, and metric files from raw profile data.
    // The wizard frontend does not send raw profile data — it sends
    // pre-generated entity YAML via { connectionId, entities } instead.
    // This branch handles callers (e.g. future CLI integrations) that
    // provide raw TableProfile[] data for server-side generation.
    const { schema: bodySchema, profiles: profileData } = body;
    if (profileData && profileData.length > 0) {
      const profiles = profileData;
      const resolvedSchema = bodySchema ?? "public";

      const catalogYaml = generateCatalogYAML(profiles);
      const catalogPath = path.join(outputBase, "catalog.yml");
      fs.writeFileSync(catalogPath, catalogYaml, "utf-8");
      savedFiles.push("catalog.yml");

      const glossaryYaml = generateGlossaryYAML(profiles);
      const glossaryPath = path.join(outputBase, "glossary.yml");
      fs.writeFileSync(glossaryPath, glossaryYaml, "utf-8");
      savedFiles.push("glossary.yml");

      // Generate metric files (sanitize table_name from profiles)
      for (const profile of profiles) {
        if (!profile.table_name || !SAFE_TABLE_NAME.test(profile.table_name)) continue;
        const metricYaml = generateMetricYAML(profile, resolvedSchema);
        if (metricYaml) {
          const safeMetricName = path.basename(profile.table_name);
          const filePath = path.join(metricsDir, `${safeMetricName}.yml`);
          fs.writeFileSync(filePath, metricYaml, "utf-8");
          savedFiles.push(`metrics/${safeMetricName}.yml`);
        }
      }
    }

    // Reset semantic whitelist cache so new entities are queryable
    _resetWhitelists();

    log.info({
      requestId,
      orgId,
      connectionId,
      entityCount: entities.length,
      fileCount: savedFiles.length,
    }, "Wizard save complete");

    return c.json({
      saved: true,
      orgId,
      connectionId,
      entityCount: entities.length,
      files: savedFiles,
    }, 201);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Wizard save failed");
    return c.json({
      error: "save_failed",
      message: `Failed to save entities: ${err instanceof Error ? err.message : String(err)}`,
      requestId,
    }, 500);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedConnection {
  url: string;
  dbType: ReturnType<typeof detectDBType>;
  schema: string;
}

/**
 * Resolve a connection URL from either the runtime ConnectionRegistry
 * or the internal database (encrypted connections table).
 *
 * Returns the resolved connection, or null if the connection does not exist.
 * Throws on infrastructure errors (e.g. database unreachable, pool exhaustion,
 * decryption failure, missing encryption key) so callers can distinguish
 * "not found" from "lookup failed".
 */
async function resolveConnectionUrl(
  connectionId: string,
  orgId?: string | null,
): Promise<ResolvedConnection | null> {
  // First try: runtime registry (works for self-hosted / env-var connections)
  if (connections.has(connectionId)) {
    const entry = connections.describe().find((c) => c.id === connectionId);
    if (entry) {
      // Get the actual URL from the registry's internal state
      // The describe() method masks the URL, so we need the raw URL for profiling.
      // Check internal DB first (it has the encrypted URL).
      if (hasInternalDB()) {
        const rows = await internalQuery<{ url: string; schema_name: string | null }>(
          "SELECT url, schema_name FROM connections WHERE id = $1",
          [connectionId],
        );
        if (rows.length > 0) {
          const url = decryptUrl(rows[0].url);
          const dbType = detectDBType(url);
          return { url, dbType, schema: rows[0].schema_name ?? "public" };
        }
      }

      // Fallback: try ATLAS_DATASOURCE_URL for the "default" connection
      if (connectionId === "default" && process.env.ATLAS_DATASOURCE_URL) {
        const url = process.env.ATLAS_DATASOURCE_URL;
        const dbType = detectDBType(url);
        return { url, dbType, schema: "public" };
      }
    }
  }

  // Second try: internal DB only (connection not in runtime registry)
  if (hasInternalDB()) {
    const orgFilter = orgId ? " AND (org_id = $2 OR org_id IS NULL)" : "";
    const params: unknown[] = [connectionId];
    if (orgId) params.push(orgId);

    const rows = await internalQuery<{ url: string; schema_name: string | null }>(
      `SELECT url, schema_name FROM connections WHERE id = $1${orgFilter}`,
      params,
    );
    if (rows.length > 0) {
      const url = decryptUrl(rows[0].url);
      const dbType = detectDBType(url);
      return { url, dbType, schema: rows[0].schema_name ?? "public" };
    }
  }

  return null;
}

export { wizard };
