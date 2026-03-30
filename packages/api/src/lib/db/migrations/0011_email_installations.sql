-- 0011_email_installations.sql
--
-- Email integration: stores per-workspace email delivery config.
-- Supports multiple providers (smtp, sendgrid, postmark, ses).
-- Each workspace admin configures their own email delivery (BYOT).

CREATE TABLE IF NOT EXISTS email_installations (
  config_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  org_id TEXT,
  installed_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_installations_org ON email_installations(org_id) WHERE org_id IS NOT NULL;
