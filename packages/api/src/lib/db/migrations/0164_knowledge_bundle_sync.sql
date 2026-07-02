-- 0164: knowledge bundle sync — credential + sync-state tables for the
-- `bundle-sync` Knowledge Base catalog row (#4211, ADR-0028 §5 follow-up).
--
-- A *synced collection* is a `pillar='knowledge'` `workspace_plugins` install
-- of the built-in `bundle-sync` catalog row: its config carries a bundle
-- endpoint URL (+ auth scheme), and a scheduled pull fetches the tarball/zip
-- and re-runs the #4207 ingest (upsert-by-path computes the diff; synced
-- content ALWAYS lands `draft` — connector-style ingest has no
-- upload-&-publish shortcut, ADR-0028 §4).
--
-- knowledge_sync_credentials — the FIRST Knowledge Base credential (the seam
-- deliberately deferred out of #4206). One optional row per synced collection
-- holding the endpoint auth secret (bearer token or basic `user:password`),
-- encrypted at rest via `db/secret-encryption.ts` (versioned AES-256-GCM).
-- Registered in `INTEGRATION_TABLES` (`db/integration-tables.ts`) in the same
-- commit so F-47 key rotation and the F-42 residue audit walk it
-- automatically. `auth_secret_encrypted` is NOT NULL: a collection with no
-- auth simply has NO row here (never a NULL-credential row), which keeps the
-- table in `NON_NULL_ENCRYPTED_TABLES`.
--
-- knowledge_sync_state — one bookkeeping row per synced collection: last sync
-- time, outcome, and error (surfaced on `/admin/knowledge`, #4209
-- coordination), plus a compact JSONB report (ingest counts + rejected files)
-- persisted for a fuller drill-down surface (no reader yet). Deliberately NOT
-- stored in `workspace_plugins.config`: a re-install upserts `config =
-- EXCLUDED.config`, which would silently wipe sync bookkeeping on every edit.
--
-- Both tables are workspace-scoped TEXT ids with no FK, matching
-- `knowledge_documents` (migration 0162): `collection_id` is the
-- `workspace_plugins.install_id` slug, and the composite-PK install row is not
-- FK-addressable without naming its catalog_id. Uninstall hard-deletes both
-- rows (secrets should not outlive the install; the DOCUMENTS are what is
-- never hard-deleted, ADR-0028 §5).
--
-- Drizzle-managed (mirrored in db/schema.ts as `knowledgeSyncCredentials` /
-- `knowledgeSyncState`, same commit). Additive CREATE only — no DROP, so no
-- two-phase-drop discipline applies.

CREATE TABLE IF NOT EXISTS knowledge_sync_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Better-Auth organization id (workspace-global, like knowledge_documents).
  workspace_id   TEXT NOT NULL,
  -- The synced collection = the `workspace_plugins.install_id` slug.
  collection_id  TEXT NOT NULL,
  -- Versioned-AES-GCM ciphertext of the endpoint auth secret (bearer token or
  -- basic `user:password`). NOT NULL — "no auth" is "no row", never a NULL.
  auth_secret_encrypted   TEXT NOT NULL,
  -- F-47 keyset version the ciphertext was produced under.
  auth_secret_key_version INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One credential per collection (the upsert conflict target).
  CONSTRAINT uq_knowledge_sync_credentials_collection
    UNIQUE (workspace_id, collection_id)
);

COMMENT ON TABLE knowledge_sync_credentials IS
  'Endpoint auth secrets for bundle-sync knowledge collections (#4211). Encrypted at rest (F-41, db/secret-encryption.ts); registered in INTEGRATION_TABLES for key rotation + residue audit. No row = collection syncs unauthenticated.';

CREATE TABLE IF NOT EXISTS knowledge_sync_state (
  -- Better-Auth organization id.
  workspace_id   TEXT NOT NULL,
  -- The synced collection = the `workspace_plugins.install_id` slug.
  collection_id  TEXT NOT NULL,
  -- When the last sync attempt finished (success or error).
  last_sync_at   TIMESTAMPTZ NOT NULL,
  -- Outcome of the last attempt.
  status         TEXT NOT NULL,
  -- Actionable failure message when status='error' (never a secret — sync
  -- errors are host-redacted at construction, see lib/knowledge/sync.ts).
  error          TEXT,
  -- Compact JSONB report of the last successful ingest: document counts,
  -- archived-absent count, links written, and (bounded) per-file rejections.
  report         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_knowledge_sync_state PRIMARY KEY (workspace_id, collection_id),
  CONSTRAINT chk_knowledge_sync_state_status CHECK (status IN ('success', 'error'))
);

COMMENT ON TABLE knowledge_sync_state IS
  'Last-sync bookkeeping per bundle-sync knowledge collection (#4211): time, outcome, error, ingest report. Surfaced on /admin/knowledge. Not content-mode: operational state, never user-surfaced content.';
