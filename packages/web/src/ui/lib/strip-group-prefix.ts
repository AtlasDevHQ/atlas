/**
 * Defensive strip for synthetic / backfilled connection-group names so the
 * raw ids don't leak into admin-facing copy.
 *
 * Why this lives in one place (closes #2432, originally tracked as #2426):
 * the same helper was duplicated across `chat/env-picker.tsx`,
 * `admin/connections/columns.tsx`, `admin/connections/page.tsx`, and
 * `admin/scheduled-tasks/task-form-dialog.tsx` — each carrying a slightly
 * different rule set (only the scheduled-tasks variant stripped the
 * `__global__:` prefix introduced by 0065/0068 and cleaned up by 0070).
 * Consolidating prevents a future migration from leaking through three of
 * four call sites by accident.
 *
 * Strips, in order:
 *   1. `__global__:` — synthetic display name from 0065/0068 cross-org
 *      mirroring (cleaned up by 0070, kept as a belt-and-suspenders strip).
 *   2. `g_` — the 0062 1:1-backfill id-as-name shape. `connection_groups.id`
 *      is `g_<connId>` and the row's `name` is the bare `<connId>`, so this
 *      strip only fires when an admin renames a group to a literal `g_*`
 *      value — defensive cleanup, not the common path.
 *
 * Returns the input unchanged when neither prefix matches.
 */
export function stripGroupPrefix(name: string): string {
  if (name.startsWith("__global__:")) return name.slice("__global__:".length);
  if (name.startsWith("g_")) return name.slice(2);
  return name;
}

/**
 * True when a connection-group id matches the migration 0062 1:1-backfill
 * shape AND the group's name still equals its source connection id (i.e.
 * the admin hasn't renamed it). Used by the admin Environments page to
 * collapse the "one auto-detected singleton per connection" noise behind a
 * toggle without hiding groups the admin has explicitly acted on.
 *
 * The id-prefix-only check (`startsWith("g_")`) is intentionally not enough:
 * the API also issues `g_<random>` ids for newly created groups, which we
 * must surface. The name equality clause is what disambiguates.
 */
export function isAutoBackfilledSingleton(group: {
  id: string;
  name: string;
  memberCount: number;
}): boolean {
  if (group.memberCount !== 1) return false;
  if (!group.id.startsWith("g_")) return false;
  return group.name === group.id.slice(2);
}

/**
 * True when a group is the empty residue of a merged-out backfill
 * singleton (#2506): id matches the `g_<connId>` backfill shape, name
 * still equals the bare connection id, and the group has zero
 * non-archived members. Two paths produce this shape in the wild:
 *
 *   1. A merge wizard run pre-#2437 whose cleanup CTE couldn't see the
 *      sibling `moved` UPDATE (shared snapshot) and skipped the DELETE.
 *   2. A merge whose cleanup CTE fired a `NOT EXISTS` guard against
 *      one of the seven content reference tables — the reference has
 *      since been cleared but the now-empty source group was never
 *      re-swept.
 *
 * Migration 0072 sweeps existing rows; this helper hides any orphan that
 * survives until then from the env combobox (Add / Edit Connection
 * dialog) so the admin cannot accidentally re-anchor a new connection
 * to a ghost group whose label collides with a real connection id.
 *
 * Distinct from `isAutoBackfilledSingleton` (member-count 1) so the
 * Environments tab's "auto-detected singletons" toggle keeps its
 * literal meaning — empty orphans surface in the curated list with the
 * "No connections yet" affordance the admin can act on.
 */
export function isEmptyBackfillOrphan(group: {
  id: string;
  name: string;
  memberCount: number;
}): boolean {
  if (group.memberCount !== 0) return false;
  if (!group.id.startsWith("g_")) return false;
  return group.name === group.id.slice(2);
}
