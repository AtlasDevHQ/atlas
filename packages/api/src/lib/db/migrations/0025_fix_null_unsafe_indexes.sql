-- 0025 — Fix NULL-unsafe partial unique indexes on semantic_entities
--
-- Migration 0024 created partial unique indexes on (org_id, name, connection_id)
-- but PostgreSQL treats NULLs as distinct in unique indexes. Since connection_id
-- is commonly NULL (single-datasource setups), the indexes failed to prevent
-- duplicate entities.
--
-- Fix: use COALESCE(connection_id, '__default__') to map NULLs to a sentinel
-- value, making the uniqueness constraint effective.

-- Drop the NULL-unsafe indexes
DROP INDEX IF EXISTS uq_semantic_entity_published;
DROP INDEX IF EXISTS uq_semantic_entity_draft;
DROP INDEX IF EXISTS uq_semantic_entity_tombstone;

-- Recreate with COALESCE to handle NULLs
CREATE UNIQUE INDEX uq_semantic_entity_published
  ON semantic_entities(org_id, name, COALESCE(connection_id, '__default__'))
  WHERE status = 'published';

CREATE UNIQUE INDEX uq_semantic_entity_draft
  ON semantic_entities(org_id, name, COALESCE(connection_id, '__default__'))
  WHERE status = 'draft';

CREATE UNIQUE INDEX uq_semantic_entity_tombstone
  ON semantic_entities(org_id, name, COALESCE(connection_id, '__default__'))
  WHERE status = 'draft_delete';
