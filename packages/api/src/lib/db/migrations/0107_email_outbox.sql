-- 0107_email_outbox.sql
--
-- `email_outbox` — durable queue for transactional email (password
-- reset, signup verification OTP) so a SUSTAINED upstream outage no
-- longer permanently loses a send (#2942, residual scope).
--
-- Context: PR #2949 already added bounded exponential-backoff retry on
-- 429/5xx/network inside `email/delivery.ts:fetchWithRetry` — that
-- covers a transient blip. This table is the backstop for the case
-- retry can't cover: the provider is down longer than the in-process
-- retry window. `sendTransactionalEmail` enqueues a `pending` row when
-- the in-process retry path is exhausted; the Scheduler-backed flusher
-- (see `packages/api/src/lib/email-outbox/`) claims, re-sends, and
-- stamps terminal status. The password-reset path stays enumeration-
-- safe (F-09): `/request-password-reset` returns 200 whether or not the
-- send succeeded — the outbox only changes WHERE the failed send goes
-- (durable queue vs dropped), never the response.
--
-- Shape rationale — deliberately a STRIPPED-DOWN mirror of `crm_outbox`
-- (0102). Both are write-then-flush durable queues with `attempts` +
-- `last_error` + `retry_after` + `claimed_at` carrying retry/recovery
-- state, and a partial index on the active statuses. What `email_outbox`
-- DROPS vs `crm_outbox`, and why:
--   * No `email_key` / per-email serialization (0104). CRM ordering
--     mattered because concurrent dispatches flipped `atlasFirstSource`;
--     transactional email has no cross-row ordering contract and an
--     at-least-once duplicate send is acceptable, so rows dispatch
--     independently.
--   * No `workspace_id` routing (0106). These are operator-level
--     transactional sends, not per-tenant plugin dispatches. `org_id`
--     (nullable) is carried only so the flusher can re-resolve a
--     per-org transport override via the same `sendEmail(msg, orgId)`
--     path; the password-reset flow has no org and lands NULL.
--   * No `twenty_person_id` / `twenty_note_id` sub-step resource IDs.
--     A send is a single operation — there is no partial-success
--     sub-step to make idempotent.
--
-- `status` is the OUTBOX LIFECYCLE status (pending/in_flight/done/dead),
-- NOT the content-mode status (draft/published/archived). `email_outbox`
-- is an operational queue, not user-surfaced content, so it is
-- intentionally OUTSIDE the content-mode system (no mode resolution, no
-- publish-transaction promotion). See CLAUDE.md § Content Mode System
-- for the carve-out rule.
--
-- Credentials: the `payload` JSONB stores the rendered message
-- (to/subject/html). The password-reset html embeds a SINGLE-USE,
-- one-hour-expiry reset URL token — an ephemeral capability, not a
-- long-lived credential — so it is NOT encrypted at rest (encryptSecret
-- is reserved for durable secrets; a short-TTL one-time token in a
-- short-lived queue row does not qualify). No API keys, connection
-- strings, or provider secrets are ever written here. The table is
-- therefore intentionally NOT a member of `INTEGRATION_TABLES`.

CREATE TABLE IF NOT EXISTS email_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Send classification for observability / metrics bucketing
  -- (e.g. 'password-reset', 'verification-otp'). Never used for routing.
  email_type    TEXT NOT NULL,
  -- Rendered EmailMessage: { to, subject, html }. The flusher hands this
  -- straight to `sendEmail`.
  payload       JSONB NOT NULL,
  -- Optional org scope so the flusher re-resolves a per-org transport
  -- override on re-send. NULL for session-less flows (password reset).
  org_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  -- Absolute timestamp before which the row must not be re-claimed. Set
  -- when a transient outcome carried an upstream-requested delay; NULL
  -- means the tier-based backoff (CLAIM_DELAY_SQL) applies. Mirrors
  -- crm_outbox.retry_after.
  retry_after   TIMESTAMPTZ,
  -- Stamped by CLAIM_SQL on every claim. The recovery sweep filters by
  -- `now() - claimed_at > threshold` so a peer pod's freshly-claimed row
  -- is not reset out from under it during a shutdown sweep (multi-pod
  -- double-send guard). Mirrors crm_outbox.claimed_at.
  claimed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  CONSTRAINT email_outbox_status_chk
    CHECK (status IN ('pending', 'in_flight', 'done', 'dead'))
);

-- Partial index keeps the flusher poll + depth snapshot fast as
-- done/dead rows accumulate (same shape as idx_crm_outbox_pending_created).
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending_created
  ON email_outbox (status, created_at)
  WHERE status IN ('pending', 'in_flight');

COMMENT ON TABLE email_outbox IS
  'Durable outbox for transactional email (password reset, signup verification OTP). sendTransactionalEmail enqueues a pending row when the in-process retry path is exhausted; the Scheduler-backed flusher claims, re-sends via sendEmail, and stamps terminal status. Stripped-down mirror of crm_outbox — no email_key/workspace_id/sub-step columns. Stores no credentials (the reset-link token is single-use + short-TTL). See packages/api/src/lib/email-outbox/ (#2942).';

COMMENT ON COLUMN email_outbox.retry_after IS
  'Absolute timestamp before which the row must not be re-claimed. Set when a transient outcome carried an upstream-requested delay; NULL means the tier-based backoff applies. Cleared on the next transient outcome that lacks a delay.';

COMMENT ON COLUMN email_outbox.claimed_at IS
  'Timestamp of the most recent CLAIM_SQL execution against this row. recoverInFlight filters by `now() - claimed_at > threshold` so a sibling pod''s in-flight row is not reset during a shutdown sweep — critical for multi-pod deployments.';
