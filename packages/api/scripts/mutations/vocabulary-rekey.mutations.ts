/**
 * The mutation list behind `vocabulary-rekey-pg.test.ts`'s table (#5061,
 * promoted from a hand-typed table by #5060's runner).
 *
 * The table this replaces was measured in three rounds over two slices, and its
 * own header had to carry a growing list of exceptions to stay honest: rows 1-25
 * regenerated in one pass, rows 26-29 applied by hand one at a time, two rows
 * re-measured for #5109 because that slice restructured the statement under
 * them. Every one of those sentences is a promise about a run nobody can repeat.
 * The runner makes the whole table one run, so the exceptions stop being
 * exceptions — what survives from that header is the REASONING, carried into the
 * preamble below, and nothing that was a number.
 *
 * ## The `&& false` convention
 *
 * Several rows here are "a guard dropped". They are spelled as
 * `if (<original condition> && false)` rather than by deleting the block,
 * because the deletion has two defensible spellings — delete the arm, or delete
 * the arm AND the state it computed — and those measure differently. Appending
 * `&& false` makes the branch unreachable without touching anything else, so one
 * label means one mutation. It is not type-correct in every case; that is
 * irrelevant here, since the runner's instrument is `bun test`, which strips
 * types, and the tree is restored from an in-memory backup either way.
 *
 * ## SQL rows keep every bind parameter bound
 *
 * `$n::type IS NOT NULL` rather than deleting a predicate that carries the only
 * reference to a parameter. Postgres refuses a statement whose parameter arity
 * disagrees with the bind message, and a suite that dies on a bind error has
 * measured the runner's spelling rather than the property under test. The two
 * collision-stamp `EXISTS` rows are the ones that need it — named rather than
 * numbered, because the generated table numbers nothing and a positional
 * citation is falsified by inserting any mutation above it. (`AND FALSE` is the
 * sibling spelling, used in `vocabulary.mutations.ts`; no row here needs it.)
 *
 * ## Needs a scratch database
 *
 * All four suites read `TEST_DATABASE_URL` and self-skip without it, so the
 * baseline is DEFLATED and the runner aborts rather than publishing a table of
 * zeros (guardrail 4):
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:<port>/<any>_scratch
 * `db:up` maps 5432; the multi-env compose maps 5433/5434/5435. Every brain
 * suite creates and drops its OWN schema, so one scratch database serves all
 * of them — but give a long regeneration its own so a concurrent `-pg` run
 * cannot perturb the counts. docs/development/testing.md has the runbook.
 */

import type { MutationSpec } from "../mutation-spec";

const DECIDE = "src/lib/brain/vocabulary-decide.ts";
const FACTS = "src/lib/content-mode/adapters/brain-facts.ts";
const IDENTITY = "src/lib/brain/identity.ts";

/**
 * The closure lookup `rekeyDriftedFactsSql` keys every row on — bound once in
 * the builder and referenced from the CTE's projection.
 */
const ALIASED = `  const aliased = \`COALESCE((SELECT t.effective_target
                               FROM brain_vocabulary_target t
                              WHERE t.workspace_id = f.workspace_id
                                AND t.slot_position = '\${position}'
                                AND t.norm = \${norm}), \${norm})\`;`;

/** The `UPDATE` arm of the re-key — the write, and the two arms that gate it. */
const UPDATE_WHERE = `             WHERE f.id = r.id
               AND r.new_key IS NOT NULL`;

/** `approveProposal`'s re-key call, with the comment that disambiguates it. */
const APPROVE_CALL = `  // — a no-op that looks exactly like a successful re-key.
  await rekeyDriftedFacts(tx, workspaceId, row.slot_position, row.id);`;

/** `rejectProposal`'s re-key call — the UNDO half, same statement. */
const REJECT_CALL = `    // {@link REKEY_DRIFTED_FACTS_SQL}.
    await rekeyDriftedFacts(tx, workspaceId, row.slot_position, row.id);`;

