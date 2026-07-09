/**
 * Pure merger module for fanned-out `executeSQL` results
 * (PRD #2515, slice 1 #2516).
 *
 * Takes the array of per-member execution outcomes from a fanout (one entry
 * per member of the active connection group, including any that errored)
 * and returns a single `{columns, rows}` result with the sentinel
 * `__env__` column prepended, plus a parallel `envContributions` array
 * that surfaces per-member metadata (row count, error message, duration).
 *
 * **Pure.** No DB, no IO, no fetch — the merger only knows about result
 * objects. The caller is responsible for actually running the queries
 * (typically via `Promise.allSettled`) and packaging the outcomes.
 *
 * Behaviour invariants pinned by the unit tests:
 *
 *   - **Column union with NULL fill.** When members return different column
 *     sets (schema divergence), the merged columns are the union in order
 *     of first appearance. Rows missing a column receive `null` for it.
 *   - **Failures contribute to envContributions only.** A member that
 *     errored adds nothing to `rows` but is listed in `envContributions`
 *     with its error message. Successful members' rows are preserved.
 *   - **Same-column type coercion.** If a column has values of different
 *     primitive types across members (e.g. `number` in us-int and `string`
 *     in eu — typically because the schemas drifted), every non-null
 *     value for that column is coerced to its `String(x)` representation.
 *     Pure-null columns and uniformly-typed columns pass through unchanged.
 *   - **`__env__` is always the first column.** Prepended to whatever the
 *     union shape says — never reordered, never duplicated even if a
 *     member happens to expose a column literally named `__env__`.
 *   - **Empty members.** A member that returned zero rows surfaces as a
 *     zero-rowCount entry in `envContributions` and contributes no rows.
 *   - **All-empty / all-error.** The merged `rows` array is empty; the
 *     merged `columns` array is just `[__env__]` (so downstream code can
 *     still render an empty table header without special-casing).
 *
 * @see PRD #2515 — agent-routed cross-environment querying
 * @see issue #2516 — slice 1 acceptance criteria
 */

import { ENV_COLUMN } from "@atlas/api/lib/env-routing";
import type { ConnectionContribution as WireConnectionContribution } from "@useatlas/types";

/** Outcome of running the same SQL against one member of a fanout. */
export interface MemberExecutionResult {
  readonly connectionId: string;
  /** Column order as returned by the driver. Omitted iff the member errored before reading any rows. */
  readonly columns?: readonly string[];
  /** Row payload. Omitted iff the member errored. */
  readonly rows?: readonly Record<string, unknown>[];
  /** Error message if the member's execution failed. Mutually exclusive with rows. */
  readonly error?: string;
  /** Wall-clock duration of the per-member execution, in ms. */
  readonly durationMs: number;
}

/**
 * Per-member contribution surfaced in the merged result. Re-exported
 * from the `@useatlas/types` wire definition (#2519, slice 4) so the
 * runtime and wire shapes cannot drift — adding a field to one without
 * the other becomes a compile error at every call site.
 */
export type ConnectionContribution = WireConnectionContribution;

export interface MergedResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly envContributions: readonly ConnectionContribution[];
}

/**
 * Merge an array of per-member execution outcomes into a single result
 * table with an `__env__` discriminator column.
 *
 * Order of operations:
 *   1. Build the column union across successful members (NULL-fill missing
 *      columns when interleaving rows below).
 *   2. Detect type-mixed columns; mark them for string-coercion.
 *   3. Interleave per-member rows in input order, with `__env__` set to the
 *      member id and any missing-or-type-coerced cells normalised.
 *   4. Emit per-member contribution metadata in input order.
 */
export function mergeMemberResults(
  memberResults: readonly MemberExecutionResult[],
): MergedResult {
  const successful = memberResults.filter(
    (r): r is MemberExecutionResult & {
      columns: readonly string[];
      rows: readonly Record<string, unknown>[];
    } => r.error === undefined && r.columns !== undefined && r.rows !== undefined,
  );

  // --- Step 1: column union (skip __env__ to keep it the sentinel first column) ---
  const seenColumns = new Set<string>();
  const unionColumns: string[] = [];
  for (const m of successful) {
    for (const col of m.columns) {
      if (col === ENV_COLUMN) continue; // member already had a column named __env__? our prepend wins.
      if (!seenColumns.has(col)) {
        seenColumns.add(col);
        unionColumns.push(col);
      }
    }
  }

  // --- Step 2: detect type-mixed columns ---
  // For each union column, scan every non-null cell across all members. If
  // we observe more than one primitive `typeof`, mark the column as
  // string-coerced. `null` / `undefined` count for nothing — only present
  // values vote on the type.
  const coercedColumns = new Set<string>();
  const observedTypes = new Map<string, Set<string>>();
  for (const m of successful) {
    for (const row of m.rows) {
      for (const col of unionColumns) {
        const v = row[col];
        if (v == null) continue;
        const t = typeof v;
        let bucket = observedTypes.get(col);
        if (!bucket) {
          bucket = new Set();
          observedTypes.set(col, bucket);
        }
        bucket.add(t);
        if (bucket.size > 1) coercedColumns.add(col);
      }
    }
  }

  // --- Step 3: interleave rows in member order ---
  const mergedRows: Record<string, unknown>[] = [];
  for (const m of successful) {
    for (const sourceRow of m.rows) {
      const out: Record<string, unknown> = { [ENV_COLUMN]: m.connectionId };
      for (const col of unionColumns) {
        const v = col in sourceRow ? sourceRow[col] : null;
        if (v == null) {
          out[col] = null;
        } else if (coercedColumns.has(col)) {
          out[col] = String(v as string | number | boolean | bigint);
        } else {
          out[col] = v;
        }
      }
      mergedRows.push(out);
    }
  }

  // --- Step 4: per-member contributions in input order ---
  const envContributions = memberResults.map(
    (m) =>
      ({
        connectionId: m.connectionId,
        rowCount: m.rows?.length ?? 0,
        error: m.error ?? null,
        durationMs: m.durationMs,
      }) satisfies ConnectionContribution,
  );

  const mergedColumns = [ENV_COLUMN, ...unionColumns];

  return {
    columns: mergedColumns,
    rows: mergedRows,
    envContributions,
  };
}
