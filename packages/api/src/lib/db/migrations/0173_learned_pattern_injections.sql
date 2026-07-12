-- Migration 0173: learned-pattern injection attribution (#4573, v0.0.50).
--
-- Every injection is ATTRIBUTED (CONTEXT.md § Learned query patterns): prompt
-- assembly records which learned-pattern IDs entered which agent turn, as a
-- cheap fire-and-forget INSERT at injection time (resolveOrgKnowledgeSection →
-- recordPatternInjections in db/internal.ts). This substrate makes an approved
-- pattern's usage observable — the cockpit joins a per-pattern injection count
-- so a never-injected approved pattern is diagnosable instead of mysterious.
-- Crediting adapted SQL back to a source pattern and demotion-on-bad-outcome
-- are explicitly DEFERRED (PRD #4570 Out of Scope) until this data exists.
--
-- One row per (pattern, turn) injection. `pattern_id` FKs `learned_patterns(id)`
-- ON DELETE CASCADE, so deleting a pattern (admin delete, or the identity
-- migration's duplicate fold) reaps its attribution rows rather than orphaning
-- them — the cockpit count can never reference a deleted pattern. `org_id` /
-- `connection_group_id` are denormalized from the pattern so workspace-scoped
-- aggregates never need the join; both are TEXT-nullable to mirror
-- `learned_patterns` (a NULL-org/NULL-group legacy pattern attributes with NULL
-- scope, matching how getApprovedPatterns reads it). `conversation_id` /
-- `request_id` name the turn (both nullable — a turn without a conversation, or
-- pre-request-context, still attributes).
--
-- Additive / single-release safe: a fresh CREATE TABLE + indexes, no column
-- drop/rename, no two-phase concern. Idempotent (IF NOT EXISTS). Mirrored in
-- db/schema.ts as `learnedPatternInjections` in the same commit so a later
-- `drizzle-kit generate` can't emit a DROP.

CREATE TABLE IF NOT EXISTS learned_pattern_injections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The injected pattern. CASCADE so a pattern delete reaps its attribution.
  pattern_id           UUID NOT NULL REFERENCES learned_patterns(id) ON DELETE CASCADE,
  -- Workspace scope, denormalized from the pattern (NULL = legacy global scope).
  org_id               TEXT,
  -- Connection group the injecting session ran under (NULL = default flat scope).
  connection_group_id  TEXT,
  -- The turn the injection served (both nullable — best-effort correlation).
  conversation_id      TEXT,
  request_id           TEXT,
  injected_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-pattern count subquery: WHERE pattern_id = $1 AND injected_at >= cutoff.
CREATE INDEX IF NOT EXISTS idx_learned_pattern_injections_pattern
  ON learned_pattern_injections (pattern_id, injected_at DESC);

-- Provisioned ahead of a not-yet-implemented workspace-scoped aggregate over a
-- time window (no current consumer — the cockpit count filters on pattern_id).
CREATE INDEX IF NOT EXISTS idx_learned_pattern_injections_org
  ON learned_pattern_injections (org_id, injected_at DESC);
