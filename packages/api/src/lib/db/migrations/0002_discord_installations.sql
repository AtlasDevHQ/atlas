-- 0002_discord_installations.sql
--
-- Discord integration: stores per-guild bot authorization records.
-- App credentials (DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET) are platform-level env vars.
-- This table records which Discord guilds (servers) have authorized the bot.

CREATE TABLE IF NOT EXISTS discord_installations (
  guild_id TEXT PRIMARY KEY,
  org_id TEXT,
  guild_name TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discord_installations_org ON discord_installations(org_id);
