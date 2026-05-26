-- 0102_crm_outbox.sql
--
-- `crm_outbox` — durable queue for SaaS CRM (Twenty) lead dispatches.
-- Slice 2 of 1.6.0 (#2729). Replaces the fire-and-forget dispatch from
-- slice 1 (#2727) with a write-then-flush pattern so a Twenty outage
-- or API crash no longer drops leads.
--
-- Shape rationale:
--   * `status` is `text` + CHECK rather than a Postgres enum: easier to
--     evolve (no `ALTER TYPE ... ADD VALUE` ceremony) and consistent
--     with the rest of the 0095+ enum-as-CHECK convention in this repo.
--   * `attempts` + `last_error` carry retry state; the flusher computes
--     the next-allowed dispatch time from `attempts` + `created_at` so
--     backoff is enforced in the WHERE clause rather than a sleep
--     (a long backoff on row A must not stall newer rows).
--   * `twenty_person_id` / `twenty_note_id` persist per-sub-step
--     resource IDs. On retry the flusher skips any sub-step whose ID
--     column is already populated — that is the only way to guarantee
--     idempotency across an "upsertPerson succeeded, createNote
--     crashed" partial commit.
--   * No `workspace_id` or other PII-bearing column beyond the payload
--     blob (which contains email + UA). The outbox stores no
--     credentials, so this table is intentionally NOT listed in
--     `INTEGRATION_TABLES` (F-47 rotation / F-42 audit skip it).
--
-- Partial index on (status, created_at) WHERE status IN
-- ('pending','in_flight') keeps the flusher's poll query fast even
-- after the table grows — done/dead rows fall out of the index.

CREATE TABLE IF NOT EXISTS crm_outbox (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         TEXT NOT NULL,
  payload            JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  twenty_person_id   TEXT,
  twenty_note_id     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at       TIMESTAMPTZ,
  CONSTRAINT crm_outbox_status_chk
    CHECK (status IN ('pending', 'in_flight', 'done', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_crm_outbox_pending_created
  ON crm_outbox (status, created_at)
  WHERE status IN ('pending', 'in_flight');

COMMENT ON TABLE crm_outbox IS
  'Durable outbox for SaaS CRM (Twenty) lead dispatches. SaasCrm.upsertLead writes a pending row; the Scheduler-backed flusher claims, dispatches, and stamps per-sub-step resource IDs. See packages/api/src/lib/lead-outbox/ (#2729).';

COMMENT ON COLUMN crm_outbox.twenty_person_id IS
  'Twenty Person ID populated after upsertPerson succeeds. On retry, the flusher skips upsertPerson when this is set — guarantees the partial-success crash path cannot create a duplicate Person.';

COMMENT ON COLUMN crm_outbox.twenty_note_id IS
  'Twenty Note ID populated after createNote succeeds. Only set for event_type=''sales-form''; demo/signup leads finish at upsertPerson.';
