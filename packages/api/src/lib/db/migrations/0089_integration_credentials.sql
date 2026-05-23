-- 0089_integration_credentials.sql
--
-- Atlas issue #2658 — dedicated `integration_credentials` table for
-- lazy OAuth integrations (Salesforce ships first; Jira / etc. ride
-- behind on the same table).
--
-- The form-based install pattern shipped in #2697 stuffs encrypted
-- credentials into `workspace_plugins.config` JSONB via
-- `encryptSecretFields`. That works for opaque, rarely-rotated SMTP
-- creds but creaks for OAuth: refresh tokens have their own lifecycle
-- (rotation, expiry, "reconnect needed" surfacing), the credential
-- lookup is on every agent tool-call hot path, and a cleanly separated
-- credential store keeps the dual-store teardown order (ADR-0003)
-- machine-checkable instead of "patch the JSONB in place."
--
-- Shape:
--   * `id` — uuid PK. Single-column PK so the F-47 rotation tooling and
--     F-42 residue audit (both walk `INTEGRATION_TABLES` with one PK
--     identifier) work unchanged.
--   * `workspace_id` / `catalog_id` — composite uniqueness keeps one row
--     per (workspace, integration). FK to `plugin_catalog.id` cascades
--     credential teardown on catalog removal (defensive — disconnect
--     deletes this row first per ADR-0003, so the cascade is the
--     backstop, not the primary path).
--   * `credentials_encrypted` — AES-256-GCM ciphertext (versioned
--     `enc:v<N>:iv:authTag:ciphertext`) from `db/secret-encryption.ts`,
--     wrapping a JSON blob: `{ access_token, refresh_token, expires_at,
--     instance_url, scope, token_type }`. The instance_url stays inside
--     the ciphertext because it's required to make the access_token
--     usable (Salesforce per-tenant instance hostnames); the same field
--     also lives in `workspace_plugins.config` (plaintext, operator-
--     visible) so the admin UI can show it without a decrypt.
--   * `credentials_key_version` — companion column carrying the F-47
--     keyset version the row's ciphertext was produced under. Mirrors
--     every other `INTEGRATION_TABLES` entry's `keyVersionColumn`
--     convention so the rotation script's UPDATE works generically.
--   * `created_at` / `updated_at` — `updated_at` bumps on refresh-token
--     rotation; admin UI surfaces it as "last refreshed."
--
-- Foreign key on `catalog_id`: a catalog row removal cascades into
-- `workspace_plugins` (existing FK) and now also into this table. The
-- ADR-0003 dual-store teardown deletes from here FIRST, then from
-- `workspace_plugins` — the cascade is the defensive backstop, not the
-- primary cleanup path.
--
-- Foreign key on `workspace_id` is intentionally omitted: organization
-- ids are user-supplied (Better Auth) or sentinel ("self-hosted") and
-- we don't FK any other integration table to them either. Cleanup on
-- workspace deletion is the responsibility of the workspace-teardown
-- path (out of scope for this slice).

CREATE TABLE IF NOT EXISTS integration_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             TEXT NOT NULL,
  catalog_id               TEXT NOT NULL REFERENCES plugin_catalog(id) ON DELETE CASCADE,
  credentials_encrypted    TEXT NOT NULL,
  credentials_key_version  INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite uniqueness — at most one credential row per (workspace,
-- catalog). Matches `workspace_plugins`' unique index shape so the two
-- stores stay 1:1 by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_credentials_unique
  ON integration_credentials (workspace_id, catalog_id);

-- Lookup index for the per-workspace listing the admin UI may run.
-- workspace-scoped queries are the dominant access pattern; catalog-
-- scoped queries (rotation, audit) walk the table directly.
CREATE INDEX IF NOT EXISTS idx_integration_credentials_workspace
  ON integration_credentials (workspace_id);
