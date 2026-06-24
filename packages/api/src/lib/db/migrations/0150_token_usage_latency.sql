-- Migration 0150: token_usage per-turn latency (#3931, demo tracking page).
--
-- The demo tracking page (#3931 scope B) surfaces per-turn latency alongside
-- token + cache spend. Until now the only latency signal was the log-only
-- `activation.first_answer_latency` event (lib/activation-metrics.ts) — nothing
-- durable to aggregate. Persisting it on `token_usage` keeps tokens, cache
-- split (#3099) AND latency on ONE per-turn row, so the rollup is a single
-- scan with no cross-table join.
--
-- The value is the agent-turn wall-clock (runAgent entry → onFinish) in
-- milliseconds, written from the same fire-and-forget INSERT that records the
-- turn's usage. It is a close proxy for `first_answer_latency` minus the demo
-- route's pre-agent overhead (auth, rate-limit, conversation upsert), and is
-- captured uniformly for every surface (demo + chat), not just demo.
--
-- Nullable, no default: rows written before this migration stay NULL (no
-- latency was recorded), and the rollup AVG/aggregates skip NULLs. The INSERT
-- path always supplies a value for rows written after this migration.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS latency_ms integer;

COMMENT ON COLUMN token_usage.latency_ms IS
  'Agent-turn wall-clock latency in milliseconds (runAgent entry → onFinish), written with the turn''s token usage. Nullable; NULL for rows predating #3931. Powers the /platform/demo tracking page latency rollup.';
