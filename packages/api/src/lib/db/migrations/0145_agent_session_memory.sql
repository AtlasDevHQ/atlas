-- 0145: agent_session_memory — durable per-session working memory (#3754, ADR-0020).
--
-- Slice 1 of the durable-working-memory workstream (PRD #3752): a typed, named
-- per-SESSION memory store the agent loop + tools read and update through a
-- `DurableState` handle. A "session" is a conversation (NOT a single turn): a
-- slot written in one turn is readable in the next, and after a crash/resume —
-- so the key is `conversation_id`, not the per-turn `agent_runs.id`. One row per
-- (session, named slot).
--
-- Persistence rides the SAME fire-and-forget `internalExecute` circuit breaker
-- as the agent_runs checkpoint + token_usage writes (ADR-0020 "checkpointing
-- never disrupts the stream"): a commit failure is logged and never disrupts the
-- live stream. Memory is gated by the durability settings flag (default OFF) and
-- degrades to a Noop store when no internal DB is present — behavior identical to
-- today.
--
-- CONTENT-MODE EXEMPT: like agent_runs, this is execution state (an in-flight
-- agent's scratch memory), not user-surfaced content — no draft/published
-- `status` column or ContentModeRegistry filtering. See
-- docs/development/content-mode.md and ADR-0020.
--
-- Drizzle-managed (mirrored in db/schema.ts as `agentSessionMemory`, same
-- commit). Additive CREATE only — no DROP, so no two-phase-drop discipline
-- applies; the mirror lands in the same commit so a later `drizzle-kit generate`
-- can't emit a DROP. `conversation_id` FKs `conversations(id)` ON DELETE CASCADE:
-- a session's memory is meaningless once the conversation is gone. `org_id` is
-- the Better-Auth organization id (TEXT, no FK — `organization` is not a Drizzle
-- table, matching conversations / agent_runs / the other org-scoped tables); it
-- is the tenant scope later slices (#3756 isolation, #3757 bounds) enforce on.

CREATE TABLE IF NOT EXISTS agent_session_memory (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          TEXT,
  namespace       TEXT NOT NULL,
  value           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, namespace)
);

COMMENT ON TABLE agent_session_memory IS
  'Durable per-session agent working memory (ADR-0020, #3754). Execution state keyed on conversation (the session), not a single turn — content-mode-exempt. One row per (conversation_id, namespace) named slot.';

-- Per-tenant scans for the future bounds/sweep + isolation slices (#3757/#3756).
-- Per-conversation lookups (the hot path: load a session's slots at turn start)
-- are already served by the leading column of the composite primary key.
CREATE INDEX IF NOT EXISTS idx_agent_session_memory_org ON agent_session_memory (org_id);
