-- 0072 — Drop empty `g_<connId>` backfill orphans (#2506).
--
-- The 0062 1:1 backfill creates `connection_groups` rows shaped
-- `id = 'g_' || conn.id`, `name = conn.id` for every existing connection.
-- When an admin later folds those singletons into a multi-region group via
-- the merge wizard (POST /admin/connection-groups/merge), the inline cleanup
-- CTE in `MERGE_CONNECTIONS_INTO_GROUP_SQL` deletes the now-empty source
-- groups in the same statement. Two paths leave a `g_<connId>` row behind
-- with zero members:
--
--   1. The merge ran before the codex #2437 fix landed. Pre-#2437 the
--      cleanup CTE's `EXISTS` guard against `connections` could not see the
--      sibling `moved` CTE's UPDATE (data-modifying CTEs share one
--      snapshot), so it concluded the source group was still occupied and
--      skipped the DELETE. The `moved` UPDATE still landed; the source
--      group survived as a 0-member orphan.
--
--   2. The merge fired a `NOT EXISTS` guard against one of the seven
--      content reference tables (approval_queue, scheduled_tasks,
--      dashboard_cards, semantic_entities, pii_column_classifications,
--      conversations — `connections` is path 1). That reference has since
--      been cleared (approval expired, task disabled, etc.) but the now-
--      empty source group was never re-swept.
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
-- Prevention for path 1 is already in place (codex #2437 landed in 1.4.4).
-- Prevention for path 2 (a stale reference clearing without re-sweeping the
-- group) is out of scope for this slice — adding a cleanup hook to every
-- reference-table delete would couple six surfaces to the group lifecycle.
-- Acceptable: backfill-shape orphans are a one-time historical artifact,
-- not a steady-state production occurrence — new groups are user-created
-- with `g_<random>` ids that this migration's predicate ignores by design.
--
-- The follow-up surface defence (env combobox skips empty backfill
-- orphans, name-collision guard refuses new groups whose name matches an
-- existing connection id) ships alongside this migration.

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
   );
