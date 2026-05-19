-- 0084 — proactive_classification_review.
--
-- Per-classify reviewer verdict for the proactive chat layer (#2622).
--
-- 1.5.0 shipped `proactive_meter_events` with per-event confidence /
-- action / reason metadata, but the admin UI at `/admin/proactive-chat`
-- only surfaced aggregate counters. Without a labelling loop, the PRD's
-- <5% misfire / >=70% acceptance bar (PRD #2291) was computable in SQL
-- but invisible to the admin reviewing dogfood traffic.
--
-- This table is the verdict store. Composite key on
-- (workspace_id, message_id) — one verdict per classified message per
-- workspace, idempotent on re-review (the admin changes their mind).
-- We deliberately do NOT FK into `proactive_meter_events`: the meter
-- table holds *all* event types (classify / react / accept / feedback)
-- whereas a review only ever attaches to the classify row; an FK would
-- be a per-row trigger lookup with no integrity benefit. The route
-- layer enforces that the matching classify row exists before insert.
--
-- PRIVACY: this table never stores the raw message text. `message_id`
-- is the chat-platform-side reference; the admin drill-down resolves
-- text by linking out to the chat platform (Slack permalink) instead of
-- mirroring text server-side. Matches the classifier adapter's existing
-- "log only on failure, preview only" posture.

CREATE TABLE IF NOT EXISTS proactive_classification_review (
  workspace_id      TEXT NOT NULL,
  message_id        TEXT NOT NULL,
  verdict           TEXT NOT NULL,
  reviewer_user_id  TEXT,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, message_id),
  CONSTRAINT chk_proactive_classification_review_verdict
    CHECK (verdict IN ('misfire', 'correct', 'unsure'))
);

-- "List labelled verdicts for a workspace ordered by most recent" — the
-- drill-down join uses this to LEFT JOIN per-event verdicts onto the
-- meter rows the page renders.
CREATE INDEX IF NOT EXISTS idx_proactive_classification_review_workspace_created
  ON proactive_classification_review (workspace_id, created_at DESC);
