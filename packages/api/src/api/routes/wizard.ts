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
import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, decryptUrl } from "@atlas/api/lib/db/internal";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { syncEntityToDisk } from "@atlas/api/lib/semantic-sync";
import { adminAuthPreamble } from "./admin-auth";
import {
  type TableProfile,
  type ProfilingResult,
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

const wizard = new Hono();

// ---------------------------------------------------------------------------
// POST /profile — List tables/views from a connected datasource
// ---------------------------------------------------------------------------

wizard.post("/profile", async (c) => {
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse wizard profile request body");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { connectionId } = body as Record<string, unknown>;
    if (!connectionId || typeof connectionId !== "string") {
      return c.json({ error: "invalid_request", message: "connectionId is required." }, 400);
    }

    // Look up the connection URL
    const connUrl = await resolveConnectionUrl(connectionId, authResult.user?.activeOrganizationId);
    if (!connUrl) {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
    }

    const { url, dbType, schema } = connUrl;

    try {
      let objects;
      switch (dbType) {
        case "postgres":
          objects = await listPostgresObjects(url, schema);
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
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, connectionId }, "Wizard profile failed");
      return c.json({
        error: "profile_failed",
        message: `Failed to list tables: ${err instanceof Error ? err.message : String(err)}`,
        requestId,
      }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /generate — Profile selected tables and generate entity YAML
// ---------------------------------------------------------------------------

wizard.post("/generate", async (c) => {
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse wizard generate request body");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { connectionId, tables } = body as Record<string, unknown>;
    if (!connectionId || typeof connectionId !== "string") {
      return c.json({ error: "invalid_request", message: "connectionId is required." }, 400);
    }
    if (!Array.isArray(tables) || tables.length === 0) {
      return c.json({ error: "invalid_request", message: "tables array is required and must not be empty." }, 400);
    }

    // Validate table names
    const tableNames = tables.filter((t): t is string => typeof t === "string");
    if (tableNames.length === 0) {
      return c.json({ error: "invalid_request", message: "tables must contain string values." }, 400);
    }

    const connUrl = await resolveConnectionUrl(connectionId, authResult.user?.activeOrganizationId);
    if (!connUrl) {
      return c.json({ error: "not_found", message: `Connection "${connectionId}" not found.` }, 404);
    }

    const { url, dbType, schema } = connUrl;

    try {
      let result: ProfilingResult;
      switch (dbType) {
        case "postgres":
          result = await profilePostgres(url, tableNames, undefined, schema);
          break;
        case "mysql":
          result = await profileMySQL(url, tableNames);
          break;
        default:
          return c.json({
            error: "unsupported_db",
            message: `Wizard profiling is currently supported for PostgreSQL and MySQL. Got: ${dbType}`,
          }, 400);
      }

      // Run heuristics
      analyzeTableProfiles(result.profiles);

      // Generate entity YAML for each profile
      const sourceId = connectionId === "default" ? undefined : connectionId;
      const entities = result.profiles.map((profile) => ({
        tableName: profile.table_name,
        objectType: profile.object_type,
        rowCount: profile.row_count,
        columnCount: profile.columns.length,
        yaml: generateEntityYAML(profile, result.profiles, dbType, schema, sourceId),
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
        profiledCount: result.profiles.length,
        errorCount: result.errors.length,
      }, "Wizard generate complete");

      return c.json({
        connectionId,
        dbType,
        schema,
        entities,
        errors: result.errors,
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, connectionId }, "Wizard generate failed");
      return c.json({
        error: "generate_failed",
        message: `Failed to profile tables: ${err instanceof Error ? err.message : String(err)}`,
        requestId,
      }, 500);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /preview — Preview agent behavior with generated entities
// ---------------------------------------------------------------------------

wizard.post("/preview", async (c) => {
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse wizard preview request body");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { question, entities } = body as Record<string, unknown>;
    if (!question || typeof question !== "string") {
      return c.json({ error: "invalid_request", message: "question is required." }, 400);
    }
    if (!Array.isArray(entities) || entities.length === 0) {
      return c.json({ error: "invalid_request", message: "entities array is required." }, 400);
    }

    // Build a semantic context summary from the provided entity YAMLs
    const entitySummaries = entities
      .filter((e): e is { tableName: string; yaml: string } =>
        typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).tableName === "string" && typeof (e as Record<string, unknown>).yaml === "string"
      )
      .map((e) => `--- ${e.tableName} ---\n${e.yaml}`)
      .join("\n\n");

    if (!entitySummaries) {
      return c.json({ error: "invalid_request", message: "entities must contain objects with tableName and yaml fields." }, 400);
    }

    // Generate a preview response showing what the agent would see
    const preview = {
      question,
      semanticContext: `The agent would see ${entities.length} entity definitions when answering this question.`,
      availableTables: entities
        .filter((e): e is { tableName: string } =>
          typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).tableName === "string"
        )
        .map((e) => e.tableName),
      entityCount: entities.length,
      sampleEntityYaml: entitySummaries.slice(0, 2000),
    };

    log.info({ requestId, question, entityCount: entities.length }, "Wizard preview generated");

    return c.json(preview);
  });
});

// ---------------------------------------------------------------------------
// POST /save — Save entities to org-scoped semantic layer
// ---------------------------------------------------------------------------

wizard.post("/save", async (c) => {
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(c.req.raw, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
    }

    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse wizard save request body");
      return null;
    });

    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { connectionId, entities, schema } = body as Record<string, unknown>;
    if (!connectionId || typeof connectionId !== "string") {
      return c.json({ error: "invalid_request", message: "connectionId is required." }, 400);
    }
    if (!Array.isArray(entities) || entities.length === 0) {
      return c.json({ error: "invalid_request", message: "entities array is required." }, 400);
    }

    // Validate entity payloads
    const validEntities = entities.filter((e): e is { tableName: string; yaml: string } =>
      typeof e === "object" && e !== null &&
      typeof (e as Record<string, unknown>).tableName === "string" &&
      typeof (e as Record<string, unknown>).yaml === "string"
    );

    if (validEntities.length === 0) {
      return c.json({ error: "invalid_request", message: "entities must contain objects with tableName and yaml fields." }, 400);
    }

    // Path traversal protection: validate all table names before writing any files
    const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
    for (const entity of validEntities) {
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
      for (const entity of validEntities) {
        const safeName = path.basename(entity.tableName);
        const filePath = path.join(entitiesDir, `${safeName}.yml`);
        fs.writeFileSync(filePath, entity.yaml, "utf-8");
        savedFiles.push(`entities/${safeName}.yml`);

        // Also sync to DB if internal DB is available
        if (hasInternalDB()) {
          await syncEntityToDisk(orgId, entity.tableName, "entity", entity.yaml).catch((err) => {
            log.warn({ err: err instanceof Error ? err.message : String(err), tableName: entity.tableName }, "Disk sync after wizard save failed");
          });
        }
      }

      // Generate and write catalog.yml if we have profile data
      // (The entities array may include profile data from the generate step)
      const profileData = (body as Record<string, unknown>).profiles;
      if (Array.isArray(profileData) && profileData.length > 0) {
        const profiles = profileData as TableProfile[];
        const resolvedSchema = typeof schema === "string" ? schema : "public";

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
        entityCount: validEntities.length,
        fileCount: savedFiles.length,
      }, "Wizard save complete");

      return c.json({
        saved: true,
        orgId,
        connectionId,
        entityCount: validEntities.length,
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
        try {
          const rows = await internalQuery<{ url: string; schema_name: string | null }>(
            "SELECT url, schema_name FROM connections WHERE id = $1",
            [connectionId],
          );
          if (rows.length > 0) {
            const url = decryptUrl(rows[0].url);
            const dbType = detectDBType(url);
            return { url, dbType, schema: rows[0].schema_name ?? "public" };
          }
        } catch (err) {
          log.warn({ err: err instanceof Error ? err.message : String(err), connectionId }, "Failed to resolve connection from internal DB");
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

    try {
      const rows = await internalQuery<{ url: string; schema_name: string | null }>(
        `SELECT url, schema_name FROM connections WHERE id = $1${orgFilter}`,
        params,
      );
      if (rows.length > 0) {
        const url = decryptUrl(rows[0].url);
        const dbType = detectDBType(url);
        return { url, dbType, schema: rows[0].schema_name ?? "public" };
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), connectionId }, "Failed to resolve connection from DB");
    }
  }

  return null;
}

export { wizard };
