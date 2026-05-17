-- 0073 — Add `bound_dashboard_id` to `conversations` (#2363).
--
-- The chat-as-dashboard-editor feature (PRD #2362) opens a chat drawer
-- on `/dashboards/[id]`. Every drawer-open creates a fresh conversation
-- bound to that dashboard so subsequent /api/v1/chat turns:
--
--   1. Know which dashboard the agent is editing (route picks the
--      bound-mode tool registry instead of the default agent loop).
--   2. Surface a per-dashboard history tab (#2368 lists rows where
--      `bound_dashboard_id = $1`).
--
-- The column is nullable — the value is only stamped at creation by
-- the chat route when the request body supplies `boundDashboardId`.
-- Existing rows stay NULL and behave exactly as they did pre-#2363.
--
-- `ON DELETE SET NULL` rather than CASCADE: deleting a dashboard
-- should not erase the audit trail of how it was built. The history
-- tab queries by `bound_dashboard_id`, so a NULLed-out row simply
-- drops off the dashboard's history list — the conversation itself
-- remains visible in the user's main chat sidebar. This mirrors the
-- decision in 0034 / share_token's "preserve the row, scrub the
-- link" handling for soft-deleted parents.
--
-- Index is a plain btree on `bound_dashboard_id` because the only
-- access pattern is "list sessions for THIS dashboard" — the org
-- scoping is already covered by `idx_conversations_org` for any
-- query the API actually runs.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bound_dashboard_id uuid
    REFERENCES dashboards(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_bound_dashboard
  ON conversations (bound_dashboard_id)
  WHERE bound_dashboard_id IS NOT NULL;
