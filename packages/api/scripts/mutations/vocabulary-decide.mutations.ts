/**
 * The mutation list behind `vocabulary-decide-pg.test.ts`'s table (#5061,
 * promoted from a hand-typed table by #5060's runner).
 *
 * The table this replaces carried its numbers in the suite's docstring under
 * the claim "measured against THIS tree … in a single run". That claim had
 * already stopped being true when it was promoted: the docstring itself
 * recorded that two of its rows were measured at #5162 and the rest at #5023,
 * and warned the reader to treat every cell as a LOWER BOUND for that reason.
 * A generated table has no such split — every row is measured in one run, on
 * one tree, every time — so that caveat is deliberately NOT carried into the
 * preamble below. It described the hand-measurement, not the seam.
 *
 * ## ELEVEN of the fifty-three cells moved, and FIVE moved DOWN
 *
 * The "lower bound" caveat above was not merely stale — it was WRONG, and in a
 * way worth stating because the reasoning behind it is the reasoning anyone
 * would use. It argued that a mutation "can only be killed by more tests, never
 * fewer, so no row above can have fallen". That holds only if tests are added.
 * Tests get REWRITTEN, and a rewritten test can stop reaching a mutation it used
 * to kill — which is the same mechanism #5027 hit on the tier guard from the
 * other direction, where an edit three describe-blocks away moved a cell nobody
 * had touched.
 *
 * Six cells rose (`6→7`, `1→2` ×3, `2→3` ×2) and five fell. Four of the five
 * are spelling-dependence this file DECLARES — the four `identityVocabulary`
 * rows, whose notes say exactly which sites they touch and why the import is
 * left in place. The fifth is not:
 *
 *   **`autoApproveEligible`'s threshold conjunct dropped: 4 → 1.** Genuine
 *   drift. Verified against a SECOND spelling before it was written down —
 *   deleting the line outright, rather than the `&& false` this spec uses —
 *   which measures 1 as well. Two spellings, one number, so the cell moved
 *   because the tests moved.
 *
 * That is the argument for the runner in one line: a docstring cannot notice
 * that its own escape clause has been falsified.
 *
 * ## The `&& false` convention
 *
 * Many rows here are "a guard dropped". They are spelled as
 * `if (<original condition> && false)` rather than by deleting the block,
 * because the deletion has two defensible spellings — delete the arm, or delete
 * the arm AND the state it computed — and those measure differently. Appending
 * `&& false` makes the branch unreachable without touching anything else, so
 * one label means one mutation. It is not type-correct in every case (a
 * narrowing that came from the arm's `throw` is lost, and one row below leaves
 * a `switch` statically unreachable); that is irrelevant here, since the
 * runner's instrument is `bun test`, which strips types, and the tree is
 * restored from an in-memory backup either way.
 *
 * ## SQL mutations keep their bind parameters bound
 *
 * Where a mutation removes a WHERE arm, the parameter it referenced is kept
 * live as `$n::text IS NOT NULL` rather than deleted. Postgres refuses a
 * statement whose parameter list and text disagree, and the suite would then
 * fail on a bind error rather than on the behaviour under measurement — a
 * number belonging to a mutation nobody chose. This bit the sibling
 * `vocabulary.mutations.ts` spec.
 *
 * ## Needs a scratch database
 *
 * Without `TEST_DATABASE_URL` the `decide-pg` column self-skips and its baseline is
 * DEFLATED — the runner aborts rather than publishing a table of zeros
 * (guardrail 4). Its sibling brain suites each create and drop their own
 * schema, so one scratch database serves them all:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:<port>/<any>_scratch
 * `db:up` maps 5432; the multi-env compose maps 5433/5434/5435. Every brain
 * suite creates and drops its OWN schema, so one scratch database serves all
 * of them — but give a long regeneration its own so a concurrent `-pg` run
 * cannot perturb the counts. docs/development/testing.md has the runbook.
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCE = "src/lib/brain/vocabulary-decide.ts";
const EXTRACT = "src/lib/brain/extract.ts";
const CORRECT_FACT_TOOL = "src/lib/tools/correct-fact.ts";
const ADMIN_ROUTE = "src/api/routes/admin-brain-facts.ts";

/** `findProposalByPair`'s WHERE — 0190's unordered-pair identity, asked in SQL. */
const PAIR_LOOKUP_WHERE = `      WHERE workspace_id = $1 AND slot_position = $2
        AND pair_low = LEAST($3::text, $4::text) AND pair_high = GREATEST($3::text, $4::text)\`,`;

/** The propose path's rejection-memory / dedup gate, anchored on its own read. */
const PROPOSE_EXISTING_GATE = `    const existing = await findProposalByPair(tx, workspaceId, input.position, fromNorm, toNorm);
    if (existing !== undefined) {`;

/** `approverEntitled`'s position half. Unique — `authorEntitled` has no position arm. */
const ENTITLEMENT_POSITION_ARMS = `  if (!isEntityPosition(position)) return true;
  return ctx.role === "owner" || ctx.role === "admin";`;

/** `approverEntitled`'s ORIGIN half, anchored on the signature so the two
 * near-identical lines in `authorEntitled` cannot be picked instead. */
const ENTITLEMENT_ORIGIN_ARMS = `function approverEntitled(position: SlotPosition, ctx: BrainPrincipalContext): boolean {
  if (ctx.origin === "unauthenticated-local") return true;
  if (ctx.origin !== "authenticated") return false;`;

