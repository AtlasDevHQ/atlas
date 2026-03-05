/**
 * Semantic layer utilities.
 *
 * Reads the semantic/ directory to extract metadata used by the SQL tool
 * (table whitelist) and the CLI (schema profiling).
 *
 * Table whitelists are partitioned by connection ID when entity YAMLs use
 * the `connection` field or when per-source subdirectories exist under the
 * semantic root (e.g. `semantic/warehouse/entities/` infers connection ID
 * `warehouse`). When no entity specifies a connection and no per-source
 * subdirectories are present, all connections share the same whitelist
 * (backward compat with single-DB).
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { invalidateSemanticIndex } from "@atlas/api/lib/semantic-index";

const log = createLogger("semantic");

const CrossSourceJoinShape = z.object({
  source: z.string().min(1),
  target_table: z.string().min(1),
  on: z.string().min(1),
  relationship: z.enum(["many_to_one", "one_to_many", "one_to_one", "many_to_many"]),
  description: z.string().optional(),
});

type CrossSourceJoinRelationship = z.infer<typeof CrossSourceJoinShape>["relationship"];

/** Core entity shape — validates table name and connection only. */
const EntityShape = z.object({
  table: z.string(),
  connection: z.string().optional(),
}).passthrough();

export interface CrossSourceJoin {
  fromSource: string;
  fromTable: string;
  toSource: string;
  toTable: string;
  on: string;
  relationship: CrossSourceJoinRelationship;
  description?: string;
}

const _whitelists = new Map<string, Set<string>>();
let _tablesByConnection: Map<string, Set<string>> | null = null;
let _crossSourceJoins: CrossSourceJoin[] | null = null;

/** Plugin-provided entity tables, keyed by connection ID. */
const _pluginEntities = new Map<string, Set<string>>();

/**
 * Load entity YAMLs from a single directory into the connection map.
 *
 * @param dir - Directory containing *.yml entity files.
 * @param defaultConnectionId - Connection ID for entities that don't specify
 *   an explicit `connection` field. When loading from a per-source subdirectory
 *   (e.g. `semantic/warehouse/entities/`), this is the subdirectory name.
 * @param byConnection - Accumulator map to populate.
 * @param crossJoins - Optional accumulator for cross-source join hints.
 *   When provided, valid `cross_source_joins` entries from each entity are
 *   appended here. Invalid individual join entries are skipped with a warning
 *   without affecting the entity's whitelist membership.
 */
function loadEntitiesFromDir(
  dir: string,
  defaultConnectionId: string,
  byConnection: Map<string, Set<string>>,
  crossJoins?: CrossSourceJoin[],
): void {
  if (!fs.existsSync(dir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.error({ dir, err: err instanceof Error ? err.message : String(err) }, "Failed to read entities directory — skipping");
    return;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const raw = yaml.load(content);
      const parsed = EntityShape.safeParse(raw);
      if (!parsed.success) {
        // Try to extract the table name from raw YAML for a more useful log message
        const tableName = raw && typeof raw === "object" && "table" in raw && typeof (raw as Record<string, unknown>).table === "string"
          ? (raw as Record<string, unknown>).table as string
          : undefined;
        log.warn({ file, table: tableName, err: parsed.error.message }, "Skipping entity file — failed to validate");
        continue;
      }
      const entity = parsed.data;

      // Explicit connection field takes precedence over directory-based inference
      const connId = entity.connection ?? defaultConnectionId;
      if (!byConnection.has(connId)) byConnection.set(connId, new Set());
      const tables = byConnection.get(connId)!;

      // Extract table name (may include schema prefix like "public.users")
      const parts = entity.table.split(".");
      tables.add(parts[parts.length - 1].toLowerCase());
      // Also add the full qualified name
      tables.add(entity.table.toLowerCase());

      // Validate and collect cross-source joins separately from core entity parsing.
      // Invalid join entries are skipped individually without dropping the entity.
      const rawJoins = (raw as Record<string, unknown>).cross_source_joins;
      if (crossJoins && Array.isArray(rawJoins)) {
        for (let i = 0; i < rawJoins.length; i++) {
          const joinParsed = CrossSourceJoinShape.safeParse(rawJoins[i]);
          if (!joinParsed.success) {
            log.warn(
              { file, table: entity.table, index: i, err: joinParsed.error.message },
              "Skipping invalid cross_source_joins entry",
            );
            continue;
          }
          const j = joinParsed.data;
          crossJoins.push({
            fromSource: connId,
            fromTable: entity.table,
            toSource: j.source,
            toTable: j.target_table,
            on: j.on,
            relationship: j.relationship,
            description: j.description,
          });
        }
      }
    } catch (err) {
      log.warn({ file, err: err instanceof Error ? err.message : String(err) }, "Skipping entity file — failed to parse");
    }
  }
}

