-- 0086_consolidate_slack_installations.sql
--
-- Atlas issue #2634 — drop the dual-store dependency between the
-- legacy `slack_installations` Postgres table and the chat plugin's
-- `chat_cache` table that already holds Slack workspace installs for
-- the @chat-adapter/slack multi-workspace lookup path.
--
-- Pre-#2634 OAuth installs wrote to `slack_installations` (with Atlas's
-- versioned secret-encryption), but the chat plugin's listener resolved
-- per-event bot tokens from `chat_cache:slack:installation:<teamId>`.
-- The two stores drifted on every install; an internal back-fill
-- script (`internal/backfill-chat-installations.ts`) was the working
-- bandage. That bandage goes away with this migration — Atlas writes
-- straight to `chat_cache` from the OAuth callback, the chat-adapter
-- reads the same rows, and `slack_installations` is dropped.
--
-- The org_id index is preserved as a **partial expression index** on
-- `chat_cache.value->>'orgId'`, filtered by the `slack:installation:`
-- key prefix. This is lighter-weight than a JSONB GIN (only the orgId
-- field is queried) and cheaper than a sidecar table (no atomic
-- two-write semantics to maintain).
--
-- This migration takes ownership of `chat_cache` (and its companion
-- expiry index) from the chat plugin's lazy `CREATE TABLE IF NOT
-- EXISTS` in `plugins/chat/src/state/pg-adapter.ts`. The plugin's
-- runtime-side creation stays in place as a safety net (idempotent),
-- but migrations are now the authoritative schema source — required
-- to (a) layer an index on top here and (b) include the table in the
-- real-PG migrate smoke test (`migrate-pg.test.ts`).
--
-- **Breaking change.** Existing `slack_installations` rows are NOT
-- copied — they were encrypted with Atlas's versioned secret-encryption
-- format which is binary-incompatible with the chat-adapter's AES-GCM
-- envelope. The chat-adapter cannot decrypt them. Operators with
-- existing installs must reinstall the Slack app once. Pre-1.0
-- semver — one-click reinstall is acceptable. The 1.5.0 dogfood
-- (#sandbox-atlas) workspace is the only known existing tenant; it
-- will be reinstalled as part of this PR's verification.

CREATE TABLE IF NOT EXISTS chat_cache (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_cache_expires
  ON chat_cache (expires_at)
  WHERE expires_at IS NOT NULL;

-- Partial expression index on the JSONB `orgId` field. The `WHERE`
-- clause keeps the index narrow — only Slack-installation rows
-- contribute, not the rest of `chat_cache` (thread subscriptions,
-- conversation IDs, OAuth state nonces, etc.).
CREATE INDEX IF NOT EXISTS idx_chat_cache_slack_org_id
  ON chat_cache ((value->>'orgId'))
  WHERE key LIKE 'slack:installation:%';

DROP TABLE IF EXISTS slack_installations;
