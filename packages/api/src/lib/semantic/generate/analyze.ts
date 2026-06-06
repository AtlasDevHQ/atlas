/**
 * Semantic-layer mechanical generator — profile analysis pass.
 *
 * Pure heuristics over `TableProfile[]`: FK inference, abandoned/denormalized
 * table detection, enum-inconsistency flags, plus the `analyzeTableProfiles`
 * orchestrator that the CLI (`atlas init`) and the web wizard both run before
 * generating YAML.
 *
 * Relocated from `lib/profiler.ts` (issue #3233) so the mechanical generator
 * and the LLM enrichment live behind one shared engine. `lib/profiler.ts`
 * re-exports these for backward compatibility.
 */

import type { TableProfile, ForeignKey } from "@useatlas/types";
import { isViewLike, pluralize, singularize } from "../../profiler-utils";
import {
  inferSemanticTypes,
  inferJoinsFromNamingConventions,
} from "../../profiler-patterns";

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

export function isView(profile: TableProfile): boolean {
  return profile.object_type === "view";
}

export function isMatView(profile: TableProfile): boolean {
  return profile.object_type === "materialized_view";
}

export function mapSalesforceFieldType(sfType: string): string {
  const lower = sfType.toLowerCase();
  switch (lower) {
    case "int":
    case "long":
      return "integer";
    case "double":
    case "currency":
    case "percent":
      return "real";
    case "boolean":
      return "boolean";
    case "date":
    case "datetime":
    case "time":
      return "date";
    default:
      return "string";
  }
}

// ---------------------------------------------------------------------------
// Profiler heuristics (pure functions on TableProfile[])
// ---------------------------------------------------------------------------

export function inferForeignKeys(profiles: TableProfile[]): void {
  const tableMap = new Map(
    profiles.filter((p) => !isViewLike(p)).map((p) => [p.table_name, p])
  );

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const constrainedCols = new Set(profile.foreign_keys.map((fk) => fk.from_column));

    for (const col of profile.columns) {
      if (!col.name.endsWith("_id")) continue;
      if (constrainedCols.has(col.name)) continue;
      if (col.is_primary_key) continue;

      const prefix = col.name.slice(0, -3);
      if (!prefix) continue;

      const candidates = [prefix, pluralize(prefix), singularize(prefix)];
      let targetTable: TableProfile | undefined;
      for (const candidate of candidates) {
        targetTable = tableMap.get(candidate);
        if (targetTable) break;
      }

      if (!targetTable) continue;

      const hasPkId = targetTable.primary_key_columns.includes("id");
      if (!hasPkId) continue;

      const inferredFK: ForeignKey = {
        from_column: col.name,
        to_table: targetTable.table_name,
        to_column: "id",
        source: "inferred",
      };

      profile.inferred_foreign_keys.push(inferredFK);

      col.profiler_notes.push(
        `Likely FK to ${targetTable.table_name}.id (inferred from column name, no constraint exists)`
      );
    }
  }
}

const ABANDONED_NAME_PATTERNS = [
  /^old_/,
  /^temp_/,
  /^legacy_/,
  /_legacy$/,
  /_backup$/,
  /_archive$/,
  /_v\d+$/,
];

export function detectAbandonedTables(profiles: TableProfile[]): void {
  const referencedTables = new Set<string>();
  for (const p of profiles) {
    for (const fk of p.foreign_keys) referencedTables.add(fk.to_table);
    for (const fk of p.inferred_foreign_keys) referencedTables.add(fk.to_table);
  }

  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const nameMatches = ABANDONED_NAME_PATTERNS.some((pat) =>
      pat.test(profile.table_name)
    );
    if (!nameMatches) continue;

    const hasInboundFKs = referencedTables.has(profile.table_name);
    if (hasInboundFKs) continue;

    profile.table_flags.possibly_abandoned = true;
    profile.profiler_notes.push(
      `Possibly abandoned: name matches legacy/temp pattern and no other tables reference it`
    );
  }
}

export function detectEnumInconsistency(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    for (const col of profile.columns) {
      if (!col.is_enum_like) continue;
      if (col.sample_values.length === 0) continue;

      const groups = new Map<string, string[]>();
      for (const val of col.sample_values) {
        const lower = val.toLowerCase();
        const existing = groups.get(lower) ?? [];
        existing.push(val);
        groups.set(lower, existing);
      }

      const inconsistencies: string[] = [];
      for (const [, originals] of groups) {
        if (originals.length > 1) {
          inconsistencies.push(originals.join(", "));
        }
      }

      if (inconsistencies.length > 0) {
        col.profiler_notes.push(
          `Case-inconsistent enum values: [${inconsistencies.join("; ")}]. Consider using LOWER() for grouping`
        );
      }
    }
  }
}

const DENORMALIZED_NAME_PATTERNS = [
  /_denormalized$/,
  /_cache$/,
  /_summary$/,
  /_stats$/,
  /_rollup$/,
];

export function detectDenormalizedTables(profiles: TableProfile[]): void {
  for (const profile of profiles) {
    if (isViewLike(profile)) continue;

    const nameMatches = DENORMALIZED_NAME_PATTERNS.some((pat) =>
      pat.test(profile.table_name)
    );
    if (!nameMatches) continue;

    profile.table_flags.possibly_denormalized = true;
    profile.profiler_notes.push(
      `Possibly denormalized/materialized table: name matches reporting pattern. Data may duplicate other tables`
    );
  }
}

export function analyzeTableProfiles(profiles: readonly TableProfile[]): TableProfile[] {
  // Create fresh copies with reset analysis fields (no mutation of input).
  // Deep-clone foreign_keys and partition_info to fully isolate from input.
  const analyzed: TableProfile[] = profiles.map((p) => ({
    ...p,
    foreign_keys: p.foreign_keys.map((fk) => ({ ...fk })),
    inferred_foreign_keys: [],
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
    columns: p.columns.map((col) => ({ ...col, profiler_notes: [] })),
    partition_info: p.partition_info
      ? { ...p.partition_info, children: [...p.partition_info.children] }
      : undefined,
  }));

  inferForeignKeys(analyzed);
  inferJoinsFromNamingConventions(analyzed);
  inferSemanticTypes(analyzed);
  detectAbandonedTables(analyzed);
  detectEnumInconsistency(analyzed);
  detectDenormalizedTables(analyzed);

  return analyzed;
}
