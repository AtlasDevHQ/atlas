-- 0070 — Rename synthetic '__global__:<id>' connection_group names (#2417).
--
-- Migrations 0065 (approvals group scoping) and 0068 (scheduled_tasks group
-- scoping) both mirror global groups into tenant orgs and synthesize the
-- row's display name as '__global__:' || g.id. That string renders verbatim
-- in admin dropdowns (e.g. the scheduled-tasks form environment picker),
-- leaking implementation detail to end users.
--
-- Backfill: for every tenant-org row whose name still carries the
-- '__global__:' prefix, replace it with the current display name of the
-- source __global__ group (looked up by id). If the source group has
-- itself been renamed since 0065/0068 ran, the latest name wins.
--
-- Uniqueness: connection_groups has a UNIQUE (org_id, name) index. If the
-- target tenant already carries a group with the same name as the source
-- __global__ group, we leave the synthetic row alone rather than throw a
-- unique-violation. The display layer's `stripGroupPrefix` helper strips
-- a residual '__global__:' prefix as a belt-and-suspenders defence
-- (currently in `packages/web/src/app/admin/scheduled-tasks/task-form-dialog.tsx`;
-- consolidation tracked in #2432).
--
-- Orphan rows: a tenant row whose name carries the '__global__:' prefix
-- but whose `id` no longer matches any `__global__` row (operator
-- manually deleted the source group, or a hand-inserted literal name)
-- is silently skipped — the FROM-clause join on `src.id = t.id` excludes
-- it. `stripGroupPrefix` keeps the dropdown clean for those residual
-- rows at render time.
--
-- Idempotent: the WHERE predicate guards on the prefix, so re-runs
-- against an already-cleaned set are no-ops.

UPDATE connection_groups t
   SET name = src.name
  FROM connection_groups src
 WHERE t.name LIKE '__global__:%'
   AND t.org_id <> '__global__'
   AND src.id = t.id
   AND src.org_id = '__global__'
   AND NOT EXISTS (
     SELECT 1
       FROM connection_groups conflict
      WHERE conflict.org_id = t.org_id
        AND conflict.name = src.name
        AND conflict.id <> t.id
   );
