-- 0003_telegram_installations.sql
--
-- Telegram integration: stores per-bot authorization records.
-- Unlike Discord/Teams, Telegram requires no platform-level env vars.
-- Each workspace admin enters their own bot token from @BotFather (BYOT).

CREATE TABLE IF NOT EXISTS telegram_installations (
  bot_id TEXT PRIMARY KEY,
  bot_token TEXT NOT NULL,
  bot_username TEXT,
  org_id TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_installations_org ON telegram_installations(org_id);
