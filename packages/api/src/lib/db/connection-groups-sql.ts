/**
 * SQL fragments for connection-group deletion shared between the
 * `admin-connection-groups` route and the real-Postgres migration smoke
 * test. Centralised here because the same statement has now caused #2410
 * three times (#2405 → #2406 → #2410) — drift between route and test was
 * the root cause of #2410 going unnoticed under the #2406 patch.
 *
 * Keeping the canonical SQL here means a regression that re-introduces
 * a too-tight WHERE clause (e.g. `AND url <> ''`) shows up in *both* the
 * route and the test in the same diff, so it can't ship green.
 */

/**
 * Atomic env-delete SQL: drop every archived connection in the group, then
 * drop the group itself. Parameters are positional and shared across the
 * two statements:
 *   $1 = group id
 *   $2 = org id
 *
 * MUST match `status = 'archived'` unconditionally — both archived shapes
 * (real org-owned archived rows AND `url = ''` per-org global-hide
 * tombstones) reference the group via `connections.group_id` and so must
 * be cleared before `DELETE FROM connection_groups` to avoid a 23503
 * against the `fk_connections_group` FK.
 */
export const DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL = `
  WITH deleted_archived_connections AS (
    DELETE FROM connections
     WHERE group_id = $1
       AND org_id = $2
       AND status = 'archived'
    RETURNING id
  )
  DELETE FROM connection_groups WHERE id = $1 AND org_id = $2
`;
