-- 0187 — Claim identity: the slot key columns, the day-one backfill, and the
-- repointed slot index (#5019, ADR-0037 §"The identity key" / §"Migration").
--
-- A brain claim's identity is `alias(lexicalNorm(surface))`. `alias` is the
-- curated workspace vocabulary and does not exist yet, so on day one it is the
-- identity function and every key is exactly `lexicalNorm(surface)` — which is
-- why this migration is a pure `UPDATE` and why the slice it belongs to is
-- expected to change no observable behaviour whatsoever.
--
-- Shaped on `0092_pillar_install_id_columns.sql:55-79` — the repo's `ADD COLUMN`
-- nullable → `UPDATE` → (eventually) `SET NOT NULL` precedent. Deliberately NOT
-- `0169_convert_notebook_conversations.sql`, which an earlier draft of this cut
-- named: 0169 is data-only and its own header states that no DDL runs there.
--
-- ## The columns land NULLABLE, and `SET NOT NULL` is #5020's
--
-- Both existing INSERT sites use an explicit column list and name none of these
-- columns — `reconcile.ts`'s `INSERT_FACT_SQL` (owned by #5020) and
-- `admin-migrate.ts`'s 18-column region-import INSERT (owned by #5035). A
-- `NOT NULL` here would therefore make every brain-fact write and every region
-- import raise a not-null violation on the first row. The two repairs that look
-- obvious are both worse than waiting: a `DEFAULT ''` silently corrupts the
-- corpus (every unkeyed row joins every other unkeyed row), and re-deriving the
-- key at the importer pre-empts #5035's still-open decision about whether keys
-- travel verbatim — the irreversible direction. So the constraint arrives with
-- its writer, in #5020, and until then a NULL key means "no writer has keyed
-- this row yet" and joins nothing.
--
-- ## The backfill is unscoped by `status`, and covers every row
--
-- Unscoped is not merely simpler. `scripts/check-brain-fact-promotion.sh`
-- matches per statement on `UPDATE …brain_facts… SET …` plus any mention of
-- `status`, and its header names this exact case: a backfill that FILTERS on
-- status needs an allowlist entry WITH a rationale. A status-unaware backfill
-- needs no carve-out and has no reason to be status-aware — a draft and a
-- published fact have identical identity.
--
-- Tombstoned (`invalidated_at IS NOT NULL`) and superseded (`valid_to IS NOT
-- NULL`) rows are keyed too, and that is the load-bearing half rather than
-- completeness for its own sake. Alias REMOVAL is the one vocabulary operation
-- that is not a rewrite — once two spellings share a key, nothing in the key
-- column tells them apart again — so re-deriving from the retained surface form
-- is the only way back. A corpus whose history is unkeyed has that undo working
-- for live rows and silently broken for everything else.
--
-- ## `updated_at` is deliberately NOT stamped
--
-- Every other `UPDATE` in the brain-facts module stamps it, so this is a
-- documented exception with no mechanical guard behind it. `updated_at` is the
-- sort key of the publish preview (`content-mode/adapters/brain-facts.ts`'s
-- `ORDER BY f.updated_at DESC`) and is projected on the wire by the candidates
-- read. A workspace-wide stamp would reshuffle every reviewer's draft queue into
-- backfill order. The principle: `updated_at` means this claim's CONTENT or
-- REVIEW STATE moved, and a key recomputation moved neither. Staleness is
-- unaffected — `computeDecaySignal` anchors on `last_observed_at` →
-- `valid_from` → `ingested_at` only. Pinned by `identity-pg.test.ts`.
--
-- ## The FTS vector is untouched
--
-- `brain_facts.fts` keeps reading the SURFACE columns, not the keys (0181).
-- Retrieval wants what people said; identity wants what they meant, and coupling
-- them would let a vocabulary edit silently re-rank `searchBrain`. Note the two
-- normalizations disagree on purpose: 0181's header records that the FTS parser
-- emits `_` as a blank so `account_owner` and `account owner` already tokenize
-- alike, which is the same unification this migration performs — arrived at
-- independently, for a different consumer, and kept separate so either can move
-- without the other.
--
-- ## Scale
--
-- Two full-table passes under the migration runner's advisory lock: the
-- `UPDATE` rewrites every row of `brain_facts`, and the index is rebuilt (the
-- runner wraps each file in one transaction, so CONCURRENTLY is unavailable).
-- The brain substrate landed in 0180 and holds a four-figure corpus at its
-- largest deployment today, so this is a sub-second hold — but it grows
-- linearly, and a future re-key at corpus scale is the drift path (in
-- TypeScript, inside the alias-approval transaction), not another migration.

ALTER TABLE brain_facts ADD COLUMN IF NOT EXISTS subject_key TEXT;
ALTER TABLE brain_facts ADD COLUMN IF NOT EXISTS predicate_key TEXT;
ALTER TABLE brain_facts ADD COLUMN IF NOT EXISTS object_key TEXT;

-- The SQL twin of `lib/brain/identity.ts`'s `lexicalNorm`: case-fold, unify
-- separators (`_`, `-`, and ASCII whitespace) into a single space, collapse
-- runs, trim. Nothing else — no stemming, no lemmatisation, no stopword or
-- copula stripping. The corpus carries `led_by` AND `leads`, which are INVERSE
-- relations; any stemmer collapses them into one slot, and over-matching a join
-- arm is what stamps `valid_to` on a belief nobody arbitrated.
--
-- The separator class is spelled out rather than written `[[:space:]]`, which
-- consults the database locale above ASCII while JavaScript's `\s` does not —
-- the two implementations have to agree on bytes, not on a collation. `-` sits
-- last in the bracket so it reads as a literal instead of opening a range, and
-- `btrim`'s second argument is given for the same reason (its default set is
-- spaces only, but saying so keeps it from drifting with a default).
--
-- `translate()` AND NOT `lower()`, which is the surprising line here and the one
-- most likely to be "simplified" back. `lower()` and JavaScript's
-- `String#toLowerCase()` are not the same function, measured on this repo's own
-- `postgres:16-alpine`: `İstanbul` (U+0130) lowers to `istanbul` here and to
-- `i` + U+0307 there, and `ΣΊΣΥΦΟΣ` lowers with a plain final sigma here and a
-- word-final `ς` there. Postgres's answer additionally moves with the database
-- collation, which is exactly the region-to-region divergence ADR-0037 §8's
-- determinism pin forbids. So both sides fold `A`–`Z` and nothing else, and
-- `Café`/`CAFÉ` deliberately do not norm together — an under-match, which costs
-- a duplicate row and is repaired by a vocabulary entry, versus keys two
-- regions compute differently, which nothing surfaces.
--
-- `WHERE … IS NULL` makes the statement re-runnable rather than scoping it: on
-- day one every row matches. It is `identity-pg.test.ts`'s handle for running
-- this file against seeded rows and comparing the result to the TypeScript
-- function row by row, which is what pins the two implementations together.
UPDATE brain_facts
   SET subject_key   = btrim(regexp_replace(translate(subject,   'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ \t\n\v\f\r_-]+', ' ', 'g'), ' '),
       predicate_key = btrim(regexp_replace(translate(predicate, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ \t\n\v\f\r_-]+', ' ', 'g'), ' '),
       object_key    = btrim(regexp_replace(translate(object,    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ \t\n\v\f\r_-]+', ' ', 'g'), ' ')
-- Parenthesized deliberately. The three arms are all `OR`, so the group is
-- redundant TODAY — it is here because `AND` binds tighter than `OR`, and the
-- one edit this statement must never silently accept is a fourth arm that
-- scopes it (`WHERE status = 'published' AND subject_key IS NULL OR …` reads as
-- unscoped and is not). Found while mutation-testing this migration: that exact
-- shape passed every assertion in `identity-pg.test.ts`.
 WHERE (subject_key IS NULL
     OR predicate_key IS NULL
     OR object_key IS NULL);

-- The slot index is REPOINTED, not duplicated — zero net new indexes.
--
-- 0180 created it on `(workspace_id, subject, predicate) WHERE invalidated_at
-- IS NULL` and called it "the retrieval read (#4773)". That description was
-- already stale: retrieval rides `idx_brain_facts_fts` (GIN), and a repo-wide
-- grep finds no other equality reader of `subject` — `candidates.ts` searches
-- with a leading-wildcard `ILIKE`, which a btree cannot serve. It is the SLOT
-- index and nothing else, so moving it onto the slot's new columns costs no
-- reader an access path it had a claim to.
--
-- Tightening the partial predicate is free in the same way: all three slot
-- consumers (the corroboration lookup, the tension-candidate scan, and the
-- supersession collision join) already require `valid_to IS NULL`, each for its
-- own recorded reason. The index gets strictly smaller and more selective.
--
-- ONE honest cost, for one slice. Those three consumers still join on the
-- SURFACE columns until #5020 pivots them onto the keys, so between this
-- migration and that one they fall back to a sequential scan over a workspace's
-- live facts. That is a deliberate trade against carrying two indexes through
-- the cut, and it is bounded by the corpus size noted above. An N-1 pod during
-- the deploy overlap sees the same thing — a slower plan, never an error, so
-- the two-phase discipline that governs `DROP COLUMN` does not apply here.
DROP INDEX IF EXISTS idx_brain_facts_subject;

CREATE INDEX IF NOT EXISTS idx_brain_facts_subject
  ON brain_facts (workspace_id, subject_key, predicate_key)
  WHERE invalidated_at IS NULL AND valid_to IS NULL;
