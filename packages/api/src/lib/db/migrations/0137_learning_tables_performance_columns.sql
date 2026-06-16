-- 0137 — latency/staleness columns on the learning tables (PRD #3617 B-0, #3631).
--
-- Workstream B (Performance-aware Atlas) needs a place to persist query
-- performance on the learning tables so later B slices can rank, decay, and
-- surface patterns by how fast/reliable they actually run:
--
--   learned_patterns:
--     avg_duration_ms  — rolling mean wall-clock of the pattern's executions
--     last_seen_at     — last time the pattern was observed running (staleness)
--     error_count      — how many times executing it errored
--   query_suggestions:
--     avg_duration_ms  — rolling mean wall-clock of the suggestion's runs
--
-- (query_suggestions already carries `last_seen_at`, added with the table, so
-- it only needs the duration column here.)
--
-- Additive-only: nullable columns plus one NOT NULL DEFAULT 0 counter — no
-- constraint changes, no rewrites of existing semantics. Under the
-- two-phase-drop discipline only DROP COLUMN / DROP TABLE need the N / N+1
-- split, so this ships safely in a single release. The Drizzle mirror in
-- `db/schema.ts` (`learnedPatterns` / `querySuggestions`) lands in the SAME PR
-- so `check-schema-drift` stays green and the next `drizzle-kit generate`
-- doesn't revert these columns.
--
-- Neither table is Better-Auth-managed, so this file does NOT join
-- MANAGED_AUTH_MIGRATIONS (db/internal.ts).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE learned_patterns
  ADD COLUMN IF NOT EXISTS avg_duration_ms DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN learned_patterns.avg_duration_ms IS
  'Rolling mean wall-clock (ms) of the pattern''s executions. NULL until first observed. PRD #3617 B-0.';
COMMENT ON COLUMN learned_patterns.last_seen_at IS
  'Last time the pattern was observed running (staleness signal). NULL until first observed. PRD #3617 B-0.';
COMMENT ON COLUMN learned_patterns.error_count IS
  'Count of executions of this pattern that errored. PRD #3617 B-0.';

ALTER TABLE query_suggestions
  ADD COLUMN IF NOT EXISTS avg_duration_ms DOUBLE PRECISION;

COMMENT ON COLUMN query_suggestions.avg_duration_ms IS
  'Rolling mean wall-clock (ms) of the suggestion''s runs. NULL until first observed. PRD #3617 B-0.';
