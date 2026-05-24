-- Migration 0094: Add 'telegram' to approval-surface CHECK constraints (#2748).
--
-- Slice 10 of 1.5.3 wires the first non-Slack chat platform end-to-end:
-- the chat plugin's `executeQuery` callback now dispatches Telegram events
-- to the agent loop, and the `botActorUser({ platform: "telegram", ... })`
-- + `approvalSurface: "telegram"` pair stamps approval rows so reviewers
-- can scope rules per chat surface (slack vs telegram vs future Discord).
--
-- This migration extends the two CHECK enums introduced by 0052 to admit
-- 'telegram'. Discord / gchat / WhatsApp (the remaining Phase D static-bot
-- platforms — #2749 / #2754 / #2753) will repeat this pattern as their
-- slices land; landing them piecemeal vs. one giant enum-bump keeps the
-- per-platform PR scope honest.
--
-- Drop-then-add the constraint because Postgres has no `ALTER CHECK` and
-- `IF NOT EXISTS` on `ADD CONSTRAINT` only handles re-runs (it doesn't
-- detect a different constraint body). The drops are NO-OP-safe via
-- `IF EXISTS`.

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS chk_approval_rule_surface;
ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_surface
  CHECK (surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'webhook'));

ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS chk_approval_request_surface;
ALTER TABLE approval_queue
  ADD CONSTRAINT chk_approval_request_surface
  CHECK (surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'webhook'));

COMMENT ON COLUMN approval_rules.surface IS
  'Origin surface this rule applies to. ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts (#2072, telegram added in #2748).';
