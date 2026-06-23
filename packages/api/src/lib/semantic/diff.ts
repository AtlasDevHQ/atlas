/**
 * Semantic layer diff — compares live database schema against entity YAML files.
 *
 * Core comparison logic extracted from the CLI `atlas diff` command so both
 * CLI and API can share the same diff engine.
 */

import * as fs from "fs";
import type { SemanticTableDiff, SemanticDiffResponse } from "@useatlas/types";
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { connections } from "@atlas/api/lib/db/connection";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { getSemanticRoot, readYamlFile, discoverEntities } from "./files";
import { resolveAllowedTables, type AllowedTablesScope } from "./allowed-tables";
import { listEntityRows, listEntitiesWithOverlay } from "./entities";

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
    t === "long" ||
    // YAML semantic-layer aliases — `parseEntityYAML` runs every dimension
    // type through this same normalizer so the diff comparison stays in
    // one target space. Without these, canonical YAML types like "number"
    // fall through to the "string" default and produce phantom drift rows.
    t === "number"
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
    // Normalize YAML dimension types into the same target space as
    // `mapSQLType` so the diff compares apples to apples. Without this,
    // YAML "timestamp" was being compared against DB-normalized "date"
    // (because `mapSQLType` collapses every date-class SQL type into
    // "date"), producing 13 false-positive "drift" rows for every
    // workspace whose YAML used the canonical semantic-layer type names
    // ("timestamp", "number", "boolean", etc).
    columns.set(dim.name, mapSQLType(dim.type));
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
 * Returns the unfiltered map — every table the DB reports for the active
 * schema. The "drift" path (#2458 slice 1) needs the unfiltered count to
 * tell "DB has no tables" apart from "whitelist excluded every table" —
 * those are very different signals to the admin.
 *
 * Callers that want to scope to the semantic whitelist should use
 * `getDBSchema` (thin wrapper) or call `filterSnapshotsByWhitelist` themselves.
 */
export async function getDBSchemaRaw(
  connectionId: string = "default",
  workspaceId?: string,
): Promise<Map<string, EntitySnapshot>> {
  // When a workspace context is available, resolve per (workspace, install_id)
  // so a shared install_id reads the correct tenant's schema, not whichever
  // workspace registered the install_id first (#3109).
  const conn = workspaceId
    ? connections.getForWorkspace(workspaceId, connectionId)
    : connections.get(connectionId);
  const dbType = connections.getDBType(connectionId, workspaceId);

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

  return snapshots;
}

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
  workspaceId?: string,
): Promise<Map<string, EntitySnapshot>> {
  const snapshots = await getDBSchemaRaw(connectionId, workspaceId);
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
    // Match entities to the requested connection by their resolved Connection
    // group (directory-canonical per ADR-0012), NOT the raw `connection`/`source`
    // fields. A canonical `groups/<group>/` entity carrying a stale `connection:`
    // field would otherwise be scoped to the field's group here while the
    // importer + whitelist scope it to its directory — diverging the drift view
    // from the imported whitelist for the same files (#3245).
    if (entity.group !== connectionId) continue;

    // Locate the entity's YAML via the layout-aware path the scanner already
    // discovered. Reconstructing `<root>/<source>/entities/<table>.yml` (the
    // legacy layout, keyed on `table`) silently skipped the canonical
    // `groups/<group>/entities/<name>.yml` namespace and broke whenever a
    // YAML's filename (`name`) differed from its `table` (#3245, ADR-0012).
    const filePath = entity.filePath;

    if (!fs.existsSync(filePath)) continue;

    try {
      const doc = readYamlFile(filePath) as Record<string, unknown>;
      if (!doc || typeof doc.table !== "string") continue;
      const snapshot = parseEntityYAML(doc);
      snapshots.set(snapshot.table, snapshot);
    } catch (err) {
      const msg = `Failed to parse ${entity.name}.yml: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), filePath }, msg);
      warnings.push(msg);
    }
  }

  return { snapshots, warnings };
}

// ---------------------------------------------------------------------------
// getYAMLSnapshotsFromDB — read entity YAMLs from the internal DB
// ---------------------------------------------------------------------------

/**
 * Build YAML snapshots from `semantic_entities` rows for an org+connection.
 *
 * SaaS workspaces store their semantic layer in the internal DB (the wizard
 * and `/use-demo` both write rows with `connection_id` set, never to disk).
 * The on-disk loader (`getYAMLSnapshots`) returns empty for those orgs, which
 * is why the drift drawer was rendering "all DB tables are new" or "no
 * entities match" — the diff was comparing a real DB schema against an
 * empty YAML side. This loader is the DB-backed counterpart.
 *
 * Mode semantics mirror the whitelist:
 *   - `developer` — overlay (draft + published; `draft_delete` tombstones
 *     drop the published row; entities under archived connections are
 *     excluded by `listEntitiesWithOverlay`) so the diff reflects what the
 *     developer is editing.
 *   - `published` or omitted — only `status = 'published'` entity rows are
 *     read. We never include `archived` rows in a diff because archived
 *     state represents removed semantic-layer state, not part of the
 *     comparison surface.
 *
 * Connection scoping matches what `executeSQL` and the whitelist do:
 *   - rows with `connection_id = connectionId` belong to that connection
 *   - rows with `connection_id IS NULL` belong to the "default" connection
 *     only — they're hidden when the caller asks about a non-default
 *     connection so an org with both `default` and `__demo__` doesn't double-
 *     count entities written before connection scoping existed.
 */
export async function getYAMLSnapshotsFromDB(
  orgId: string,
  connectionId: string,
  atlasMode: AtlasMode | undefined,
): Promise<{ snapshots: Map<string, EntitySnapshot>; warnings: string[] }> {
  const snapshots = new Map<string, EntitySnapshot>();
  const warnings: string[] = [];

  // Lazy import to avoid pulling js-yaml into the CLI's bundle of this module.
  const yaml = await import("js-yaml");

  // Always filter to non-archived rows. `listEntityRows(..., undefined)` would
  // include `archived` (verified at entities.ts) — undesirable for a diff.
  const rows = atlasMode === "developer"
    ? await listEntitiesWithOverlay(orgId, "entity")
    : await listEntityRows(orgId, "entity", "published");

  for (const row of rows) {
    const rowConnection = row.connection_group_id ?? "default";
    if (rowConnection !== connectionId) continue;
    try {
      const doc = yaml.load(row.yaml_content) as Record<string, unknown> | null;
      if (!doc || typeof doc.table !== "string") continue;
      const snapshot = parseEntityYAML(doc);
      snapshots.set(snapshot.table, snapshot);
    } catch (err) {
      const msg = `Failed to parse entity row ${row.name}: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)), entityName: row.name, orgId },
        msg,
      );
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
// Extends AllowedTablesScope so the diff's whitelist scope stays in lockstep
// with the shared resolver: a new required scoping axis surfaces here as a
// compile error rather than silently going unpassed (the diff supplies its own
// `onMissingOrgDB` at the call site, so it isn't part of this public shape).
export interface DiffOptions extends Pick<AllowedTablesScope, "orgId" | "atlasMode"> {
  /** Organization ID for org-scoped semantic whitelist. */
  orgId?: string;
  /** Atlas mode — `published` (end-user) or `developer` (overlay with drafts). */
  atlasMode?: AtlasMode;
}

