/**
 * Schema diff logic — compare live DB profiles against YAML entity snapshots.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import type { TableProfile } from "@atlas/api/lib/profiler";
import { mapSQLType, isView, isMatView } from "@atlas/api/lib/profiler";

// --- Schema diff types ---

export interface EntitySnapshot {
  table: string;
  columns: Map<string, string>; // column name → normalized type
  foreignKeys: Set<string>; // "from_col→target_table.target_col"
  objectType?: string; // "fact_table", "view", "materialized_view"
  partitionStrategy?: string;
  partitionKey?: string;
}

export interface TableDiff {
  table: string;
  addedColumns: { name: string; type: string }[];
  removedColumns: { name: string; type: string }[];
  typeChanges: { name: string; yamlType: string; dbType: string }[];
  addedFKs: string[];
  removedFKs: string[];
  metadataChanges: string[];
}

export interface DiffResult {
  newTables: string[];
  removedTables: string[];
  tableDiffs: TableDiff[];
}

// --- Schema diff logic ---

/**
 * Parse an entity YAML object into a normalized EntitySnapshot.
 * Skips virtual dimensions. Extracts FKs from joins array.
 */
export function parseEntityYAML(
  doc: Record<string, unknown>,
): EntitySnapshot {
  const table = doc.table as string;
  const columns = new Map<string, string>();
  const foreignKeys = new Set<string>();

  // Extract columns from dimensions (skip virtual)
  const rawDimensions = doc.dimensions ?? [];
  if (!Array.isArray(rawDimensions)) {
    console.warn(
      `[atlas diff] Skipping ${table}: 'dimensions' field is not an array`,
    );
    return { table, columns, foreignKeys };
  }
  const dimensions = rawDimensions as Record<string, unknown>[];
  for (const dim of dimensions) {
    if (dim.virtual) continue;
    if (typeof dim.name !== "string" || typeof dim.type !== "string") {
      console.warn(
        `[atlas diff] Skipping malformed dimension in ${table}: name=${String(dim.name)}, type=${String(dim.type)}`,
      );
      continue;
    }
    columns.set(dim.name, dim.type);
  }

  // Extract FKs from joins
  const rawJoins = doc.joins ?? [];
  if (!Array.isArray(rawJoins)) {
    console.warn(
      `[atlas diff] Skipping joins for ${table}: 'joins' field is not an array`,
    );
    return { table, columns, foreignKeys };
  }
  const joins = rawJoins as Record<string, unknown>[];
  for (const join of joins) {
    const joinCols = join.join_columns as
      | { from: string; to: string }
      | undefined;
    const targetEntity = join.target_entity as string | undefined;
    if (!joinCols || !targetEntity) {
      console.warn(
        `[atlas diff] Skipping malformed join in ${table}: missing join_columns or target_entity`,
      );
      continue;
    }
    if (
      typeof joinCols.from !== "string" ||
      typeof joinCols.to !== "string"
    ) {
      console.warn(
        `[atlas diff] Skipping malformed join in ${table}: join_columns.from/to must be strings`,
      );
      continue;
    }

    // target_entity is PascalCase entity name — we need the table name.
    // Approximate inverse of entityName(): splits on lowercase→uppercase boundaries.
    // Works for segments >= 2 chars (e.g. "UserAccount" → "user_account").
    const targetTable = targetEntity
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();
    foreignKeys.add(`${joinCols.from}→${targetTable}.${joinCols.to}`);
  }

  // Extract metadata
  const objectType =
    typeof doc.type === "string" ? doc.type : undefined;
  const partitionStrategy =
    typeof doc.partition_strategy === "string"
      ? doc.partition_strategy
      : undefined;
  const partitionKey =
    typeof doc.partition_key === "string" ? doc.partition_key : undefined;

  return {
    table,
    columns,
    foreignKeys,
    objectType,
    partitionStrategy,
    partitionKey,
  };
}

/**
 * Build EntitySnapshot from a live DB profile.
 * Must be called after analyzeTableProfiles() — that step populates
 * inferred_foreign_keys which are included alongside declared FKs.
 */
export function profileToSnapshot(profile: TableProfile): EntitySnapshot {
  const columns = new Map<string, string>();
  for (const col of profile.columns) {
    columns.set(col.name, mapSQLType(col.type));
  }

  const foreignKeys = new Set<string>();
  for (const fk of [
    ...profile.foreign_keys,
    ...profile.inferred_foreign_keys,
  ]) {
    foreignKeys.add(`${fk.from_column}→${fk.to_table}.${fk.to_column}`);
  }

  // Map object_type to entity type string used in YAML
  let objectType: string | undefined;
  if (isMatView(profile)) {
    objectType = "materialized_view";
  } else if (isView(profile)) {
    objectType = "view";
  } else {
    objectType = "fact_table";
  }

  return {
    table: profile.table_name,
    columns,
    foreignKeys,
    objectType,
    partitionStrategy: profile.partition_info?.strategy,
    partitionKey: profile.partition_info?.key,
  };
}