/** The workspace-mismatch gate on the decide seam. */
const DECIDE_WORKSPACE_GATE = `  if (approver.kind === "human" && approver.ctx.workspaceId !== workspaceId) {`;

/** `extract.ts` reaches `ClaimVocabulary` through a TYPE-only import today. */
const EXTRACT_IDENTITY_IMPORT = {
  file: EXTRACT,
  oldString: `import type { ClaimVocabulary } from "@atlas/api/lib/brain/identity";`,
  newString: `import { identityVocabulary, type ClaimVocabulary } from "@atlas/api/lib/brain/identity";`,
} as const;

const CORRECT_FACT_IDENTITY_IMPORT = {
  file: CORRECT_FACT_TOOL,
  oldString: `import {
  VocabularyClosureError,
  loadWorkspaceVocabulary,
} from "@atlas/api/lib/brain/vocabulary";`,
  newString: `import {
  VocabularyClosureError,
  loadWorkspaceVocabulary,
} from "@atlas/api/lib/brain/vocabulary";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";`,
} as const;

const ADMIN_ROUTE_IDENTITY_IMPORT = {
  file: ADMIN_ROUTE,
  oldString: `import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";`,
  newString: `import { loadWorkspaceVocabulary } from "@atlas/api/lib/brain/vocabulary";
import { identityVocabulary } from "@atlas/api/lib/brain/identity";`,
} as const;

/** The retract route's `correctFact` call — the pair with the one below is why
 * both are anchored on surrounding lines rather than on the identical
 * `vocabulary:` line they share. */
const ADMIN_RETRACT_VOCABULARY = `            verb: "retract",
            requestId,
            vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),`;

const ADMIN_CORRECT_VOCABULARY = `            // answer, and the empty vocabulary is not a safe one.
            vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),`;

/** An inline `ClaimVocabulary` that answers every norm with itself. */
const INLINE_IDENTITY = `{ subject: (n: string) => n, predicate: (n: string) => n, object: (n: string) => n }`;

