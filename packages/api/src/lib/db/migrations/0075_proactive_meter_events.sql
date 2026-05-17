-- 0075 — proactive_meter_events.
--
-- Per-event meter for proactive chat (#2296). Records every lifecycle
-- transition so admin analytics and the eventual billing wiring share
-- one source of truth.
--
-- Five event types tracked end-to-end:
--   - `classify`  — classifier ran (with or without LLM call). `tokens`
--                   carries the model usage when the LLM was invoked,
--                   `0` when the regex prefilter rejected before the LLM.
--   - `react`     — policy decided to interject; reaction emoji applied.
--   - `offer`     — Atlas posted an answer-offer (later slice; reserved).
--   - `accept`    — asker accepted the offer (later slice; reserved).
--   - `feedback`  — thumbs / outcome submitted post-answer.
--
-- Cost stored as `cost_micro_usd` (millionths) so a 6 d.p. fixed-point
-- integer covers the realistic per-classify range without rounding.
-- `0` until the BYOT pricing tables wire in — the column is present now
-- so the schema doesn't have to migrate twice.
--
-- `confidence` is `numeric(3,2)` — the classifier emits values in
-- `[0, 1]` to two decimal places; the column tolerates a leading 0.
-- Nullable because `accept` and `feedback` events have no confidence
-- to record.
--
-- Audit rows (parallel `proactive.classify` / `react` / `answer` /
-- `feedback` `admin_action_log` entries) are intentionally NOT
-- replaced by this table — meter is per-event with cost, audit is the
-- human-readable forensic trail. See `audit/actions.ts` for the
-- action-type rationale.

CREATE TABLE IF NOT EXISTS proactive_meter_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  message_id        TEXT,
  event_type        TEXT NOT NULL,
  outcome           TEXT,
  tokens            INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd    INTEGER NOT NULL DEFAULT 0,
  confidence        NUMERIC(3, 2),
  actor_user_id     TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_proactive_meter_event_type
    CHECK (event_type IN ('classify', 'react', 'offer', 'accept', 'feedback')),
  CONSTRAINT chk_proactive_meter_outcome
    CHECK (outcome IS NULL OR outcome IN ('helpful', 'not-helpful', 'wrong-data', 'no-feedback'))
);

-- Recent-events scan (admin analytics "last 30 days").
CREATE INDEX IF NOT EXISTS idx_proactive_meter_events_workspace_created
  ON proactive_meter_events (workspace_id, created_at DESC);

-- Per-type rollups (classifier-call count, helpful/not-helpful split).
CREATE INDEX IF NOT EXISTS idx_proactive_meter_events_workspace_type_created
  ON proactive_meter_events (workspace_id, event_type, created_at DESC);
