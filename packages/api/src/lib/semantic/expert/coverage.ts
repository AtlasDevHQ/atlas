/**
 * Coverage matrix (#4521, PRD #4502; CONTEXT.md § Semantic improvement) — the
 * PURE seam behind the column-anchored coverage view.
 *
 * It takes a connection's *physical* schema (the baseline profile's
 * `TableProfile[]`, #4509) and the *semantic store* (the group's
 * `ParsedEntity[]`) and reports, per table and per column, whether coverage
 * exists and how good it is: is the table modeled by an entity, is a column
 * represented as a dimension, and — for a covered column — is that dimension
 * described and sampled. Uncovered tables/columns are reported honestly; the
 * view routes them to the enrich flow, never to an "add entity" amendment
 * (ADR-0032 — amendments refine, never grow the whitelisted table set).
 *
 * Does **no I/O**: the output is a function of `(profiles, entities)` alone, so
 * this seam is trivially unit-testable. The impure gather that loads the
 * baseline payload + entities and triggers the lazy backfill lives in
 * `coverage-inputs.ts` (mirroring the briefing pure/impure split).
 *
 * The column→dimension match is the SAME rule the coverage-gap analyzer uses
 * (`findCoverageGaps` in `categories.ts`): a dimension whose `sql` equals the
 * physical column name (case-insensitively). Primary-key columns are surfaced
 * but excluded from the coverable denominator — PKs are usually not modeled as
 * dimensions, exactly as the analyzer skips them, so a PK-only table reads as
 * fully covered rather than perpetually partial.
 */

import type { ColumnProfile, TableProfile } from "@useatlas/types";
import type { ParsedEntity } from "./types";

/**
 * Mirrors the analyzer's auto-generated-description sniff (`AUTO_DESC_PATTERN`
 * in `categories.ts`). A description matching it counts as *undescribed* for the
 * "described" quality chip so an auto-stamped "The foo column" doesn't read as
 * real documentation. Kept local (not exported from `categories.ts`) because
 * this is a display heuristic, not a correctness gate — the two are allowed to
 * be independently tuned.
 */
const AUTO_DESC_PATTERN = /^The \w+ column\.?$|^Column \w+\.?$/i;

/** Whether a dimension description is meaningful (present + not auto-generated). */
function isDescribed(description: string | undefined): boolean {
  if (!description) return false;
  const trimmed = description.trim();
  return trimmed.length > 0 && !AUTO_DESC_PATTERN.test(trimmed);
}

/** How well one physical column is represented in the semantic layer. */
export interface ColumnCoverage {
  /** The physical column name (from the baseline profile). */
  readonly column: string;
  /** The column's SQL type, verbatim from the profile. */
  readonly type: string;
  /** A primary-key column — surfaced, but excluded from the coverable count. */
  readonly isPrimaryKey: boolean;
  /** True when a dimension models this column (by `sql` = column name). */
  readonly covered: boolean;
  /** The matching dimension's name, or `null` when uncovered. */
  readonly dimension: string | null;
  /** The covered dimension carries a meaningful (non-auto) description. */
  readonly described: boolean;
  /** The covered dimension carries sample values. */
  readonly sampled: boolean;
}

/**
 * A table's coverage state:
 *   - `covered`   — modeled by an entity AND every coverable (non-PK) column is a dimension.
 *   - `partial`   — modeled by an entity, but some coverable columns are still uncovered.
 *   - `uncovered` — no entity models this table at all (routes to enrich).
 */
export type TableCoverageState = "covered" | "partial" | "uncovered";

/** One physical table matched against the semantic store. */
export interface TableCoverage {
  /** The physical table name (from the baseline profile). */
  readonly table: string;
  /** Row count from the profile — orientation for the view. */
  readonly rowCount: number;
  /** The modeling entity's name, or `null` when uncovered. */
  readonly entity: string | null;
  /**
   * The modeling entity's Connection group (its resolved `group`/`connection`),
   * or `null` for the flat/default group or an uncovered table. Carried into the
   * column anchor so the launched conversation scopes correctly.
   */
  readonly group: string | null;
  readonly state: TableCoverageState;
  readonly columns: readonly ColumnCoverage[];
  /** Coverable (non-PK) columns that are represented as dimensions. */
  readonly coveredColumnCount: number;
  /** Total coverable (non-PK) columns — the denominator for the table state. */
  readonly coverableColumnCount: number;
}

