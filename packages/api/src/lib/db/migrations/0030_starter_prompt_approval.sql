-- 0029 — Starter-prompt approval queue columns (#1476, PRD #1473)
--
-- Adds the approval + mode columns on query_suggestions and the
-- (suggestion_id, user_id) dedup table that backs distinct-user click
-- counting. See packages/api/src/lib/suggestions/approval-service.ts for
-- the canonical state-matrix explainer and the auto-promote policy.

-- ── Approval + mode columns ───────────────────────────────────────────
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE query_suggestions ADD COLUMN IF NOT EXISTS distinct_user_clicks INTEGER NOT NULL DEFAULT 0;

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
-- per suggestion. first_clicked_at marks the earliest click so the
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
-- Accelerates queries that filter by (org_id, approval_status) and
-- order by last_seen_at — the shape of the admin moderation queue.
CREATE INDEX IF NOT EXISTS idx_query_suggestions_approval_queue
  ON query_suggestions(org_id, approval_status, last_seen_at DESC);
