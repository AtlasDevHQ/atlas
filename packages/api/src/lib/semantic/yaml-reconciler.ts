/**
 * Pure YAML reconciler for the drift-drawer reconcile actions. Caller is
 * responsible for fetching the entity, applying the result, and writing it
 * back as a draft — keeping these pure lets the unit tests cover every
 * variant without a DB.
 */

import * as yaml from "js-yaml";
import type { SemanticTableDiff } from "@useatlas/types";

interface Dimension {
  name?: string;
  type?: string;
  sql?: string;
  [key: string]: unknown;
}

/**
 * Apply a column-level diff to an entity's YAML. Top-level fields other
 * than `dimensions` (description, joins, measures, query_patterns, plus
 * any per-dimension metadata on retained rows) round-trip verbatim.
 *
 * Precedence when a column appears in both `removedColumns` and
 * `typeChanges` (the diff engine doesn't currently emit this combo, but
 * the type permits it): the dimension is dropped. Removal wins.
 *
 * Throws when the input YAML can't be parsed into an object.
 */
export function reconcileEntityYaml(
  existingYaml: string,
  diff: SemanticTableDiff,
): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(existingYaml);
  } catch (err) {
    throw new Error(
      `reconcileEntityYaml: YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `reconcileEntityYaml: parsed YAML must be an object (got ${
        parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed
      })`,
    );
  }
  const doc = parsed as Record<string, unknown>;

  const rawDims = Array.isArray(doc.dimensions) ? (doc.dimensions as Dimension[]) : [];
  const removedNames = new Set(diff.removedColumns.map((c) => c.name));
  const typeOverrides = new Map(diff.typeChanges.map((c) => [c.name, c.dbType] as const));

  const kept: Dimension[] = [];
  for (const dim of rawDims) {
    if (typeof dim?.name === "string" && removedNames.has(dim.name)) continue;
    if (typeof dim?.name === "string" && typeOverrides.has(dim.name)) {
      kept.push({ ...dim, type: typeOverrides.get(dim.name) });
    } else {
      kept.push(dim);
    }
  }

  for (const col of diff.addedColumns) {
    kept.push({ name: col.name, sql: col.name, type: col.type });
  }

  return yaml.dump({ ...doc, dimensions: kept }, { lineWidth: 120, noRefs: true });
}

/** Build a starter entity YAML from an introspected DB column list. */
export function generateStarterEntityYaml(
  table: string,
  columns: ReadonlyArray<{ name: string; type: string }>,
): string {
  const doc = {
    table,
    description: `Auto-generated from database introspection of "${table}".`,
    dimensions: columns.map((c) => ({ name: c.name, sql: c.name, type: c.type })),
  };
  return yaml.dump(doc, { lineWidth: 120, noRefs: true });
}
