#!/bin/bash
# Refuse any write to `brain_facts.status`, or any MUTATION of
# `brain_facts.visible_to`, `brain_facts.valid_to`, or a fact's IDENTITY KEYS,
# outside the atomic publish endpoint (#4769 / #4823 / #4912 / #5019,
# ADR-0036 + ADR-0037). Scope + blind spots below.
#
# `brain_facts.status` is the fact class's review gate. ADR-0036 makes the gate
# the brain's conflict-resolution mechanism, which only holds if `draft →
# published` happens in exactly ONE place: the exotic content-mode adapter that
# `/api/v1/admin/publish` runs inside its transaction. A second writer — a
# connector shortcut, an "just mark it reviewed" admin action, a backfill — would
# not merely duplicate logic; it would bypass the no-provenance / no-grant
# refusals and stamp trust on a claim nothing checked.
#
# `brain_facts.visible_to` is the fact's ACL, and #4823 made the same publish
# path its second writer: a draft is promoted with its own grant unioned with
# those of the episodes on its `provenance` edges. ADR-0036 §T5 permits a grant
# to widen at the review gate and NOWHERE else, so the same single-writer
# argument applies — with a worse failure direction. A rogue `status` write
# over-trusts a claim; a rogue `visible_to` write DISCLOSES one.
#
# `brain_facts.valid_to` is the temporal axis (#4912). ADR-0036 §Temporal: a
# human promotion stamps it, and there is no autonomous supersession. Its
# failure direction is worse again — a rogue stamp retires a belief no human
# arbitrated, and every as-of-now read then HIDES the row it touched, so the
# damage is invisible in both directions.
#
# THE GATED COLUMNS ARE ASYMMETRIC, and the asymmetry is load-bearing:
#   - `status` — refused on UPDATE **and** INSERT. A writer must omit it so
#     0180's `draft` default applies the review gate by construction.
#   - `visible_to`, and `pre_widening_visible_to` on the same terms (#4836) —
#     refused on UPDATE **only** (including an upsert's `DO UPDATE` half). A
#     grant is DERIVED AT INGEST: `reconcile.ts`'s `INSERT_FACT_SQL` names the
#     column and must, so an INSERT arm here would refuse the write the whole
#     ACL design rests on.
#   - `valid_to` — UPDATE **only**, for the grant's reason inverted: a producer
#     may open a validity window (`valid_from` on an INSERT) but never close
#     one, and an import carrying an already-closed window is a restore rather
#     than an arbitration.
#   - the identity keys — `subject_key`, `predicate_key`, `object_key`, and the
#     `_cmp` comparison columns (#5019) — UPDATE **only**, on the grant's terms
#     exactly: derived at ingest, so INSERT must stay legal; never RE-derived by
#     a second writer, because re-keying changes what a claim collides with and
#     the collision is what stamps `valid_to`.
# Fixtures pin BOTH directions on every column, so "tidying" this into symmetry
# has to fail a test first.
#
# WHAT IS REFUSED (each has a fixture in the adversarial suite)
#   - `UPDATE [schema.]brain_facts … SET … status …`
#   - `UPDATE [schema.]brain_facts … SET … visible_to …`
#   - `UPDATE [schema.]brain_facts … SET … valid_to …` (#4912 — the
#     supersession stamp; UPDATE-only like the grant, see the column notes)
#   - `UPDATE [schema.]brain_facts … SET … subject_key / predicate_key /
#     object_key / subject_cmp / object_cmp …` (#5019 — a re-key; UPDATE-only,
#     with `object_cmp` live since #5030 and `subject_cmp` since #5032)
#   - `INSERT INTO [schema.]brain_facts (… status …)`
#   - `INSERT INTO … brain_facts … ON CONFLICT … DO UPDATE SET … visible_to …`
#   - `INSERT INTO … brain_facts … ON CONFLICT … DO UPDATE SET … status …`
#     — the path-upsert shape ADR-0030's connector engine uses, and therefore
#     the single most likely way #4770/#4771 would reach this column. It names
#     no table after `UPDATE` and no `status` in the column list, so it evaded
#     both of the patterns above until it was called out.
#   - `INSERT INTO brain_facts VALUES (…)` with NO column list — positional, so
#     whether it sets `status` is unknowable by grep. Refused on principle:
#     a positional insert into a table this wide is unreviewable anyway.
#   - `db.update([schema.]brainFacts).set({ status … })` and
#     `db.insert([schema.]brainFacts).values({ … status … })` — both Drizzle
#     write-builder halves, including the `.onConflictDoUpdate({ set: { status
#     … } })` upsert (covered by the insert pattern's window).
#
# Matching is case-INSENSITIVE for the SQL forms (keyword casing is a style
# choice, not a security boundary) and accepts an optional schema qualifier and
# double-quoted identifier.
#
# WHAT THIS GATE STILL CANNOT SEE. Stated in full so nobody reads the list above
# as a completeness proof:
#   - A table name assembled at runtime (`UPDATE ${t} SET status`) — ungreppable
#     by construction.
#   - A gated write assembled ACROSS statement boundaries. Segmentation is by
#     `;` (see the `tr ';' '\n'` below) and each rule AND-s independent tokens
#     WITHIN one chunk, so `const q = db.update(brainFacts); q.set({ status });`
#     never presents both halves together. (Merging in the other direction is
#     safe — it only widens a chunk, which can only add findings. This bullet
#     replaced an earlier `.{0,400}`-window blind spot; the window form was
#     dropped for the backtracking reason documented further down.)
#   - Any language or file type outside `--include` (`.ts`/`.tsx`/`.js`).
# The structural half of the guarantee is therefore NOT this script: it is
# `adapters/__tests__/brain-facts.test.ts`, which asserts the registry entry
# stays `exotic`. Flipping it to `simple` would route promotion through the
# registry's blanket UPDATE and bypass every refusal without any file in this
# scan changing.
#
# NOTE the deliberate over-breadth. Matching is per-STATEMENT, and within a
# statement the rules ask only "does it touch the table AND mention `status`" —
# so `status` in a WHERE clause counts. Both of these are refused even though
# neither mutates the review state:
#   UPDATE brain_facts SET invalidated_at = now() WHERE … status = 'published'
#   INSERT INTO brain_facts (…) SELECT … WHERE status = 'draft'
# That is the safe direction for a security gate. A legitimate case — a
# retraction or backfill that FILTERS on status, which #4772/#4773 may well
# want — needs an allowlist entry WITH a rationale, not a quiet loosening. Both
# shapes have fixtures, so relaxing this has to fail a test first.
#
# An INSERT that does NOT name `status` is fine and is the expected shape for
# every writer: migration 0180 defaults the column to `draft`, so the ingest
# path (#4770 / #4771) gets the review gate by construction rather than by
# remembering to ask for it. That is the whole point of the default.
#
# ALLOWLIST — each entry is a recorded carve-out, per CLAUDE.md § Content Mode:
#
#   packages/api/src/lib/content-mode/adapters/brain-facts.ts
#     THE promotion path. Runs only from `runPublishPhases`, inside the publish
#     transaction.
#
#   packages/api/src/api/routes/admin-migrate.ts
#     Region import (ADR-0024). Preserves the SOURCE workspace's review status
#     verbatim — 0180's header states this explicitly — because a migration must
#     not silently demote a tenant's already-reviewed facts back to draft, which
#     would re-queue a human's completed review work at every region cutover.
#     It is a restore of a prior gate decision, not a new one; the import's own
#     `grantProblem` validation is paired with the 0180 CHECK.
#     ⚠️ THAT "RESTORE, NEVER MINT" READING NO LONGER COVERS THE WHOLE FILE
#     (#5047). `tombstonePlaceholder` now MINTS an `invalidated_at` for a fact
#     whose surface normalizes away, matching what migration 0194 does to the
#     same population — the row has no identity at some position, cannot be
#     keyed by any vocabulary or re-key, and the slot keys are NOT NULL. It is
#     still not an ARBITRATION (nothing decided that a meaningful claim is
#     false; the claim asserts nothing), which is the distinction this allowlist
#     draws — but the plain reading above would tell a reader the file never
#     writes a tombstone of its own, and it does. A fact whose key merely failed
#     to ARRIVE while its surface keys fine is refused outright rather than
#     tombstoned, because that row is repairable and retiring it would not be.
#     It also restores `pre_widening_visible_to` (#4836) — necessarily, since
#     the column cannot be re-derived in the target region (the import writes
#     `status` verbatim, so the fact never re-publishes and the widening UPDATE
#     that derives it never runs again). `validateBundle` checks that column's
#     SHAPE only, not `grantProblem`: absent-or-empty is legitimate there
#     (`null` = never widened, `[]` = the source could not vouch for it), and
#     the fail direction is opposite to `visible_to`'s — a bad pre-widening
#     grant over-WITHHOLDS attribution, which is recoverable, where a bad
#     `visible_to` would over-disclose.
#     SINCE #5035 IT ALSO WRITES THE IDENTITY KEYS, and #5036 records it here
#     for `correction.ts`'s reason exactly: the entry is WHOLE-FILE, so it
#     already covers what follows whether or not anyone writes it down, which is
#     precisely why it has to be written down rather than left to the scan.
#     WHAT IT DOES WITH THEM: the explicit column INSERT carries `subject_key`,
#     `predicate_key` and `object_key` verbatim off a v3 bundle, and computes
#     them ONCE for a legacy v1/v2 one via `alias_dest(lexicalNorm(surface))`.
#     WHY THAT IS A ROW-COPY AND NOT A SECOND CANONICALIZER: ADR-0037 §8 — *a
#     row-copy path carries keys verbatim; a claim-supply path never supplies
#     them*. §1 prohibits a PRODUCER computing identity; this copies rows that
#     were already keyed in another region of the same product. The legacy arm
#     is the one place it computes rather than copies, and it is bounded to
#     bundles that carry no keys at all — where the alternative is not "carry"
#     but "leave NULL", which the NOT NULL slot keys forbid.
#     ⚠️ WHAT THE ENTRY THEREFORE COSTS, stated because it is load-bearing: a
#     future `UPDATE brain_facts SET subject_key = …` added to THIS file would
#     be exempt, silently — it was allowlisted for `status` long before it had
#     any business near a key. The compensating pins are
#     `migrate-roundtrip-pg.test.ts`'s verbatim-carry assertions (read against
#     what the BUNDLE carried, not against literals the test also wrote) and
#     `keys-not-on-the-wire.test.ts`.
#     ⚠️ IT IS ALSO THE ONE IMPORT PATH THAT NOW WRITES NO VOCABULARY STATEMENT
#     OF ITS OWN (#5036). The arriving alias edges are merged by
#     `lib/brain/vocabulary.ts`'s `mergeApprovedEdges`, which the route calls —
#     so a reader looking here for the vocabulary's restore will not find it,
#     and `bundle-scope.test.ts` is what keeps that delegation honest in both
#     directions. Nothing about the fact-key story above changes: the merge
#     touches the two vocabulary tables only, and reads no fact.
#
#   packages/api/src/lib/brain/correction.ts
#     `correct_fact` (#4915) — the SECOND gate-time decision maker this
#     script's gated-column commentary forecast (pre-#4915 wording: "M2's
#     correct_fact will be the second, through the same allowlisted
#     review-gate machinery"). It writes `status` exactly once (promoting the
#     human-authored replacement of a superseded fact to `published`, inside
#     the correction transaction — the correction's author IS the reviewer,
#     and the row is still screened through `classifyFactForPromotion` first),
#     and it stamps `valid_to` by executing the publish adapter's own
#     `SUPERSEDE_STAMP_EXPLICIT_SQL` — since #5024 the human-arbitration half
#     of the adapter's own `supersedeStampSql` builder, so both warrants still
#     share one SET clause — rather than spelling a second stamp. Every write
#     is actor-attributed and recorded as an immutable human-authored
#     correction episode in the same transaction; the TARGET read/write is
#     ACL-gated on the actor's own visibility, while the retraction's
#     dependent re-review flags are deliberately NOT (opaque quality markers
#     on rows the retraction undermined — see `DEPENDENT_FACTS_SQL`'s
#     rationale in the module), and none of those flag writes touches a gated
#     column.
#     SINCE #5037 IT ALSO HANDLES THE IDENTITY KEYS — recorded here because the
#     entry is whole-file and therefore already covers what follows, which is
#     exactly why it has to be written down rather than left to the scan.
#     WHAT IT DOES WITH THEM: reads all three off the target row and passes the
#     SUBJECT and PREDICATE back down through `reconcileFacts` on
#     `FactCandidate.inheritedSlot`, so the replacement lands in the slot the
#     corrected fact is already in. It executes NO statement that writes a key:
#     the INSERT is still `reconcile.ts`'s, bound with values this module
#     copied rather than composed. So this is not a fourth key writer, and the
#     IDENTITY arm has nothing to fire on today.
#     WHY IT IS A ROW-COPY AND NOT A SECOND CANONICALIZER: ADR-0037 §8 — *a
#     row-copy path carries keys verbatim; a claim-supply path never supplies
#     them*. §1 prohibits a producer COMPUTING identity; this copies it, which
#     is the distinction that made `correction.ts` the immune producer before
#     keys existed. The OBJECT key is deliberately not carried: the replacement
#     object is new, human-authored text and canonicalizes at the seam like any
#     other claim.
#     ⚠️ WHAT THIS ENTRY THEREFORE COSTS, stated because it is newly load-
#     bearing: a future `UPDATE brain_facts SET subject_key = …` added to THIS
#     module would be exempt, silently — the file was allowlisted for `status`
#     long before it had any business near a key. The compensating pin is
#     `correction.test.ts`'s "the identity keys never leave the target read
#     (#5037)", which reads the projection span of every statement the module
#     exports; it is also what replaces the whole-file exemption this slice
#     needed from `keys-not-on-the-wire.test.ts`.
#
#   packages/api/src/lib/brain/vocabulary-decide.ts
#     The alias decide transaction (#5023, ADR-0037 §6/§7) — the IDENTITY arm's
#     sanctioned writer. This entry was a PRE-REGISTRATION until #5024; the
#     write it reserved has now landed, so what follows is the argument the
#     entry only promised.
#     WHAT IT WRITES: `subject_key` / `predicate_key` / `object_key`, and only
#     those three, through ONE statement per position (`REKEY_DRIFTED_FACTS_SQL`)
#     — ADR-0037 §7's drift re-key.
#     WHY IT IS THE RIGHT HOME, and why this is not a second promotion path: a
#     key decides what a claim COLLIDES with, and an alias approval or removal
#     changes that for rows already in the corpus. §7 puts the re-key inside
#     this transaction — TypeScript at request time, NOT another migration
#     (0187, re-run by 0188, was the day-one backfill) — because the re-key is
#     triggered BY the decision, needs the same workspace advisory lock the edge
#     write takes, and is the one place the vocabulary version that authorized
#     it is known. A migration cannot be any of those three things. The write is
#     a RECOMPUTATION of a derived column under a vocabulary a human just
#     approved: it moves no claim's content and no claim's review state, which
#     is also why it does not touch `updated_at`.
#     WHY IT IS SAFE FOR THE GATE'S PURPOSE: the identity keys are gated on
#     UPDATE because "re-keying changes what a claim collides with and the
#     collision is what stamps `valid_to`" (see the column notes above). #5024
#     closes that consequence rather than inheriting it — the same slice puts
#     publish and this seam under one advisory namespace
#     (`IDENTITY_MUTATION_LOCK_NAMESPACE`, `lib/brain/identity.ts`) and makes
#     `SUPERSEDE_STAMP_SQL` re-check the collision join, so a re-key can no
#     longer land between the publish gate's unlocked SELECT and its stamp.
#     COST, stated because this list has no per-column granularity: an entry
#     exempts a FILE, so this also exempts the seam for `status`, `visible_to`
#     and `valid_to` — columns it has no business writing and does not write.
#     What holds that in place is the register in docs/development/content-mode.md
#     plus a COLUMN-SCOPED assertion in `vocabulary-decide-pg.test.ts`, which
#     replaced the "names no `brain_facts` at all" tripwire this entry used to
#     rely on. That tripwire could not survive #5024 by construction, and it was
#     retired deliberately rather than deleted quietly — the replacement is
#     narrower but is the one that still bites.
#
# Comments are stripped before matching so an explanatory comment in a source
# file cannot trip the gate. (Not this file — a `.sh` under `scripts/` is in
# neither the search roots nor `--include`, so the gate can never scan itself.)
# Two caveats on the stripping, which is the shared sed from check-ee-imports.sh:
# an UNTERMINATED `/*` truncates the rest of the file, which hides real
# offenders below it — the safe direction is the one it does NOT take, so treat
# a suspiciously clean result on a file with odd comment syntax with suspicion.
#
# Tests are excluded by filename pattern: a fixture must be able to construct a
# published row.
#
# `*.mutations.ts` is excluded for the SAME reason, one step further out (#5061).
# A mutation spec under `packages/api/scripts/mutations/` is a test fixture that
# happens to live outside `__tests__`: it holds the exact before/after strings
# `scripts/mutate.ts` applies to real source and then reverts from an in-memory
# backup. Writing the violation down is the entire job — `object-cmp.mutations.ts`
# carries `UPDATE brain_facts SET object_cmp = object` precisely because
# `object-cmp-pg.test.ts` asserts migration 0191 must never grow that backfill,
# and the only way to measure what that assertion is worth is to perform it.
#
# ⚠️ EXCLUDED BY PATTERN RATHER THAN ALLOWLISTED BY PATH, deliberately. An
# ALLOWLIST entry exempts one FILE for all four gated columns and would have to
# be re-added per spec; this is the fourth mutation spec to trip a lexical brain
# guard (`keys-not-on-the-wire.test.ts` already carries three by path), so the
# recurrence has cleared the bar for a mechanical rule over a fourth carve-out.
# The suffix is the narrow part: a real writer has to be named `*.mutations.ts`
# to inherit it, which no production module in this tree is. Excluding the
# DIRECTORY was rejected — `mutations/` is an ordinary name a GraphQL or
# migration module could take, and that carve-out any package could adopt.
#
# Both directions are pinned in the adversarial fixture suite: a spec quoting the
# forbidden statement must PASS, and a same-directory `.ts` that is not a spec
# must still FAIL.
#
# `db/migrations/` is NOT excluded by directory — the `.sql`
# migrations are already out of scope via `--include`, and excluding the
# directory would have let a one-shot backfill under
# `db/migrations/scripts/*.ts` (where CLAUDE.md says they live) write this
# column with no gate at all.
#
# ⚠️ THAT `.sql` EXEMPTION IS A REAL HOLE, and #5047 is the first migration to
# walk through it, so it is recorded here rather than only in the migration:
# `0194_brain_fact_slot_keys_not_null.sql` writes `invalidated_at` on rows whose
# surfaces normalize away — a second, non-`promoteBrainFacts` retirement of
# beliefs, including published ones. It passes this gate by EXCLUSION, not by
# review, because `--include` cannot see it.
#
# The carve-out, per CLAUDE.md § Content Mode: those rows assert nothing at some
# position. No reader could ever have acted on them, no vocabulary or re-key can
# produce a key for them, and the ingest guard now refuses to create more. The
# tombstone is what lets the slot keys be `NOT NULL` without inventing identity
# for a row that has none. 0194's header carries the full argument.
#
# A future `.sql` migration writing `status`, `visible_to`, `valid_to` or
# `invalidated_at` on `brain_facts` gets the same treatment: it is unguarded, so
# it needs a reviewer who knows that. Widening `--include` to `.sql` is the real
# fix and is not free — every historical migration would have to be allowlisted —
# so this note is the interim, and the fact that it is an interim is the point.
#
# A regression here means a new promotion path appeared. Route it through
# `promoteBrainFacts` (or, if it is genuinely a restore-not-a-decision like the
# region import, add it to ALLOWLIST below WITH the rationale).

