-- 0008_github_installations.sql
--
-- GitHub integration: stores per-workspace personal access tokens.
-- Each workspace admin enters their own PAT (BYOT).

CREATE TABLE IF NOT EXISTS github_installations (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  username TEXT,
  org_id TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_installations_org ON github_installations(org_id);
