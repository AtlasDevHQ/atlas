-- 0026 — Drop legacy unique index on semantic_entities
--
-- The baseline index idx_semantic_entities_org_type_name on
-- (org_id, entity_type, name) enforced a single row per entity key
-- across all statuses. The developer/published dual-mode system (#1421)
-- requires draft/published rows to coexist for the same entity, so the
-- legacy index is incompatible.
--
-- Uniqueness is now enforced by the partial unique indexes added in 0024/0025:
--   uq_semantic_entity_published — at most one published row per key
--   uq_semantic_entity_draft     — at most one draft row per key
--   uq_semantic_entity_tombstone — at most one draft_delete row per key

DROP INDEX IF EXISTS idx_semantic_entities_org_type_name;
