/**
 * Semantic layer diff — compares live database schema against entity YAML files.
 *
 * Core comparison logic extracted from the CLI `atlas diff` command so both
 * CLI and API can share the same diff engine.
 */

import * as fs from "fs";
import * as path from "path";
import type { SemanticTableDiff, SemanticDiffResponse } from "@useatlas/types";
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { connections } from "@atlas/api/lib/db/connection";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getSemanticRoot, readYamlFile, discoverEntities } from "./files";
import {
  getOrgWhitelistedTables,
  getWhitelistedTables,
  loadOrgWhitelist,
} from "./whitelist";

const log = createLogger("semantic-diff");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntitySnapshot {
  table: string;
  columns: Map<string, string>; // column name → normalized type
  foreignKeys: Set<string>;     // "from_col→target_table.target_col"
}

export interface DiffResult {
  newTables: string[];
  removedTables: string[];
  tableDiffs: SemanticTableDiff[];
  unchangedCount: number;
}

// ---------------------------------------------------------------------------
// mapSQLType — normalizes raw SQL types to semantic dimension types
// ---------------------------------------------------------------------------

export function mapSQLType(sqlType: string): string {
  const unwrapped = sqlType.replace(/Nullable\((.+)\)/g, "$1").replace(/LowCardinality\((.+)\)/g, "$1");
  const t = unwrapped.toLowerCase();
  if (t.includes("interval") || t.includes("money")) return "string";
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("real") ||
    t.includes("numeric") ||
    t.includes("decimal") ||
    t.includes("double") ||
    t === "currency" ||
    t === "percent" ||
    t === "long"
  )
    return "number";
  if (t.startsWith("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp"))
    return "date";
  return "string";
}

// ---------------------------------------------------------------------------
// parseEntityYAML — build EntitySnapshot from a YAML document
// ---------------------------------------------------------------------------

export function parseEntityYAML(doc: Record<string, unknown>): EntitySnapshot {
  const table = doc.table as string;
  const columns = new Map<string, string>();
  const foreignKeys = new Set<string>();

  const rawDimensions = doc.dimensions ?? [];
  if (!Array.isArray(rawDimensions)) {
    return { table, columns, foreignKeys };
  }
  const dimensions = rawDimensions as Record<string, unknown>[];
  for (const dim of dimensions) {
    if (dim.virtual) continue;
    if (typeof dim.name !== "string" || typeof dim.type !== "string") continue;
    columns.set(dim.name, dim.type);
  }

  const rawJoins = doc.joins ?? [];
  if (!Array.isArray(rawJoins)) {
    return { table, columns, foreignKeys };
  }
  const joins = rawJoins as Record<string, unknown>[];
  for (const join of joins) {
    const joinCols = join.join_columns as { from: string; to: string } | undefined;
    const targetEntity = join.target_entity as string | undefined;
    if (!joinCols || !targetEntity) continue;
    if (typeof joinCols.from !== "string" || typeof joinCols.to !== "string") continue;
    const targetTable = targetEntity.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    foreignKeys.add(`${joinCols.from}→${targetTable}.${joinCols.to}`);
  }

  return { table, columns, foreignKeys };
}

// ---------------------------------------------------------------------------
// computeDiff — pure comparison of DB vs YAML snapshots
// ---------------------------------------------------------------------------

export function computeDiff(
  dbSnapshots: Map<string, EntitySnapshot>,
  yamlSnapshots: Map<string, EntitySnapshot>,
): DiffResult {
  const dbTables = new Set(dbSnapshots.keys());
  const yamlTables = new Set(yamlSnapshots.keys());

  const newTables = [...dbTables].filter((t) => !yamlTables.has(t)).sort();
  const removedTables = [...yamlTables].filter((t) => !dbTables.has(t)).sort();

  const tableDiffs: SemanticTableDiff[] = [];
  let unchangedCount = 0;

  for (const table of [...dbTables].filter((t) => yamlTables.has(t)).sort()) {
    const db = dbSnapshots.get(table)!;
    const yml = yamlSnapshots.get(table)!;

    const addedColumns: { name: string; type: string }[] = [];
    const removedColumns: { name: string; type: string }[] = [];
    const typeChanges: { name: string; yamlType: string; dbType: string }[] = [];

    for (const [name, type] of db.columns) {
      if (!yml.columns.has(name)) {
        addedColumns.push({ name, type });
      } else if (yml.columns.get(name) !== type) {
        typeChanges.push({ name, yamlType: yml.columns.get(name)!, dbType: type });
      }
    }

    for (const [name, type] of yml.columns) {
      if (!db.columns.has(name)) {
        removedColumns.push({ name, type });
      }
    }

    if (addedColumns.length > 0 || removedColumns.length > 0 || typeChanges.length > 0) {
      tableDiffs.push({ table, addedColumns, removedColumns, typeChanges });
    } else {
      unchangedCount++;
    }
  }

  return { newTables, removedTables, tableDiffs, unchangedCount };
}

