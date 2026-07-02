-- 0162: knowledge_documents — hosted OKF documents, one row per file in a
-- collection's bundle tree (#4206, ADR-0028).
--
-- A *collection* is a Knowledge Base install (a `workspace_plugins` row,
-- pillar `knowledge`, whose `install_id` is the collection slug). Each document
-- belongs to exactly one collection and is addressed by its bundle `path`
-- (e.g. `runbooks/eu-replica.md`). Documents are WORKSPACE-GLOBAL, never
-- group-scoped: an entity describes a Connection group's schema; a knowledge
-- document describes the business (ADR-0028 §2, "Group-scoped … rejected").
--
-- Atlas hosts OKF verbatim (ADR-0028 §3): the OKF frontmatter fields land as
-- real columns (`type`, `title`, `description`, `tags`, `timestamp`, `resource`)
-- and the markdown lands byte-identical in `body`. The only Atlas addition is
-- provenance under the `atlas:` frontmatter extension key — the collection
-- (already `collection_id`), the ingest source, and the ingest time
-- (`atlas_source` / `atlas_ingested_at`).
--
-- CONTENT-MODE PARTICIPANT (ADR-0028 §4): every ingest lands `draft` so a human
-- reviews third-party content before the non-admin agent path can read it;
-- promotion happens only through the atomic publish endpoint. The `status`
-- column + CHECK + default `draft` opt this table into the ContentModeRegistry
-- (see docs/development/content-mode.md); `updated_at` is required by the
-- registry's simple promote UPDATE. Ingest, serving, and search are follow-up
-- slices — this migration is schema only.
--
-- No credentials / no INTEGRATION_TABLES entry: the v0 `okf-upload` install is
-- a credential-less form install (ADR-0028 §5); connectors arrive later.
--
-- Drizzle-managed (mirrored in db/schema.ts as `knowledgeDocuments`, same
-- commit). Additive CREATE only — no DROP, so no two-phase-drop discipline
-- applies; the mirror lands in the same commit so a later `drizzle-kit
-- generate` can't emit a DROP. `workspace_id` / `collection_id` are TEXT with
-- no FK, matching the org-scoped Atlas tables (conversations / settings /
-- semantic_entities) and the composite-PK `workspace_plugins` install ref.

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Better-Auth organization id. Workspace-global scope (never a group FK).
  workspace_id   TEXT NOT NULL,
  -- The owning collection = the `workspace_plugins.install_id` slug of the
  -- knowledge install. No composite FK: workspace_plugins' PK carries a
  -- `catalog_id` this table doesn't need to name, and the singleton unique
  -- excludes the knowledge pillar. Referential integrity is the ingest slice's
  -- job; this is the install ref (ADR-0028 §2).
  collection_id  TEXT NOT NULL,
  -- Bundle path within the collection tree, unique PER COLLECTION (not per
  -- workspace) — the same `index.md` may exist in two collections. Uploads
  -- upsert into the tree by this path.
  path           TEXT NOT NULL,
  -- OKF frontmatter, stored verbatim as real columns.
  type           TEXT,
  title          TEXT,
  description    TEXT,
  tags           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- OKF `timestamp` frontmatter field (the document's own timestamp), distinct
  -- from Atlas's ingest bookkeeping below. Quoted because `timestamp` is a
  -- Postgres type keyword.
  "timestamp"    TIMESTAMPTZ,
  resource       TEXT,
  -- The markdown body, byte-identical to what was reviewed (ADR-0028 §3).
  body           TEXT NOT NULL,
  -- `atlas:` frontmatter provenance extension (spec-legal unknown key).
  atlas_source   TEXT,
  atlas_ingested_at TIMESTAMPTZ,
  -- Content-mode lifecycle. Defaults `draft` — the review gate (ADR-0028 §4).
  status         TEXT NOT NULL DEFAULT 'draft',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_knowledge_documents_status
    CHECK (status IN ('draft', 'published', 'archived')),
  -- `path` is unique per collection, not per workspace (ADR-0028 §2).
  CONSTRAINT uq_knowledge_documents_collection_path
    UNIQUE (workspace_id, collection_id, path)
);

COMMENT ON TABLE knowledge_documents IS
  'Hosted OKF documents (ADR-0028). One row per file in a collection bundle tree; workspace-global, owned by one collection via collection_id. Content-mode participant — every ingest lands draft, promoted only via the atomic publish endpoint.';

-- Per-collection tree walks (a collection's documents) and per-tenant scans.
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_collection
  ON knowledge_documents (workspace_id, collection_id);

-- Content-mode status filter (mirrors idx_workspace_plugins_status): the
-- non-admin published-only read and the developer-mode overlay both scope by
-- (workspace_id, status).
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status
  ON knowledge_documents (workspace_id, status);

-- GIN over the OKF `tags` array for the frontmatter-filter search layer
-- (ADR-0028 §5 — "structured frontmatter filter" is the first search tier).
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tags
  ON knowledge_documents USING gin (tags);
