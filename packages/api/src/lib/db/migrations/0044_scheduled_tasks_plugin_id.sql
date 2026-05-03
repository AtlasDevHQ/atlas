-- 0044 — Tag scheduled_tasks rows with the plugin that owns them (#1987).
--
-- Plugins can create scheduled_tasks rows via ctx.db.execute() during their
-- own initialization (e.g. an email-digest plugin scheduling a daily run).
-- Without a plugin_id column, an uninstall could not target the plugin's
-- own tasks for cleanup — so the scheduler kept firing them indefinitely.
--
-- Semantics:
--   plugin_id IS NULL      → user-created task (default; existing rows are
--                            unaffected by this migration). Survives every
--                            plugin uninstall.
--   plugin_id IS NOT NULL  → plugin-owned task. The string matches the
--                            `catalog_id` stored in `workspace_plugins` —
--                            i.e. the plugin's catalog row id, not the
--                            workspace_plugins installation id (which gets
--                            a fresh value on every reinstall and would
--                            therefore lose the cleanup link).
--
-- Cleanup contract:
--   On uninstall (DELETE /api/v1/admin/marketplace/:id), the route runs:
--     DELETE FROM scheduled_tasks WHERE plugin_id = $catalog_id AND org_id = $orgId
--   Both predicates are required so the cleanup never crosses workspaces.
--
-- Why a soft FK (no REFERENCES clause)?
--   plugin_catalog rows can be removed administratively (DELETE /catalog/:id),
--   which already cascades to workspace_plugins. We do NOT want it to also
--   nuke scheduled_tasks via FK — the uninstall path should be the single
--   place that cleanup happens, so its accounting (how many tasks deleted)
--   is auditable. A nullable text column captures the relationship without
--   binding cleanup ordering to FK cascade order.
--
-- Issue: #1987

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS plugin_id TEXT;

-- Cleanup-path index: (plugin_id, org_id) is the exact predicate the uninstall
-- DELETE uses. Partial index keeps the cost zero for user-created tasks (the
-- common case — plugin_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_plugin_org
  ON scheduled_tasks (plugin_id, org_id)
  WHERE plugin_id IS NOT NULL;
