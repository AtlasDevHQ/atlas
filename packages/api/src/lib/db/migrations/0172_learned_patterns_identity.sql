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
-- exceed Postgres's ~2704-byte btree maximum for a large analytical query —
-- Postgres raises `index row size ... exceeds btree ... maximum`, which errors
-- the fire-and-forget INSERT (the wrapper logs it, then the pattern is dropped:
-- logged, but invisible to the user). Hashing keeps the key fixed-width — the
-- same reason peer query_suggestions indexes normalized_hash and
-- user_favorite_prompts indexes md5(text). Collision risk is ~2^-128; the
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
-- Additive / single-release safe: a one-time fold of pre-existing duplicate
-- rows, then index + CHECKs — no column drop/rename, no two-phase concern. The
-- index/CHECK DDL is idempotent (IF NOT EXISTS / DROP-IF-EXISTS-then-ADD); the
-- dedup fold is a no-op on a table with no duplicates, so a manual re-run is
-- safe. Mirrored in db/schema.ts (chk_learned_patterns_status /
-- chk_learned_patterns_type + a comment for the raw-SQL partial unique index)
-- in the same commit.

-- Pre-dedup: fold any pre-existing duplicate query_pattern rows into one
-- survivor per identity BEFORE creating the unique index, so CREATE UNIQUE
-- INDEX cannot abort the deploy on the very concurrent-race artifact this
-- migration exists to prevent (historical rows predating the ON CONFLICT
-- guarantee). The window PARTITION treats NULL org/group as equal (SQL groups
-- NULLs together in PARTITION BY), matching the index's NULLS NOT DISTINCT.
-- Survivor = a rejected row if the group has one (preserve the sticky admin
-- reject, #3636), else the most-repeated / most-recent. The survivor absorbs
-- the folded rows' repetition_count (w_all is unordered, so its SUM is the
-- full-partition total, not a running sum) and takes the group-max confidence;
-- its source_queries / latency already represent the same normalized SQL. On a
-- clean table with no duplicates both statements match zero rows.
WITH ranked AS (
  SELECT id,
         row_number() OVER w_ord AS rn,
         sum(repetition_count) OVER w_all AS group_total,
         max(confidence) OVER w_all AS group_conf,
         count(*) OVER w_all AS group_size
    FROM learned_patterns
   WHERE type = 'query_pattern'
  WINDOW
    w_ord AS (PARTITION BY org_id, connection_group_id, md5(pattern_sql)
              ORDER BY (status = 'rejected') DESC, repetition_count DESC, updated_at DESC, id DESC),
    w_all AS (PARTITION BY org_id, connection_group_id, md5(pattern_sql))
)
UPDATE learned_patterns lp
   SET repetition_count = r.group_total,
       confidence = r.group_conf,
       updated_at = now()
  FROM ranked r
 WHERE lp.id = r.id AND r.rn = 1 AND r.group_size > 1;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY org_id, connection_group_id, md5(pattern_sql)
           ORDER BY (status = 'rejected') DESC, repetition_count DESC, updated_at DESC, id DESC
         ) AS rn
    FROM learned_patterns
   WHERE type = 'query_pattern'
)
DELETE FROM learned_patterns
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

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
