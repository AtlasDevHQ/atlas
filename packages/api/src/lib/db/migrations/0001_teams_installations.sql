-- 0001_teams_installations.sql
--
-- Teams integration: stores per-tenant authorization records.
-- App credentials (appId, appPassword) stay as env vars.
-- This table records which Azure AD tenants have admin-consented to the bot.

CREATE TABLE IF NOT EXISTS teams_installations (
  tenant_id TEXT PRIMARY KEY,
  org_id TEXT,
  tenant_name TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_teams_installations_org ON teams_installations(org_id);
