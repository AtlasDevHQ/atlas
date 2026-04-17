-- 0029 — Starter-prompt approval queue columns (#1476, PRD #1473)
--
-- Introduces the orthogonal state matrix for starter-prompt moderation:
--   approval_status: pending | approved | hidden   — moderation lifecycle
--   status:          draft   | published | archived — 1.2.0 mode participation
-- The axes are independent: an approved prompt may be `draft` (awaiting
-- publish) or `published`. See packages/api/src/lib/suggestions/approval-service.ts
-- for the state-matrix explainer.
--
-- `distinct_user_clicks` backs the auto-promote threshold (default 3,
-- configurable via ATLAS_STARTER_PROMPT_AUTO_PROMOTE_CLICKS) over the cold
-- window (default 90 days, ATLAS_STARTER_PROMPT_COLD_WINDOW_DAYS). Unique
-- user clicks are recorded in suggestion_user_clicks so the counter is
-- idempotent across repeat clicks from the same user.

-- ── Approval + mode columns ───────────────────────────────────────────
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS distinct_user_clicks INTEGER NOT NULL DEFAULT 0;

-- Explicit backfill for safety (column DEFAULT handles new rows and most
-- drivers, but some ALTER TABLE paths leave pre-existing rows as NULL
-- briefly — this ensures the acceptance-criteria defaults are guaranteed).
UPDATE query_suggestions SET approval_status = 'pending' WHERE approval_status IS NULL;
UPDATE query_suggestions SET status = 'draft' WHERE status IS NULL;
UPDATE query_suggestions SET distinct_user_clicks = 0 WHERE distinct_user_clicks IS NULL;

-- ── Check constraints ────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE query_suggestions ADD CONSTRAINT chk_query_suggestions_approval_status
    CHECK (approval_status IN ('pending', 'approved', 'hidden'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE query_suggestions ADD CONSTRAINT chk_query_suggestions_status
    CHECK (status IN ('draft', 'published', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Unique-click tracking ─────────────────────────────────────────────
-- (suggestion_id, user_id) PK guarantees each user counts at most once
-- per suggestion — first-clicked-at marks the earliest click so the
-- window check considers the user's first engagement, not their latest.
CREATE TABLE IF NOT EXISTS suggestion_user_clicks (
  suggestion_id UUID NOT NULL REFERENCES query_suggestions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  first_clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (suggestion_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_suggestion_user_clicks_suggestion_clicked
  ON suggestion_user_clicks(suggestion_id, first_clicked_at DESC);

-- ── Queue lookup index ───────────────────────────────────────────────
-- Accelerates GET /admin/starter-prompts/queue which filters by
-- (org_id, approval_status) and orders by last_seen_at.
CREATE INDEX IF NOT EXISTS idx_query_suggestions_approval_queue
  ON query_suggestions(org_id, approval_status, last_seen_at DESC);