/**
 * Compute the diff between DB snapshots and YAML snapshots.
 * Pure function — no I/O.
 */
export function computeDiff(
  dbSnapshots: Map<string, EntitySnapshot>,
  yamlSnapshots: Map<string, EntitySnapshot>,
): DiffResult {
  const dbTables = new Set(dbSnapshots.keys());
  const yamlTables = new Set(yamlSnapshots.keys());

  const newTables = [...dbTables].filter((t) => !yamlTables.has(t)).sort();
  const removedTables = [...yamlTables]
    .filter((t) => !dbTables.has(t))
    .sort();

  const tableDiffs: TableDiff[] = [];

  // Compare shared tables
  for (const table of [...dbTables]
    .filter((t) => yamlTables.has(t))
    .sort()) {
    const db = dbSnapshots.get(table)!;
    const yml = yamlSnapshots.get(table)!;

    const addedColumns: { name: string; type: string }[] = [];
    const removedColumns: { name: string; type: string }[] = [];
    const typeChanges: {
      name: string;
      yamlType: string;
      dbType: string;
    }[] = [];

    // Columns in DB but not YAML
    for (const [name, type] of db.columns) {
      if (!yml.columns.has(name)) {
        addedColumns.push({ name, type });
      } else if (yml.columns.get(name) !== type) {
        typeChanges.push({
          name,
          yamlType: yml.columns.get(name)!,
          dbType: type,
        });
      }
    }

    // Columns in YAML but not DB
    for (const [name, type] of yml.columns) {
      if (!db.columns.has(name)) {
        removedColumns.push({ name, type });
      }
    }

    // FK differences
    const addedFKs = [...db.foreignKeys]
      .filter((fk) => !yml.foreignKeys.has(fk))
      .sort();
    const removedFKs = [...yml.foreignKeys]
      .filter((fk) => !db.foreignKeys.has(fk))
      .sort();

    // Metadata differences
    const metadataChanges: string[] = [];
    // Only flag type changes that indicate real schema drift (e.g. table↔view).
    // Semantic classifications like dimension_table vs fact_table are enrichment
    // metadata — the profiler always assigns "fact_table" to non-views, so comparing
    // it against enriched YAML produces false positives.
    const semanticTypes = new Set(["fact_table", "dimension_table"]);
    if (
      db.objectType &&
      yml.objectType &&
      db.objectType !== yml.objectType &&
      !(
        semanticTypes.has(db.objectType) &&
        semanticTypes.has(yml.objectType)
      )
    ) {
      metadataChanges.push(
        `type changed: ${yml.objectType} → ${db.objectType}`,
      );
    }
    if (db.partitionStrategy !== yml.partitionStrategy) {
      if (db.partitionStrategy && !yml.partitionStrategy) {
        metadataChanges.push(
          `partition strategy added: ${db.partitionStrategy}`,
        );
      } else if (!db.partitionStrategy && yml.partitionStrategy) {
        metadataChanges.push(
          `partition strategy removed (was: ${yml.partitionStrategy})`,
        );
      } else if (db.partitionStrategy && yml.partitionStrategy) {
        metadataChanges.push(
          `partition strategy changed: ${yml.partitionStrategy} → ${db.partitionStrategy}`,
        );
      }
    }
    if (db.partitionKey !== yml.partitionKey) {
      if (db.partitionKey && !yml.partitionKey) {
        metadataChanges.push(`partition key added: ${db.partitionKey}`);
      } else if (!db.partitionKey && yml.partitionKey) {
        metadataChanges.push(
          `partition key removed (was: ${yml.partitionKey})`,
        );
      } else if (db.partitionKey && yml.partitionKey) {
        metadataChanges.push(
          `partition key changed: ${yml.partitionKey} → ${db.partitionKey}`,
        );
      }
    }

    if (
      addedColumns.length > 0 ||
      removedColumns.length > 0 ||
      typeChanges.length > 0 ||
      addedFKs.length > 0 ||
      removedFKs.length > 0 ||
      metadataChanges.length > 0
    ) {
      tableDiffs.push({
        table,
        addedColumns,
        removedColumns,
        typeChanges,
        addedFKs,
        removedFKs,
        metadataChanges,
      });
    }
  }

  return { newTables, removedTables, tableDiffs };
}

