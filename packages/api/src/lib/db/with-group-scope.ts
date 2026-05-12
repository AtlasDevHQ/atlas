/**
 * Helpers that encapsulate the `COALESCE(connection_id, '__default__')`
 * sentinel pattern used by the developer-mode publish flow to compare and
 * match rows on `semantic_entities`' nullable scope column.
 *
 * Migration 0028 made `(org_id, entity_type, name, COALESCE(connection_id,
 * '__default__'))` the natural key of `semantic_entities`. That sentinel
 * literal then leaks into every consumer that joins drafts to published rows
 * or upserts via the matching partial index. Five files inlined the same
 * fragment — `semantic/entities.ts`, `api/routes/admin-publish-preview.ts`,
 * `api/routes/mode.ts`, `lib/content-mode/tables.ts`, and the test mocks in
 * `api/__tests__/admin-publish.test.ts` (kept inlined intentionally — see the
 * `makeArchiveRestoreStubs` comment block).
 *
 * This module is the pre-cursor to #2336 (multi-environment semantic layer):
 * by funnelling the COALESCE shape through one helper, the eventual
 * `connection_id` → `connection_group_id` column rename becomes a one-line
 * change here instead of a five-file sweep.
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
  /** Org the scope belongs to. Kept for future helpers that fold org + scope
   *  into a single WHERE clause; today's helpers only operate on the scope
   *  column. */
  readonly orgId: string;
  /** Normalised scope id — `null` when the caller passed `null` or `undefined`. */
  readonly scopeId: string | null;
  /** Bind value to pass at the placeholder produced by `.match()`. */
  readonly param: string | null;
  /**
   * SQL fragment matching the scope column against `$paramIndex`, using
   * COALESCE-with-sentinel so a NULL row matches a NULL/undefined scope.
   *
   * The fragment is parameter-free aside from `$paramIndex`; the caller must
   * pass `.param` at that placeholder.
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
 * Factory returning a `GroupScope` bound to the given org + scope id. Use
 * `.match(paramIndex)` to produce the COALESCE'd equality clause and bind
 * `.param` at that placeholder.
 */
export function withGroupScope(
  orgId: string,
  scopeId: string | null | undefined,
): GroupScope {
  const normalised = scopeId ?? null;
  return {
    orgId,
    scopeId: normalised,
    param: normalised,
    match(paramIndex, ref) {
      return `${coalescedScopeColumn(ref)} = COALESCE($${paramIndex}, '${GROUP_SCOPE_SENTINEL}')`;
    },
  };
}
