-- 0036 — Encrypt workspace integration credentials at rest (F-41 phase 5)
--
-- Every workspace integration store previously held a bearer credential
-- in a plaintext column. A DB dump (backup / disk image / read-replica
-- snapshot / compromised read-only credential) exposed every customer's
-- chat-platform bot tokens and email-provider API keys verbatim.
--
-- This migration adds a nullable `*_encrypted` TEXT column alongside
-- each plaintext credential column. The handler layer dual-writes: new
-- and updated rows populate both columns; reads prefer the encrypted
-- column and decrypt via `decryptSecret` (`enc:v1:iv:authTag:ciphertext`,
-- AES-256-GCM, same key derivation as `encryptUrl`).
--
-- The plaintext columns are also relaxed to nullable so the dual-write
-- path can one day (follow-up PR, separate issue) stop writing to them
-- and let them be dropped without breaking back-compat for rows still
-- carrying a plaintext value pre-backfill.
--
-- Existing plaintext rows are backfilled post-migration by a separate
-- TS script (scripts/backfill-integration-credentials.ts) — encryption
-- happens in app code, not SQL, so the backfill cannot be a raw UPDATE.
--
-- The follow-up PR (step 4 in the F-41 plan, tracked as #1832) will
-- drop the plaintext columns and re-tighten NOT NULL on the encrypted
-- columns.
--
-- Audit row: .claude/research/security-audit-1-2-3.md F-41
-- Issue: #1815

-- ── Slack ───────────────────────────────────────────────────────────────
ALTER TABLE slack_installations
  ADD COLUMN IF NOT EXISTS bot_token_encrypted TEXT;
ALTER TABLE slack_installations
  ALTER COLUMN bot_token DROP NOT NULL;

-- ── Teams ───────────────────────────────────────────────────────────────
-- app_password was already nullable (admin-consent flow populates it
-- only in BYOT mode); only the encrypted column needs adding.
ALTER TABLE teams_installations
  ADD COLUMN IF NOT EXISTS app_password_encrypted TEXT;

-- ── Discord ─────────────────────────────────────────────────────────────
-- bot_token was already nullable.
ALTER TABLE discord_installations
  ADD COLUMN IF NOT EXISTS bot_token_encrypted TEXT;

-- ── Telegram ────────────────────────────────────────────────────────────
ALTER TABLE telegram_installations
  ADD COLUMN IF NOT EXISTS bot_token_encrypted TEXT;
ALTER TABLE telegram_installations
  ALTER COLUMN bot_token DROP NOT NULL;

-- ── Google Chat ─────────────────────────────────────────────────────────
ALTER TABLE gchat_installations
  ADD COLUMN IF NOT EXISTS credentials_json_encrypted TEXT;
ALTER TABLE gchat_installations
  ALTER COLUMN credentials_json DROP NOT NULL;

-- ── GitHub ──────────────────────────────────────────────────────────────
ALTER TABLE github_installations
  ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT;
ALTER TABLE github_installations
  ALTER COLUMN access_token DROP NOT NULL;

-- ── Linear ──────────────────────────────────────────────────────────────
ALTER TABLE linear_installations
  ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;
ALTER TABLE linear_installations
  ALTER COLUMN api_key DROP NOT NULL;

-- ── WhatsApp ────────────────────────────────────────────────────────────
ALTER TABLE whatsapp_installations
  ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT;
ALTER TABLE whatsapp_installations
  ALTER COLUMN access_token DROP NOT NULL;

-- ── Email providers ─────────────────────────────────────────────────────
-- `config` is JSONB carrying provider-specific secrets (apiKey, password,
-- serverToken, etc. per discriminated ProviderConfig). We do NOT try to
-- split columns — blob-encryption is the right call so additions to the
-- provider config don't require schema churn. `config_encrypted` carries
-- `encryptSecret(JSON.stringify(config))`.
ALTER TABLE email_installations
  ADD COLUMN IF NOT EXISTS config_encrypted TEXT;
ALTER TABLE email_installations
  ALTER COLUMN config DROP NOT NULL;
ALTER TABLE email_installations
  ALTER COLUMN config DROP DEFAULT;

-- ── Sandbox credentials ─────────────────────────────────────────────────
-- Same JSONB blob-encryption pattern as email_installations.
ALTER TABLE sandbox_credentials
  ADD COLUMN IF NOT EXISTS credentials_encrypted TEXT;
ALTER TABLE sandbox_credentials
  ALTER COLUMN credentials DROP NOT NULL;
