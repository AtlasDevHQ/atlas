-- 0063 — Group-scope semantic entities (PRD #2336, issue #2340).
--
-- Adds `semantic_entities.connection_group_id` while retaining the legacy
-- `connection_id` column for the transitional dual-write window. Existing
-- rows are backfilled from their owning connection's group. When an admin
-- already merged multiple connections into one group before this migration
-- runs, duplicate per-connection entity rows collapse to the newest row for
-- the same logical key so the group-scoped unique indexes can be created.

ALTER TABLE semantic_entities
  ADD COLUMN IF NOT EXISTS connection_group_id TEXT;

UPDATE semantic_entities se
SET connection_group_id = (
  SELECT c.group_id
  FROM connections c
  WHERE c.id = se.connection_id
    AND c.group_id IS NOT NULL
    AND (c.org_id = se.org_id OR c.org_id = '__global__')
  ORDER BY CASE WHEN c.org_id = se.org_id THEN 0 ELSE 1 END
  LIMIT 1
)
WHERE se.connection_group_id IS NULL
  AND se.connection_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM connections c
    WHERE c.id = se.connection_id
      AND c.group_id IS NOT NULL
      AND (c.org_id = se.org_id OR c.org_id = '__global__')
  );

-- If multiple connection-scoped rows now share one group key, keep the most
-- recently updated row. `id` is the deterministic tie-breaker. The FK from
-- semantic_entity_versions cascades for rows removed here.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY
             org_id,
             entity_type,
             name,
             status,
             COALESCE(connection_group_id, '__default__')
           ORDER BY updated_at DESC, id DESC
         ) AS rn
  FROM semantic_entities
  WHERE status IN ('published', 'draft', 'draft_delete')
)
DELETE FROM semantic_entities se
USING ranked r
WHERE se.id = r.id
  AND r.rn > 1;

DROP INDEX IF EXISTS uq_semantic_entity_published;
DROP INDEX IF EXISTS uq_semantic_entity_draft;
DROP INDEX IF EXISTS uq_semantic_entity_tombstone;

CREATE UNIQUE INDEX uq_semantic_entity_published
  ON semantic_entities(org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
  WHERE status = 'published';

CREATE UNIQUE INDEX uq_semantic_entity_draft
  ON semantic_entities(org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
  WHERE status = 'draft';

CREATE UNIQUE INDEX uq_semantic_entity_tombstone
  ON semantic_entities(org_id, entity_type, name, COALESCE(connection_group_id, '__default__'))
  WHERE status = 'draft_delete';

CREATE INDEX IF NOT EXISTS idx_semantic_entities_connection_group
  ON semantic_entities(connection_group_id);
