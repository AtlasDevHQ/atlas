-- Migration 0172: DB-enforced learned-pattern identity (#4572, v0.0.50).
--
-- Pattern identity — (org_id, connection_group_id, normalized SQL) per
-- CONTEXT.md § Learned query patterns — becomes DB-enforced for query_pattern
-- rows via a PARTIAL UNIQUE INDEX. The fire-and-forget proposer inserts via
-- ON CONFLICT (see insertLearnedPattern in db/internal.ts), so a concurrent
-- duplicate observation that slips past the application-side read-then-insert
-- dedup (findPatternBySQL) becomes exactly the repetition increment it should
-- have been. The read is now a fast path; this index is the guarantee.
--
-- PARTIAL on `type = 'query_pattern'`: only query patterns have this identity.
-- `semantic_amendment` rows are a review queue — many proposals may target the
-- same entity/scope — so they must stay unconstrained by this index.
--
-- Indexed on md5(pattern_sql), NOT pattern_sql directly: a normalized query has
-- no length cap (normalizeSQL), and a btree index tuple over the raw text would
-- exceed Postgres's ~2704-byte btree maximum for a large analytical query,
-- silently dropping the fire-and-forget INSERT. Hashing keeps the key
-- fixed-width — the same reason peer query_suggestions indexes normalized_hash
-- and user_favorite_prompts indexes md5(text). Collision risk is ~2^-128; the
-- application fast path (findPatternBySQL) still matches on exact pattern_sql.
--
-- NULLS NOT DISTINCT (PG15+; we run PG16 everywhere): the legacy/default scope
-- carries org_id = NULL (global) and/or connection_group_id = NULL (the flat
-- entities/ group). Without NULLS NOT DISTINCT, Postgres treats each NULL as
-- distinct, so two NULL-scope rows with identical SQL would MULTIPLY rather than
-- collide. NULLS NOT DISTINCT makes those NULLs equal, so the index dedups them
-- — matching findPatternBySQL's `IS NULL` scope match. Peer query_suggestions
-- (0000_baseline) already relies on the same construct.
--
-- status / type CHECK constraints ride the same migration — peer status tables
-- (query_suggestions, dashboard_stage_changes, workspace_proactive_config)
-- already carry equivalents. `applying` is included in the status set even
-- though it is NOT a wire status (LEARNED_PATTERN_STATUSES omits it): it is the
-- transient claim state the amendment decide seam writes
-- (pending → applying → approved|pending, #4506). Omitting it would make the
-- claim UPDATE violate the CHECK.
--
-- Additive / single-release safe: index + CHECKs only — no column drop/rename,
-- no two-phase concern. Idempotent (IF NOT EXISTS / DROP-IF-EXISTS-then-ADD).
-- Mirrored in db/schema.ts (chk_learned_patterns_status /
-- chk_learned_patterns_type + a comment for the raw-SQL partial unique index)
-- in the same commit.

CREATE UNIQUE INDEX IF NOT EXISTS uq_learned_patterns_identity
  ON learned_patterns (org_id, connection_group_id, md5(pattern_sql))
  NULLS NOT DISTINCT
  WHERE type = 'query_pattern';

ALTER TABLE learned_patterns
  DROP CONSTRAINT IF EXISTS chk_learned_patterns_status;
ALTER TABLE learned_patterns
  ADD CONSTRAINT chk_learned_patterns_status
  CHECK (status IN ('pending', 'applying', 'approved', 'rejected'));

ALTER TABLE learned_patterns
  DROP CONSTRAINT IF EXISTS chk_learned_patterns_type;
ALTER TABLE learned_patterns
  ADD CONSTRAINT chk_learned_patterns_type
  CHECK (type IN ('query_pattern', 'semantic_amendment'));
