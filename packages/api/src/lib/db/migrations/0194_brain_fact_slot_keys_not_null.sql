-- 0194 — Claim identity, step three and last: the slot keys become TOTAL
-- (#5047, ADR-0037 §1 "The identity key" / §7 "Migration").
--
-- 0187 added `subject_key` / `predicate_key` / `object_key` nullable and keyed
-- every row that existed. 0188 repeated that backfill for the rows written in
-- the window before #5020 keyed `INSERT_FACT_SQL`. This file makes a NULL key
-- impossible, which is what makes a NULL key mean ONE thing again — or rather,
-- nothing at all.
--
-- ⚠️ READ 0187's header before this one. It enumerates the three prerequisites
-- of `SET NOT NULL` and it is deliberately more careful than any summary of it.
-- All three are in place as of this migration's own PR:
--
--   1. **Both writers key their rows.** #5020 keyed `INSERT_FACT_SQL`; #5035
--      carries keys verbatim on a v3 region bundle and keys a legacy v1/v2
--      bundle once at import.
--   2. **The backfill is re-run immediately before the constraint** — below,
--      and see "Why the re-run is not 0188's statement" for the two caveats
--      0187 attached to that repeat, both of which have gone live since.
--   3. **The ingest guard is tightened.** `reconcile.ts`'s `MALFORMED_CLAIM`
--      now refuses a candidate whose `slotKey` is null, post-resolution. Without
--      it this constraint would not merely fail on legacy rows: `String#trim`
--      strips whitespace but not `_` or `-`, so `-` and `___` are STORABLE
--      claims today, and an ordinary ingest would start raising `23502` and
--      failing the whole reconcile transaction.
--
-- ## The three populations, and why only one of them needed a decision
--
-- After 0188, a NULL key has exactly three causes, and they are not one problem:
--
--   * **Written in a gap.** A rolling deploy's own overlap re-opens the window
--     each backfill closes: the migration commits on the new instance while the
--     N-1 instance's extraction fiber is still writing through the old
--     `INSERT_FACT_SQL`. 0188's header names this and says the constraint flip's
--     own backfill re-run is what sweeps the residue. That is the `UPDATE`s
--     below.
--   * **Landed by a region import.** #5035 closed the systematic case. What can
--     still arrive is a null on the wire, and `admin-migrate.ts` now splits it by
--     the SURFACE: a fact whose surface also normalizes away is tombstoned on this
--     file's terms, while one whose surface keys perfectly well REFUSES the import
--     — that row is repairable by the next drift re-key, and both ways of landing
--     it (tombstoning a healthy belief, or re-deriving its key under this region's
--     vocabulary) are irreversible.
--   * **A surface that normalizes away.** `-`, `___`, `  ` key to NULL
--     permanently and LEGALLY (`identityKey`'s ⚠️, and 0188's "What this does
--     NOT fix"). No backfill has ever been able to repair these — 0187 and 0188
--     both re-visit them on every run and both write the same NULL — because
--     there is no key to compute. They are the only population that needed a
--     policy, and the section below is it.
--
-- ## The reverse deploy-overlap window, which this migration OPENS
--
-- The first bullet above covers an N-1 instance writing UNKEYED rows BEFORE the
-- constraint. The reverse is worth stating because it is the one an operator
-- sees: once this file commits on the new instance, an N-1 instance — which has
-- #5020's keyed `INSERT_FACT_SQL` but NOT #5047's tightened guard — that ingests
-- `-` or `___` binds NULL and takes a `23502`, failing the WHOLE reconcile
-- transaction, i.e. every candidate in that episode rather than the one offender.
-- On the `correct_fact` path it surfaces as a 500.
--
-- Bounded and self-healing: the episode stays on the queue and is retried, and
-- the window closes when the rollout completes. Recorded so `23502` spikes during
-- a deploy read as expected rather than as a new defect.
--
-- ## Why the re-run is not 0188's statement, character for character
--
-- 0188 IS 0187's statement character for character, and `migrate.test.ts`
-- asserts that byte-identity. This file breaks that lineage deliberately, on
-- both of the caveats 0187 attached to the repeat — each of which was inert when
-- 0188 shipped and is live now.
--
--   1. **It is no longer a PRE-VOCABULARY operation.** 0187's caveat: *"This
--      statement writes the raw `identityKey(surface)`, so once `alias` is a real
--      table, re-running it OVERWRITES aliased keys on every row it matches."*
--      `alias` became a real table with #5022 (migration 0189,
--      `brain_vocabulary_target`). Two consequences, and the fix for each is
--      below:
--        * The value written must be `alias(lexicalNorm(surface))`, not
--          `lexicalNorm(surface)`. A row keyed with the raw norm sits in a
--          DIFFERENT slot from every sibling the vocabulary unified, which is an
--          under-match nothing surfaces. So the statements below join
--          `brain_vocabulary_target` and are transcriptions of
--          `REKEY_DRIFTED_FACTS_SQL` (`lib/brain/vocabulary-decide.ts`, #5024),
--          which is itself the SQL transcription of `slotKey`.
--        * The statement must touch ONE column per statement. 0187 and 0188 are
--          a single `UPDATE` setting all three keys `WHERE (subject_key IS NULL
--          OR predicate_key IS NULL OR object_key IS NULL)`, so a row unkeyed at
--          ONE position has its other two keys rewritten as well. Pre-vocabulary
--          that is a no-op; post-vocabulary it silently reverts two aliased keys
--          to raw norms. Hence three statements, each scoped to its own column.
--      This is a KEYING operation and not a re-keying one, and the per-column
--      `IS NULL` scope is what keeps that true — which matters because ADR-0037
--      §7 puts re-keying in the decide transaction, in TypeScript, and
--      `check-brain-fact-promotion.sh`'s identity remedy block says so by name.
--      A row that already has a key is not touched here at any position.
--   2. **`subject_key IS NULL` already means two things.** So the count of rows
--      this migration must repair is NOT `WHERE subject_key IS NULL` — that set
--      includes the permanently-degenerate rows, which no `UPDATE` repairs.
--      Wherever this file needs to distinguish them it compares against the
--      EXPRESSION, never against the column: a row is repairable exactly when
--      the expression is NOT NULL and the column is, and permanently unkeyable
--      exactly when the expression is NULL. The two statements below are written
--      in those terms rather than in the column's.
--
-- ## The degenerate population: TOMBSTONED, with a per-row placeholder key
--
-- A claim whose surface normalizes away asserts nothing. That is the argument
-- the tightened `MALFORMED_CLAIM` guard now makes at ingest, and it is as true
-- of a row written last year as of a candidate arriving now. The rows already in
-- the corpus cannot be refused retroactively, so this migration does the nearest
-- honest thing: it marks them as not-beliefs and leaves everything else intact.
--
--   * **`invalidated_at` — the tombstone, and the load-bearing half.** 0180 calls
--     it exactly that, and `schema.ts` states the corpus invariant as
--     *"invalidate-never-delete. Nothing DELETEs."* — so deleting these rows was
--     never on the table, whatever their content. The tombstone is also what
--     makes the placeholder below SAFE rather than merely legal: all three slot
--     consumers (`CORROBORATION_LOOKUP_SQL`, `TENSION_CANDIDATES_SQL`,
--     `supersessionCollisionJoin`) require `invalidated_at IS NULL AND valid_to
--     IS NULL`, so a tombstoned row is outside every join by the tombstone and
--     not by its key. Its behaviour is therefore what it was — it joined nothing
--     before, it joins nothing now.
--   * **The placeholder is PER-ROW, and that is the whole difference from the
--     sentinel 0187 rejects.** That header rejects a sentinel key as *"the
--     one-slot-for-every-placeholder hazard"* — a SHARED value under which every
--     degenerate row joins every other one, so publishing either stamps
--     `valid_to` on the other. `'-unkeyable:' || id` is unique per row, so the
--     hazard it names cannot arise: the value equals itself and nothing else.
--   * **No computed key can ever collide with it**, for two independent reasons,
--     stated twice on purpose because this is the property the placeholder rests
--     on. `lexicalNorm` collapses every run of `[ \t\n\v\f\r_-]` to one space and
--     then trims, so (a) its output can never START with `-`, and (b) its output
--     can never CONTAIN a `-` at all, which the id's own hyphens would also
--     defeat. Both hold for a carried foreign key too (#5035), since that is the
--     source region's `lexicalNorm` output.
--   * **`updated_at` is NOT stamped**, matching 0187 and 0188 and for their
--     reason: it sorts the publish preview and is projected on the wire by the
--     candidates read, so a workspace-wide stamp reshuffles every reviewer's
--     draft queue. A tombstone removes the row from that queue outright
--     (`brainFactCurrentClause`), so there is nothing for a sort key to order.
--
-- What this costs, stated plainly rather than left for a reader to find: these
-- rows leave `searchBrain` and the review queue, where they were previously
-- visible. They were unreviewable — nothing about `Billing / is owned by / -` can
-- be corroborated, contradicted, arbitrated, or corrected — and the system now
-- refuses to create more of them. The surfaces are retained verbatim, the
-- provenance edges are untouched, and `invalidated_at` can be cleared by hand if
-- an operator disagrees.
--
-- One consumer had to learn about this population: `REKEY_DRIFTED_FACTS_SQL`
-- re-derives every key in a workspace at the next alias decision, INCLUDING
-- tombstoned rows (deliberately — the re-derive-from-surface undo needs them),
-- and for these rows it re-derives NULL. Left alone it would write that NULL
-- into a `NOT NULL` column and abort a human-gated alias approval with a `23502`
-- that has nothing to do with the approval. #5047 adds an `IS NOT NULL` arm
-- there; see that statement's comment.
--
-- ## Scale
--
-- Four passes over `brain_facts` under the migration runner's advisory lock (the
-- three keying `UPDATE`s and the tombstone), plus three `SET NOT NULL`, each of
-- which is a full validating scan on PG 16 — `ALTER TABLE … SET NOT NULL` can
-- skip the scan only when a matching `CHECK … NOT NULL` constraint already
-- proves it, and there is none here. 0187 measured a four-figure corpus at the
-- largest deployment the team could observe as of 2026-08-03, so this is a
-- sub-second hold; it grows linearly, and that estimate carries 0187's own
-- caveat about self-hosted installs nobody can see. The three keying `UPDATE`s
-- touch zero rows on any corpus that deployed 0187, 0188 and #5020 together,
-- which is every fresh install and every CI run, and pay only the scan.

-- ── 1. The backfill re-run: vocabulary-aware, one statement per column ──────
--
-- Each statement is `REKEY_DRIFTED_FACTS_SQL[position]` with two changes: it is
-- unscoped by workspace (a migration has no request to scope to), and its
-- predicate is `IS NULL` rather than `IS DISTINCT FROM`, which is what makes it
-- a keying operation rather than a re-key. The inner expression is 0187's,
-- character for character, and every reason 0187's header gives for its shape
-- holds here unchanged — `chr()` instead of a backslash class (escape processing
-- is a GUC, and `\v` silently degrades to a literal `v`, shredding every key
-- containing one), `translate()` instead of `lower()` (`lower()` disagrees with
-- `String#toLowerCase()` on U+0130 and on word-final sigma, and moves with the
-- database collation), and `NULLIF(…, '')` instead of a stored empty string
-- (which would make every degenerate row join every other one).
--
-- The COALESCE is `alias`: a norm with no vocabulary entry maps to itself. The
-- OUTER `NULLIF(btrim(regexp_replace(translate(…` is `slotKey`'s re-norm of the
-- vocabulary's answer, and it is not optional — an entry authored as
-- `is priced at → "Priced At"` would otherwise write a key that joins nothing.
-- A surface that normalizes away yields NULL from the inner expression, so the
-- closure lookup matches no row (`norm = NULL` is never true), the COALESCE
-- stays NULL and the key stays NULL. That is `slotKey`'s "the alias is never
-- consulted for a claim that asserts nothing", reached by the same road — and it
-- is precisely the population statement 2 then tombstones.

UPDATE brain_facts f
   SET subject_key = NULLIF(btrim(regexp_replace(translate(COALESCE((SELECT t.effective_target
                                                                       FROM brain_vocabulary_target t
                                                                      WHERE t.workspace_id = f.workspace_id
                                                                        AND t.slot_position = 'subject'
                                                                        AND t.norm = NULLIF(btrim(regexp_replace(translate(f.subject, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')),
                                                                    NULLIF(btrim(regexp_replace(translate(f.subject, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')),
                                                          'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')
 WHERE f.subject_key IS NULL;

UPDATE brain_facts f
   SET predicate_key = NULLIF(btrim(regexp_replace(translate(COALESCE((SELECT t.effective_target
                                                                         FROM brain_vocabulary_target t
                                                                        WHERE t.workspace_id = f.workspace_id
                                                                          AND t.slot_position = 'predicate'
                                                                          AND t.norm = NULLIF(btrim(regexp_replace(translate(f.predicate, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')),
                                                                      NULLIF(btrim(regexp_replace(translate(f.predicate, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')),
                                                            'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')
 WHERE f.predicate_key IS NULL;

UPDATE brain_facts f
   SET object_key = NULLIF(btrim(regexp_replace(translate(COALESCE((SELECT t.effective_target
                                                                      FROM brain_vocabulary_target t
                                                                     WHERE t.workspace_id = f.workspace_id
                                                                       AND t.slot_position = 'object'
                                                                       AND t.norm = NULLIF(btrim(regexp_replace(translate(f.object, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')),
                                                                   NULLIF(btrim(regexp_replace(translate(f.object, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')),
                                                         'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' '), '')
 WHERE f.object_key IS NULL;

-- ── 2. The permanently-unkeyable remainder: tombstone, then placeholder ─────
--
-- Everything statement 1 could key is keyed, so what still tests NULL here is
-- exactly the population whose EXPRESSION is NULL — which is the distinction
-- 0187's second caveat demands, arrived at by construction rather than by
-- restating the expression a fourth time. Testing the column is correct HERE and
-- only here, and only because the statements above ran first in the same
-- transaction.
--
-- `COALESCE` per column rather than one blanket assignment: a row can be
-- degenerate at one position and perfectly keyed at the other two (`Billing /
-- is owned by / -` is the shape that reaches this in practice), and overwriting
-- the good keys with placeholders would take a row that is merely valueless at
-- one slot and make it unreachable at all three.
--
-- `invalidated_at` is likewise `COALESCE`d: a row already tombstoned keeps its
-- original timestamp, because when it stopped being a belief is a fact about the
-- corpus and not about this migration.
--
-- The parenthesized `OR` group is 0187's and 0188's, kept for their reason: the
-- arms are all `OR`, so the group is redundant TODAY and `AND` binds tighter, so
-- a fourth arm that scopes the statement reads as unscoped and is not.
--
-- Wrapped in a `DO` block for the ROW COUNT, which is this statement's one
-- operator breadcrumb. It retires beliefs — they leave `searchBrain` and the
-- review queue at boot — and an operator who notices a smaller review queue
-- afterwards has no other way to correlate it with this deploy. 0032's header
-- names the mistake this repeats otherwise: *"Emit a RAISE NOTICE with the
-- coerced row count so operators have a post-mortem breadcrumb instead of silent
-- rewrites (0031 shipped without this — don't repeat that gap)."* 0034, 0055,
-- 0072 and 0085 all follow it.
--
-- ⚠️ Those five breadcrumbs were being DISCARDED until #5047: `migrate.ts` ran
-- each file with no `notice` listener on the client, and `node-postgres` drops a
-- server notice when nothing is listening. The listener was added in this same
-- PR, which is the only reason this block is a signal rather than a decoration.
DO $$
DECLARE tombstoned_count INTEGER;
BEGIN
  UPDATE brain_facts f
     SET subject_key    = COALESCE(f.subject_key,   '-unkeyable:' || f.id::text),
         predicate_key  = COALESCE(f.predicate_key, '-unkeyable:' || f.id::text),
         object_key     = COALESCE(f.object_key,    '-unkeyable:' || f.id::text),
         invalidated_at = COALESCE(f.invalidated_at, now())
   WHERE (f.subject_key IS NULL
       OR f.predicate_key IS NULL
       OR f.object_key IS NULL);
  -- ⚠️ THIS SELECTS ON THE COMPOSED EXPRESSION'S RESULT, WHICH IS TWO
  -- POPULATIONS, NOT ONE. Statement 1 wrote `alias(lexicalNorm(surface))`, so a
  -- key is still NULL here when the SURFACE normalizes away (permanent, and the
  -- case this section's argument is written for) OR when this workspace's
  -- vocabulary maps a real norm to something that does (repairable — remove the
  -- alias entry and the drift re-key restores the key).
  --
  -- The second is closed today by the authoring guards (`vocabulary-decide.ts`
  -- refuses a `degenerate-norm` target, `validateBundle` refuses a non-norm
  -- edge), so it should reach this statement only through a hand-written or
  -- restored `brain_vocabulary_target` row. It is named anyway, for the reason
  -- `REKEY_DRIFTED_FACTS_SQL` gives for not leaning on those guards either — and
  -- because the cost is asymmetric: a repairable row tombstoned here comes back
  -- keyed but permanently invisible, since nothing in the product clears
  -- `invalidated_at`. The notice below says both causes rather than asserting
  -- the one this file would prefer.
  GET DIAGNOSTICS tombstoned_count = ROW_COUNT;
  IF tombstoned_count > 0 THEN
    RAISE NOTICE '[0194] tombstoned % brain_facts row(s) that could not be keyed, each with a per-row placeholder key. TWO causes reach this: the surface normalizes away (permanent — no vocabulary can ever key it), or this workspace''s vocabulary maps that norm to something that does (repairable — fix the alias entry, though the tombstone stays until cleared by hand). They leave searchBrain and the review queue; their surfaces are retained verbatim and only clearing invalidated_at restores them', tombstoned_count;
  END IF;
END $$;

-- ── 3. The constraint ───────────────────────────────────────────────────────
--
-- ADR-0037 §1: *"`subject_key`, `predicate_key`, `object_key` are `NOT NULL`."*
-- Three separate statements because that is what `ALTER TABLE … ALTER COLUMN`
-- takes; they are one transaction either way, since the runner wraps the file.
--
-- What this buys is not tidiness. Until now `= NULL` being unknown made an
-- unkeyed row silently INVISIBLE to all three slot consumers: a re-observation
-- forked a duplicate draft instead of strengthening the fact, no advisory
-- tension edge was minted, and the publish gate's will-supersede disclosure
-- reported "nothing to supersede" for a draft whose check could not run — a
-- positive verdict where the check was skipped. Fail-closed, recoverable, and
-- undetectable. The constraint is what makes that state unrepresentable instead
-- of merely rare.
ALTER TABLE brain_facts ALTER COLUMN subject_key SET NOT NULL;
ALTER TABLE brain_facts ALTER COLUMN predicate_key SET NOT NULL;
ALTER TABLE brain_facts ALTER COLUMN object_key SET NOT NULL;
