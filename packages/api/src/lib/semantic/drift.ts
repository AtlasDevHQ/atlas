/**
 * Per-entity drift attachment for the admin entities-list endpoint
 * (#2458 slice 1 / issue #2459).
 *
 * Pure module: given a `DiffResult` and a list of entity rows, returns the
 * same rows with a `drift` field per row plus a `noIntrospectedTables` flag.
 *
 * The flag is the load-bearing dogfood fix from 2026-05-16: when DB
 * introspection returns zero tables every YAML entity would otherwise show
 * as `removed`. Slice 3 consumes the flag to render a targeted empty
 * state on the unified semantic page rather than "13 removed tables".
 *
 * Slice 2 (the drift drawer) will reuse `attachDrift` from the per-entity
 * detail endpoint — keeping this pure lets both call sites test in isolation
 * behind a `DiffResult` stub.
 */

import type { DiffResult } from "./diff";

export type DriftState = "new" | "removed" | "changed" | "in-sync";

export interface EntityDrift {
  state: DriftState;
  /**
   * Total column changes (added + removed + type changes) for `changed`
   * rows. Omitted for the other three states — `in-sync` has nothing to
   * count, `removed` rows aren't in the DB to compare against, and `new`
   * doesn't apply to entities the YAML side already has (kept in the type
   * for the slice-2 drawer which will surface DB-only rows).
   */
  changeCount?: number;
}

interface HasTable {
  readonly table: string;
}

/**
 * `entities` is intentionally mutable — Hono's `c.json()` runtime check
 * `JSONValue` rejects readonly arrays. The drift attachment is itself
 * pure (no mutation in `attachDrift`); the contract just exposes a shape
 * the route handler can hand straight to `c.json()` without spread copies.
 */
export interface DriftEnvelope<T> {
  entities: (T & { drift: EntityDrift | null })[];
  /** `true` when DB introspection returned zero tables (NOT "the connection failed"). */
  noIntrospectedTables: boolean;
}

/**
 * Attach per-entity drift state to an entity list.
 *
 * When `meta.noIntrospectedTables` is true, every entity gets `drift: null`
 * because the diff is meaningless — the DB itself has zero tables, so every
 * YAML row would otherwise show as `removed`, the dogfood false-positive
 * this slice exists to prevent.
 *
 * Otherwise, each entity's drift is derived from where its `table` shows up
 * in the diff:
 *   - in `diff.removedTables` → `removed`
 *   - in `diff.tableDiffs` → `changed` (with `changeCount`)
 *   - otherwise → `in-sync`
 *
 * `new` is reserved for the slice-2 drawer that surfaces DB-only rows
 * (tables present in `diff.newTables` with no YAML counterpart). This
 * function never returns it because the input is the YAML-side entity list.
 */
export function attachDrift<T extends HasTable>(
  entities: readonly T[],
  diff: DiffResult,
  meta: { readonly noIntrospectedTables: boolean },
): DriftEnvelope<T> {
  if (meta.noIntrospectedTables) {
    return {
      entities: entities.map((e) => ({ ...e, drift: null })),
      noIntrospectedTables: true,
    };
  }

  const removedSet = new Set(diff.removedTables);
  const changeCounts = new Map<string, number>();
  for (const td of diff.tableDiffs) {
    changeCounts.set(
      td.table,
      td.addedColumns.length + td.removedColumns.length + td.typeChanges.length,
    );
  }

  return {
    entities: entities.map((e) => {
      const count = changeCounts.get(e.table);
      let drift: EntityDrift;
      if (removedSet.has(e.table)) {
        drift = { state: "removed" };
      } else if (count !== undefined) {
        drift = { state: "changed", changeCount: count };
      } else {
        drift = { state: "in-sync" };
      }
      return { ...e, drift };
    }),
    noIntrospectedTables: false,
  };
}