set -euo pipefail

# Matched as GLOBS against the full path, naming each file's two real homes:
# the source of truth under `packages/api/`, and the gitignored copy that
# `create-atlas/scripts/prepare-templates.sh` mirrors into
# `create-atlas/templates/*/src/`. The scan covers `create-atlas` on purpose — a
# template that grew a rogue writer must still fail — so both spellings have to
# be listed.
#
# Deliberately NOT a bare `src/...` suffix, even though that is shorter and
# covers both. It would exempt those two relative paths in EVERY scanned root,
# so a `plugins/anything/src/api/routes/admin-migrate.ts` would inherit the
# region-import carve-out for free. A carve-out has to name the file it trusts,
# not a shape any package can adopt.
ALLOWLIST=(
  "packages/api/src/lib/content-mode/adapters/brain-facts.ts"
  "packages/api/src/api/routes/admin-migrate.ts"
  "packages/api/src/lib/brain/correction.ts"
  "packages/api/src/lib/brain/vocabulary-decide.ts"
  "create-atlas/templates/*/src/lib/content-mode/adapters/brain-facts.ts"
  "create-atlas/templates/*/src/api/routes/admin-migrate.ts"
  "create-atlas/templates/*/src/lib/brain/correction.ts"
  "create-atlas/templates/*/src/lib/brain/vocabulary-decide.ts"
)

