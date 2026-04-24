-- 0037 — Encryption key versioning columns (F-47, phase 5)
--
-- Before F-47, every ciphertext column (connections.url,
-- workspace_model_config.api_key_encrypted, all F-41 integration
-- stores) was encrypted under a single key derived from
-- ATLAS_ENCRYPTION_KEY ?? BETTER_AUTH_SECRET. Rotating that key
-- orphaned every row — `decryptUrl` / `decryptSecret` threw and the
-- only remediation was to re-enter each admin-managed credential.
--
-- F-47 introduces ATLAS_ENCRYPTION_KEYS (multi-key, with explicit
-- v<N>: version labels). On the ciphertext side two histories matter:
--   • F-41 integration credentials already carried the prefix
--     `enc:v1:iv:authTag:ciphertext` — F-47 generalizes the `v1` to
--     `v<N>` where <N> points into the keyset.
--   • Pre-F-47 connection URLs (connections.url) carried the bare
--     3-part `iv:authTag:ciphertext` with no prefix at all. F-47 is
--     what introduces the `enc:v<N>:` prefix on *new* URL writes; the
--     decryptUrl legacy-unversioned fallback still reads the old
--     format by trying the v1 key (or the active key as a last
--     resort, with a loud warn breadcrumb).
--
-- This migration adds a `*_key_version INTEGER NOT NULL DEFAULT 1`
-- column alongside every encrypted column. The column is populated by
-- app code on write (stamping the active keyset version) and read by
-- ops / the rotation script to identify rows below the active version
-- that still need re-encrypting.
--
-- DEFAULT 1 + NOT NULL is load-bearing:
--   • Legacy rows (pre-F-47) land as v1 without a backfill — their
--     actual ciphertext is either un-prefixed (for connection URLs) or
--     carries the old `enc:v1:` prefix (F-41 secrets). Both read fine
--     under the v1 key in the keyset.
--   • Every new INSERT omits the column → DB stamps 1 via DEFAULT.
--     Once the active version advances (via rotation), app code starts
--     writing the column explicitly with the higher number.
--
-- Audit row: .claude/research/security-audit-1-2-3.md F-47
-- Issue: #1820
-- Runbook: apps/docs/content/docs/platform-ops/encryption-key-rotation.mdx

-- ── Pre-F-41 encrypted columns ──────────────────────────────────────────
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS url_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workspace_model_config
  ADD COLUMN IF NOT EXISTS api_key_key_version INTEGER NOT NULL DEFAULT 1;

-- ── F-41 chat-platform integrations ─────────────────────────────────────
ALTER TABLE slack_installations
  ADD COLUMN IF NOT EXISTS bot_token_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE teams_installations
  ADD COLUMN IF NOT EXISTS app_password_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE discord_installations
  ADD COLUMN IF NOT EXISTS bot_token_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE telegram_installations
  ADD COLUMN IF NOT EXISTS bot_token_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE gchat_installations
  ADD COLUMN IF NOT EXISTS credentials_json_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE github_installations
  ADD COLUMN IF NOT EXISTS access_token_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE linear_installations
  ADD COLUMN IF NOT EXISTS api_key_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE whatsapp_installations
  ADD COLUMN IF NOT EXISTS access_token_key_version INTEGER NOT NULL DEFAULT 1;

-- ── F-41 JSONB blob stores ──────────────────────────────────────────────
ALTER TABLE email_installations
  ADD COLUMN IF NOT EXISTS config_key_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sandbox_credentials
  ADD COLUMN IF NOT EXISTS credentials_key_version INTEGER NOT NULL DEFAULT 1;