/**
 * Directory names at the semantic root that are part of the default connection's
 * structure, not per-source subdirectories. These are skipped when scanning for
 * source-specific directories.
 */
const RESERVED_DIRS = new Set(["entities", "metrics"]);

/**
 * Load entity YAMLs and partition tables by connection ID.
 *
 * Supports two directory layouts:
 * - **Flat (legacy):** `entitiesDir` points to a single directory of *.yml files.
 * - **Multi-source:** `semanticRoot` points to the semantic root which contains
 *   `entities/` (default connection) and per-source subdirectories like
 *   `warehouse/entities/` whose name becomes the connection ID.
 *
 * @param semanticRoot - Semantic layer root directory (scans subdirectories).
 * @param entitiesDir - Override for a single flat entities directory (DI for tests).
 */
function loadTablesByConnection(
  semanticRoot?: string,
  entitiesDir?: string,
  crossJoins?: CrossSourceJoin[],
): Map<string, Set<string>> {
  const byConnection = new Map<string, Set<string>>();

  // Legacy flat-directory path (existing tests use this)
  if (entitiesDir) {
    loadEntitiesFromDir(entitiesDir, "default", byConnection, crossJoins);
    return byConnection;
  }

  const root = semanticRoot ?? path.resolve(process.cwd(), "semantic");

  // 1. Default entities (backward compat — semantic/entities/*.yml)
  loadEntitiesFromDir(path.join(root, "entities"), "default", byConnection, crossJoins);

  // 2. Per-source subdirectories (e.g. semantic/warehouse/entities/*.yml)
  if (fs.existsSync(root)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log.error({ root, err: err instanceof Error ? err.message : String(err) }, "Failed to scan semantic root — skipping per-source discovery");
      return byConnection;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (RESERVED_DIRS.has(entry.name)) continue;
      const subEntities = path.join(root, entry.name, "entities");
      if (fs.existsSync(subEntities)) {
        log.info({ source: entry.name, dir: subEntities }, "Discovered per-source entities directory");
        loadEntitiesFromDir(subEntities, entry.name, byConnection, crossJoins);
      }
    }
  }

  const hasPartitioned = Array.from(byConnection.keys()).some((k) => k !== "default");
  if (hasPartitioned) {
    log.info({ connections: Array.from(byConnection.keys()) }, "Partitioned table whitelist mode");
  }

  return byConnection;
}

function getTablesByConnection(semanticRoot?: string, entitiesDir?: string): Map<string, Set<string>> {
  if (!_tablesByConnection) {
    const crossJoins: CrossSourceJoin[] = [];
    _tablesByConnection = loadTablesByConnection(semanticRoot, entitiesDir, crossJoins);
    _crossSourceJoins = crossJoins;
  }
  return _tablesByConnection;
}

/**
 * Get the set of whitelisted table names for a given connection.
 *
 * The system switches to partitioned mode (each connection only sees its
 * own tables) when either:
 * - An entity YAML uses the `connection` field, or
 * - Per-source subdirectories exist under the semantic root (e.g.
 *   `semantic/warehouse/entities/` infers connection `warehouse`).
 *
 * When neither trigger is present, all connections share the same table
 * set (identical to pre-v0.7 behavior).
 *
 * @param connectionId - Connection to get tables for. Defaults to "default".
 * @param entitiesDir - Override for a single flat entities directory (DI for tests).
 * @param semanticRoot - Override for the semantic root directory (DI for tests).
 *   When provided, scans both `root/entities/` and per-source subdirectories.
 */
