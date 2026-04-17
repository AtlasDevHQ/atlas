-- 0028 — Rebuild semantic_entities partial unique indexes to include entity_type
--
-- 0024/0025 indexed (org_id, name, connection_id) filtered by status — but the
-- original uniqueness key was (org_id, entity_type, name). 'accounts' exists as
-- both an entity_type='entity' row AND an entity_type='metric' row for the same
-- org + connection, so the 0024/0025 indexes rejected perfectly legitimate data.
--
-- Prod regions us + apac boot-crashed on 0024/0025 because of this; eu passed
-- only because it had zero rows at migration time.
--
-- Fix: drop and recreate with entity_type in the key. COALESCE(connection_id,
-- '__default__') is preserved from 0025 for NULL-safety.

DROP INDEX IF EXISTS uq_semantic_entity_published;
DROP INDEX IF EXISTS uq_semantic_entity_draft;
DROP INDEX IF EXISTS uq_semantic_entity_tombstone;

CREATE UNIQUE INDEX uq_semantic_entity_published
  ON semantic_entities(org_id, entity_type, name, COALESCE(connection_id, '__default__'))
  WHERE status = 'published';

CREATE UNIQUE INDEX uq_semantic_entity_draft
  ON semantic_entities(org_id, entity_type, name, COALESCE(connection_id, '__default__'))
  WHERE status = 'draft';

CREATE UNIQUE INDEX uq_semantic_entity_tombstone
  ON semantic_entities(org_id, entity_type, name, COALESCE(connection_id, '__default__'))
  WHERE status = 'draft_delete';
