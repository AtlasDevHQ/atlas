-- 0079 — Proactive activation announcement idempotency (#2300, PRD #2291).
--
-- Adds a one-shot stamp column so the AnnouncementCoordinator can
-- announce the first time a workspace admin flips
-- `proactive.enabled = true` and ignore every subsequent flip. The
-- column is intentionally a timestamptz (not a boolean) so the audit
-- trail surfaces when the announcement landed; null = never posted.
--
-- Idempotency contract:
--   * NULL                 → AnnouncementCoordinator may post.
--   * NOT NULL             → AnnouncementCoordinator no-ops (even if the
--                            admin disables + re-enables the workspace).
--
-- We deliberately don't clear the stamp on disable: re-announcing every
-- toggle would surface noise in shared channels and erodes trust with
-- end-users who already saw the introduction message.

ALTER TABLE workspace_proactive_config
  ADD COLUMN IF NOT EXISTS announcement_posted_at TIMESTAMPTZ;
