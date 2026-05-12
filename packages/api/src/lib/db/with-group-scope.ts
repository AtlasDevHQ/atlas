/**
 * Helpers that encapsulate the `COALESCE(connection_id, '__default__')`
 * sentinel pattern used by the developer-mode publish flow to compare and
 * match rows on `semantic_entities`' nullable scope column.
 *
 * Migration 0028 made `(org_id, entity_type, name, COALESCE(connection_id,
 * '__default__'))` the natural key of `semantic_entities`. That sentinel
 * literal then leaks into every consumer that joins drafts to published rows
 * or upserts via the matching partial index. Four production files inlined
 * the same fragment across ten sites — `semantic/entities.ts` (×6),
 * `api/routes/admin-publish-preview.ts` (×2), `api/routes/mode.ts` (×1), and
 * `lib/content-mode/tables.ts` (×1). The test mocks in
 * `api/__tests__/admin-publish.test.ts` (the `mock.module("@atlas/api/lib/
 * semantic/entities", ...)` block) keep the SQL inlined intentionally — that
 * mock fully replaces the real `applyTombstones` / `promoteDraftEntities`, so
 * its SQL fixture is independent of the production query. A drift-guard test
 * in `admin-publish.test.ts` pins the mock substring to this helper's output.
 *
 * This module is the pre-cursor to #2336 (multi-environment semantic layer):
 * by funnelling the COALESCE shape through one helper, the eventual
 * `connection_id` → `connection_group_id` column rename becomes a one-line
 * change here instead of a four-file sweep.
 *
 * The helpers are pure — they produce SQL string fragments only. Callers
 * remain responsible for composing them into a larger query and binding the
 * `.param` value at the matching positional placeholder.
 */

/**
 * Sentinel value substituted for NULL scope ids in COALESCE comparisons.
 * Mirrors the literal baked into migration 0028's partial unique indexes on
 * `semantic_entities`; changing it here without a coordinated migration would
 * silently break the draft/published natural key.
 */
export const GROUP_SCOPE_SENTINEL = "__default__" as const;

export interface ScopeColumnRef {
  /** Column name. Defaults to `connection_id`. */
  readonly column?: string;
  /** Optional table alias prefix (e.g. `"d"` → `d.connection_id`). */
  readonly alias?: string;
}

export interface GroupScope {
  /**
   * Bind value to pass at the placeholder produced by `.match()`. Equal to the
   * caller's `scopeId` argument, with `undefined` and the empty string both
   * normalised to `null` so a "no scope" caller can't accidentally split rows
   * across distinct partial-index buckets.
   */
  readonly param: string | null;
  /**
   * SQL fragment matching the scope column against `$paramIndex`, using
   * COALESCE-with-sentinel so a NULL row matches a NULL/undefined scope.
   *
   * The fragment is parameter-free aside from `$paramIndex`; the caller must
   * pass `.param` at that placeholder. `paramIndex` must be a positive
   * integer — the helper throws on `0`, negatives, or non-integers rather
   * than producing a SQL fragment `pg` will reject opaquely at execution.
   */
  match(paramIndex: number, ref?: ScopeColumnRef): string;
}

export interface ScopeAliasMatch {
  readonly leftAlias: string;
  readonly rightAlias: string;
  /** Column name. Defaults to `connection_id`. */
  readonly column?: string;
}

function qualifiedRef(opts?: ScopeColumnRef): string {
  const column = opts?.column ?? "connection_id";
  return opts?.alias ? `${opts.alias}.${column}` : column;
}

/**
 * SQL fragment of the form `COALESCE(<col>, '__default__')`, optionally
 * qualified with a table alias. Used in ON CONFLICT partial-index targets and
 * anywhere a single COALESCE'd reference is needed.
 */
export function coalescedScopeColumn(opts?: ScopeColumnRef): string {
  return `COALESCE(${qualifiedRef(opts)}, '${GROUP_SCOPE_SENTINEL}')`;
}

/**
 * SQL fragment matching the scope columns of two joined rows, e.g.
 * `COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id,
 * '__default__')`. Used by every draft/published join in the publish flow.
 */
export function matchScopeAcrossAliases(opts: ScopeAliasMatch): string {
  const column = opts.column ?? "connection_id";
  return (
    coalescedScopeColumn({ column, alias: opts.leftAlias }) +
    " = " +
    coalescedScopeColumn({ column, alias: opts.rightAlias })
  );
}

/**
 * Factory returning a `GroupScope` bound to the given scope id. Use
 * `.match(paramIndex)` to produce the COALESCE'd equality clause and bind
 * `.param` at that placeholder.
 *
 * `undefined` and `""` (empty string) both normalise to `null` so a partial
 * client payload can't accidentally land a row in a distinct partial-index
 * bucket from rows with no scope at all.
 */
export function withGroupScope(
  scopeId: string | null | undefined,
): GroupScope {
  const normalised = scopeId == null || scopeId === "" ? null : scopeId;
  return {
    param: normalised,
    match(paramIndex, ref) {
      if (!Number.isInteger(paramIndex) || paramIndex < 1) {
        throw new Error(
          `withGroupScope.match: paramIndex must be a positive integer, got ${paramIndex}`,
        );
      }
      return `${coalescedScopeColumn(ref)} = COALESCE($${paramIndex}, '${GROUP_SCOPE_SENTINEL}')`;
    },
  };
}