const spec: MutationSpec = {
  title: "Mutations the alias-decision suites catch",
  out: "scripts/mutations/vocabulary-decide.md",
  targets: [
    { name: "decide-pg", file: "src/lib/brain/__tests__/vocabulary-decide-pg.test.ts" },
    // ⚠️ THE TWO CONSUMER SUITES ARE COLUMNS BECAUSE THE ALTERNATIVE WAS TWO
    // JUSTIFIED ZEROS. The inline-identity rows are the revert `decide-pg`'s
    // source-level tripwire structurally cannot see — it matches on the IMPORT,
    // and those rows leave the import in place. Their first cut measured 0 here
    // with a note naming these two files as the falsifier, which is exactly the
    // shape #5061's own brief warns about: a `0` justified by prose pointing at
    // a test that exists. If the falsifier exists, it is a COLUMN.
    { name: "correct-fact-tool", file: "src/lib/tools/__tests__/correct-fact-tool.test.ts" },
    { name: "admin-route", file: "src/api/routes/__tests__/admin-brain-facts.test.ts" },
  ],
  preamble: `
Source: \`${SOURCE}\`, plus the four call sites that consume a
\`ClaimVocabulary\` (\`${EXTRACT}\`, \`${CORRECT_FACT_TOOL}\`, and both
\`correctFact\` entry points in \`${ADMIN_ROUTE}\`). Mutation list:
\`scripts/mutations/vocabulary-decide.mutations.ts\`.

⚠️ **The table covers the DECISION, not the diagnostics.** #5162 added a
once-per-process warn latch (\`settingsTierWarned\`) and the human-path
short-circuit at the decide call site. Neither has a row, and both would
SURVIVE — but NOT for want of a seam, and the distinction is what makes this gap
cheap to close. \`vocabulary-rekey-logging.test.ts\` already mocks the logger
process-wide and drives this very module through it; it just filters for "Drift
re-key complete" and only ever approves as a human, so neither #5162 line is
reached, let alone asserted. Falsifying them is a matter of adding cases there,
not of building capture. Stated rather than papered over: the refusal MESSAGE is
falsified (it has a row); the log LINE is not.

Five groups of rows need reading with care rather than at face value.

**The ordered-identity row** is NOT caught by the headline producer test: that
one re-emits the pair in the same order it was removed in, so an ordered
identity still suppresses it and the test passes. The reverse-direction case is
the only thing separating them, which is why it exists as its own \`test()\`
instead of an extra assertion.

**The entity-position conjunct** is DEAD CODE under the shipped knob — the only
eligible source class is \`warehouse_key\`, and that is refused at the predicate
position before eligibility is consulted. The one test that kills it widens the
knob AND carries confidence 1; at this suite's default 0.8 the threshold
conjunct refuses first and the mutation survives, which is what the first cut of
that test did.

**The three lock rows** are caught STRUCTURALLY, by recording each transaction's
first statement AND ITS PARAMS. The text alone could not tell a correctly-keyed
lock from one in the wrong namespace or on a constant key — which is the failure
that matters, since a wrong namespace stops the seam being mutually exclusive
with \`approveAliasEdge\` and the region importer. The ordering row is separate
again: the 5022 → 5024 ORDER row lives in \`vocabulary-rekey.md\`, not this
table, and is structural for a different reason — what it guards is an
invariant, not a deadlock a single-process test can provoke.

**\`slot_position\` asserted instead of narrowed** is reachable only by DROPPING
0190's CHECK, which its test does — the same move \`vocabulary-pg.test.ts\`
makes to write a cyclic pair the primitives refuse to. Simulating a row written
outside this seam is the point: the mutation's failure direction is permissive
(an unknown position takes the PREDICATE entitlement bar), so leaving it
unreachable-and-untested would have left an entitlement bypass behind a
constraint nobody re-checks.

**The \`identityVocabulary\` rows are the PR's other half** — the four call sites
that used to name it, plus the two ways to revert one (a reverted import, and an
inline identity vocabulary at the call site). Named by their content rather than
by position, because they are not contiguous in the table and an earlier version
of this line said "the last six rows", which points at a different set. Before
these landed, reverting ANY of them left every suite in this repo green: every
fixture workspace had an empty vocabulary, so the loaded answer and the empty one
were byte-identical and no assertion could tell them apart. The ingest revert and
its degrade-on-failure twin are caught behaviourally in \`decide-pg\`; the
\`correctFact\` sites are caught by asserting the vocabulary the caller actually
handed over, which is what the other two columns are for.

⚠️ **Read the two inline-identity rows ACROSS the columns — that pair is the
whole reason this table has three.** \`decide-pg\`'s guard on those sites is a
source-level tripwire, and it fires on the IMPORT; the inline rows are spelled to
leave the import in place, so they are the revert a tripwire structurally cannot
see. Their \`decide-pg\` cell is 0 for that reason and no other, and the cell
beside it is what closes them. Measured before the columns were added: they were
0 with a NOTE naming these two files as the falsifier — a justified zero pointing
at a test that exists, which is the one shape #5061 says to close rather than
annotate.

NOT here, deliberately — two spellings whose mutations kill NOTHING and cannot,
listed so a later reader does not mistake the silence for an oversight:

  - the eligibility threshold \`!(confidence >= t)\` vs \`confidence < t\`. The
    two differ only on NaN, which propose refuses outright and the stored column
    cannot hold (Postgres orders NaN above every value, so 0190's
    \`confidence <= 1\` CHECK rejects it — and unlike the position CHECK,
    dropping this one does not make the value storable).
  - a threshold above 1, and an unparseable one. \`confidence\` is bounded at 1,
    so "disabled" and "compares against an impossible bar" are observationally
    identical; only the \`-1\` case can kill the range guard, and it has its own
    \`test()\` for that reason.

Both are defensive style, not tested properties. A row claiming otherwise would
be a fabricated measurement.
`,
  mutations: [
    {
      label: "rejection memory dropped (`rejected` falls through to the insert)",
      edits: [
        {
          file: SOURCE,
          oldString: PROPOSE_EXISTING_GATE,
          newString: `    const existing = await findProposalByPair(tx, workspaceId, input.position, fromNorm, toNorm);
    if (existing !== undefined && existing.status !== "rejected") {`,
        },
      ],
      note: "Spelled by narrowing the gate rather than by deleting the `rejected` arm, because the label says *falls through to the INSERT* and deleting the arm falls through to `already_pending` instead — a different mutation, which is the row below it. 0190's unique index on `(workspace_id, slot_position, pair_low, pair_high)` is total, so the insert then raises a unique violation: the schema refuses what the TypeScript guard stopped refusing, and what is lost is the typed `rejected` outcome the producer counts.",
    },
    {
      label: "rejection-memory identity made ORDERED",
      edits: [
        {
          file: SOURCE,
          oldString: PAIR_LOOKUP_WHERE,
          newString: `      WHERE workspace_id = $1 AND slot_position = $2
        AND from_norm = $3::text AND to_norm = $4::text\`,`,
        },
      ],
      note: "The identity a rejection remembers, asked in the ordered direction. Both parameters stay bound, so the failure is the ordered lookup and not an arity error. A producer that emits the pair the other way round then routes around a rejection without any intent to — which the headline producer test cannot see, since it re-emits in the order it removed.",
    },
    {
      label: "the `rejected` arm reports `already_pending` instead of refusing",
      edits: [
        {
          file: SOURCE,
          oldString: `        return { kind: "rejected", id: existing.id };`,
          newString: `        return { kind: "already_pending", id: existing.id };`,
        },
      ],
      note: "The memory is still read; only its OUTCOME is downgraded. `AliasProducerCounters.rejected` is documented as *THE counter that matters on a re-run* — a producer whose second pass reports zero there is one whose removals did not stick — and this makes every suppression report as a dedup instead.",
    },
    {
      label: "removal stops writing `rejected` (edge dropped, row left `approved`)",
      edits: [
        {
          file: SOURCE,
          oldString: `        SET status = 'rejected', reviewed_by = $3, reviewed_at = now()`,
          newString: `        SET reviewed_by = $3, reviewed_at = now()`,
        },
      ],
      note: "The stamp keeps its `WHERE … status = $4` arm and its `RETURNING id`, so the transition still reports success — it simply leaves the row in the status it read. The edge is gone and the row says the pair is approved, which is the state a producer re-proposes against.",
    },
    {
      label: "`removeAliasEdge` dropped from the reject arm",
      edits: [
        {
          file: SOURCE,
          oldString: `    const removed = await removeAliasEdge(
      tx,
      workspaceId,
      row.slot_position,
      row.from_norm,
    );`,
          newString: `    const removed = true;`,
        },
      ],
      note: "Only the removal call is dropped — `removed` is left TRUE so the did-nothing throw below stays out of the way and the re-key still runs. That isolates the label: the row is stamped `rejected`, the corpus is re-keyed, and the edge is still in force.",
    },
    {
      label: "the removal's did-nothing THROW downgraded to a silent stamp",
      edits: [
        { file: SOURCE, oldString: `    if (!removed) {`, newString: `    if (!removed && false) {` },
      ],
      note: "The arm that refuses to stamp a removal that removed nothing. Downgraded, the seam reports `removedEdge: true` for a vocabulary written outside it — a hand-written DELETE, a restore — and the operator reads a removal that never happened.",
    },
    {
      label: "the pending-dedup arm dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `      return { kind: "already_pending", id: existing.id };`,
          newString: ``,
        },
      ],
      note: "The arm is DELETED here rather than neutered, because it is the block's fall-through return: removing it lands the duplicate on the insert, which is what dropping a dedup means. 0190's total unique index then refuses the second row, so the failure is a constraint violation rather than two queued rows.",
    },
    {
      label: "`autoApproveEligible`'s entity-position conjunct dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!isSlotPosition(position) || !isEntityPosition(position)) return false;`,
          newString: `  if (!isSlotPosition(position)) return false;`,
        },
      ],
      note: "The narrowing is kept and only the ENTITY half is dropped — the conjunct ADR-0037 §6 spells in code precisely because an operator cannot widen it from settings. Dead code under the shipped knob (see the preamble), so only a test that widens the knob AND carries confidence 1 can reach it.",
    },
    {
      label: "`autoApproveEligible`'s source-class conjunct dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  return aliasAutoApproveSources(workspaceId).has(sourceClass);`,
          newString: `  return true;`,
        },
      ],
      note: "The KNOB's source half, not the `isAliasSourceClass` narrowing above it — that one fails closed on an unrecognised value and is a different property. An operator who listed no eligible class, or listed only `extractor`, then auto-approves everything that clears the threshold.",
    },
    {
      label: "`autoApproveEligible`'s threshold conjunct dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!(candidate.confidence >= threshold)) return false;`,
          newString: `  if (!(candidate.confidence >= threshold) && false) return false;`,
        },
      ],
      note: "`&& false` rather than deleting the line, so `threshold` stays read and the `threshold === null` disable arm above is untouched — this row measures the COMPARISON only. ⚠️ THE ONE CELL THAT MOVED DOWN AND IS NOT SPELLING-DEPENDENCE: the docstring this table replaces carried 4, under an explicit argument that no cell could fall. Both spellings — this one and deleting the line outright — measure the same, so the tests moved, not the mutation.",
    },
    {
      label: "the threshold's 0–1 range guard dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {`,
          newString: `  if (!Number.isFinite(parsed)) {`,
        },
      ],
      note: "The finite check is KEPT and only the range half is dropped, which is what the label names. `-1` is the dangerous direction: it clears every confidence, so a typo auto-approves every warehouse-derived entity edge in the workspace. A value above 1 cannot kill it — `confidence` is bounded at 1, so an impossible bar and a disabled knob are observationally identical.",
    },
    {
      label: "the knob read platform-wide (`workspaceId` dropped from both reads)",
      edits: [
        {
          file: SOURCE,
          oldString: `  const raw = getSettingAuto("ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD", workspaceId);`,
          newString: `  const raw = getSettingAuto("ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD");`,
        },
        {
          file: SOURCE,
          oldString: `  const raw = getSettingAuto("ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES", workspaceId) ?? "";`,
          newString: `  const raw = getSettingAuto("ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES") ?? "";`,
        },
      ],
      note: "BOTH reads, stated because the label says so and either alone is a different mutation with a different number. `getSettingAuto`'s `orgId` is optional, so each edit is a one-token deletion and the workspace tier simply stops being consulted — one workspace's opt-out then governs every other.",
    },
    {
      label: "the `warehouse_key`-at-predicate refusal dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (input.sourceClass === "warehouse_key" && !isEntityPosition(input.position)) {`,
          newString: `  if (input.sourceClass === "warehouse_key" && !isEntityPosition(input.position) && false) {`,
        },
      ],
      note: "Admitting the class at the predicate position routes a predicate alias through the auto-approve arm ADR-0037 §6 reserves for evidence outside the grant grammar — and it is what makes the entity-position conjunct dead code rather than redundant.",
    },
    {
      label: "the auto arm's re-check at decide time dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `      if (approver.kind === "auto" && !eligible) {`,
          newString: `      if (approver.kind === "auto" && !eligible && false) {`,
        },
      ],
      note: "Neutered at the GUARD rather than by deleting the `eligible` computation, so `autoApproveEligible` is still called and this row does not silently absorb the two #5162 rows below it. The property is that the knob is live: a producer that cached `autoApprove: true` across a batch must not approve under a policy the operator has since turned off.",
    },
    {
      label: "`direction-required` dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (direction === undefined) {
    if (!row.directed) {`,
          newString: `  if (direction === undefined) {
    if (!row.directed && false) {`,
        },
      ],
      note: "An undirected proposal approved with no direction then silently takes its STORED order — the arbitrary one a producer happened to emit. That is the workspace-wide re-key on a guess nobody made, and it is indistinguishable afterwards from the direction a human would have set.",
    },
    {
      label: "`direction-not-in-pair` dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!pair.includes(fromNorm) || !pair.includes(toNorm) || fromNorm === toNorm) {`,
          newString: `  if ((!pair.includes(fromNorm) || !pair.includes(toNorm) || fromNorm === toNorm) && false) {`,
        },
      ],
      note: "The whole disjunction is parenthesised before `&& false`; appending it bare would bind to the last arm only and silently measure the same-norm conjunct instead — which is a separate row further down.",
    },
    {
      label: "`direction-conflict` dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (row.directed && (fromNorm !== row.from_norm || toNorm !== row.to_norm)) {`,
          newString: `  if (row.directed && (fromNorm !== row.from_norm || toNorm !== row.to_norm) && false) {`,
        },
      ],
      note: "A directed proposal is then FLIPPED at approval. The reviewer read one direction and the corpus is re-keyed in the other, and the two are indistinguishable once committed.",
    },
    {
      label: "`lexicalNorm` dropped from the supplied direction",
      edits: [
        {
          file: SOURCE,
          oldString: `  const fromNorm = lexicalNorm(direction.fromNorm);
  const toNorm = lexicalNorm(direction.toNorm);`,
          newString: `  const fromNorm = direction.fromNorm;
  const toNorm = direction.toNorm;`,
        },
      ],
      note: "A UI sending the display form a human clicked then fails `pair.includes`, and a correct approval is refused as `direction-not-in-pair`. The stored pair is normed; the supplied direction has to be asked the same question.",
    },
    {
      label: "the approval STAMPS the proposed direction instead of the resolved one",
      edits: [
        {
          file: SOURCE,
          oldString: `      direction.fromNorm,
      direction.toNorm,
      recordedApprover(approver),
      claim.claimed_at,`,
          newString: `      row.from_norm,
      row.to_norm,
      recordedApprover(approver),
      claim.claimed_at,`,
        },
      ],
      note: "The EDGE is written in the resolved direction and only the ROW records the proposed one, so the vocabulary is right and its audit trail is wrong. The next reader of the queue sees a decision that does not match the edge it produced.",
    },
    {
      label: "the EDGE is written in the proposed direction instead of the resolved one",
      edits: [
        {
          file: SOURCE,
          oldString: `  const applied = await approveAliasEdge(tx, workspaceId, {
    position: row.slot_position,
    fromNorm: direction.fromNorm,
    toNorm: direction.toNorm,
    approvedBy: recordedApprover(approver),
  });`,
          newString: `  const applied = await approveAliasEdge(tx, workspaceId, {
    position: row.slot_position,
    fromNorm: row.from_norm,
    toNorm: row.to_norm,
    approvedBy: recordedApprover(approver),
  });`,
        },
      ],
      note: "The mirror of the row above, and the one that actually re-keys the corpus: the human's direction is discarded and the producer's arbitrary order becomes the vocabulary.",
    },
    {
      label: "`approverEntitled`'s entity-position owner/admin bar dropped",
      edits: [
        { file: SOURCE, oldString: ENTITLEMENT_POSITION_ARMS, newString: `  return true;` },
      ],
      note: "Any authenticated member then approves an ENTITY edge — the one owner/admin gate the brain has (ADR-0037 §6), guarding evidence that is a warehouse row and content that IS the confidential bit.",
    },
    {
      label: "`approverEntitled` made owner/admin at EVERY position",
      edits: [
        {
          file: SOURCE,
          oldString: ENTITLEMENT_POSITION_ARMS,
          newString: `  return ctx.role === "owner" || ctx.role === "admin";`,
        },
      ],
      note: "The other direction, and the one a tidy-up produces: the two postures collapse onto the stricter bar. Predicate aliases stop being approvable by the members who can read the corpus they came from, and the distinction T11 §3(d) rests on disappears without any refusal looking wrong.",
    },
    {
      label: "the `unresolved`-origin arm admitted",
      edits: [
        {
          file: SOURCE,
          oldString: ENTITLEMENT_ORIGIN_ARMS,
          newString: `function approverEntitled(position: SlotPosition, ctx: BrainPrincipalContext): boolean {
  if (ctx.origin === "unauthenticated-local") return true;
  if (ctx.origin !== "authenticated") return true;`,
        },
      ],
      note: "Anchored on the signature because `authorEntitled` carries two near-identical lines. An unresolvable identity reaching the write then hits `recordedApprover`'s `unresolved` arm, which THROWS by design — so the observable failure is an error rather than an unattributed re-key, which is the direction that arm was built to force.",
    },
    {
      label: "the `unauthenticated-local` arm dropped (the local operator locked out)",
      edits: [
        {
          file: SOURCE,
          oldString: ENTITLEMENT_ORIGIN_ARMS,
          newString: `function approverEntitled(position: SlotPosition, ctx: BrainPrincipalContext): boolean {
  if (ctx.origin === "unauthenticated-local" && false) return true;
  if (ctx.origin !== "authenticated") return false;`,
        },
      ],
      note: "The fail-closed direction, and it is still a defect: a self-hosted no-auth deployment has DECLARED the local operator is the only identity there is, so this locks the only reader out of the vocabulary entirely.",
    },
    {
      label: "the workspace-mismatch guard dropped",
      edits: [
        {
          file: SOURCE,
          oldString: DECIDE_WORKSPACE_GATE,
          newString: `  if (approver.kind === "human" && approver.ctx.workspaceId !== workspaceId && false) {`,
        },
      ],
      note: "The proposal read below is workspace-scoped, so the row is still not FOUND — what is lost is refusing a scope escalation BEFORE the row is read under another workspace's identity, and the distinction between `workspace-mismatch` and `not_decidable` that says which happened.",
    },
    {
      label: "the machine-may-not-reject backstop dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (decision === "rejected" && approver.kind !== "human") {`,
          newString: `  if (decision === "rejected" && approver.kind !== "human" && false) {`,
        },
      ],
      note: "The RUNTIME half of a guard the type already makes unconstructible — #5025's route builds a decision out of a parsed HTTP body, where the compiler is not in the room. `rejectProposal`'s signature is narrowed to a human approver too, so the write itself still refuses; what this measures is whether the seam refuses at its entry.",
    },
    {
      label: "the local operator recorded as a machine",
      edits: [
        {
          file: SOURCE,
          oldString: `    case "unauthenticated-local":
      return LOCAL_OPERATOR_ACTOR;`,
          newString: `    case "unauthenticated-local":
      return null;`,
        },
      ],
      note: "`null` is the value migration 0189 defines as *auto-approved, no human* at the column it calls the one an audit of a workspace-wide re-key reads first. Scoped to the DECIDE STAMPS, which are the three of `recordedApprover`'s five call sites that pass the value through unchanged; the other two — propose and remove — spell `recordedApprover(…) ?? LOCAL_OPERATOR_ACTOR`, so the injected `null` is coalesced straight back there and their authorship is untouched.",
    },
    {
      label: "the human approver never recorded (`approved_by`/`reviewed_by` always NULL)",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (approver.kind === "auto") return null;`,
          newString: `  return null;`,
        },
      ],
      note: "The broader form of the row above: every arm of `recordedApprover` returns NULL, so the decide stamps never record a human. Not 'every path in the module' — the propose and remove sites coalesce to `LOCAL_OPERATOR_ACTOR`, which is why the label names the two columns rather than the function. The `switch` below is left statically unreachable, which is fine: the runner's instrument strips types.",
    },
    {
      label: "the apply refusal RETURNED instead of thrown",
      edits: [
        {
          file: SOURCE,
          oldString: `    throw new AliasApplyRefusedError(row.id, applied.refusal, applied.message);`,
          newString: `    return { kind: "refused", id: row.id, refusal: applied.refusal, message: applied.message };`,
        },
      ],
      note: "The claim onto `applying` is already written in this transaction and only a ROLLBACK undoes it, so returning the refusal COMMITS the claim and strands the row `applying` — invisible to the queue and undecidable forever. The throw's only job is to reach the rollback first.",
    },
    {
      label: "the catch broadened — every error becomes a refusal",
      edits: [
        {
          file: SOURCE,
          oldString: `    if (err instanceof AliasApplyRefusedError) {
      // An \`already-aliased\` or \`would-cycle\` refusal means a caller is`,
          newString: `    if (err instanceof Error) {
      // An \`already-aliased\` or \`would-cycle\` refusal means a caller is`,
        },
      ],
      note: "Anchored with the comment line because `authorAliasEdge` carries the same `instanceof` one seam over. Broadened, an unreachable database or a non-converging closure is reported as a typed refusal — the one class a caller must be able to tell apart from a decision.",
    },
    {
      label: "the claim's `status = 'pending'` predicate dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `      WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
          newString: `      WHERE workspace_id = $1 AND id = $2`,
        },
      ],
      note: "The claim then takes an already-`approved` row and re-applies it, so an approved pair's only remaining transition stops being removal. The stamp's own `status = 'applying'` arm is untouched — this row measures the CLAIM's conditionality alone.",
    },
    {
      label: "the `applying`-not-rejectable arm dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (row.status !== "pending" && row.status !== "approved") {`,
          newString: `  if (row.status !== "pending" && row.status !== "approved" && false) {`,
        },
      ],
      note: "An `applying` row is a decision in flight in another transaction. Admitting it rejects a row whose approval is mid-apply, and `removedEdge` reads `false` because the status is not yet `approved` — so the removal that the other transaction is committing is never undone.",
    },
    {
      label: "the vocabulary lock taken AFTER the proposal read",
      edits: [
        {
          file: SOURCE,
          oldString: `      await lockIdentityMutation(tx, workspaceId);

      const row = await loadProposal(tx, workspaceId, id);
      if (row === undefined) return { kind: "not_decidable", id };`,
          newString: `      const row = await loadProposal(tx, workspaceId, id);
      await lockIdentityMutation(tx, workspaceId);

      if (row === undefined) return { kind: "not_decidable", id };`,
        },
      ],
      note: "Anchored on the `loadProposal` line because `lockIdentityMutation` is called from three places. Both locks still get taken, so nothing here can deadlock in a single-process test — what the suite pins is the ORDER, by recording each transaction's statements and asserting the first one that touches anything is the lock.",
    },
    {
      label: "the lock taken in the WRONG namespace",
      edits: [
        {
          file: SOURCE,
          oldString: `  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);`,
          newString: `  await tx.query(VOCABULARY_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, workspaceId]);`,
        },
      ],
      note: "Spelled as 5024 rather than an invented number, because that is the confusion this module is one import away from making — and it is already in scope, so the mutation needs no new import. Taking 5024 where 5022 belongs stops the seam being mutually exclusive with `approveAliasEdge` and the region importer, which is precisely the failure recording PARAMS (not just statement text) exists to catch.",
    },
    {
      label: "the lock keyed on a CONSTANT instead of the workspace",
      edits: [
        {
          file: SOURCE,
          oldString: `  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);`,
          newString: `  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, "brain-vocabulary"]);`,
        },
      ],
      note: "Every workspace then serializes against every other on one key — correct, and catastrophically wide. Indistinguishable from the real thing in statement text, which is why the recorder keeps the params.",
    },
    {
      label: "`slot_position` asserted instead of narrowed",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!isSlotPosition(row.slot_position)) {`,
          newString: `  if (!isSlotPosition(row.slot_position) && false) {`,
        },
      ],
      note: "Reachable only by dropping 0190's CHECK, which its test does. The failure direction is PERMISSIVE: `isEntityPosition` answers `false` for anything outside `subject | object`, so an unknown position takes the PREDICATE arm and clears the bar for any authenticated member — an entitlement bypass sitting behind a constraint nobody re-checks.",
    },
    {
      label: "the eligible-but-refused row stops counting as `queued`",
      edits: [
        {
          file: SOURCE,
          oldString: `          counters.queued++;
          counters.refused++;`,
          newString: `          counters.refused++;`,
        },
      ],
      note: "That row IS queued and a human still has to decide it. Counting it under `refused` alone makes `queued` stop meaning *rows awaiting review*, which is the field's documented promise and the number a producer dashboard reads.",
    },
    {
      label: "`deduped` and `refused` swapped",
      edits: [
        {
          file: SOURCE,
          oldString: `      case "already_pending":
        counters.deduped++;`,
          newString: `      case "already_pending":
        counters.refused++;`,
        },
        {
          file: SOURCE,
          oldString: `        counters.refused++;
        break;
      case "queued": {`,
          newString: `        counters.deduped++;
        break;
      case "queued": {`,
        },
      ],
      note: "BOTH increments, because a swap is not two mutations. The second edit is anchored on the `case \"queued\"` that follows it, so it cannot pick the `already_pending` arm the first edit just rewrote — and the two are order-independent for that reason.",
    },
    {
      label: "the ingest path reverts to `identityVocabulary`",
      edits: [
        EXTRACT_IDENTITY_IMPORT,
        {
          file: EXTRACT,
          oldString: `  const vocabulary = await deps.loadVocabulary(episode.workspaceId);`,
          newString: `  const vocabulary = identityVocabulary;`,
        },
      ],
      note: "TWO edits, because a revert needs the import: `extract.ts` reaches `identity.ts` through a TYPE-only import today, and the suite's source-level tripwire matches on the IMPORT rather than on any mention (the prose explaining why a load failure is NOT degraded would otherwise trip it). Behaviourally the whole episode keys un-aliased — which no fixture could see before #5023, since every fixture workspace had an empty vocabulary and the two answers were byte-identical.",
    },
    {
      label: "the correctFact TOOL reverts to `identityVocabulary`",
      edits: [
        CORRECT_FACT_IDENTITY_IMPORT,
        {
          file: CORRECT_FACT_TOOL,
          oldString: `        vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),`,
          newString: `        vocabulary: identityVocabulary,`,
        },
      ],
      note: "The `loadWorkspaceVocabulary` import is deliberately LEFT in place: the tripwire first asserts each consumer still loads a vocabulary at all, and removing it would trip that backstop instead of the assertion this row is about. The behavioural coverage for this site is the `correct-fact-tool` column beside it, which is why that suite is a column at all.",
    },
    {
      label: "the admin route reverts to `identityVocabulary`",
      edits: [
        ADMIN_ROUTE_IDENTITY_IMPORT,
        {
          file: ADMIN_ROUTE,
          oldString: ADMIN_RETRACT_VOCABULARY,
          newString: `            verb: "retract",
            requestId,
            vocabulary: identityVocabulary,`,
        },
        {
          file: ADMIN_ROUTE,
          oldString: ADMIN_CORRECT_VOCABULARY,
          newString: `            // answer, and the empty vocabulary is not a safe one.
            vocabulary: identityVocabulary,`,
        },
      ],
      note: "BOTH admin call sites, spelled out because *the admin route* names two — the retract verb and the correct verb are separate `correctFact` calls with an identical `vocabulary:` line, so each is anchored on its own surrounding lines. Reverting one alone is a different mutation with a different number.",
    },
    {
      label: "the pair lookup loses its `slot_position` arm",
      edits: [
        {
          file: SOURCE,
          oldString: PAIR_LOOKUP_WHERE,
          newString: `      WHERE workspace_id = $1 AND $2::text IS NOT NULL
        AND pair_low = LEAST($3::text, $4::text) AND pair_high = GREATEST($3::text, $4::text)\`,`,
        },
      ],
      note: "`$2` is kept BOUND rather than removed, so the failure is the cross-position collision the label names and not a parameter-arity error that would fail the whole suite on a bind. The three positions are independent vocabularies: a pair aliased at `subject` then suppresses the same pair proposed at `predicate`.",
    },
    {
      label: "`approverEntitled` narrowed to owner only (admins locked out)",
      edits: [
        {
          file: SOURCE,
          oldString: ENTITLEMENT_POSITION_ARMS,
          newString: `  if (!isEntityPosition(position)) return true;
  return ctx.role === "owner";`,
        },
      ],
      note: "The fail-closed direction of the same bar, and ADR-0037 §6 says owner OR admin — `acl.ts` spells the identical pair for the audit override. A workspace whose only owner has left cannot decide its vocabulary at all.",
    },
    {
      label: "`resolveDirection`'s same-norm conjunct dropped",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!pair.includes(fromNorm) || !pair.includes(toNorm) || fromNorm === toNorm) {`,
          newString: `  if (!pair.includes(fromNorm) || !pair.includes(toNorm)) {`,
        },
      ],
      note: "`pair.includes` passes for a direction whose two sides are the SAME norm — it is in the pair, twice. Without this conjunct a self-edge reaches `approveAliasEdge`, where the schema's `ck_..._not_self` refuses it by throwing instead of the seam refusing it by returning.",
    },
    {
      label: "the ingest load DEGRADED to the empty vocabulary on failure",
      edits: [
        EXTRACT_IDENTITY_IMPORT,
        {
          file: EXTRACT,
          oldString: `  const vocabulary = await deps.loadVocabulary(episode.workspaceId);`,
          newString: `  const vocabulary = await deps
    .loadVocabulary(episode.workspaceId)
    .catch(() => identityVocabulary);`,
        },
      ],
      note: "The failure semantics `extract.ts` spends twenty lines forbidding. It carries the import edit for the same reason the revert above does, so it trips the tripwire too — the distinguishing half is that the load still SUCCEEDS on a healthy workspace, so the alias wiring keeps working and only the throw path changes. The degrade keys the whole episode into the slot the vocabulary exists to move it OUT of: an under-match today, an over-match the moment an entry merges two spellings, and neither visible at rest.",
    },
    {
      label: "the correctFact TOOL hands over an inline identity vocabulary",
      edits: [
        {
          file: CORRECT_FACT_TOOL,
          oldString: `        vocabulary: await loadWorkspaceVocabulary(ctx.workspaceId),`,
          newString: `        vocabulary: ${INLINE_IDENTITY},`,
        },
      ],
      note: "NO import edit, and that is the whole point of the row: this is the revert a source-level tripwire cannot see. The `loadWorkspaceVocabulary` import survives (unused), so the tripwire's `includes` check still passes and only a test asserting the vocabulary the caller actually handed over can kill it.",
    },
    {
      label: "the admin route hands over an inline identity vocabulary",
      edits: [
        {
          file: ADMIN_ROUTE,
          oldString: ADMIN_RETRACT_VOCABULARY,
          newString: `            verb: "retract",
            requestId,
            vocabulary: ${INLINE_IDENTITY},`,
        },
        {
          file: ADMIN_ROUTE,
          oldString: ADMIN_CORRECT_VOCABULARY,
          newString: `            // answer, and the empty vocabulary is not a safe one.
            vocabulary: ${INLINE_IDENTITY},`,
        },
      ],
      note: "Both admin sites again, and no import edit — the tripwire-invisible form. On the retract verb the value is loaded and never read, so only the correct/supersede site changes an answer; that asymmetry is why reverting one site alone would measure something different.",
    },
    {
      label: "`recordedApprover` collapses every human onto the local-operator sentinel",
      edits: [
        {
          file: SOURCE,
          oldString: `  switch (approver.ctx.origin) {
    case "authenticated":
      return approver.ctx.userId;`,
          newString: `  switch (approver.ctx.origin) {
    case "authenticated":
      return LOCAL_OPERATOR_ACTOR;`,
        },
      ],
      note: "The `ctx.userId ?? SENTINEL` spelling the switch exists to refuse, reached from the other side: every authenticated approver is recorded as the declared local operator, so `approved_by` stops naming who re-keyed the corpus without ever being NULL.",
    },
    {
      label: "the machine-may-not-reject refusal downgraded to `not-entitled`",
      edits: [
        {
          file: SOURCE,
          oldString: `      refusal: "machine-may-not-reject",`,
          newString: `      refusal: "not-entitled",`,
        },
      ],
      note: "The refusal still refuses; it says the wrong thing. `not-entitled` is a 403 a DIFFERENT user could satisfy, and this is *no actor of this class may ever do this* — the distinction #5025's route maps to a response, and the reason the member exists rather than reusing `not-entitled`.",
    },
    {
      label: "the entitlement bar scoped to the APPROVE verb only",
      edits: [
        {
          file: SOURCE,
          oldString: `      if (approver.kind === "human" && !approverEntitled(position, approver.ctx)) {`,
          newString: `      if (decision === "approved" && approver.kind === "human" && !approverEntitled(position, approver.ctx)) {`,
        },
      ],
      note: "REJECTION is the graver verb — on an approved row it is a removal that drops an edge a human approved and writes memory no producer can undo — so a bar that holds only on approve lets any member undo an owner's entity edge.",
    },
    {
      label: "the workspace-mismatch guard scoped to the APPROVE verb only",
      edits: [
        {
          file: SOURCE,
          oldString: DECIDE_WORKSPACE_GATE,
          newString: `  if (decision === "approved" && approver.kind === "human" && approver.ctx.workspaceId !== workspaceId) {`,
        },
      ],
      note: "The same asymmetry one guard over: a reviewer from another workspace can no longer approve but can still attempt a removal, which is the verb that destroys state rather than creating it.",
    },
    {
      label: "the unreadable-settings-tier latch dropped (#5162)",
      edits: [
        {
          file: SOURCE,
          oldString: `  if (!settingsCacheEverLoaded()) {`,
          newString: `  if (!settingsCacheEverLoaded() && false) {`,
        },
      ],
      note: "Both knobs are workspace-scoped with a PERMISSIVE default, so a workspace opts out by writing a DB override — and an override that cannot be read is indistinguishable from one never written. On the one boot where the first `loadSettings` fails, an opted-out workspace resolves to the shipped defaults and auto-approves again.",
    },
    {
      label: "the settings-unreadable refusal message replaced by the policy one (#5162)",
      edits: [
        {
          file: SOURCE,
          oldString: `      const settingsUnreadable = !settingsCacheEverLoaded();`,
          newString: `      const settingsUnreadable = false;`,
        },
      ],
      note: "The refusal is unchanged; only its EXPLANATION is. *The settings narrow that further* is FALSE when the settings were never read, and it sends an operator to inspect two knobs that are set correctly while the real cause — one failed `loadSettings` at boot — appears nowhere in the response.",
    },
  ],
};

export default spec;
