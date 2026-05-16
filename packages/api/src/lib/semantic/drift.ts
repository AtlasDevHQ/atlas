/**
 * Per-entity drift attachment for the admin entities-list endpoint
 * (#2458 slice 1 / issue #2459).
 *
 * Pure module: given a `DiffResult` and a list of entity rows, returns the
 * same rows with a `drift` field per row plus a `noIntrospectedTables` flag.
 *
 * The flag is the load-bearing dogfood fix: when DB introspection returns
 * zero tables every YAML entity would otherwise show as `removed`. Slice 3
 * consumes the flag to render a targeted empty state on the unified
 * semantic page rather than the alarming "N removed tables" UX.
 *
 * Slice 2 (the drift drawer) will reuse `attachDrift` from the per-entity
 * detail endpoint — keeping this pure lets both call sites test in isolation
 * behind a `DiffResult` stub.
 */

import type { DiffResult } from "./diff";

export type DriftState = "new" | "removed" | "changed" | "in-sync";

/**
 * Discriminated union — only `changed` carries a `changeCount`. The
 * weaker `{ state; changeCount?: number }` shape used to allow nonsensical
 * `{ state: "in-sync", changeCount: 7 }`; consumers narrow on `state`
 * first so the type now mirrors what the producer actually emits.
 *
 * `new` is reserved for slice 2's drawer (DB-only rows that have no YAML
 * counterpart). `attachDrift` narrows its return below to exclude `new`
 * so today's call sites can't see it; the drawer will widen back.
 */
export type EntityDrift =
  | { state: "changed"; changeCount: number }
  | { state: "removed" | "in-sync" | "new" };

interface HasTable {
  readonly table: string;
}

/**
 * `entities` is intentionally mutable — Hono's `c.json()` runtime check
 * `JSONValue` rejects readonly arrays. The drift attachment is itself
 * pure (no mutation in `attachDrift`); the contract just exposes a shape
 * the route handler can hand straight to `c.json()` without spread copies.
 *
 * The generic `D` defaults to the full `EntityDrift` union but `attachDrift`
 * narrows it to `Exclude<EntityDrift, { state: "new" }>` so YAML-side
 * call sites don't have to handle a variant the producer never emits.
 */
export interface DriftEnvelope<T, D extends EntityDrift = EntityDrift> {
  entities: (T & { drift: D | null })[];
  /** `true` when DB introspection returned zero tables (NOT "the connection failed"). */
  noIntrospectedTables: boolean;
}

/** The variants `attachDrift` can actually produce — drops `new`. */
export type YamlSideDrift = Exclude<EntityDrift, { state: "new" }>;

/**
 * Attach per-entity drift state to an entity list.
 *
 * When `meta.noIntrospectedTables` is true, every entity gets `drift: null`
 * because the diff is meaningless — the DB itself has zero tables, so every
 * YAML row would otherwise show as `removed` (the dogfood false-positive
 * this slice exists to prevent).
 *
 * Otherwise, each entity's drift is derived from where its `table` shows up
 * in the diff:
 *   - in `diff.removedTables` → `removed`
 *   - in `diff.tableDiffs` → `changed` (with `changeCount`)
 *   - otherwise → `in-sync`
 *
 * The return type narrows to `YamlSideDrift` so consumers don't have to
 * handle the `new` variant the producer never emits.
 */
export function attachDrift<T extends HasTable>(
  entities: readonly T[],
  diff: DiffResult,
  meta: { readonly noIntrospectedTables: boolean },
): DriftEnvelope<T, YamlSideDrift> {
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
      let drift: YamlSideDrift;
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
