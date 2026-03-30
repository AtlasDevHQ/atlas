-- 0005_byot_credentials.sql
--
-- BYOT (Bring Your Own Token) support for Teams and Discord integrations.
-- Adds credential columns so workspace admins can connect without
-- platform-level OAuth env vars — matching how Slack (bot_token) and
-- Telegram (bot_token) already work.

-- Teams: store app credentials for BYOT (platform OAuth stores nothing here)
ALTER TABLE teams_installations ADD COLUMN IF NOT EXISTS app_password TEXT;

-- Discord: store bot credentials for BYOT (platform OAuth stores nothing here)
ALTER TABLE discord_installations ADD COLUMN IF NOT EXISTS bot_token TEXT;
ALTER TABLE discord_installations ADD COLUMN IF NOT EXISTS application_id TEXT;
ALTER TABLE discord_installations ADD COLUMN IF NOT EXISTS public_key TEXT;