# `BRAIN_PROMOTION_ROOT` points the scan at a throwaway tree — used ONLY by the
# adversarial fixture suite (`scripts/__tests__/check-brain-fact-promotion.test.sh`),
# so the fixtures can assert the guard actually fires without editing real files.
if [ -n "${BRAIN_PROMOTION_ROOT:-}" ]; then
  SEARCH_ROOTS=("$BRAIN_PROMOTION_ROOT")
else
  SEARCH_ROOTS=(packages apps ee examples create-atlas create-atlas-plugin plugins)
fi
EXISTING_ROOTS=()
for root in "${SEARCH_ROOTS[@]}"; do
  [ -d "$root" ] && EXISTING_ROOTS+=("$root")
done

if [ ${#EXISTING_ROOTS[@]} -eq 0 ]; then
  echo "::error::no search roots present — wrong working directory?" >&2
  exit 2
fi

# Candidate files: anything naming the table in EITHER spelling — the raw-SQL
# `brain_facts` or the Drizzle export `brainFacts`. Cheap pre-filter; the precise
# (multi-line, comment-stripped) match happens per file below.
# `|| true` on the next line would map grep's exit 1 (no match) and exit 2
# (unreadable file, bad root) onto the same empty result, and the script would
# then print "check passed" for a scan that never ran. A gate that reaches the
# irreversible `valid_to` stamp by proxy should not fail open, so the status is
# captured and only 1 is accepted — the same posture as the empty-search-roots
# check above.
set +e
CANDIDATES=$(grep -rlE 'brain_facts|\bbrainFacts\b' "${EXISTING_ROOTS[@]}" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.js' \
  --exclude='*.test.ts' \
  --exclude='*.test.tsx' \
  --exclude='*.spec.ts' \
  --exclude='*.spec.tsx' \
  --exclude='*.mutations.ts' \
  --exclude-dir='__tests__' \
  --exclude-dir='__mocks__' \
  --exclude-dir='__test-utils__' \
  --exclude-dir='node_modules' \
  --exclude-dir='.next' \
  --exclude-dir='dist' \
  --exclude-dir='__snapshots__')
GREP_STATUS=$?
set -e
if [ "$GREP_STATUS" -gt 1 ]; then
  echo "::error::the candidate scan failed (grep exit $GREP_STATUS) — this gate did NOT run" >&2
  exit 2
fi

# Same comment-stripping program as check-ee-imports.sh / the legacy-SQL gate.
STRIP_COMMENTS='sed -E "s#/\*([^*]|\*+[^*/])*\*+/##g; /\/\*/,/\*\// d; s#//.*\$##"'

# Once a file is split into STATEMENTS (below), "these two tokens belong to the
# same statement" is structural — so each rule is a set of cheap independent
# greps AND-ed together, not one regex with `.{0,400}`-style windows.
#
# That is not only simpler, it is why this gate is fast. The window form was
# catastrophically backtracking: a single pattern took 1.6s on `schema.ts`
# alone, and the whole gate ran >200s in `/ci` stage 1.
#
# `QUALIFIED` admits an optional schema qualifier with either identifier
# independently quoted, so `public.brain_facts`, `"public"."brain_facts"`, and
# `"brain_facts"` all match. `ORM_TABLE` does the same for a namespace-qualified
# Drizzle reference (`schema.brainFacts`).
QUALIFIED='("?[a-zA-Z_][a-zA-Z0-9_]*"?\.)?"?brain_facts"?'
ORM_TABLE='([a-zA-Z_$][a-zA-Z0-9_$]*\.)?brainFacts'

# The gated columns, and why the arms are asymmetric.
#
# `status` is refused on UPDATE **and** INSERT: a writer must omit it entirely
# so 0180's `draft` default applies the review gate by construction.
#
# `visible_to` (#4823) is refused on UPDATE **only**. A grant is DERIVED AT
# INGEST — `reconcile.ts`'s `INSERT_FACT_SQL` and `ingest/episodes.ts` name the
# column on their inserts, and must — so an INSERT arm here would refuse the
# write the whole ACL design depends on. What must not exist is a second writer
# that MUTATES an existing fact's grant: ADR-0036 §T5 permits widening only at
# the review gate, and unlike the `status` gate the failure direction here is
# DISCLOSURE rather than fail-closed over-restriction.
#
# `pre_widening_visible_to` (#4836) joins it on the same terms, and the `\b`
# subtlety is why it needs NAMING rather than inheriting: `_` and `v` are both
# word characters, so `\bvisible_to\b` does NOT match inside
# `pre_widening_visible_to`. That is what the optional `(pre_widening_)?` group
# below buys — WITHOUT it, a statement touching only the pre-widening column
# would be invisible here, since the widening UPDATE trips the gate on
# `visible_to` alone. The group is pinned by its own fixtures as of #4939;
# before that the arm was written but unheld. Corrupting that
# column is silent in both directions: set it to the widened grant (or NULL)
# and #4836's disclosure returns in full; set it to `[]` and attribution is
# withheld corpus-wide. A "backfill the pre-widening grant from evidence edges"
# script — which migration 0183's header explicitly forecloses — is exactly the
# shape that would otherwise slip through.
#
# The IDENTITY columns — `subject_key`, `predicate_key`, `object_key`, and the
# `_cmp` comparison columns — join on the same UPDATE-only terms (#5019,
# ADR-0037). A key is DERIVED AT INGEST exactly as a grant is, so INSERT must
# stay legal: #5020's `INSERT_FACT_SQL` names all three and must. What must not
# exist is a second writer that RE-KEYS an existing fact, because a key
# determines what a claim collides with, and the collision is what the publish
# gate stamps `valid_to` on. Re-keying outside the alias-approval seam therefore
# reaches the irreversible column by proxy: de-merging two keys between
# `SUPERSESSION_TARGETS_SQL`'s SELECT and `SUPERSEDE_STAMP_SQL`'s UPDATE stamps a
# pair that no longer collides, and every as-of-now read then hides the row it
# touched. This also converts what was legal-by-OMISSION into a recorded
# decision: an alias approval mutates PUBLISHED rows' collision behaviour with no
# draft stage, and that is defensible (the surfaces are untouched, so no
# user-facing content changed) but it should be defensible on the record.
#
# BOTH `_cmp` columns are LIVE. `object_cmp` since #5030 (migration 0191) and
# `subject_cmp` since #5032 (migration 0193); `INSERT_FACT_SQL` names both —
# legal, because this gate is UPDATE-only and each value is derived at ingest
# exactly as the grant is. This paragraph used to say `subject_cmp` did not
# exist yet and that the guard was running ahead of its schema, which was the
# right posture then and is now false.
#
# They are NOT twins, and the difference is why re-deriving either is refused
# for a DIFFERENT reason: `object_cmp` proves DIFFERENCE at the object, which
# ENABLES supersession, so a second writer that re-derived one could stamp
# `valid_to` on a pair nobody arbitrated. `subject_cmp` proves difference at the
# subject, which SUPPRESSES corroboration, tension and supersession alike — so a
# second writer there splits a live belief apart, silently, in the direction
# nobody can report (a missed corroboration writes no row to find). Same gate,
# opposite hazards.
#
# `valid_to` (#4912) is the third gated column, UPDATE-only like the grant:
# "a human promotion stamps `valid_to`; there is no autonomous supersession"
# (ADR-0036 §Temporal). Its writers are `promoteBrainFacts`' supersession
# stamp and `correct_fact`'s supersede verb (#4915) — which EXECUTES the
# adapter's stamp statement rather than spelling its own; both are allowlisted
# review-gate machinery. Any other writer would retire a belief no human
# arbitrated — and unlike a stray `status` write the damage is INVISIBLE, since
# every as-of-now read hides the row it touched. INSERT is deliberately not
# gated: `INSERT_FACT_SQL` names `valid_from` (a producer may know when a claim
# began), never `valid_to`, and a future entry point importing a fact with a
# closed validity window is a restore, not an arbitration.
# ⚠️ THESE TWO ARE DECLARATIONS, NOT THE GATE. Nothing in this script reads
# them — `statement_writes_gated_column` matches with its own inline patterns,
# because each arm has to echo WHICH column tripped and a single alternation
# cannot. Adding a column here and nowhere else gates nothing.
#
# `UPDATE_GATED_COLUMNS` is not dead, though, and that is why it stays:
# `brain-promotion-carveout-register.test.ts` parses it as the guard's declared
# vocabulary, requires `docs/development/content-mode.md` to name every column
# in it, and separately cross-checks declared ⊆ enforced — so a column added
# here and not below fails that test with a message saying exactly that.
# `keys-not-on-the-wire.test.ts` additionally requires its own key list to be a
# subset of this one, which is what stops a rename in #5032 from leaving that
# guard matching a column that no longer exists.
#
# `ORM_UPDATE_GATED_COLUMNS` has no such reader — it is documentation of the
# camelCase spellings and nothing more. Stated plainly because the sentence
# above used to cover both and did not apply to it.
UPDATE_GATED_COLUMNS='(status|(pre_widening_)?visible_to|valid_to|subject_key|predicate_key|object_key|subject_cmp|object_cmp)'
ORM_UPDATE_GATED_COLUMNS='(status|preWideningVisibleTo|visibleTo|validTo|subjectKey|predicateKey|objectKey|subjectCmp|objectCmp)'

# Does one statement write a gated `brain_facts` column? Exit 0 = yes, and it
# ECHOES which — they have completely different remedies, and a message that
# named the wrong column would send the reader to fix code they did not write.
#
# EVERY matching arm is reported, space-separated, NOT the first. First-match
# was a real defect, not a style choice: each arm asks only "does this statement
# mention the token", the over-breadth is deliberate, and every SLOT-CONSUMER
# statement carries `AND valid_to IS NULL` — all three require it by design, so
# a realistic re-key does too. (Not every brain_facts statement does:
# `INSERT_FACT_SQL` has no WHERE at all, and the promote UPDATE filters on
# `workspace_id`, `status`, `invalidated_at` and an id list — never `valid_to`.)
# So the realistic re-key
#
#   UPDATE brain_facts SET subject_key = $3
#    WHERE workspace_id = $1 AND invalidated_at IS NULL AND valid_to IS NULL
#
# matched `valid_to` first and reported a supersession stamp, sending the reader
# to fix a write they did not make while the identity advice — the part that
# names the alias-approval seam and says INSERT is legal — was unreachable.
# Reporting all of them costs a longer message and lets the aggregate branch
# below do what it was always written to do.
statement_writes_gated_column() {
  local stmt="$1"
  local hits=""

  # WHICH WRITE SHAPE is this, resolved BEFORE any column is looked at.
  #
  # The four shapes differ in how they spell "this mutates a row"; none of them
  # differs in WHICH columns are gated. Matching shape first means each column
  # family is tested once per spelling instead of once per shape — the earlier
  # form repeated the grant/valid_to/identity trio four times, so #5032's
  # `_cmp` column would have needed the same edit in four places and a fifth
  # family would need four more.
  #
  # The upsert's `DO UPDATE` half rides the mutation flag rather than getting
  # its own block, and that is the whole reason it needs naming: it names no
  # table after `UPDATE`, which is how it evaded the UPDATE rule when the grant
  # arm was first written.
  local sql_mutates=0 orm_mutates=0
  if { grep -qiE "UPDATE[[:space:]]+${QUALIFIED}\b" <<<"$stmt" \
       && grep -qiE '\bSET\b' <<<"$stmt"; } \
    || { grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+${QUALIFIED}\b" <<<"$stmt" \
         && grep -qiE 'ON[[:space:]]+CONFLICT' <<<"$stmt" \
         && grep -qiE 'DO[[:space:]]+UPDATE' <<<"$stmt"; }; then
    sql_mutates=1
  fi
  if { grep -qE "\.update\([[:space:]]*${ORM_TABLE}[[:space:]]*\)" <<<"$stmt" \
       && grep -qE '\.set\(' <<<"$stmt"; } \
    || { grep -qE "\.insert\([[:space:]]*${ORM_TABLE}[[:space:]]*\)" <<<"$stmt" \
         && grep -qE '\.onConflictDoUpdate\(' <<<"$stmt"; }; then
    orm_mutates=1
  fi

  # The UPDATE-gated families, once per spelling.
  #
  # Deliberately over-broad, as everywhere here: a column merely MENTIONED in a
  # WHERE clause counts. That is the safe direction, and a legitimate case wants
  # an allowlist entry with a rationale rather than a quiet loosening.
  if [ "$sql_mutates" -eq 1 ]; then
    grep -qiE '\bstatus\b' <<<"$stmt" && hits="$hits status"
    grep -qiE "\b(pre_widening_)?visible_to\b" <<<"$stmt" && hits="$hits visible_to"
    grep -qiE '\bvalid_to\b' <<<"$stmt" && hits="$hits valid_to"
    # Spelled out rather than hoisted into a shared constant, and that is not an
    # oversight: `brain-promotion-carveout-register.test.ts` proves
    # declared ⊆ ENFORCED by scanning this function for `\bname\b` literals, so a
    # `${VAR}` reference here would make five gated columns read as unenforced
    # and the cross-check would go quiet. Hoisting was tried and the register
    # test refused it — correctly.
    grep -qiE '\bsubject_key\b|\bpredicate_key\b|\bobject_key\b|\bsubject_cmp\b|\bobject_cmp\b' <<<"$stmt" && hits="$hits identity"
  fi
  if [ "$orm_mutates" -eq 1 ]; then
    grep -qE '\bstatus\b' <<<"$stmt" && hits="$hits status"
    grep -qE '\b(preWideningVisibleTo|visibleTo)\b' <<<"$stmt" && hits="$hits visible_to"
    grep -qE '\bvalidTo\b' <<<"$stmt" && hits="$hits valid_to"
    grep -qE '\b(subjectKey|predicateKey|objectKey|subjectCmp|objectCmp)\b' <<<"$stmt" && hits="$hits identity"
  fi

  # `status` alone is ALSO refused on a plain INSERT — the asymmetry the header
  # explains: a writer must omit it so 0180's `draft` default applies the review
  # gate by construction. The grant, the validity stamp, and the keys are all
  # DERIVED AT INGEST, so an INSERT arm for them would refuse the writes the ACL
  # and identity designs both rest on.
  if grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+${QUALIFIED}\b" <<<"$stmt" \
    && grep -qiE '\bstatus\b' <<<"$stmt"; then
    hits="$hits status"
  fi
  if grep -qE "\.insert\([[:space:]]*${ORM_TABLE}[[:space:]]*\)" <<<"$stmt" \
    && grep -qE '\bstatus\b' <<<"$stmt"; then
    hits="$hits status"
  fi

  # A column-less positional INSERT. No gated column can appear by name, so this
  # is refused on shape: a positional insert into a table this wide is
  # unreviewable regardless of what it happens to set. (Deliberately no column
  # count here — `brain_facts` has grown twice since this was written and the
  # number decayed both times.)
  if grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+${QUALIFIED}[[:space:]]+VALUES\b" <<<"$stmt"; then
    hits="$hits status"
  fi

  # Deduplicate, preserving first-seen order. Reachable now that `status` can
  # fire from both the mutation arm and the blanket INSERT arm in one statement
  # (an upsert naming it does exactly that), which is why the dedupe is not
  # cosmetic: without it the offenders line reads `(status status)`.
  local seen="" out="" h
  for h in $hits; do
    case " $seen " in *" $h "*) continue ;; esac
    seen="$seen $h"
    out="${out:+$out }$h"
  done
  [ -n "$out" ] || return 1
  echo "$out"
}

# The headline precedence, most-severe first. Parsed by the fixture suite, which
# asserts every ordered pair — so reordering this line is a behaviour change a
# test has to agree to.
SEVERITY_ORDER=(visible_to identity valid_to status)

# Did this arm fire? Maps a SEVERITY_ORDER entry onto its flag.
arm_fired() {
  case "$1" in
    visible_to) [ "$SAW_GRANT" -eq 1 ] ;;
    identity) [ "$SAW_IDENTITY" -eq 1 ] ;;
    valid_to) [ "$SAW_VALIDITY" -eq 1 ] ;;
    status) [ "$SAW_STATUS" -eq 1 ] ;;
    *)
      echo "::error::internal: SEVERITY_ORDER names '$1', which arm_fired does not know. Add the arm, or drop the entry." >&2
      exit 2
      ;;
  esac
}

