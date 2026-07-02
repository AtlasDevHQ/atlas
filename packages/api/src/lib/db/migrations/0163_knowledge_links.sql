-- 0163: knowledge_links — the intra-collection link graph extracted at ingest
-- (#4206, ADR-0028).
--
-- One row per markdown link found in a source document: (source document,
-- target path, anchor text). Populated by the ingest slice — the frontmatter
-- and links are extracted once, at ingest, from the fs-free OKF parser (ADR-0028
-- §5). The graph backs the layered-search roadmap's "1-hop link-graph
-- expansion" tier without re-ingestion (ADR-0028 §Consequences); v0 search is
-- grep-native and does not read this table yet. This migration is schema only.
--
-- `target_path` is a bundle path string, NOT a FK to knowledge_documents.id: a
-- link may point at a path that isn't ingested yet (or a broken link), so the
-- edge is resolved lazily at query time, never enforced at write time.
--
-- CONTENT-MODE EXEMPT: a link is derived data, not user-authored content. Its
-- visibility follows its source document (the content-mode participant); a link
-- has nothing of its own to draft/publish/archive. So it deliberately omits the
-- `status` column + ContentModeRegistry filtering — see
-- docs/development/content-mode.md "Carve-outs must be explicit and justified".
-- Cascade-deleting with the source document keeps the graph consistent when a
-- document is re-ingested (the ingest slice deletes-then-reinserts a document's
-- edges).
--
-- Drizzle-managed (mirrored in db/schema.ts as `knowledgeLinks`, same commit).
-- Additive CREATE only — no DROP, so no two-phase-drop discipline applies.

CREATE TABLE IF NOT EXISTS knowledge_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The document the link was found in. Cascade so a document's edges vanish
  -- with it (re-ingest = delete document → its links go too).
  source_document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  -- The bundle path the link points at — a plain string, resolved lazily. Not a
  -- FK: the target may not be ingested (yet) or may be a dangling link.
  target_path        TEXT NOT NULL,
  -- The link's anchor text, if any.
  anchor_text        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE knowledge_links IS
  'Intra-collection link graph extracted at ingest (ADR-0028). Edges of (source_document_id, target_path, anchor_text). Content-mode-exempt: derived data whose visibility follows its source document. target_path is a lazily-resolved path string, not a FK.';

-- Outbound edges of a document (the common walk direction) and inbound
-- resolution by path (which documents link to this path).
CREATE INDEX IF NOT EXISTS idx_knowledge_links_source
  ON knowledge_links (source_document_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_target
  ON knowledge_links (target_path);
