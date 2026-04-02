-- 0015_semantic_versions.sql
--
-- Version history for semantic entities. Stores a full YAML snapshot
-- on every save, enabling diff view and one-click rollback.

CREATE TABLE IF NOT EXISTS semantic_entity_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES semantic_entities(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  yaml_content TEXT NOT NULL,
  change_summary TEXT,
  author_id TEXT,
  author_label TEXT,
  version_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sev_entity ON semantic_entity_versions(entity_id);
CREATE INDEX IF NOT EXISTS idx_sev_org_type_name ON semantic_entity_versions(org_id, entity_type, name);
CREATE INDEX IF NOT EXISTS idx_sev_created ON semantic_entity_versions(entity_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sev_entity_version ON semantic_entity_versions(entity_id, version_number);
