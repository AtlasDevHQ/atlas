-- 0143: agent_runs — durable agent-session checkpoint store (#3745, ADR-0020).
--
-- Phase 1a of the durable-agent-sessions epic (#3742): the minimal end-to-end
-- checkpoint pipe. A *run* is one user turn. For now a turn writes exactly ONE
-- terminal row at completion — `done` on a clean finish, `failed` on an
-- uncaught error — establishing the persistence seam before per-step
-- granularity (`running`) and resume (`parked` + `resuming_lease`) land in
-- later slices. The `running`/`parked` statuses and the `resuming_lease`
-- column are defined now (the schema is the contract) but not yet written.
--
-- The write rides the existing fire-and-forget `internalExecute` circuit
-- breaker (shared with token_usage / audit), so a persistence failure is
-- logged and never disrupts the live stream (ADR-0020 "checkpointing never
-- disrupts the stream"). Durability is gated by a settings flag (default OFF)
-- and degrades to today's behavior when no internal DB is present.
--
-- CONTENT-MODE EXEMPT: agent_runs is execution state (the in-flight turn's
-- transcript + status), not user-surfaced content. It deliberately omits the
-- draft/published `status` column and ContentModeRegistry filtering that
-- user-facing tables carry — there is nothing to publish. The `status` column
-- here is the run lifecycle (running/parked/done/failed), unrelated to content
-- mode. See docs/development/content-mode.md and ADR-0020.
--
-- Drizzle-managed (mirrored in db/schema.ts as `agentRuns`, same commit).
-- Additive CREATE only — no DROP, so no two-phase-drop discipline applies; the
-- mirror lands in the same commit so a later `drizzle-kit generate` can't emit
-- a DROP. `conversation_id` FKs `conversations(id)` ON DELETE CASCADE: a run
-- belongs to a conversation and is meaningless once the conversation is gone.
-- `org_id` is the Better-Auth organization id (TEXT, no FK — `organization` is
-- not a Drizzle table, matching conversations / settings / the other
-- org-scoped Atlas tables).

CREATE TABLE IF NOT EXISTS agent_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  step_index      INTEGER NOT NULL DEFAULT 0,
  transcript      JSONB NOT NULL,
  parked_reason   TEXT,
  resuming_lease  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_runs_status CHECK (status IN ('running', 'parked', 'done', 'failed'))
);

COMMENT ON TABLE agent_runs IS
  'Durable agent-session checkpoints (ADR-0020). Execution state, not user-surfaced content — content-mode-exempt (no draft/published status column). status is the run lifecycle: running/parked/done/failed.';

-- Per-conversation lookups (a conversation''s runs) and per-tenant scans.
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_org ON agent_runs (org_id);

-- Non-terminal runs are the working set for resume + the park reaper: a small,
-- hot slice of a table dominated by terminal (done/failed) rows awaiting the
-- retention sweep. A partial index keeps that scan cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_agent_runs_active ON agent_runs (status)
  WHERE status IN ('running', 'parked');
