-- 0140_operator_integration_credentials.sql
--
-- Atlas issue #3704 — operator-tier (platform) integration app
-- credentials, settable + rotatable from the Admin console without a
-- redeploy, encrypted at rest. Pilot platform: Slack.
--
-- Background: until this table, the OPERATOR credentials for every chat
-- platform / action-target integration (Atlas's OWN app registrations —
-- `SLACK_CLIENT_ID` / `_SECRET` / `_SIGNING_SECRET` / `_ENCRYPTION_KEY`,
-- etc.) were read from `process.env` at boot. Rotating a hosted region's
-- Slack signing secret therefore required a Railway deploy — exactly the
-- "no deploy for a config change" rule the SaaS-first principle forbids
-- (#3701). Workspace-tier plugin credentials already live encrypted in
-- dedicated tables (ADR-0005 `integration_credentials`, `twenty_integrations`,
-- etc.) and are set via Admin → Integrations; this table brings the
-- operator/platform tier up to the same model.
--
-- This is the OPERATOR tier, deliberately separate from the WORKSPACE
-- tier. Operator credentials are Atlas's own app registrations (one row
-- per platform, no `workspace_id`); workspace credentials are a tenant's
-- per-install secrets (keyed by `workspace_id`). The two must never read
-- from each other's store — see `lib/integrations/operator-credentials/`
-- and the `operator-credential-isolation.test.ts` seam test. Env stays
-- the fallback for self-host (resolver precedence: DB row → env → unset).
--
-- Shape:
--   * `id` — uuid PK. Single-column PK so the F-47 rotation tooling and
--     F-42 residue audit (both walk `INTEGRATION_TABLES` with one PK
--     identifier) work unchanged.
--   * `platform` — the operator-tier platform slug (`slack`, future
--     `discord` / `jira` / …). UNIQUE: one operator credential row per
--     platform (the app registration is operator-shared across every
--     workspace, so there is no per-workspace dimension here).
--   * `credentials_encrypted` — AES-256-GCM ciphertext (versioned
--     `enc:v<N>:iv:authTag:ciphertext`) from `db/secret-encryption.ts`,
--     wrapping a JSON object of `{ <ENV_VAR_NAME>: <value>, … }` (e.g.
--     `{ SLACK_CLIENT_ID: "...", SLACK_CLIENT_SECRET: "...", … }`). Env-var
--     names are the keys so the resolver can overlay the decrypted bundle
--     straight onto the env the adapter builders already read.
--   * `credentials_key_version` — companion column carrying the F-47
--     keyset version the row's ciphertext was produced under. Mirrors
--     every other `INTEGRATION_TABLES` entry's `keyVersionColumn`
--     convention so the rotation script's UPDATE works generically.
--   * `created_at` / `updated_at` — `updated_at` bumps on every rotation;
--     the Admin UI surfaces it as "last rotated."
--
-- No foreign keys: `platform` is an operator-chosen slug, not a row in
-- any tenant table. Matches the FK-free convention of every other
-- integration credential table.

CREATE TABLE IF NOT EXISTS operator_integration_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform                 TEXT NOT NULL,
  credentials_encrypted    TEXT NOT NULL,
  credentials_key_version  INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One operator credential row per platform — the app registration is
-- operator-shared, so the platform slug is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_integration_credentials_platform
  ON operator_integration_credentials (platform);
