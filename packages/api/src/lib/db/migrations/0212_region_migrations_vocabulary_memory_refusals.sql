-- 0212_region_migrations_vocabulary_memory_refusals.sql
-- #5533 — migration 0204's two columns, twice over, for the two vocabulary-memory
-- tables #5113 put on the bundle.
--
-- 0204 made a refused alias EDGE durable at the source, because the source is the
-- party that cuts over and schedules the cleanup which DELETEs its own rows after
-- CLEANUP_GRACE_PERIOD_DAYS (7) — so it held a COUNT while the record that would
-- let anyone undo it lived in the TARGET region's log retention, outliving the data
-- it describes by only as long as that retention happens to be.
--
-- #5113 then put `brain_vocabulary_proposal` and `brain_predicate_cardinality` on
-- the bundle with three-counter import sections, and both refuse rows BY DESIGN: a
-- decided arriving row that contradicts a decided destination row, plus (cardinality
-- only) an entry whose predicate the destination's post-merge closure aliases onto a
-- different norm. Those refusals shipped as counter + per-row target log ONLY, and
-- the decision was recorded at both `bundle-scope.ts` entries naming this issue.
-- Both tables are `exported`, so `stays` does not apply — but the cleanup sweep
-- deletes the SOURCE's rows for an exported table just the same, which is what makes
-- 0204's argument transfer verbatim rather than merely by analogy.
--
-- These six columns (0204's two, plus four here) are that record, on the source's
-- own migration row.
--
-- ## Why `region_migrations` is still the right home
--
-- Unchanged from 0204: it is classified `platform` in `lib/residency/bundle-scope.ts`
-- — "the migration bookkeeping itself — must survive the migration it describes" —
-- so `runSourceCleanupSweep` never touches it. The payloads therefore outlive the
-- very deletion that makes them the last copy.
--
-- ## Two columns per section, for 0204's reason
--
-- `*_refused` is the COUNT, and it is what the audit events surface. `*_refusals` is
-- the recovery PAYLOAD, capped at VOCABULARY_REFUSAL_DETAIL_CAP entries by the
-- writer. They are not redundant and the count is not derivable from the array's
-- length: the array is capped and an older target answers with a count and no
-- payloads at all, so `jsonb_array_length(x_refusals) < x_refused` is exactly the
-- "some of this is unrecoverable" signal. Collapsing them would make a truncated
-- record indistinguishable from a complete one.
--
-- ## Separate columns per section rather than one merged array
--
-- The three payload shapes differ — an edge carries a slot and an approver, a
-- proposal carries a pair and two statuses, a cardinality carries a key, two values
-- and the destination's own canonical norm — so one array would need a discriminator
-- no region sends. Worse, it would collapse three independent truncation comparisons
-- into one that cannot say WHICH section was truncated, at the moment that is the
-- only question worth answering.
--
-- All four NULL is the state of every row written before this migration, and of
-- every migration that never reached the transfer phase. NULL means UNKNOWN, not
-- zero: a source build that did not ask, or a migration that failed before the
-- target answered. `0` means the target answered and refused nothing.
--
-- ADDITIVE ONLY — no rename, no drop, so the two-phase drop discipline in
-- migrations/README.md does not bite: an N-1 build that never reads or writes these
-- columns is unaffected by their existence.
ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS vocabulary_proposals_refused INTEGER;

ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS vocabulary_proposal_refusals JSONB;

ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS predicate_cardinalities_refused INTEGER;

ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS predicate_cardinality_refusals JSONB;
