-- 0039 — F-77 per-conversation step ceiling
--
-- Adds an aggregate `total_steps` counter to `conversations`. The chat
-- handler increments it by `result.steps.length` after each agent run
-- and rejects new messages with `conversation_budget_exceeded` once the
-- counter crosses `ATLAS_CONVERSATION_STEP_CAP` (default 500 = 20
-- follow-ups × 25 steps).
--
-- Per-request caps are well-enforced (`stepCountIs(25)` plus the 180s
-- wall-clock budget). What was missing was an aggregate budget across
-- follow-ups on the same conversationId — the context grows
-- monotonically with each message so per-message LLM cost grows roughly
-- linearly. A 50-message × 25-step conversation could consume ~3.75M
-- tokens against platform budget on one conversation, all within plan
-- and abuse limits on a generous tier.
--
-- Default 0 NOT NULL means existing rows backfill via the column
-- default — no separate backfill script (unlike F-41's encryption
-- transition).
--
-- Audit row: .claude/research/security-audit-1-2-3.md F-77
-- Issue: #1848

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS total_steps INTEGER NOT NULL DEFAULT 0;
