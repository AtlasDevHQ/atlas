-- 0024 — Developer/published mode: add status column to content tables
--
-- Foundation for the dual-mode system (#1421). Adds a status column:
--   connections:        published | draft | archived
--   semantic_entities:  published | draft | draft_delete | archived
--   prompt_collections: published | draft | archived
-- Semantic entities get unique partial indexes on (org_id, name,
-- connection_id) ensuring at most one row per entity key per status.
--
-- All existing rows default to 'published' via the column default.
-- No data migration needed.

-- ── Connections ────────────────────────────────────────────────────────
ALTER TABLE connections ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

DO $$ BEGIN
  ALTER TABLE connections ADD CONSTRAINT chk_connections_status
    CHECK (status IN ('published', 'draft', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Semantic entities ─────────────────────────────────────────────────
ALTER TABLE semantic_entities ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

DO $$ BEGIN
  ALTER TABLE semantic_entities ADD CONSTRAINT chk_semantic_entities_status
    CHECK (status IN ('published', 'draft', 'draft_delete', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- At most one published row per entity key
CREATE UNIQUE INDEX IF NOT EXISTS uq_semantic_entity_published
  ON semantic_entities(org_id, name, connection_id)
  WHERE status = 'published';

-- At most one draft row per entity key
CREATE UNIQUE INDEX IF NOT EXISTS uq_semantic_entity_draft
  ON semantic_entities(org_id, name, connection_id)
  WHERE status = 'draft';

-- At most one tombstone per entity key
CREATE UNIQUE INDEX IF NOT EXISTS uq_semantic_entity_tombstone
  ON semantic_entities(org_id, name, connection_id)
  WHERE status = 'draft_delete';

-- ── Prompt collections ────────────────────────────────────────────────
ALTER TABLE prompt_collections ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

DO $$ BEGIN
  ALTER TABLE prompt_collections ADD CONSTRAINT chk_prompt_collections_status
    CHECK (status IN ('published', 'draft', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