/** The collision re-check `SUPERSEDE_STAMP_SQL` carries and the explicit arm does not. */
const COLLISION_RECHECK = `        return \`
     AND EXISTS (
       SELECT 1
         FROM brain_facts d
        WHERE d.workspace_id = $1
          AND d.id = ANY($3::uuid[])
          AND \${supersessionCollisionPredicate("d", "p")})\`;`;

const spec: MutationSpec = {
  title: "Mutations the drift-re-key suites catch",
  out: "scripts/mutations/vocabulary-rekey.md",
  targets: [
    { name: "rekey-pg", file: "src/lib/brain/__tests__/vocabulary-rekey-pg.test.ts" },
    { name: "decide-pg", file: "src/lib/brain/__tests__/vocabulary-decide-pg.test.ts" },
    { name: "brain-facts", file: "src/lib/content-mode/adapters/__tests__/brain-facts.test.ts" },
    { name: "rekey-logging", file: "src/lib/brain/__tests__/vocabulary-rekey-logging.test.ts" },
  ],
  preamble: `
Sources: \`${DECIDE}\` (\`rekeyDriftedFactsSql\`, the decide lock bracket, the
completion line), \`${FACTS}\` (the publish lock and the collision stamp), and
\`${IDENTITY}\` (\`lexicalNormSql\`, \`identityKeySql\`).
Mutation list: \`scripts/mutations/vocabulary-rekey.mutations.ts\`.

## The column means something different from the table it replaces

The hand-typed table's column was **"first test to die"** — a NAME. This one is
a COUNT of failing tests per suite, and the change is a gain rather than a loss.
A name is one datum from a run nobody can reproduce: it says which assertion
happened to be reached first, which depends on file order and on tests that have
nothing to do with the mutation. A count is reproducible, and \`--check\`
recomputes it, so a row that stops being true fails CI instead of sitting there
reading like a measurement. The old header's own defence of the column was that
the name was *"that recorded name, not an author's guess"* — which is precisely
the property a generated table has by construction rather than by promise.

## What the four suites are, and what each is blind to

\`rekey-pg\` owns the statement: the re-key, the undo, the collision re-check
proved by de-merging BETWEEN the targets SELECT and the UPDATE, and the lock's
transaction scope. It does NOT pin which code paths take the namespace —
nothing in it calls \`promoteBrainFacts\`, so the publish-lock rows are
\`brain-facts\`' contribution. \`decide-pg\` carries the lock ORDER as an
invariant (5022 before 5024) and the column-scoped allowlist assertion over the
statement text. \`rekey-logging\` is the last hop: that the counts reach the
operator's LINE and that its message changes when the actionable one is
non-zero. Nothing else in the repo reads those counts, so without that suite a
number could stop being logged with every SQL test still green.

\`content-mode/__tests__/registry.test.ts\` is deliberately NOT a column, and
that is worth stating rather than leaving as an omission. It pins the brain
phase's whole statement PLAN by index, so it fails on any statement added,
removed or MOVED — a real fourth backstop, but a column measured over it would
credit kills to a plan assertion rather than to a test of the property. That is
the attribution problem round 3 of the panel caught in the workspace-scope row,
where a mutation was dying on an unrelated string anchor in another suite: a
measured kill for the wrong reason, inside the discipline that exists to catch
exactly that.

## What three rounds of panels found, kept because the mutations encode it

**A fixture built entirely through the sanctioned seam cannot falsify the guards
that exist for writers which bypass it.** Round 1's only survivor was dropping
the outer \`identityKeySql\`: every closure row the suite wrote went through
\`approveAliasEdge\`, which re-norms both endpoints, so the outer re-norm was a
no-op on every fixture. The defence is reachable from outside the seam — 0189's
CHECKs do not constrain \`effective_target\` to being a norm, and the region
import rebuilds that table — so the fix was a test that writes the two relations
DIRECTLY.

**A suite whose fixtures all share one value of a parameter cannot probe that
parameter at all.** Every \`approve()\` was at the \`predicate\` position, so
hardcoding the position argument passed every test across two suites — subject
and object approvals re-keying NOTHING, with a success line in the log. The
closure-subquery position rows and the hardcoded-\`slot_position\` row exist
because of it.

**For a guard, the mutation that matters is rarely "delete it" — it is "move
it".** The reset tests pinned the reset's PRESENCE and not its POSITION, so
displacing it past \`DRAFT_FACTS_SQL\` — leaking the bound over exactly the
statements it exists to keep unbounded — passed everything. And the
\`SET LOCAL lock_timeout\` a round added was at first never reset, so it governed
every later lock wait in both transactions: a fix that turns a wait into a
failure is a behaviour change, not a hardening.

## What is NOT measured here, so the table is not over-read

The 5022 → 5024 ORDER is asserted as an invariant, not provoked as a deadlock.
No wait-for cycle is reachable for either ordering today: publish and the decide
seam take their advisory locks before they UPDATE, and the region importer only
ever INSERTs, and an uncommitted INSERT blocks no UPDATE. The inverted order
becomes real the moment the importer UPDATEs an existing fact row. An
interleaving which cannot form a cycle passes against a broken implementation,
so a row claiming a deadlock was caught would be a fabricated measurement.

## One row is deliberately historical

The MERGED-skip-count row is #5109's own first cut, kept as a row rather than
quietly fixed. That cut reported the declined rows as ONE number, re-collapsing
the very distinction #5109 was filed to draw: a tombstoned row needing nothing
and a LIVE row whose vocabulary entry is the defect have different remedies. The
review that caught it asked one question — *does this fix exhibit the defect it
fixes, one layer over?* — and the answer was yes.
`,
  mutations: [
    {
      label: "`rekeyDriftedFacts` call deleted from `approveProposal`",
      edits: [
        {
          file: DECIDE,
          oldString: APPROVE_CALL,
          newString: "  // — a no-op that looks exactly like a successful re-key.",
        },
      ],
      note: "Anchored on the comment line above the call: the two call sites are byte-identical apart from indentation, so the `approveProposal` one is a SUBSTRING of the `rejectProposal` one and matches twice on its own.",
    },
    {
      label: "`rekeyDriftedFacts` call deleted from `rejectProposal`",
      edits: [
        {
          file: DECIDE,
          oldString: REJECT_CALL,
          newString: "    // {@link REKEY_DRIFTED_FACTS_SQL}.",
        },
      ],
      note: "The UNDO half. It is the same statement, and re-keying from the SURFACE rather than key-to-key is what makes the removal land every row on the target the POST-removal vocabulary decides.",
    },
    {
      label: "re-key gains `AND f.invalidated_at IS NULL`",
      edits: [
        {
          file: DECIDE,
          oldString: UPDATE_WHERE,
          newString: `             WHERE f.id = r.id
               AND f.invalidated_at IS NULL
               AND r.new_key IS NOT NULL`,
        },
      ],
      note: "Spelled on the UPDATE's `WHERE`, not on the CTE's. The CTE spelling is the other defensible one and is a DIFFERENT mutation: it also removes the row from both skip counts, so it moves numbers the write-side spelling leaves alone.",
    },
    {
      label: "re-key gains `AND f.valid_to IS NULL`",
      edits: [
        {
          file: DECIDE,
          oldString: UPDATE_WHERE,
          newString: `             WHERE f.id = r.id
               AND f.valid_to IS NULL
               AND r.new_key IS NOT NULL`,
        },
      ],
      note: "The superseded half of the same exclusion — same site, same reason for putting it there as the row above.",
    },
    {
      label: "re-key gains `, updated_at = now()`",
      edits: [
        {
          file: DECIDE,
          oldString: "               SET ${key} = r.new_key",
          newString: "               SET ${key} = r.new_key, updated_at = now()",
        },
      ],
      note: "`updated_at` is projected on the wire and is the sort key of the publish preview, so stamping it here reshuffles every reviewer's draft queue into re-key order. The principle: *`updated_at` means this claim's content or review state moved; a key recomputation moved neither.*",
    },
    {
      label: "re-key's workspace scope weakened to `OR TRUE`",
      edits: [
        {
          file: DECIDE,
          oldString: `             WHERE workspace_id = $1
          ),`,
          newString: `             WHERE (workspace_id = $1 OR TRUE)
          ),`,
        },
      ],
      note: "`$1` stays bound, so the failure is the cross-workspace reach rather than a parameter-arity error. The scope MOVED to the CTE in #5109 and did not weaken — `f.id = r.id` joins on the primary key against a set already scoped to `$1` — which is why this row's site moved with it.",
    },
    {
      label: "every position uses the `subject` columns",
      edits: [
        {
          file: DECIDE,
          oldString: "  const { surface, key } = SLOT_COLUMNS[position];",
          newString: '  const { surface, key } = SLOT_COLUMNS["subject"];',
        },
      ],
      note: "Both the read column and the key column, since the destructure supplies both. The closure subquery still interpolates `position`, so this isolates the COLUMN pair rather than the whole statement. The `rekey-pg` count is a large fraction of that suite and is NOT a compound row: the mutation produces valid SQL that writes the wrong column pair, and nearly every test in the file exercises a re-key and then asserts the key it produced. Contrast the advisory-lock row of `vocabulary.md`, where a comparable fraction IS compounding — there the probe fails and every mutating test throws.",
    },
    {
      label: "outer `identityKeySql` dropped from the assignment",
      edits: [
        {
          file: DECIDE,
          oldString: "            SELECT f.id AS id, ${norm} AS surface_norm, ${identityKeySql(aliased)} AS new_key",
          newString: "            SELECT f.id AS id, ${norm} AS surface_norm, ${aliased} AS new_key",
        },
      ],
      note: "The re-norm of the vocabulary's ANSWER. Since #5109 the assignment is this projection — the `UPDATE` writes `r.new_key` — so the site moved even though the property did not. 0189's CHECKs do not constrain `effective_target` to being a norm, and the region import rebuilds that table, which is why trusting the closure is not safe.",
    },
    {
      label: "closure subquery's position pinned to `'predicate'`",
      edits: [
        {
          file: DECIDE,
          oldString: "                                AND t.slot_position = '${position}'",
          newString: "                                AND t.slot_position = 'predicate'",
        },
      ],
    },
    {
      label: "closure subquery's position filter DELETED",
      edits: [
        {
          file: DECIDE,
          oldString: `                                AND t.slot_position = '\${position}'
                                AND t.norm = \${norm}), \${norm})\`;`,
          newString: "                                AND t.norm = ${norm}), ${norm})`;",
        },
      ],
      note: "The three positions are independent vocabularies. A statement blind to position reads whichever entry happens to carry the norm, which is why a fixture aliasing one norm at two positions is what separates this from the row above.",
    },
    {
      label: "`COALESCE(closure, norm)` -> the closure alone",
      edits: [
        {
          file: DECIDE,
          oldString: ALIASED,
          newString: `  const aliased = \`(SELECT t.effective_target
                               FROM brain_vocabulary_target t
                              WHERE t.workspace_id = f.workspace_id
                                AND t.slot_position = '\${position}'
                                AND t.norm = \${norm})\`;`,
        },
      ],
      note: "REPLACED WHOLE rather than by deleting `COALESCE(` and its tail separately: the two ends are 4 lines apart and editing them independently is two mutations wearing one label. The row falsifies the control — a row the approval says NOTHING about has no closure entry, so without the fallback its recomputed key is NULL and it is silently declined instead of left alone.",
    },
    {
      label: "`row.slot_position` -> hardcoded `\"predicate\"` (both call sites)",
      edits: [
        {
          file: DECIDE,
          oldString: APPROVE_CALL,
          newString: `  // — a no-op that looks exactly like a successful re-key.
  await rekeyDriftedFacts(tx, workspaceId, "predicate", row.id);`,
        },
        {
          file: DECIDE,
          oldString: REJECT_CALL,
          newString: `    // {@link REKEY_DRIFTED_FACTS_SQL}.
    await rekeyDriftedFacts(tx, workspaceId, "predicate", row.id);`,
        },
      ],
      note: "BOTH call sites in one mutation, stated because either alone is a different mutation with a different number — the ambiguity the docstring this replaces could not record. This is the round-2 bug itself: it passed every test in two suites, because every fixture approved at the `predicate` position, while subject and object approvals re-keyed nothing and logged success.",
    },
    {
      label: "`EXISTS` arm removed from the collision stamp",
      edits: [
        {
          file: FACTS,
          oldString: COLLISION_RECHECK,
          newString: `        return \`
     AND $3::uuid[] IS NOT NULL\`;`,
        },
      ],
      note: "`$3` is kept BOUND rather than removed. The caller passes three parameters; a statement that references only two makes Postgres refuse the bind, and every test in the file then dies on an arity error rather than on the missing re-check. What the arm buys: an alias REMOVAL landing between the targets SELECT and this UPDATE de-merges a pair, and stamping it retires a belief no arbitration supports — invisible to every as-of-now read, in both directions.",
    },
    {
      label: "`EXISTS` arm's `$3` -> `$2`",
      edits: [
        {
          file: FACTS,
          oldString: "          AND d.id = ANY($3::uuid[])",
          newString: "          AND d.id = ANY($2::uuid[]) AND $3::uuid[] IS NOT NULL",
        },
      ],
      note: "The dangling `$3::uuid[] IS NOT NULL` is there to keep the arity, not as part of the defect: the re-check now asks whether a PUBLISHED target still collides with itself instead of whether a promotable draft still collides with it.",
    },
    {
      label: "collision predicate -> `TRUE` inside the `EXISTS`",
      edits: [
        {
          file: FACTS,
          oldString: '          AND ${supersessionCollisionPredicate("d", "p")})`;',
          newString: "          AND TRUE)`;",
        },
      ],
      note: "The arm still runs and still references `$3`, so the shape of the statement is untouched — what is lost is the only part that can notice a de-merge. This is the row that separates *the re-check exists* from *the re-check re-asks the right question*.",
    },
    {
      label: "publish's identity-lock call deleted",
      edits: [
        {
          file: FACTS,
          oldString: `    yield* Effect.tryPromise({
      try: () =>
        tx.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, orgId]),`,
          newString: `    yield* Effect.tryPromise({
      try: () => Promise.resolve({ rows: [] }),`,
        },
      ],
      note: "The QUERY is dropped, not the `Effect.tryPromise` wrapper and its `catch`. Deleting the whole block is the other spelling and would also delete the `55P03` classification, which is a separate row below; neutering the call alone keeps one label meaning one mutation. `DRAFT_FACTS_SQL`'s `FOR UPDATE` locks drafts only, so without this lock a concurrent alias REMOVAL can de-merge a pair between the targets SELECT and the stamp.",
    },
    {
      label: "publish's `SET LOCAL lock_timeout` deleted",
      edits: [
        {
          file: FACTS,
          oldString: "      try: () => tx.query(IDENTITY_MUTATION_LOCK_TIMEOUT_SQL),",
          newString: "      try: () => Promise.resolve({ rows: [] }),",
        },
      ],
      note: "`pg_advisory_xact_lock` never errors on contention — it waits, forever — so an unbounded acquisition is a publish request that hangs with no log line and no `requestId`, which is the one outcome the 500 path cannot report because it is never reached.",
    },
    {
      label: "publish's lock_timeout RESET deleted (bound leaks to the txn)",
      edits: [
        {
          file: FACTS,
          oldString: "      try: () => tx.query(IDENTITY_MUTATION_LOCK_RESET_SQL),",
          newString: "      try: () => Promise.resolve({ rows: [] }),",
        },
      ],
      note: "`SET LOCAL` reverts at COMMIT, not at the next statement, so leaving it set bounds every later lock wait in the transaction — the promote UPDATEs, the supersede stamp, and the phase-4 archive loop. A publish that used to block and commit instead rolls back everything already promoted, on a transient class, under a generic message. The suites pin the reset's POSITION and not merely its presence.",
    },
    {
      label: "publish's namespace -> 5022",
      edits: [
        {
          file: FACTS,
          oldString: "        tx.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, orgId]),",
          newString: "        tx.query(IDENTITY_MUTATION_LOCK_SQL, [5022, orgId]),",
        },
      ],
      note: "The literal rather than an added import of `VOCABULARY_LOCK_NAMESPACE`, so the mutation is one edit in one file. Publish taking 5022 serializes it against the vocabulary lock and NOT against the identity mutation it exists to exclude — a lock held, correctly, on the wrong resource.",
    },
    {
      label: "`isLockTimeout` always false (55P03 relayed raw)",
      edits: [
        {
          file: FACTS,
          oldString: "        if (isLockTimeout(cause)) {",
          newString: "        if (isLockTimeout(cause) && false) {",
        },
      ],
      note: "The lock is still taken and still bounded; what is lost is the one failure in the phase that is TRANSIENT and worth retrying being NAMED. An operator reading a bare `lock_not_available` has no way to know an alias decision is what they are queued behind.",
    },
    {
      label: "decide's lock order flipped (5024 before 5022)",
      edits: [
        {
          file: DECIDE,
          oldString: `  // path takes no bound at all on the same argument, and its test says so.
  await lockVocabulary(tx, workspaceId);`,
          newString: "  // path takes no bound at all on the same argument, and its test says so.",
        },
        {
          file: DECIDE,
          oldString: `  await tx.query(IDENTITY_MUTATION_LOCK_RESET_SQL);
}`,
          newString: `  await tx.query(IDENTITY_MUTATION_LOCK_RESET_SQL);
  await lockVocabulary(tx, workspaceId);
}`,
        },
      ],
      note: "TWO edits, because a flip is a move: the call is removed from the top of `lockIdentityMutation` and re-added after the 5024 bracket. Spelled as a move rather than a delete so the mutation is the ORDER and not the absence of the 5022 lock. `await lockVocabulary(tx, workspaceId);` alone matches twice — the other call site differs only by indentation — hence the comment anchor.",
    },
    {
      label: "decide's lock_timeout RESET deleted (bound leaks past 5024)",
      edits: [
        {
          file: DECIDE,
          oldString: `  await tx.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, workspaceId]);
  await tx.query(IDENTITY_MUTATION_LOCK_RESET_SQL);`,
          newString: "  await tx.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, workspaceId]);",
        },
      ],
      note: "The decide-side mirror of publish's leak: the bound would cover the proposal claim and every row lock the workspace-wide re-key takes below, turning waits that are correct into failures. The first cut of that fix did exactly that.",
    },
    {
      label: "`lexicalNormSql`'s `translate()` -> `lower()`",
      edits: [
        {
          file: IDENTITY,
          oldString: "    `btrim(regexp_replace(translate(${columnExpr}, ` +\n    `'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), ` +",
          newString: "    `btrim(regexp_replace(lower(${columnExpr}), ` +",
        },
      ],
      note: "The fold is `A`-`Z` and nothing else, mirroring migration 0187. `lower()` is locale-dependent and folds far more than the ASCII range, so the SQL expression and the TypeScript `lexicalNorm` stop agreeing on any row outside it — a disagreement that keys a fact one way on write and looks it up another.",
    },
    {
      label: "`chr(11)` dropped from the separator class",
      edits: [
        {
          file: IDENTITY,
          oldString: "    `'[ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' ')`",
          newString: "    `'[ ' || chr(9) || chr(10) || chr(12) || chr(13) || '_-]+', ' ', 'g'), ' ')`",
        },
      ],
      note: "One character out of a class of seven — the smallest edit in the table, and the one a corpus-wide agreement test exists for. The pair is only falsifiable by a row that actually contains a vertical tab.",
    },
    {
      label: "`identityKeySql`'s `NULLIF(..., '')` dropped",
      edits: [
        {
          file: IDENTITY,
          oldString: "  return `NULLIF(${lexicalNormSql(columnExpr)}, '')`;",
          newString: "  return lexicalNormSql(columnExpr);",
        },
      ],
      note: "REPO-WIDE, and the widest-reaching row here: every caller of `identityKeySql` changes with it. A stored `''` is the ONE key value that joins every other degenerate row, so two unrelated placeholder claims occupy one slot and publishing either stamps `valid_to` on the other.",
    },
    {
      label: "the `IS NOT NULL` arm on the recomputed key dropped (#5047)",
      edits: [
        {
          file: DECIDE,
          oldString: `             WHERE f.id = r.id
               AND r.new_key IS NOT NULL
               AND f.\${key} IS DISTINCT FROM r.new_key`,
          newString: `             WHERE f.id = r.id
               AND f.\${key} IS DISTINCT FROM r.new_key`,
        },
      ],
      note: "Load-bearing rather than defensive: a row whose SURFACE norms away recomputes to NULL, is `IS DISTINCT FROM` its stored key, and the UPDATE writes NULL into a `NOT NULL` column — `23502`, aborting a human-gated alias approval that has nothing to do with that row. #5109 respelled the arm as `r.new_key IS NOT NULL` over the same expression; the property did not move.",
    },
    {
      label: "a skip count dropped from the completion line (#5109)",
      edits: [
        {
          file: DECIDE,
          oldString: "    skippedDegenerateSurface: counts.skippedDegenerateSurface,\n",
          newString: "",
        },
      ],
      note: "Spelled as dropping the DEGENERATE-SURFACE count. Dropping `skippedVocabularyTarget` from the payload instead is a different mutation and would be a different row — it leaves the message still branching on a number the line no longer reports. The counts are computed in SQL and pinned there, but nothing in the repo READS them, so a line that quietly stopped carrying one leaves every SQL test green while measuring a number no human is shown.",
    },
    {
      label: "the two skip causes MERGED into one count (#5109 round 1's own defect)",
      edits: [
        {
          file: DECIDE,
          oldString: `    skippedDegenerateSurface: counts.skippedDegenerateSurface,
    skippedVocabularyTarget: counts.skippedVocabularyTarget,`,
          newString: "    skipped: counts.skippedDegenerateSurface + counts.skippedVocabularyTarget,",
        },
      ],
      note: "DELIBERATELY HISTORICAL — this is the shape #5109's first cut shipped, kept as a row rather than quietly fixed. Spelled at the LINE rather than in the SQL: merging the two count subqueries instead makes the executor answer without the three counts, and every suite then dies on the refusal rather than on the merge. The two causes have two remedies — a tombstoned population that needs nothing, and a live row whose `brain_vocabulary_target` entry is the defect — and one number sends an operator to the wrong one or to neither.",
    },
    {
      label: "the completion message stops being conditional on `skippedVocabularyTarget`",
      edits: [
        {
          file: DECIDE,
          oldString: "  if (counts.skippedVocabularyTarget > 0) {",
          newString: "  if (counts.skippedVocabularyTarget > 0 && false) {",
        },
      ],
      note: "*\"existing facts now carry the keys this vocabulary decides\"* is FALSE of the declined rows — they carry the keys the PREVIOUS vocabulary decided — so an unconditional line is a success sentence about the one population that needs a human. The level splits with the message, so this also drops the `warn`: a conditional message at a flat `info` would have been the same defect one layer out.",
    },
  ],
};

export default spec;
