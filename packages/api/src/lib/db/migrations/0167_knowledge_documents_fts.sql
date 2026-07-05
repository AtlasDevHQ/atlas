-- 0167: knowledge_documents.fts — stored generated tsvector column + GIN
-- index for the searchKnowledge lexical tier (#4222, scale follow-up to
-- #4210 / ADR-0028 §5).
--
-- The lexical FTS tier previously computed the tsvector on the fly in both
-- the `@@` match predicate and the `ts_rank` expression, seq-scanning every
-- row passing the (workspace_id, status) filter and recomputing the vector
-- over the full markdown body per row. This materializes the vector once
-- per row and lets lexical queries take the GIN bitmap path.
--
-- A stored generated column beats a bare expression index: the planner
-- match is trivial (`kd.fts @@ ...`) instead of requiring the code's
-- interpolated expression to stay byte-identical to the index expression
-- forever. `STORED` is load-bearing on Postgres 18: a bare
-- `GENERATED ALWAYS AS (...)` defaults to VIRTUAL there, and GIN indexes
-- cannot be built on virtual columns.
--
-- Field weighting is folded in while the column is being built (one table
-- rewrite instead of two): title A, description B, body D. Lexemes from an
-- unweighted to_tsvector already default to D, so body ranking is
-- unchanged — title/description hits now win ties, resolving the
-- unweighted-ranking limitation flagged at the old TS_VECTOR definition.
-- Both to_tsvector('english', ...) (explicit regconfig) and setweight()
-- are immutable, so the expression is legal in a generated column.
--
-- Operational note: ADD COLUMN ... STORED forces a full table rewrite
-- under an ACCESS EXCLUSIVE lock, and the CREATE INDEX builds over the
-- whole corpus (CONCURRENTLY is not an option — the migration runner
-- wraps every migration in a transaction). Fine at the designed scale;
-- if this ships after a workspace has grown into the trigger condition
-- (thousands of documents), expect the boot migration to hold the lock
-- for the duration of the rewrite.
--
-- Additive only — no DROP, so no two-phase-drop discipline applies.
-- Mirrored in db/schema.ts (same commit) so a later `drizzle-kit
-- generate` can't emit a DROP.

-- NOT NULL: every input is coalesced, so the expression is provably never
-- NULL — declare the invariant rather than implying it.
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'D')
  ) STORED NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_fts
  ON knowledge_documents USING gin (fts);