// The allowed-tables whitelist resolution lives in `./allowed-tables`
// (`resolveAllowedTables`) so the diff and the public `/api/v1/tables`
// endpoint (#3898) share ONE definition and can't drift on the org / mode /
// internal-DB axes — "advertised == enforced" stays structural.

/**
 * Internal: resolve the YAML snapshot side of the diff, preferring DB-backed
 * entities (SaaS workspaces) and falling back to disk-backed entities for
 * self-hosted-with-no-internal-DB or legacy CLI callers. The disk fallback
 * also kicks in for self-hosted-with-internal-DB-and-disk-only-YAML — when
 * the DB query yields zero entries we re-try the disk loader so an admin who
 * hand-edits files still gets a meaningful diff.
 */
async function resolveYAMLSnapshots(
  connectionId: string,
  options: DiffOptions,
): Promise<{ snapshots: Map<string, EntitySnapshot>; warnings: string[] }> {
  const { orgId, atlasMode } = options;
  if (orgId && hasInternalDB()) {
    const dbResult = await getYAMLSnapshotsFromDB(orgId, connectionId, atlasMode);
    if (dbResult.snapshots.size === 0) {
      const diskResult = getYAMLSnapshots(connectionId);
      return {
        snapshots: diskResult.snapshots,
        warnings: [...dbResult.warnings, ...diskResult.warnings],
      };
    }
    return { snapshots: dbResult.snapshots, warnings: dbResult.warnings };
  }
  return getYAMLSnapshots(connectionId);
}

export async function runDiff(
  connectionId: string = "default",
  options: DiffOptions = {},
): Promise<SemanticDiffResponse> {
  // The diff opts into the file-whitelist fallback for an org-without-internal-DB
  // (a self-hosted admin who set an org but hand-edits YAML still gets a
  // meaningful diff); the enforcement-parity surfaces (/api/v1/tables) use the
  // default "empty" so they match validateSQL exactly.
  const allowedTables = await resolveAllowedTables(connectionId, { ...options, onMissingOrgDB: "file" });
  // Scope introspection to the querying workspace (#3109) so a shared
  // install_id reads the correct tenant's schema, not a sibling's.
  const dbSnapshots = await getDBSchema(connectionId, allowedTables, options.orgId);
  const { snapshots: yamlSnapshots, warnings } = await resolveYAMLSnapshots(connectionId, options);

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

/**
 * Drift-check variant of `runDiff` for the admin entities-list endpoint
 * (#2458 slice 1). Returns the raw `DiffResult` (not the public response
 * envelope) plus the introspected table count BEFORE whitelist filtering.
 *
 * The pre-filter count is the load-bearing bit: an empty `introspectedTables`
 * means "the database itself has no tables", which the file tree should
 * surface as a targeted empty state instead of showing every YAML entry
 * as drifted-removed. A non-empty unfiltered set with an empty filtered
 * set means "tables exist but the whitelist excluded all of them" — a
 * very different signal that the existing diff machinery already handles.
 */
export async function runDriftDiff(
  connectionId: string = "default",
  options: DiffOptions = {},
): Promise<{
  diff: DiffResult;
  introspectedTableCount: number;
  warnings: string[];
}> {
  // The diff opts into the file-whitelist fallback for an org-without-internal-DB
  // (a self-hosted admin who set an org but hand-edits YAML still gets a
  // meaningful diff); the enforcement-parity surfaces (/api/v1/tables) use the
  // default "empty" so they match validateSQL exactly.
  const allowedTables = await resolveAllowedTables(connectionId, { ...options, onMissingOrgDB: "file" });
  // Scope introspection to the querying workspace (#3109) so a shared
  // install_id reads the correct tenant's schema, not a sibling's.
  const rawDBSnapshots = await getDBSchemaRaw(connectionId, options.orgId);
  const dbSnapshots = filterSnapshotsByWhitelist(rawDBSnapshots, allowedTables);
  const { snapshots: yamlSnapshots, warnings } = await resolveYAMLSnapshots(connectionId, options);

  const diff = computeDiff(dbSnapshots, yamlSnapshots);
  return { diff, introspectedTableCount: rawDBSnapshots.size, warnings };
}
