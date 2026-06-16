-- 0139 — `auto_promoted` flag on learned_patterns (PRD #3617 B-2, #3636).
--
-- The nightly auto-promote/decay job (lib/learn/promote-decay-scheduler.ts)
-- flips qualifying `query_pattern` rows from pending → approved without a human
-- in the loop. The admin UI must distinguish those machine-approved rows from
-- ones a human explicitly approved, and the decay half of the job must only
-- ever demote rows IT promoted (never undo a human approval) — both need a
-- durable marker that survives the status round-trip (approved → pending →
-- approved). `reviewed_by` is free-text and gets overwritten the moment an admin
-- touches the row, so it can't carry that signal; a dedicated boolean can.
--
--   auto_promoted — true once the nightly job promotes the row; stays true
--                   across a later auto-demote (approved → pending) so the row
--                   remains an auto-managed candidate that decay can still act
--                   on. A human approve/reject via the admin route clears it
--                   back to false, re-attributing the row to that human, so a
--                   human-reviewed row never reads as machine-approved and decay
--                   never demotes it out from under the admin.
--
-- Additive-only: one NOT NULL column with a DEFAULT, no constraint changes, no
-- rewrites of existing semantics — ships safely in a single release (only
-- DROP COLUMN / DROP TABLE need the two-phase N / N+1 split). The Drizzle mirror
-- in `db/schema.ts` (`learnedPatterns`) lands in the SAME PR so
-- `check-schema-drift` stays green and the next `drizzle-kit generate` doesn't
-- revert the column.
--
-- learned_patterns is not Better-Auth-managed, so this file does NOT join
-- MANAGED_AUTH_MIGRATIONS (db/internal.ts).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE learned_patterns
  ADD COLUMN IF NOT EXISTS auto_promoted BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN learned_patterns.auto_promoted IS
  'True when the nightly auto-promote/decay job (PRD #3617 B-2) promoted this row from pending → approved. Stays true across a later auto-demote so decay only ever demotes machine-promoted rows, never human approvals.';
