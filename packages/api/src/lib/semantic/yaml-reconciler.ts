/**
 * Pure YAML reconciler for the drift-drawer reconcile actions (#2462 / PRD #2458).
 *
 * `reconcileEntityYaml` takes the entity's current YAML string and a
 * column-level {@link SemanticTableDiff} from the diff engine and returns the
 * updated YAML — the dimension list is rewritten to match the introspected
 * DB columns while user-authored fields (`description`, `sample_values`,
 * `joins`, `measures`, `query_patterns`, plus any per-dimension metadata)
 * are preserved verbatim.
 *
 * `generateStarterEntityYaml` builds a brand-new entity YAML from an
 * introspected column list — used by the `create_from_db` reconcile action
 * to bootstrap a starter entity for a DB table that has no matching YAML.
 *
 * Both functions are pure: no DB calls, no fs writes. The drift-reconcile
 * dispatcher (`reconcile.ts`) is the side-effecting caller — keeping these
 * pure lets the unit tests cover every variant without spinning up a DB.
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
 * Apply a column-level DB↔YAML diff to an entity's YAML.
 *
 * - `addedColumns` → appended as new dimensions (`{ name, sql: name, type }`).
 * - `removedColumns` → matching dimensions dropped by name.
 * - `typeChanges` → existing dimension's `type` overwritten with `dbType`;
 *   description, sample_values, primary_key, foreign_key, etc. preserved.
 *
 * Top-level fields other than `dimensions` are untouched — `description`,
 * `joins`, `measures`, `query_patterns`, and any other user-authored
 * sections round-trip verbatim.
 *
 * Throws when the input YAML can't be parsed into an object. The caller is
 * responsible for re-fetching the entity, applying the result, and writing
 * it back as a draft.
 */
export function reconcileEntityYaml(
  existingYaml: string,
  diff: SemanticTableDiff,
): string {
  const parsed = yaml.load(existingYaml);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("reconcileEntityYaml: input YAML did not parse to an object");
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

/**
 * Build a starter entity YAML from an introspected DB table's column list.
 * Used by the `create_from_db` reconcile action. The caller is expected to
 * have already verified that no entity with this name exists.
 */
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
