-- 0098_twenty_integrations.sql
--
-- Atlas issue #2727 — `twenty_integrations` schema for the Twenty CRM
-- plugin. Slice 1 of #2726 only creates the table; the admin UI flow
-- that populates it lands in slice 9. The env-var path
-- (`TWENTY_API_KEY`) in `TwentyCredentialResolver` ships first so the
-- demo → Twenty pipe (this slice) can be smoke-tested without any
-- per-workspace row.
--
-- Shape:
--   * `id` — uuid PK. Single-column PK so the F-47 rotation tooling and
--     F-42 residue audit (both walk `INTEGRATION_TABLES` with one PK
--     identifier) work unchanged.
--   * `workspace_id` — composite uniqueness with this column; matches
--     the `integration_credentials` shape from 0089. One Twenty
--     install per workspace, full stop.
--   * `base_url` — Twenty REST base URL, plaintext (operator-visible
--     hostnames aren't secret on their own; the API key is the secret).
--     Defaults to https://crm.useatlas.dev in the application code,
--     not at the SQL layer — `NULL` here means "fall back to the
--     default the resolver picks."
--   * `api_key_encrypted` — AES-256-GCM ciphertext (versioned
--     `enc:v<N>:iv:authTag:ciphertext`) from `db/secret-encryption.ts`,
--     per the CLAUDE.md guidance for new integration credential
--     columns. Pairs with `api_key_key_version` for F-47 rotation.
--   * `api_key_key_version` — F-47 keyset version the row's ciphertext
--     was produced under. Mirrors every other `INTEGRATION_TABLES`
--     entry's `keyVersionColumn` convention.
--   * `created_at` / `updated_at` — `updated_at` bumps on credential
--     rotation; admin UI will surface it.
--
-- Foreign key on `workspace_id` is intentionally omitted — every other
-- integration credential table (slack_installations, telegram,
-- linear, integration_credentials, etc.) makes the same call. Cleanup
-- on workspace deletion is the responsibility of the
-- workspace-teardown path.

CREATE TABLE IF NOT EXISTS twenty_integrations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             TEXT NOT NULL,
  base_url                 TEXT,
  api_key_encrypted        TEXT NOT NULL,
  api_key_key_version      INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite uniqueness — one Twenty install per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_twenty_integrations_workspace_unique
  ON twenty_integrations (workspace_id);