export function getWhitelistedTables(
  connectionId: string = "default",
  entitiesDir?: string,
  semanticRoot?: string,
): Set<string> {
  // When using custom paths (tests), bypass the global cache
  if (entitiesDir || semanticRoot) {
    const byConnection = loadTablesByConnection(semanticRoot, entitiesDir);
    const hasNonDefaultConnection = Array.from(byConnection.keys()).some((k) => k !== "default");

    let tables: Set<string>;
    if (!hasNonDefaultConnection) {
      tables = new Set(byConnection.get("default") ?? []);
    } else {
      tables = new Set(byConnection.get(connectionId) ?? []);
      if (tables.size === 0) {
        log.warn(
          { connectionId, knownConnections: Array.from(byConnection.keys()) },
          "No entities found for connection — whitelist is empty; all queries will be rejected",
        );
      }
    }
    // Merge plugin-provided entities even in custom-path mode
    const pluginTables = _pluginEntities.get(connectionId);
    if (pluginTables && pluginTables.size > 0) {
      for (const t of pluginTables) tables.add(t);
    }
    return tables;
  }

  const cached = _whitelists.get(connectionId);
  if (cached) return cached;

  const byConnection = getTablesByConnection();

  // Backward compat: if no entity uses `connection:` and no per-source
  // subdirectories exist, all connections share the full set (pre-v0.7).
  const hasNonDefaultConnection = Array.from(byConnection.keys()).some((k) => k !== "default");

  let tables: Set<string>;
  if (!hasNonDefaultConnection) {
    tables = new Set(byConnection.get("default") ?? []);
  } else {
    tables = new Set(byConnection.get(connectionId) ?? []);
    if (tables.size === 0) {
      log.warn(
        { connectionId, knownConnections: Array.from(byConnection.keys()) },
        "No entities found for connection — whitelist is empty; all queries will be rejected",
      );
    }
  }

  // Merge plugin-provided entities for this connection
  const pluginTables = _pluginEntities.get(connectionId);
  if (pluginTables && pluginTables.size > 0) {
    for (const t of pluginTables) tables.add(t);
  }

  _whitelists.set(connectionId, tables);
  return tables;
}

/**
 * Get all cross-source join hints parsed from entity YAMLs.
 *
 * When called with a `semanticRoot`, loads fresh from disk and returns a new
 * array without affecting the global cache. When called without arguments,
 * uses the global cache populated by `getTablesByConnection`.
 */
export function getCrossSourceJoins(semanticRoot?: string): readonly CrossSourceJoin[] {
  if (semanticRoot) {
    const crossJoins: CrossSourceJoin[] = [];
    loadTablesByConnection(semanticRoot, undefined, crossJoins);
    return crossJoins;
  }
  // Ensure global cache is populated
  getTablesByConnection();
  return _crossSourceJoins ?? [];
}

/** Clears cached whitelists, table-by-connection mappings, cross-source joins, and semantic index. */
export function _resetWhitelists(): void {
  _whitelists.clear();
  _tablesByConnection = null;
  _crossSourceJoins = null;
  invalidateSemanticIndex();
}

/**
 * Register plugin-provided entity definitions into the table whitelist.
 *
 * Parses each entity's YAML content using the same validation as disk-based
 * entities. Tables are stored in a separate in-memory map that is merged
 * into the whitelist on read. No files are written to disk.
 *
 * @param connectionId - Connection ID the entities belong to (usually the plugin ID).
 * @param entities - Array of `{ name, yaml }` entity definitions.
 */
export function registerPluginEntities(
  connectionId: string,
  entities: Array<{ name: string; yaml: string }>,
): void {
  if (!_pluginEntities.has(connectionId)) {
    _pluginEntities.set(connectionId, new Set());
  }
  const tables = _pluginEntities.get(connectionId)!;

  let skippedCount = 0;
  for (const entity of entities) {
    try {
      const raw = yaml.load(entity.yaml);
      const parsed = EntityShape.safeParse(raw);
      if (!parsed.success) {
        log.warn(
          { connectionId, entity: entity.name, err: parsed.error.message },
          "Skipping plugin entity — failed to validate YAML",
        );
        skippedCount++;
        continue;
      }
      const tableName = parsed.data.table;
      const parts = tableName.split(".");
      tables.add(parts[parts.length - 1].toLowerCase());
      tables.add(tableName.toLowerCase());
    } catch (err) {
      log.warn(
        { connectionId, entity: entity.name, err: err instanceof Error ? err.message : String(err) },
        "Skipping plugin entity — failed to parse YAML",
      );
      skippedCount++;
    }
  }

  // Clear the merged whitelist cache so the next read picks up plugin entities
  _whitelists.clear();

  if (skippedCount === entities.length && entities.length > 0) {
    log.error(
      { connectionId, entityCount: entities.length, skippedCount, tableCount: tables.size },
      "All plugin entities failed to register",
    );
  } else {
    log.info(
      { connectionId, entityCount: entities.length, skippedCount, tableCount: tables.size },
      "Registered plugin entities",
    );
  }
}

/** Clears plugin-provided entity registrations. For testing. */
export function _resetPluginEntities(): void {
  _pluginEntities.clear();
  _whitelists.clear();
}
