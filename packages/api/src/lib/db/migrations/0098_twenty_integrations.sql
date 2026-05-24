-- 0098_twenty_integrations.sql
--
-- `twenty_integrations` — per-workspace credentials for the Twenty CRM
-- plugin. Until the admin-UI install flow lands, dispatch resolves
-- credentials from `TWENTY_API_KEY` env via `TwentyCredentialResolver`;
-- this table is the destination for per-workspace overrides.
--
-- Shape:
--   * `id` — uuid PK. Single-column PK so the F-47 rotation tooling and
--     F-42 residue audit (both walk `INTEGRATION_TABLES` with one PK
--     identifier) work unchanged.
--   * `workspace_id` — unique on its own; one Twenty install per
--     workspace.
--   * `base_url` — Twenty REST base URL, plaintext (operator-visible
--     hostnames aren't secret; the API key is). NULL here means
--     "no override" — the application code picks its known fallback.
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

-- One Twenty install per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_twenty_integrations_workspace_unique
  ON twenty_integrations (workspace_id);