/** Rollup counts for the view's summary chips. */
export interface CoverageSummary {
  readonly coveredTables: number;
  readonly partialTables: number;
  readonly uncoveredTables: number;
  readonly totalTables: number;
}

/** The full physical-schema × semantic-store coverage matrix for one connection. */
export interface CoverageMatrix {
  readonly tables: readonly TableCoverage[];
  readonly summary: CoverageSummary;
}

/** The modeling entity's effective Connection group (null for flat/default). */
function coverageGroupOf(entity: ParsedEntity): string | null {
  return entity.group ?? entity.connection ?? null;
}

/**
 * The entity that models a physical table — matched by `table` first, falling
 * back to `name` (the same predicate the coverage-gap analyzer uses). The caller
 * passes entities already scoped to the connection's group, so at most one
 * matches; the first is picked deterministically if names ever collide.
 */
function findModelingEntity(
  entities: readonly ParsedEntity[],
  tableName: string,
): ParsedEntity | null {
  return entities.find((e) => e.table === tableName || e.name === tableName) ?? null;
}

function coverColumn(col: ColumnProfile, entity: ParsedEntity | null): ColumnCoverage {
  const dim =
    entity?.dimensions.find((d) => d.sql.toLowerCase() === col.name.toLowerCase()) ?? null;
  return {
    column: col.name,
    type: col.type,
    isPrimaryKey: col.is_primary_key,
    covered: dim !== null,
    dimension: dim?.name ?? null,
    described: dim ? isDescribed(dim.description) : false,
    sampled: dim ? (dim.sample_values?.length ?? 0) > 0 : false,
  };
}

/** Compute one table's coverage against its (optional) modeling entity. */
function computeTableCoverage(
  profile: TableProfile,
  entity: ParsedEntity | null,
): TableCoverage {
  const columns = profile.columns.map((col) => coverColumn(col, entity));
  const coverable = columns.filter((c) => !c.isPrimaryKey);
  const coveredColumnCount = coverable.filter((c) => c.covered).length;
  const coverableColumnCount = coverable.length;

  let state: TableCoverageState;
  if (!entity) {
    state = "uncovered";
  } else if (coveredColumnCount === coverableColumnCount) {
    // Every coverable column is a dimension (a PK-only table has zero coverable
    // columns and reads as fully covered — nothing left to model).
    state = "covered";
  } else {
    state = "partial";
  }

  return {
    table: profile.table_name,
    rowCount: profile.row_count,
    entity: entity?.name ?? null,
    group: entity ? coverageGroupOf(entity) : null,
    state,
    columns,
    coveredColumnCount,
    coverableColumnCount,
  };
}

/**
 * Compute the coverage matrix for one connection's physical schema against the
 * semantic store. `entities` should already be scoped to the connection's group
 * (the loader filters); `computeCoverage` re-applies no group scoping — it matches
 * each profile to an entity by table/name identity alone (see `findModelingEntity`).
 * Tables are returned in the profile's order, so the view is stable across renders.
 */
export function computeCoverage(
  profiles: readonly TableProfile[],
  entities: readonly ParsedEntity[],
): CoverageMatrix {
  const tables = profiles.map((profile) =>
    computeTableCoverage(profile, findModelingEntity(entities, profile.table_name)),
  );

  const summary: CoverageSummary = {
    coveredTables: tables.filter((t) => t.state === "covered").length,
    partialTables: tables.filter((t) => t.state === "partial").length,
    uncoveredTables: tables.filter((t) => t.state === "uncovered").length,
    totalTables: tables.length,
  };

  return { tables, summary };
}
