-- 0009_linear_installations.sql
--
-- Linear integration: stores per-workspace Linear API keys (BYOT).
-- Each workspace admin enters their own API key.

CREATE TABLE IF NOT EXISTS linear_installations (
  user_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  user_name TEXT,
  user_email TEXT,
  org_id TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linear_installations_org ON linear_installations(org_id);