/**
 * Format a DiffResult as a human-readable string.
 * @param dbSnapshots — when provided, new-table summaries include column counts
 *   from the live DB profile.
 */
export function formatDiff(
  diff: DiffResult,
  dbSnapshots?: Map<string, EntitySnapshot>,
): string {
  const lines: string[] = [];
  lines.push(
    "Atlas Diff — comparing database against semantic/entities/\n",
  );

  const hasDrift =
    diff.newTables.length > 0 ||
    diff.removedTables.length > 0 ||
    diff.tableDiffs.length > 0;

  if (!hasDrift) {
    lines.push(
      "No drift detected — semantic layer is in sync with the database.",
    );
    return lines.join("\n");
  }

  if (diff.newTables.length > 0) {
    lines.push("New tables (in DB, not in semantic layer):");
    for (const t of diff.newTables) {
      const snap = dbSnapshots?.get(t);
      const detail = snap ? ` (${snap.columns.size} columns)` : "";
      lines.push(`  + ${t}${detail}`);
    }
    lines.push("");
  }

  if (diff.removedTables.length > 0) {
    lines.push("Removed tables (in semantic layer, not in DB):");
    for (const t of diff.removedTables) {
      lines.push(`  - ${t}`);
    }
    lines.push("");
  }

  if (diff.tableDiffs.length > 0) {
    lines.push("Changed tables:");
    for (const td of diff.tableDiffs) {
      lines.push(`  ${td.table}`);
      for (const col of td.addedColumns) {
        lines.push(`    + added column: ${col.name} (${col.type})`);
      }
      for (const col of td.removedColumns) {
        lines.push(`    - removed column: ${col.name} (${col.type})`);
      }
      for (const tc of td.typeChanges) {
        lines.push(
          `    ~ type changed: ${tc.name} — YAML: ${tc.yamlType}, DB: ${tc.dbType}`,
        );
      }
      for (const fk of td.addedFKs) {
        lines.push(`    + added FK: ${fk}`);
      }
      for (const fk of td.removedFKs) {
        lines.push(`    - removed FK: ${fk}`);
      }
      for (const mc of td.metadataChanges) {
        lines.push(`    ~ ${mc}`);
      }
      lines.push("");
    }
  }

  // Summary line
  const totalAdded = diff.tableDiffs.reduce(
    (n, td) => n + td.addedColumns.length,
    0,
  );
  const totalRemoved = diff.tableDiffs.reduce(
    (n, td) => n + td.removedColumns.length,
    0,
  );
  const totalTypeChanges = diff.tableDiffs.reduce(
    (n, td) => n + td.typeChanges.length,
    0,
  );
  const totalAddedFKs = diff.tableDiffs.reduce(
    (n, td) => n + td.addedFKs.length,
    0,
  );
  const totalRemovedFKs = diff.tableDiffs.reduce(
    (n, td) => n + td.removedFKs.length,
    0,
  );
  const totalMetadata = diff.tableDiffs.reduce(
    (n, td) => n + td.metadataChanges.length,
    0,
  );

  const parts: string[] = [];
  if (diff.newTables.length > 0)
    parts.push(
      `${diff.newTables.length} new table${diff.newTables.length === 1 ? "" : "s"}`,
    );
  if (diff.removedTables.length > 0)
    parts.push(`${diff.removedTables.length} removed`);
  if (diff.tableDiffs.length > 0) {
    const details: string[] = [];
    if (totalAdded > 0)
      details.push(
        `${totalAdded} column${totalAdded === 1 ? "" : "s"} added`,
      );
    if (totalRemoved > 0) details.push(`${totalRemoved} removed`);
    if (totalTypeChanges > 0)
      details.push(
        `${totalTypeChanges} type change${totalTypeChanges === 1 ? "" : "s"}`,
      );
    if (totalAddedFKs > 0)
      details.push(
        `${totalAddedFKs} FK${totalAddedFKs === 1 ? "" : "s"} added`,
      );
    if (totalRemovedFKs > 0)
      details.push(
        `${totalRemovedFKs} FK${totalRemovedFKs === 1 ? "" : "s"} removed`,
      );
    if (totalMetadata > 0)
      details.push(
        `${totalMetadata} metadata change${totalMetadata === 1 ? "" : "s"}`,
      );
    parts.push(
      `${diff.tableDiffs.length} changed (${details.join(", ")})`,
    );
  }
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}
