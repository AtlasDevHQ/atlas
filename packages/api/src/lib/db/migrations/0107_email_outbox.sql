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
-- Credentials: the `payload` TEXT stores the rendered message
-- (to/subject/html) ENCRYPTED AT REST via `encryptSecret` (versioned
-- AES-256-GCM `enc:v<N>:...`). The password-reset html embeds a
-- single-use reset URL token and the verification html embeds an OTP —
-- both are live bearer capabilities for the TTL window, so anyone with
-- read access to the internal DB or a backup could replay them. The
-- queue therefore encrypts the payload (codex review on #2972). When no
-- encryption key is configured (self-hosted dev), `encryptSecret`
-- degrades to plaintext passthrough and `decryptSecret` round-trips it
-- unchanged. Still NOT a member of `INTEGRATION_TABLES` (no long-lived
-- provider credential; nothing for F-47 rotation to re-key).
--
-- `expires_at`: the reset link expires in 1h and the OTP in 10m, so a
-- send that can't go out before then would deliver a dead token. The
-- enqueue stamps a per-type TTL; the flusher dead-letters (does NOT
-- send) a row past its `expires_at` rather than delivering an unusable
-- link/code (codex review on #2972).

CREATE TABLE IF NOT EXISTS email_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Send classification for observability / metrics bucketing
  -- (e.g. 'password-reset', 'verification-otp'). Never used for routing.
  email_type    TEXT NOT NULL,
  -- Rendered EmailMessage { to, subject, html }, JSON-serialized then
  -- encrypted via encryptSecret (enc:v<N>:... AES-256-GCM). TEXT, not
  -- JSONB, because the stored value is opaque ciphertext. The flusher
  -- decrypts before handing it to `sendEmail`.
  payload       TEXT NOT NULL,
  -- Optional org scope so the flusher re-resolves a per-org transport
  -- override on re-send. NULL for session-less flows (password reset).
  org_id        TEXT,
  -- Hard delivery deadline: past this the embedded token/OTP is dead, so
  -- the flusher dead-letters rather than sending a useless email. NULL =
  -- no deadline (non-expiring sends).
  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  -- Absolute earliest re-claim time. Stamped on EVERY transient failure
  -- as GREATEST(now() + tier(attempts), upstream_retry_after) — measured
  -- from the failure moment, so a long-pending row can't burst through
  -- its budget. NULL only on a never-failed row, where the claim gate
  -- falls back to created_at + tier (immediate at attempts=0). Cleared
  -- back to NULL on a terminal done/dead.
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
  'Durable outbox for transactional email (password reset, signup verification OTP). sendTransactionalEmail enqueues a pending row when the in-process retry path is exhausted; the Scheduler-backed flusher claims, re-sends via sendEmail, and stamps terminal status. Stripped-down mirror of crm_outbox — no email_key/workspace_id/sub-step columns; adds expires_at (TTL) + encrypted payload because the body carries a live reset link / OTP. payload is encryptSecret-encrypted at rest. See packages/api/src/lib/email-outbox/ (#2942).';

COMMENT ON COLUMN email_outbox.payload IS
  'JSON-serialized rendered EmailMessage { to, subject, html }, encrypted at rest via encryptSecret (enc:v<N>:... AES-256-GCM; plaintext passthrough when no key is configured). Holds a live reset link / OTP for the TTL window, hence encryption. Decrypted by the flusher before sendEmail.';

COMMENT ON COLUMN email_outbox.expires_at IS
  'Hard delivery deadline derived from the email type TTL at enqueue (reset link 1h, OTP 10m). The flusher dead-letters a row past this instead of delivering a dead token. NULL = no deadline.';

COMMENT ON COLUMN email_outbox.retry_after IS
  'Absolute earliest re-claim time. Stamped on every transient failure as GREATEST(now() + tier, upstream_retry_after) — measured from the failure moment, not created_at, so a row that sat pending a long time before its first claim cannot burst through its retry budget. NULL only on a never-failed row (claim gate then uses created_at + tier; immediate at attempts=0). Cleared to NULL on a terminal done/dead.';

COMMENT ON COLUMN email_outbox.claimed_at IS
  'Timestamp of the most recent CLAIM_SQL execution against this row. recoverInFlight filters by `now() - claimed_at > threshold` so a sibling pod''s in-flight row is not reset during a shutdown sweep — critical for multi-pod deployments.';
