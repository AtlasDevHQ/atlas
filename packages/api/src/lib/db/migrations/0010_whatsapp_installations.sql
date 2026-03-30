-- 0010_whatsapp_installations.sql
--
-- WhatsApp integration: stores per-workspace WhatsApp Cloud API credentials (BYOT).
-- Each workspace admin enters their phone number ID and access token from Meta Business Suite.

CREATE TABLE IF NOT EXISTS whatsapp_installations (
  phone_number_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  display_phone TEXT,
  org_id TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_installations_org ON whatsapp_installations(org_id);
