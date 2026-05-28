import type {
  SemanticSelection,
  SemanticTreeDrift,
} from "@/ui/components/admin/semantic-file-tree";

/**
 * Minimal lookup row — name + group qualifier + drift state + table.
 * Kept narrower than `EntitySummary` so a future schema growth on the
 * page can't drift this predicate's input shape without an explicit
 * edit.
 *
 * `table` is required (#2891) because the drift drawer keys diff lookups
 * by SQL table (`tableDiffs[].table`, `removedTables[]`, `newTables[]`),
 * not the entity storage `name`. When the two diverge (e.g. DB row
 * `name = audit_log_v2` with YAML `table: audit_log`, or any YAML whose
 * `name:` field doesn't match `table:`), routing the drawer by `name`
 * would open it to "no drift detected".
 */
export interface DriftRoutingEntity {
  readonly name: string;
  readonly table: string;
  readonly connectionGroupId: string | null;
  readonly drift?: SemanticTreeDrift | null;
}

/**
 * Returns the SQL table name to open the drift drawer for, or `null` if
 * the click should fall through to the regular entity-detail view.
 *
 * The drawer opens for `changed`, `removed`, or `new` rows (#2461). `new`
 * doesn't currently appear in the YAML-side file tree but is included so
 * a future caller surfacing DB-only rows won't silently no-op.
 *
 * Match keys on both `name` and `connectionGroupId` to keep multi-
 * environment orgs (#2412) coherent — the same `name` under two groups
 * is two rows, and a stale group qualifier shouldn't open a drawer for
 * the other env's drift. The returned value is the matched entity's
 * `table` (#2891) so the drawer's drift lookup hits.
 */
export function driftDrawerTargetFor(
  selection: SemanticSelection,
  entities: ReadonlyArray<DriftRoutingEntity>,
): string | null {
  if (selection?.type !== "entity") return null;
  const match = entities.find(
    (e) =>
      e.name === selection.name &&
      e.connectionGroupId === (selection.connectionGroupId ?? null),
  );
  if (!match) return null;
  const state = match.drift?.state;
  if (state === "changed" || state === "removed" || state === "new") {
    return match.table;
  }
  return null;
}
