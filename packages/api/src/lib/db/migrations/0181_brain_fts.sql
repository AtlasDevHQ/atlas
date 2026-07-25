-- 0181 — Brain lexical search: stored generated tsvector columns + GIN
-- indexes on `brain_facts` and `brain_episodes` (#4773, ADR-0036 §Retrieval).
--
-- `searchBrain` is FTS-first (M1). The KB store already has its lexical index
-- (`knowledge_documents.fts`, migration 0167); 0180 gave the two brain tables
-- structure, grants, and a subject lookup index but no text index at all — so
-- without this every lexical read over the substrate is a seq scan that
-- recomputes a tsvector per row, exactly the cost #4222 removed from the KB
-- side.
--
-- Same shape as 0167, and deliberately so: a STORED generated column rather
-- than an expression index, because the planner match is then trivial
-- (`f.fts @@ …`) instead of requiring the code's interpolated expression to
-- stay byte-identical to the index expression forever. `STORED` is
-- load-bearing on Postgres 18, where a bare `GENERATED ALWAYS AS (…)` defaults
-- to VIRTUAL and GIN indexes cannot be built on virtual columns.
--
-- Additive only — no DROP, so the two-phase-drop discipline does not apply.
-- Mirrored in db/schema.ts in the same commit so a later `drizzle-kit
-- generate` cannot emit a DROP.
--
-- Operational note (same as 0167): `ADD COLUMN … STORED` forces a full table
-- rewrite under ACCESS EXCLUSIVE and the GIN build covers the whole corpus
-- (CONCURRENTLY is unavailable — the migration runner wraps each migration in
-- a transaction). The brain tables are new as of 0180, so at the time this
-- ships they are empty or near-empty in every deployment.

-- ---------------------------------------------------------------------------
-- brain_facts.fts — the tier-2 claim vector.
-- ---------------------------------------------------------------------------
--
-- Weighting follows what a retrieval query is actually asking about. Subject
-- and object are the ENTITIES ("who owns Acme", "who is Jane's manager") and
-- both take weight A; the predicate is the relation and takes B, so a claim
-- ABOUT an entity outranks a claim that merely uses the same relation word.
--
-- Predicates are machine-derived and reliably snake_case (`account_owner`,
-- `reports_to`), and NO special handling is needed for that: the default
-- parser emits `_` as a `blank` token, so `to_tsvector('english',
-- 'account_owner')` is `'account':1 'owner':2` — byte-identical to
-- `'account owner'`. Both spellings match through the plain expression.
--
-- An earlier cut of this migration also indexed
-- `replace(predicate, '_', ' ')` on the theory that the parser did not split
-- on `_`. It does. The extra term added no matchability and was not inert: `||`
-- merges a repeated lexeme's ENTRY but concatenates its POSITIONS
-- (`'report':1B,2B`), which inflates `ts_rank` on predicate hits by ~25% and
-- works directly against the A-over-B separation the paragraph above exists to
-- create. Don't re-add it without measuring; `search-pg.test.ts` pins both the
-- snake_case match and the subject-outranks-predicate ordering.
--
-- NOT NULL: every input is coalesced, so the expression is provably never NULL.
ALTER TABLE brain_facts ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(object, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(predicate, '')), 'B')
  ) STORED NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_facts_fts
  ON brain_facts USING gin (fts);

-- ---------------------------------------------------------------------------
-- brain_episodes.fts — the tier-3 evidence vector.
-- ---------------------------------------------------------------------------
--
-- Body XOR locator (0180's CHECK), so exactly one of the two is ever non-empty
-- per row and the coalesce pair costs nothing. The body is the chat text and
-- takes the default body weight D; the locator is a reference
-- (`warehouse://…`, a document path) and takes B so "find the episode behind
-- this reference" resolves ahead of an incidental body mention of the same
-- token.
--
-- `source_actor` is deliberately NOT indexed: it holds opaque source-side
-- principals (`U024BE7LH`), which contribute no matchable language and would
-- dilute ranking on the tokens that do.
ALTER TABLE brain_episodes ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(locator, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'D')
  ) STORED NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brain_episodes_fts
  ON brain_episodes USING gin (fts);
