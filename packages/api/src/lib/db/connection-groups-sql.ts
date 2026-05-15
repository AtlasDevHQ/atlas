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

/**
 * Atomic merge SQL: consolidate N source connections into one target
 * environment within a single statement (#2409). A single CTE-driven
 * statement is the atomicity primitive — Postgres evaluates every branch
 * inside one implicit transaction, so a failure in any branch rolls every
 * branch back. Avoids needing `pool.connect()` + manual BEGIN/COMMIT
 * (which the route mock surface doesn't currently expose).
 *
 * Parameters:
 *   $1 = target group id (newly generated; only consumed when the
 *        ON CONFLICT branch does NOT fire and we actually insert)
 *   $2 = org id
 *   $3 = target group display name (trimmed, validated via GROUP_NAME_PATTERN)
 *   $4 = primary_connection_id to seed on INSERT (always one of the source ids)
 *   $5 = boolean — when true, the override REPLACES the existing primary on
 *        ON CONFLICT DO UPDATE; when false, the existing primary is preserved
 *   $6 = source connection ids (text[])
 *   $7 = source group ids — the union of group_ids the source connections
 *        were sitting in before the merge. Cleanup is gated by:
 *          - id LIKE 'g\_%' ESCAPE '\' AND name = SUBSTRING(id FROM 3) →
 *            only auto-backfilled singletons (migration 0062 shape) are
 *            eligible; user-renamed groups and `g_<random>` user-created
 *            groups are preserved even when empty.
 *          - id != target.id → never delete the target we just landed in.
 *          - NOT EXISTS guards against every inbound FK / reference table
 *            so a source group that still anchors an approval, scheduled
 *            task, dashboard card, semantic entity, PII classification, or
 *            conversation is left in place. The merge succeeds with a
 *            partial cleanup — the admin sees the residual group in the
 *            list and can act on it separately. This is preferable to a
 *            23503 that rolls the whole merge back.
 *
 * Return shape: one row, three columns.
 *   target               jsonb  — { id, name, primaryConnectionId, createdAt, updatedAt, created }
 *   moved_connection_ids text[] — ids actually re-parented this statement
 *   deleted_group_ids    text[] — auto-backfilled source groups cleaned up
 *
 * The `(xmax = 0)` trick on the target CTE tells INSERT (no concurrent
 * xact touched the row) from ON CONFLICT DO UPDATE (the conflicting row
 * was visible). Wire-format calls this `created` so the wizard knows
 * whether to say "Created prod" vs "Added to prod".
 */
export const MERGE_CONNECTIONS_INTO_GROUP_SQL = `
  WITH target AS (
    INSERT INTO connection_groups (id, org_id, name, primary_connection_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (org_id, name) DO UPDATE
      SET updated_at = NOW(),
          primary_connection_id = CASE
            WHEN $5::boolean THEN EXCLUDED.primary_connection_id
            ELSE connection_groups.primary_connection_id
          END
    RETURNING id, name, primary_connection_id, created_at, updated_at, (xmax = 0) AS created
  ),
  moved AS (
    UPDATE connections
       SET group_id = (SELECT id FROM target), updated_at = NOW()
     WHERE id = ANY($6::text[])
       AND org_id = $2
    RETURNING id
  ),
  cleanup AS (
    DELETE FROM connection_groups cg
     WHERE cg.org_id = $2
       AND cg.id = ANY($7::text[])
       AND cg.id <> (SELECT id FROM target)
       AND cg.id LIKE 'g\\_%' ESCAPE '\\'
       AND cg.name = SUBSTRING(cg.id FROM 3)
       AND NOT EXISTS (
         SELECT 1 FROM connections c
          WHERE c.group_id = cg.id AND c.org_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM approvals a
          WHERE a.connection_group_id = cg.id AND a.org_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_tasks st
          WHERE st.connection_group_id = cg.id AND st.org_id = $2
       )
    RETURNING cg.id
  )
  SELECT
    (SELECT jsonb_build_object(
       'id', t.id,
       'name', t.name,
       'primaryConnectionId', t.primary_connection_id,
       'createdAt', t.created_at,
       'updatedAt', t.updated_at,
       'created', t.created
     ) FROM target t) AS target,
    COALESCE((SELECT array_agg(id ORDER BY id) FROM moved), ARRAY[]::text[]) AS moved_connection_ids,
    COALESCE((SELECT array_agg(id ORDER BY id) FROM cleanup), ARRAY[]::text[]) AS deleted_group_ids
`;
