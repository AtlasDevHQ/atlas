-- 0146: agent_runs parked⟺parked_reason invariant (#3748, ADR-0020).
--
-- Approval-park (phase 3) suspends a turn as `status = 'parked'` with the
-- approval-queue request id in `parked_reason`. That column is the ONLY link
-- from a queue decision back to the suspended turn (the two tables are decoupled
-- at the schema level), so a `parked` row with a NULL `parked_reason` is an
-- un-resolvable zombie: no reviewer decision could ever find and re-arm it.
--
-- The application write path always stamps a reason (recordParkedAgentRun's arg
-- is required), but that invariant lived only in TypeScript + WHERE clauses. This
-- CHECK makes it unrepresentable at the source of truth: a parked row MUST carry
-- a reason; non-parked rows (running/done/failed) may not (resolution + the
-- sweep both clear it back to NULL when leaving `parked`). One-line backstop, no
-- behavior change for correct writers.
--
-- Safe to add: approval-park is introduced in this same epic, so no deployed
-- code path has ever written a `parked` row without a reason — there are no
-- pre-existing rows that could violate the constraint. Drop-then-add for
-- idempotency (Postgres has no ADD CONSTRAINT IF NOT EXISTS); the migration is
-- recorded in __atlas_migrations so it runs exactly once regardless.
--
-- Plain DDL on the Atlas-internal `agent_runs` table (NOT Better-Auth-managed) —
-- it runs in every auth mode and is NOT added to MANAGED_AUTH_MIGRATIONS. The
-- db/schema.ts mirror lands in the same commit (check-schema-drift.sh).

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS chk_agent_runs_parked_reason;

ALTER TABLE agent_runs
  ADD CONSTRAINT chk_agent_runs_parked_reason
    CHECK (status <> 'parked' OR parked_reason IS NOT NULL);
