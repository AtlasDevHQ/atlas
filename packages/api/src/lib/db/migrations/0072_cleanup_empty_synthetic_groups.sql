-- 0072 — Drop empty `g_<connId>` backfill orphans (#2506).
--
-- The 0062 1:1 backfill creates `connection_groups` rows shaped
-- `id = 'g_' || conn.id`, `name = conn.id` for every existing connection.
-- Two production code paths can re-parent the connection out of that
-- backfill group without cleaning up the now-empty source row:
--
--   A. Merge wizard skip-and-cleared (`MERGE_CONNECTIONS_INTO_GROUP_SQL`):
--      the inline cleanup CTE in the merge route deletes auto-backfilled
--      source groups in the same statement, but skips any source group
--      that anchors a row in one of the seven content reference tables
--      (`connections`, `approval_queue`, `scheduled_tasks`,
--      `dashboard_cards`, `semantic_entities`, `pii_column_classifications`,
--      `conversations`). The skipped id is surfaced in
--      `skipped_group_ids` on the wire so the wizard can show what it
--      preserved. If that reference is later cleared (approval expired,
--      task disabled, semantic entity archived, dashboard card removed)
--      no path re-evaluates the now-empty source group, and it survives
--      indefinitely.
--
--   B. Member-move endpoints with no cascade cleanup
--      (`POST /admin/connection-groups/:id/members` and the
--      `connectionGroupId` branch of `PUT /admin/connections/:id`):
--      both re-parent a connection's `group_id` and stop there. When
--      the connection's prior group was the 0062 backfill row, the
--      source row stays in `connection_groups` with zero members. The
--      merge wizard avoids this by re-parenting via the same CTE that
--      sweeps the source; the member-move routes are simpler one-shot
--      UPDATEs that predate the group lifecycle work and never picked
--      up an equivalent cleanup.
--
-- Symptom on prod: `/admin/connections?groupBy=environment` surfaces a
-- ghost `us-prod` group with "No connections yet"; the same name pollutes
-- the env combobox in the Add Connection dialog as a selectable
-- environment alongside the real `prod` group that already contains the
-- `us-prod` connection.
--
-- This migration is a one-time sweep that mirrors the merge CTE's cleanup
-- predicate exactly:
--
--   `id LIKE 'g\_%' ESCAPE '\' AND name = SUBSTRING(id FROM 3)`
--     — only auto-backfill shapes. User-created `g_<random>` groups (whose
--       `name` was set explicitly by the admin) and admin-renamed groups
--       are preserved even when empty.
--
--   `NOT EXISTS` against every reference table that carries a
--   `connection_group_id` column today, plus `connections.group_id`.
--   `dashboard_cards` is the lone reference without its own `org_id`
--   (see 0066 "Why no FK on connection_group_id" — cards inherit org
--   scope from their parent `dashboards` row). The global-cg.id collision
--   risk is the same trade documented in `MERGE_CONNECTIONS_INTO_GROUP_SQL`.
--
-- Idempotent: a second pass against a freshly-cleaned schema is a 0-row
-- DELETE. The `LIKE 'g\_%'` predicate prevents the migration from ever
-- touching admin-curated groups.
--
-- Permanent path-B prevention (cascading cleanup into the member-move
-- endpoints, and likewise into the merge route's `skipped_group_ids`
-- after the reference clears) is out of scope for this slice — adding
-- the hook to every reference-table delete plus both member-move call
-- sites would couple eight surfaces to the group lifecycle. Tracked as
-- a follow-up at https://github.com/AtlasDevHQ/atlas/issues/2506
-- comment thread; this migration sweeps existing orphans and the
-- route-layer name-collision guard prevents new ones from being
-- intentionally created.
--
-- The surface defence (env combobox skips empty backfill orphans,
-- name-collision guard refuses new groups whose name matches an existing
-- connection id) ships alongside this migration.
--
-- Wrapped in a DO block so `RAISE NOTICE` emits a deleted-count line into
-- the migration runner's Railway log. Destructive migrations without an
-- audit signal are debugging hell when prod surfaces an unexpected drop.

DO $$
DECLARE
  deleted_count integer;
BEGIN
  WITH deleted AS (
    DELETE FROM connection_groups cg
     WHERE cg.id LIKE 'g\_%' ESCAPE '\'
       AND cg.name = SUBSTRING(cg.id FROM 3)
       AND NOT EXISTS (
         SELECT 1 FROM connections c
          WHERE c.group_id = cg.id AND c.org_id = cg.org_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM approval_queue aq
          WHERE aq.connection_group_id = cg.id AND aq.org_id = cg.org_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_tasks st
          WHERE st.connection_group_id = cg.id AND st.org_id = cg.org_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM dashboard_cards dc
          WHERE dc.connection_group_id = cg.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM semantic_entities se
          WHERE se.connection_group_id = cg.id AND se.org_id = cg.org_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM pii_column_classifications pc
          WHERE pc.connection_group_id = cg.id AND pc.org_id = cg.org_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversations cv
          WHERE cv.connection_group_id = cg.id AND cv.org_id = cg.org_id
       )
     RETURNING cg.id, cg.org_id
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  RAISE NOTICE '[0072] cleanup_empty_synthetic_groups: deleted % orphan backfill group(s)', deleted_count;
END $$;