headline_for() {
  case "$1" in
    visible_to) echo "::error::a company-brain fact's \`visible_to\` is MUTATED outside the atomic publish endpoint (#4823)." ;;
    identity) echo "::error::a company-brain fact is RE-KEYED outside the alias-approval seam (#5019)." ;;
    valid_to) echo "::error::a company-brain fact's \`valid_to\` is stamped outside the atomic publish endpoint (#4912)." ;;
    status) echo "::error::a company-brain fact's \`status\` is written outside the atomic publish endpoint (#4769)." ;;
    *)
      echo "::error::internal: no headline for '$1' — every SEVERITY_ORDER entry needs one." >&2
      exit 2
      ;;
  esac
}

OFFENDERS=""
# Which arm(s) fired — the four families have completely different remedies, so
# only the relevant advice is printed. Printing all would put a wrong fix in
# front of every reader, and "omit the column" is actively wrong for a grant.
SAW_STATUS=0
SAW_GRANT=0
SAW_VALIDITY=0
SAW_IDENTITY=0
if [ -n "$CANDIDATES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Glob match against a `*/`-prefixed pattern, so the fixture suite can stage
    # the same repo-relative paths under a temporary root while the pattern
    # still pins the package. `$a` is intentionally unquoted — it IS the glob.
    allowed=0
    for a in "${ALLOWLIST[@]}"; do
      # shellcheck disable=SC2053
      [[ "$f" == $a || "$f" == */$a ]] && allowed=1 && break
    done
    [ "$allowed" -eq 1 ] && continue
    # Split into STATEMENTS, then keep only those naming the table. Two reasons:
    #
    #   CORRECTNESS — each rule above AND-s independent tokens, which only means
    #   "in the same write" because the unit here is a statement. Per-file, an
    #   UPDATE on one table could pair with a `status` belonging to another.
    #
    #   COST — `schema.ts` is a candidate (it holds the `brainFacts` pgTable) and
    #   is 167KB; the statement filter cuts what the rules ever see to a handful
    #   of short lines. Atlas SQL is single-statement by rule, so a `;` inside a
    #   query literal is not a case this has to handle.
    while IFS= read -r stmt; do
      [ -z "$stmt" ] && continue
      if columns=$(statement_writes_gated_column "$stmt"); then
        OFFENDERS="${OFFENDERS}${f}  (${columns})"$'\n'
        # Every column the statement tripped, not just the first — see the note
        # on `statement_writes_gated_column`. A re-key that mentions `valid_to`
        # in its WHERE has to raise BOTH flags, or the reader gets the wrong
        # remedy for the write they actually made.
        for column in $columns; do
          case "$column" in
            status) SAW_STATUS=1 ;;
            visible_to) SAW_GRANT=1 ;;
            valid_to) SAW_VALIDITY=1 ;;
            identity) SAW_IDENTITY=1 ;;
            # NOT a `SAW_STATUS` fallback. An unrouted token would print "omit
            # `status` entirely", which this script says at length is actively
            # wrong for a grant — a silent wrong-remedy fallback, in a gate
            # whose whole argument is that the remedy has to match the column.
            *)
              echo "::error::internal: statement_writes_gated_column echoed an unrouted token '$column'. Add a \`case\` arm here AND a remedy block below — a new gated column with no remedy sends every reader the wrong fix." >&2
              exit 2
              ;;
          esac
        done
        break
      fi
    done < <(eval "$STRIP_COMMENTS \"\$f\"" | tr '\n' ' ' | tr ';' '\n' \
      | grep -iE 'brain_facts|brainFacts' || true)
  done <<<"$CANDIDATES"
