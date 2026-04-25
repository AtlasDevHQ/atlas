-- 0040 — Drop F-41 plaintext integration credential columns (one-way door)
--
-- F-41 step 4: workspace integration tokens have been dual-writing to
-- `<col>` (plaintext) and `<col>_encrypted` (AES-256-GCM ciphertext) since
-- migration 0036_integration_credentials_encryption.sql shipped on
-- 2026-04-24. After one full release of soak with the encrypted path live
-- and the backfill script `backfill-integration-credentials.ts` run
-- against every region, the plaintext columns are now redundant — every
-- read goes through `decryptSecret(<col>_encrypted)`. This migration
-- deletes them.
--
-- ── ONE-WAY DOOR ──────────────────────────────────────────────────────
-- Dropping a column is destructive and irreversible at the schema layer.
-- Recovery requires restoring from a pre-migration backup, NOT
-- re-running the migration in reverse. Operator pre-flight checks
-- (enumerated in the PR description) MUST report zero residue rows in
-- every production region before this migration is applied:
--
--   1. Run `bun run packages/api/scripts/audit-plugin-config-residue.ts`
--      against US, EU, APAC. Expected: exit code 0 — zero residue
--      findings. The script asserts every row in the eight non-nullable
--      F-41 integration tables (Slack, Telegram, GChat, GitHub, Linear,
--      WhatsApp, Email, Sandbox) has a non-empty `<col>_encrypted`
--      value matching `enc:v<N>:`. A non-zero exit indicates either an
--      F-41 row whose ciphertext was never written or an F-42
--      `secret: true` field still carrying plaintext.
--   2. One last idempotent backfill pass per region. The integration
--      credential backfill script (`backfill-integration-credentials.ts`)
--      is deleted in this PR, so step 2 collapses into step 1 — exit-0
--      from the audit covers the same invariant. For workspace + plugin
--      config, the backfill remains at `lib/db/backfill-plugin-config.ts`
--      (one-off F-42 plaintext → ciphertext walk, idempotent on
--      `enc:v<N>:` prefix).
--   3. Confirm zero `count(*) FROM <table> WHERE <col>_encrypted IS NULL`
--      across all eight non-nullable integration tables and all 3
--      regions. The audit script in step 1 asserts this for every row;
--      a manual re-run of this exact query in ≥1 region is the
--      belt-and-braces double-check.
--
-- If ANY pre-flight check returns non-zero, do NOT apply this
-- migration. Dropping the plaintext column on a row whose ciphertext
-- column is still NULL silently nulls out a live integration
-- credential — the workspace's bot stops working and the credential
-- must be re-entered by the workspace admin. There is no recovery
-- short of a backup restore.
--
-- After this migration:
--   • Read paths in each integration store must drop the back-compat
--     fall-through to the plaintext column (same PR);
--   • `pickDecryptedSecret` is removed from `secret-encryption.ts` and
--     its callers fold into `decryptSecret(...)` /
--     `JSON.parse(decryptSecret(...))` directly;
--   • `backfill-integration-credentials.ts` and its tests are deleted
--     (one-shot tool — never runs again).
--
-- The `<col>_encrypted` columns are tightened to NOT NULL where the
-- original plaintext was NOT NULL pre-0036. Two columns
-- (`teams_installations.app_password`, `discord_installations.bot_token`)
-- were already nullable pre-0036 — they stay nullable on the encrypted
-- side because admin-consent / OAuth-only Teams + Discord installs
-- legitimately persist no bearer secret.
--
-- Audit row: .claude/research/security-audit-1-2-3.md F-41 step 4
-- Closes:    #1832

-- ── Slack ───────────────────────────────────────────────────────────────
ALTER TABLE slack_installations DROP COLUMN bot_token;
ALTER TABLE slack_installations
  ALTER COLUMN bot_token_encrypted SET NOT NULL;

-- ── Teams ───────────────────────────────────────────────────────────────
-- app_password was nullable pre-0036; encrypted column stays nullable
-- because admin-consent installs persist no password.
ALTER TABLE teams_installations DROP COLUMN app_password;

-- ── Discord ─────────────────────────────────────────────────────────────
-- bot_token was nullable pre-0036; encrypted column stays nullable
-- because the OAuth path leaves bot_token unset until BYOT supplies it.
ALTER TABLE discord_installations DROP COLUMN bot_token;

-- ── Telegram ────────────────────────────────────────────────────────────
ALTER TABLE telegram_installations DROP COLUMN bot_token;
ALTER TABLE telegram_installations
  ALTER COLUMN bot_token_encrypted SET NOT NULL;

-- ── Google Chat ─────────────────────────────────────────────────────────
ALTER TABLE gchat_installations DROP COLUMN credentials_json;
ALTER TABLE gchat_installations
  ALTER COLUMN credentials_json_encrypted SET NOT NULL;

-- ── GitHub ──────────────────────────────────────────────────────────────
ALTER TABLE github_installations DROP COLUMN access_token;
ALTER TABLE github_installations
  ALTER COLUMN access_token_encrypted SET NOT NULL;

-- ── Linear ──────────────────────────────────────────────────────────────
ALTER TABLE linear_installations DROP COLUMN api_key;
ALTER TABLE linear_installations
  ALTER COLUMN api_key_encrypted SET NOT NULL;

-- ── WhatsApp ────────────────────────────────────────────────────────────
ALTER TABLE whatsapp_installations DROP COLUMN access_token;
ALTER TABLE whatsapp_installations
  ALTER COLUMN access_token_encrypted SET NOT NULL;

-- ── Email providers ─────────────────────────────────────────────────────
ALTER TABLE email_installations DROP COLUMN config;
ALTER TABLE email_installations
  ALTER COLUMN config_encrypted SET NOT NULL;

-- ── Sandbox credentials ─────────────────────────────────────────────────
ALTER TABLE sandbox_credentials DROP COLUMN credentials;
ALTER TABLE sandbox_credentials
  ALTER COLUMN credentials_encrypted SET NOT NULL;
