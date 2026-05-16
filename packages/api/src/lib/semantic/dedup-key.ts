/**
 * `(name, connection_group_id)` dedup key — used by every admin-side entity
 * merge (#2412 / #2503).
 *
 * Lives in its own module so consumers (`mergeAdminEntities` in
 * `admin-source.ts`, `loadEntitiesForOrg` in `expert/context-loader.ts`) can
 * import the same formula without dragging the larger admin-source surface
 * into each other's test fixtures. Keeping the formula in one place is the
 * mechanical guarantee that the Health card's entity count can't silently
 * drift from the Overview tile / file tree.
 */

/**
 * Build the dedup key. `\0` is illegal in YAML names and connection-group
 * ids, so it's a safe delimiter — `users` + `g_users` cannot collide with
 * another row.
 */
export function dedupKey(name: string, groupId: string | null): string {
  return `${name}\0${groupId ?? ""}`;
}
