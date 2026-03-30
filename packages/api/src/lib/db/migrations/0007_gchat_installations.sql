-- 0007_gchat_installations.sql
--
-- Google Chat integration: stores per-workspace service account credentials.
-- Google Chat uses service accounts (not OAuth). Each workspace admin
-- pastes their service account JSON key (BYOT).

CREATE TABLE IF NOT EXISTS gchat_installations (
  project_id TEXT PRIMARY KEY,
  service_account_email TEXT NOT NULL,
  credentials_json TEXT NOT NULL,
  org_id TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gchat_installations_org ON gchat_installations(org_id);