fi

OFFENDERS=$(echo "${OFFENDERS%$'\n'}" | grep -v '^$' || true)

if [ -n "$OFFENDERS" ]; then
  # ONE headline, chosen by SEVERITY — and the order is DATA, not control flow.
  #
  # `::error::` is the single line GitHub surfaces in the Actions UI, so it has
  # to be the most actionable thing available. Multi-arm firing is the common
  # case, not the exception: the arms cannot tell a `SET`-list mention from a
  # `WHERE`-clause one (deliberate over-breadth), and a slot statement naming
  # `valid_to` in its WHERE is ordinary. Every arm that fired is still named in
  # the offenders line and still prints its own remedy block below.
  #
  # An `if/elif` chain expressed this until it had been wrong TWICE in one
  # review — `valid_to` ahead of `identity`, so a re-key was reported as a
  # supersession stamp the author never made. A chain also lets a fixture pin
  # only one ordered pair at a time, which is how it survived the first fix. As
  # an array the suite loops every pair (`check-brain-fact-promotion.test.sh`).
  #
  # Order follows FAILURE DIRECTION: a grant write DISCLOSES; a re-key reaches
  # the irreversible `valid_to` stamp by proxy, so it subsumes the stamp on any
  # statement carrying both; a stamp retires a belief invisibly; a status write
  # over-trusts a claim, which is the recoverable one.
  for column in "${SEVERITY_ORDER[@]}"; do
    if arm_fired "$column"; then
      headline_for "$column"
      break
    fi
  done

  echo ""
  echo "Offending files (with the column that tripped the gate):"
  echo "$OFFENDERS" | sed 's/^/  /'
  echo ""

  if [ "$SAW_STATUS" -eq 1 ]; then
    echo "\`brain_facts.status\` is the review gate (ADR-0036). Promotion happens only"
    echo "in the allowlisted gate machinery: \`promoteBrainFacts\` (inside the"
    echo "\`/api/v1/admin/publish\` transaction) and \`correct_fact\`'s in-transaction"
    echo "promote of a human-authored replacement (#4915) — both screen through"
    echo "\`classifyFactForPromotion\`, which is where no-provenance-no-promotion and"
    echo "no-grant-no-promotion are enforced. Any other writer bypasses both."
    echo ""
    echo "Fixes for a \`status\` write:"
    echo "  * Writing a NEW fact? Omit \`status\` entirely — migration 0180 defaults it"
    echo "    to 'draft', which is the review gate applying itself."
    echo "  * Promoting? Don't. Let \`/api/v1/admin/publish\` do it."
    echo "  * Retracting? Stamp \`invalidated_at\` — a fact is never deleted and never"
    echo "    demoted by status (ADR-0036: supersession is not deletion)."
    echo "  * Genuinely restoring a PRIOR gate decision (a region import)? Add the file"
    echo "    to ALLOWLIST in this script WITH the rationale, per CLAUDE.md § Content Mode."
    echo ""
  fi

  if [ "$SAW_VALIDITY" -eq 1 ]; then
    echo "\`brain_facts.valid_to\` is the supersession stamp (ADR-0036 §Temporal):"
    echo "\"a human promotion stamps valid_to; there is no autonomous supersession\"."
    echo "Its writers are \`promoteBrainFacts\`' supersession arm (inside the publish"
    echo "transaction, where the will-supersede disclosure ran BEFORE the admin"
    echo "confirmed) and \`correct_fact\`'s supersede verb (#4915), which executes the"
    echo "same allowlisted statement. Any other writer retires a belief no human"
    echo "arbitrated — and invisibly, because every as-of-now read hides the row it"
    echo "touched."
    echo ""
    echo "Fixes for a \`valid_to\` write:"
    echo "  * Superseding because a newer value arrived? Don't write it. Let the"
    echo "    claim reconcile into a draft; the publish gate stamps the rival when"
    echo "    a human promotes it (#4912)."
    echo "  * Retracting? That is \`invalidated_at\`, the tombstone — a different"
    echo "    axis. Superseded facts stay readable to as-of reads; retracted ones"
    echo "    are withdrawn."
    echo "  * Writing a NEW fact with a known validity START? \`valid_from\` on the"
    echo "    INSERT is fine and ungated; \`valid_to\` is not yours to close."
    echo "  * Genuinely a new gate-time decision (a \`correct_fact\` verb)? It"
    echo "    belongs beside \`promoteBrainFacts\`, or in an allowlisted file WITH a"
    echo "    recorded rationale."
    echo ""
  fi

  if [ "$SAW_IDENTITY" -eq 1 ]; then
    echo "\`brain_facts.subject_key\` / \`predicate_key\` / \`object_key\` (and the \`_cmp\`"
    echo "comparison columns) are the claim's IDENTITY — \`alias(lexicalNorm(surface))\`,"
    echo "materialized (#5019, ADR-0037). A key decides what a claim COLLIDES with, and a"
    echo "collision is what the publish gate stamps \`valid_to\` on. So a second writer that"
    echo "re-keys an existing fact reaches the irreversible column by proxy: de-merge two"
    echo "keys between \`SUPERSESSION_TARGETS_SQL\`'s SELECT and \`SUPERSEDE_STAMP_SQL\`'s"
    echo "UPDATE and the transaction retires a pair that no longer collides — invisibly,"
    echo "because every as-of-now read hides the row it touched."
    echo ""
    echo "Fixes for an identity-key write — note that OMITTING the columns is NOT one:"
    echo "  * Writing a NEW fact? Naming the keys on the INSERT is correct and required —"
    echo "    they are derived at ingest, exactly as the grant is, so only UPDATE (and an"
    echo "    upsert's \`DO UPDATE\` half) is refused here."
    echo "  * Re-keying because the vocabulary changed? That is the alias-approval decide"
    echo "    transaction, which takes the identity-mutation advisory lock and shows the"
    echo "    reviewer a preview of the effect before they commit. Not a second writer."
    echo "  * Re-keying corpus-wide because a vocabulary entry changed? Still the decide"
    echo "    transaction — ADR-0037 §7 makes the drift re-key TypeScript, at request time,"
    echo "    NOT another migration. 0187 was the one-off day-one backfill and is done."
    echo "  * Re-deriving from the surface to undo an alias removal? Same answer — the"
    echo "    approval seam, where the vocabulary version that authorized it is known."
    echo ""
  fi

  if [ "$SAW_GRANT" -eq 1 ]; then
    echo "\`brain_facts.visible_to\` is the fact's ACL. ADR-0036 §T5 makes it a"
    echo "per-version snapshot that may widen ONLY at the review gate — which is"
    echo "\`promoteBrainFacts\`, where a draft is published with its own grant unioned"
    echo "with those of its \`provenance\` evidence (#4823). Note the failure direction:"
    echo "a stray \`status\` write over-trusts a claim, a stray grant write DISCLOSES one."
    echo ""
    echo "Fixes for a \`visible_to\` write — note that OMITTING the column is NOT one:"
    echo "  * Writing a NEW fact or episode? An INSERT naming \`visible_to\` is correct"
    echo "    and required — the grant is derived at ingest (\`ingest/grant.ts\`). Only"
    echo "    UPDATE (and an upsert's \`DO UPDATE\` half) is refused here."
    echo "  * Widening because new evidence arrived? Don't write it. Record the"
    echo "    \`provenance\` edge; the next publish unions the grants in for you."
    echo "  * Repairing a malformed grant? That is not this path either — see"
    echo "    \`lib/brain/grant-sweep.ts\` and #4797; the sweep is an observer by design."
    echo "  * Genuinely a new gate-time decision? It belongs in \`promoteBrainFacts\`,"
    echo "    not in a second writer. An allowlist entry needs a recorded rationale."
  fi
  exit 1
fi

echo "Brain-fact promotion check passed — no ungated status, visible_to, valid_to, or identity-key write to brain_facts outside the atomic publish endpoint."