// ---------------------------------------------------------------------------
// filterSnapshotsByWhitelist — scope DB snapshots to semantic layer tables
// ---------------------------------------------------------------------------

/**
 * Filter a DB snapshot map to only include tables present in the semantic
 * whitelist. Matches both the bare table name and any schema-qualified form
 * (e.g. `public.users`) so whitelists that record one, the other, or both
 * continue to work.
 *
 * When `allowed` is undefined, the snapshots are returned unchanged — callers
 * that don't want scoping should pass `undefined` rather than an empty set.
 * An empty `allowed` set means "nothing is allowed" and returns an empty map.
 */
export function filterSnapshotsByWhitelist(
  snapshots: Map<string, EntitySnapshot>,
  allowed: Set<string> | undefined,
): Map<string, EntitySnapshot> {
  if (!allowed) return snapshots;
  const filtered = new Map<string, EntitySnapshot>();
  for (const [tableName, snapshot] of snapshots) {
    const bare = tableName.toLowerCase();
    if (allowed.has(bare)) {
      filtered.set(tableName, snapshot);
      continue;
    }
    // Schema-qualified match — loadEntitiesFromDir stores both forms, but a
    // future whitelist shape might only include the qualified name. Treat the
    // DB-returned bare name as matching any `schema.tableName` form too.
    for (const allowedName of allowed) {
      const dot = allowedName.lastIndexOf(".");
      if (dot >= 0 && allowedName.slice(dot + 1) === bare) {
        filtered.set(tableName, snapshot);
        break;
      }
    }
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// getDBSchema — query information_schema for table/column metadata
// ---------------------------------------------------------------------------

/**
 * Query information_schema for table/column metadata for a connection.
 *
 * When `allowedTables` is provided, the result map is filtered to only include
 * tables present in the whitelist (both bare and schema-qualified matches).
 * When omitted, every table in the DB is returned (legacy behavior — retained
 * for callers that do their own scoping).
 */
export async function getDBSchema(
  connectionId: string = "default",
  allowedTables?: Set<string>,
): Promise<Map<string, EntitySnapshot>> {
  const conn = connections.get(connectionId);
  const dbType = connections.getDBType(connectionId);

  let sql: string;
  if (dbType === "mysql") {
    sql = `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`;
  } else if (dbType === "postgres") {
    sql = `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`;
  } else {
    throw new Error(`Schema diff is not yet supported for ${dbType} connections. Supported: postgres, mysql.`);
  }

  let result;
  try {
    result = await conn.query(sql, 15000);
  } catch (err) {
    throw new Error(`Database schema query failed for connection "${connectionId}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const snapshots = new Map<string, EntitySnapshot>();

  for (const row of result.rows) {
    const tableName = String(row.table_name);
    const columnName = String(row.column_name);
    const dataType = String(row.data_type);

    if (!snapshots.has(tableName)) {
      snapshots.set(tableName, { table: tableName, columns: new Map(), foreignKeys: new Set() });
    }
    snapshots.get(tableName)!.columns.set(columnName, mapSQLType(dataType));
  }

  return filterSnapshotsByWhitelist(snapshots, allowedTables);
}

// ---------------------------------------------------------------------------
// getYAMLSnapshots — read entity YAML files for a given connection
// ---------------------------------------------------------------------------

export function getYAMLSnapshots(
  connectionId: string = "default",
): { snapshots: Map<string, EntitySnapshot>; warnings: string[] } {
  const root = getSemanticRoot();
  const snapshots = new Map<string, EntitySnapshot>();
  const warnings: string[] = [];

  if (!fs.existsSync(root)) {
    warnings.push(`Semantic root not found: ${root}. Run 'atlas init' to create it.`);
    return { snapshots, warnings };
  }

  // Discover entities to find their source/connection mapping
  const { entities, warnings: discoverWarnings } = discoverEntities(root);
  if (discoverWarnings.length > 0) {
    warnings.push(...discoverWarnings);
  }

  for (const entity of entities) {
    // Match entities to the requested connection:
    // - entities with connection=null/undefined belong to "default"
    // - entities with an explicit connection belong to that connection
    const entityConnection = entity.connection ?? entity.source ?? "default";
    // "default" source means flat layout → default connection
    const effectiveConnection = entityConnection === "default" ? "default" : entityConnection;
    if (effectiveConnection !== connectionId) continue;

    // Resolve entity file path
    const entitiesDir = entity.source === "default"
      ? path.join(root, "entities")
      : path.join(root, entity.source, "entities");
    const filePath = path.join(entitiesDir, `${entity.table}.yml`);

    if (!fs.existsSync(filePath)) continue;

    try {
      const doc = readYamlFile(filePath) as Record<string, unknown>;
      if (!doc || typeof doc.table !== "string") continue;
      const snapshot = parseEntityYAML(doc);
      snapshots.set(snapshot.table, snapshot);
    } catch (err) {
      const msg = `Failed to parse ${entity.table}.yml: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), filePath }, msg);
      warnings.push(msg);
    }
  }

  return { snapshots, warnings };
}

