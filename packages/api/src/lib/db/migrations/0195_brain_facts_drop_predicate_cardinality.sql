-- expand-contract: phase 2 of #5028. Nothing has read or written brain_facts.predicate_cardinality since v0.2.6, which is live in prod — #5027 stopped the reconcile write, #5035 the region importer's, and #5152 (phase 1b) removed the last two reads (CANDIDATE_COLUMNS and FACT_COLUMNS) plus the published wire field. The N-1 containers draining during this deploy are v0.2.6, so no rolling pod can SELECT this column.
--
-- 0195 — drop brain_facts.predicate_cardinality and its CHECK (#5028 phase 2)
--
-- ## What this removes, and why the value was never worth keeping
--
-- 0180 created the column NOT NULL DEFAULT 'multi'. It was believed unpopulated
-- and was not: `extract.ts` wrote the MODEL's per-claim guess and `correction.ts`
-- inherited it onto every replacement. The publish gate's collision rule then
-- required 'single' on BOTH sides, and the two sides came from two INDEPENDENT
-- model calls against a prompt that says "When unsure answer 'multi'". So
-- supersession fired at roughly P(model says single)^2 — stochastically, on an
-- irreversible operation (a `valid_to` stamp no verb restores).
--
-- ⚠️ THE BACKFILL DISCARDS, IT DOES NOT CARRY. There is deliberately no
-- INSERT INTO brain_predicate_cardinality here. Cardinality is now a property of
-- the canonical PREDICATE, curated by a human and stored in
-- brain_predicate_cardinality (0192, ADR-0037 §3). Seeding that table from these
-- per-row LLM guesses would launder the exact stochastic input #5027 made
-- unrepresentable into the curated decision that replaced it — and it would do so
-- silently, at the one moment nobody is looking. The values die with the column.
--
-- ## Why this is a SEPARATE migration from 0192
--
-- 0192 created the vocabulary table and explicitly declined to drop this column,
-- in its own words: "That column is NOT NULL with a CHECK, and dropping it in the
-- same release that stops writing it is single-phase." That release was v0.2.6.
-- This one is N+1.
--
-- ## Ordering
--
-- The CHECK goes first. Dropping the column would take the constraint with it,
-- but naming both makes the intent auditable and keeps the statement legible to
-- anyone reading the migration rather than the catalog. Both are IF EXISTS so a
-- re-run is a no-op — the runner locks per FILE, not per statement.

ALTER TABLE brain_facts
  DROP CONSTRAINT IF EXISTS chk_brain_facts_predicate_cardinality;

ALTER TABLE brain_facts
  DROP COLUMN IF EXISTS predicate_cardinality;
