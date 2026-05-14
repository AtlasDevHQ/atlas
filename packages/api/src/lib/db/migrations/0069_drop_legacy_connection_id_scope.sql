-- 0069 — Drop legacy content-scope connection_id columns (#2347).
--
-- The group-scoped rollout is complete: content tables key on
-- connection_group_id, while conversations.connection_id remains the
-- execution target and is intentionally retained.

WITH source AS (
  SELECT id, org_id
    FROM connections
   WHERE group_id IS NULL
)
INSERT INTO connection_groups (id, org_id, name)
SELECT 'g_' || id, org_id, id
  FROM source
ON CONFLICT (id, org_id) DO NOTHING;

UPDATE connections
   SET group_id = 'g_' || id
 WHERE group_id IS NULL
   AND EXISTS (
     SELECT 1
       FROM connection_groups g
      WHERE g.id = 'g_' || connections.id
        AND g.org_id = connections.org_id
   );

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
      FROM connections
     WHERE group_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot set connections.group_id NOT NULL while ungrouped connections remain';
  END IF;
END $$;

ALTER TABLE connections
  ALTER COLUMN group_id SET NOT NULL;

ALTER TABLE semantic_entities
  DROP COLUMN IF EXISTS connection_id;

ALTER TABLE dashboard_cards
  DROP COLUMN IF EXISTS connection_id;

ALTER TABLE scheduled_tasks
  DROP COLUMN IF EXISTS connection_id;

ALTER TABLE approval_queue
  DROP COLUMN IF EXISTS connection_id;

ALTER TABLE pii_column_classifications
  DROP COLUMN IF EXISTS connection_id;

COMMENT ON COLUMN connections.group_id IS
  'Required connection group membership. Content tables scope by connection_group_id; conversations.connection_id remains the execution target.';