// ---------------------------------------------------------------------------
// runDiff — orchestrates the full diff for a connection
// ---------------------------------------------------------------------------

/**
 * Options for scoping a schema diff to a specific org + mode.
 *
 * When `orgId` is provided, the DB snapshot is filtered to only include
 * tables present in the org's mode-aware semantic whitelist. This prevents
 * phantom tables from appearing in the diff when multiple orgs share a
 * physical database (e.g. demo orgs sharing the same Postgres).
 *
 * When `orgId` is omitted, falls back to the file-based whitelist
 * (`getWhitelistedTables(connectionId)`) — same source of truth the
 * SQL execution path uses for self-hosted single-tenant deployments.
 *
 * Mode semantics:
 *   - `published` — only published entities count as whitelisted
 *   - `developer` — draft overlay is included (drafts supersede published,
 *     tombstones hide tables, archived-connection entities are excluded)
 *   - omitted — legacy path (no status filter, all rows including tombstones)
 */
export interface DiffOptions {
  /** Organization ID for org-scoped semantic whitelist. */
  orgId?: string;
  /** Atlas mode — `published` (end-user) or `developer` (overlay with drafts). */
  atlasMode?: AtlasMode;
}

export async function runDiff(
  connectionId: string = "default",
  options: DiffOptions = {},
): Promise<SemanticDiffResponse> {
  const { orgId, atlasMode } = options;

  // Resolve the mode-aware whitelist for this org+connection. Falls back to
  // the file-based whitelist when no org context is available (self-hosted).
  let allowedTables: Set<string> | undefined;
  if (orgId && hasInternalDB()) {
    try {
      await loadOrgWhitelist(orgId, atlasMode);
      allowedTables = getOrgWhitelistedTables(orgId, connectionId, atlasMode);
    } catch (err) {
      // Fail closed — an empty allowed set means the diff returns no tables,
      // which is safer than leaking the whole DB schema across tenants.
      log.error(
        { orgId, connectionId, atlasMode, err: err instanceof Error ? err.message : String(err) },
        "Failed to load org whitelist — scoping diff to empty set",
      );
      allowedTables = new Set();
    }
  } else {
    allowedTables = getWhitelistedTables(connectionId);
  }

  const dbSnapshots = await getDBSchema(connectionId, allowedTables);
  const { snapshots: yamlSnapshots, warnings } = getYAMLSnapshots(connectionId);

  const diff = computeDiff(dbSnapshots, yamlSnapshots);

  const total = diff.newTables.length + diff.removedTables.length + diff.tableDiffs.length + diff.unchangedCount;

  return {
    connection: connectionId,
    newTables: diff.newTables,
    removedTables: diff.removedTables,
    tableDiffs: diff.tableDiffs,
    unchangedCount: diff.unchangedCount,
    summary: {
      total,
      new: diff.newTables.length,
      removed: diff.removedTables.length,
      changed: diff.tableDiffs.length,
      unchanged: diff.unchangedCount,
    },
    ...(warnings.length > 0 && { warnings }),
  };
}
