-- 0068 — Group-scoped scheduled tasks (PRD #2336, issue #2343).
--
-- Scheduled tasks now belong to a connection group (UI: environment)
-- rather than a single physical connection. The legacy connection_id column
-- remains as an execution/audit compatibility field until the #2346 cleanup.
--
-- Runtime execution remains one task dispatch per cron tick. At fire time the
-- scheduler resolves connection_group_id to the group's primary member, or to
-- the first member by (created_at, id) when no usable primary exists.

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

WITH global_task_groups AS (
  SELECT DISTINCT
         c.group_id AS group_id,
         st.org_id AS tenant_org_id,
         ('__global__:' || g.id) AS name
    FROM scheduled_tasks st
    JOIN connections c
      ON c.id = st.connection_id
     AND c.org_id = '__global__'
    JOIN connection_groups g
      ON g.id = c.group_id
     AND g.org_id = '__global__'
   WHERE st.org_id IS NOT NULL
     AND st.org_id <> '__global__'
     AND c.group_id IS NOT NULL
)
INSERT INTO connection_groups (id, org_id, name)
SELECT group_id, tenant_org_id, name
  FROM global_task_groups
ON CONFLICT (id, org_id) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'scheduled_tasks'
      AND constraint_name = 'fk_scheduled_tasks_group'
  ) THEN
    ALTER TABLE scheduled_tasks
      ADD CONSTRAINT fk_scheduled_tasks_group
      FOREIGN KEY (connection_group_id, org_id)
      REFERENCES connection_groups (id, org_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_group
  ON scheduled_tasks (org_id, connection_group_id);

UPDATE scheduled_tasks st
   SET connection_group_id = c.group_id
   FROM connections c
   WHERE st.connection_id IS NOT NULL
     AND st.connection_group_id IS NULL
     AND c.id = st.connection_id
     AND (c.org_id = st.org_id OR c.org_id = '__global__');

COMMENT ON COLUMN scheduled_tasks.connection_group_id IS
  'Group scope for this scheduled task (#2343). New rows should set this field; connection_id remains as a legacy execution/audit compatibility field until #2346.';
