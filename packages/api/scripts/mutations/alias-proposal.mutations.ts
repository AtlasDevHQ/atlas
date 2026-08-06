/**
 * The alias-proposal query, measured (#5034, ADR-0037 §4).
 *
 * ## What this table has to prove
 *
 * On day one the query returns zero rows for want of populated `object_cmp`, so
 * EVERY prohibition in this slice passes green against a statement that matches
 * nothing at all. The corpus's firing cases are what make the columns non-zero;
 * read the two `restatement` / `seen-twice` rows first, because a mutation that
 * kills only prohibitions and none of the controls is a mutation that switched
 * the machinery off rather than one that changed its rule.
 *
 * The FIRST TWO columns are complements and are worth reading against each
 * other. The `-pg` suite is the only lane that can see WHICH ROWS the three arms
 * admit; the fast lane sees binds, the ranking rules and the statement's TEXT.
 * That is why several SQL rows below are 0 in the fast lane and several
 * TypeScript rows are 0 in the `-pg` one — neither is a superset of the other.
 * The other two columns are narrower by design and mostly zeros:
 * `alias-proposal-logging.test.ts` is the OPERATOR-LINE column and
 * `extract-reconcile-pg.test.ts` is the WIRING's.
 *
 * Every mutation LISTED below dies in at least one column, with ONE stated
 * exception — and "listed" is deliberate: the list is curated, not exhaustive,
 * so it is evidence about the suites' reach and never a proof that nothing else
 * survives.
 *
 * ⚠️ TWO rows are exceptions — *the post-deadline continuation is deleted* and
 * *the cross-tenant skip is silent* — and they share one named closure rather
 * than being untestable: both need the logger mocked on the EXTRACT path (an
 * `extract-logging.test.ts` on `acl-logging.test.ts`'s pattern), which this
 * slice does not add. Two rows wanting the same file is the argument for
 * building it next. Read their notes before treating either `0` as evidence.
 *
 * ⚠️ **FOUR rows in this file have shipped as measured NO-OPS across the review
 * rounds** — and the fourth was created by the round that announced it had
 * cleaned up the other three, when a code edit invalidated a row's anchor — one splicing `${…}` as literal text into a module importing
 * neither, one appending a duplicate `pending` to a `Promise.race`, one leaving a
 * `new Promise` executor in place so `setTimeout` still ran. Each published a
 * `0` that measured nothing. Before believing a zero, read the edit and ask what
 * the mutant actually does.
 *
 * The remaining zeros are all of one kind — a SQL mutation invisible to a lane that never runs SQL, or a
 * TypeScript one invisible to a lane whose assertions are about which rows
 * matched — and none of them is a mutation nothing catches.
 *
 * ⚠️ The two `-pg` columns can flake under concurrent scratch-DB contention, so
 * a cell that surprises you is worth re-running that row alone before treating
 * it as evidence. Panel round 2 re-measured the negated-tier-guard row's third
 * column as 0 where generation recorded 1; two subsequent regenerations both
 * recorded 1. Generated numbers are maintained by re-running, never by editing.
 *
 * Both suites need `TEST_DATABASE_URL` for the `-pg` column; without it that
 * column is 0 for a reason that has nothing to do with coverage:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import type { MutationSpec } from "../mutation-spec";
// Imported so the negated-tier-guard row splices the SAME list `supersedableTierSql`
// does. A hand-typed `ARRAY['slack', …]` here would be a second spelling that goes
// stale the day a source is added — and this row already shipped once measuring the
// wrong list (#5060).
import { episodeSourceArraySql, NON_WAREHOUSE_SOURCES } from "../../src/lib/brain/sources";

const ALIAS = "src/lib/brain/alias-proposal.ts";
const SOURCES = "src/lib/brain/sources.ts";
const EXTRACT = "src/lib/brain/extract.ts";
const RECONCILE = "src/lib/brain/reconcile.ts";
const PG_ENV = {
  TEST_DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5433/brain_4771_scratch",
};

const spec: MutationSpec = {
  title: "Mutations the alias-proposal suites catch",
  out: "scripts/mutations/alias-proposal.md",
  targets: [
    {
      name: "alias-proposal-pg.test.ts",
      file: "src/lib/brain/__tests__/alias-proposal-pg.test.ts",
      env: PG_ENV,
    },
    { name: "alias-proposal.test.ts", file: "src/lib/brain/__tests__/alias-proposal.test.ts" },
    {
      // The OPERATOR-LINE column. Two of this module's log statements are the
      // only thing separating states that are byte-identical to every caller,
      // and both were deletable-green before this suite existed.
      name: "alias-proposal-logging.test.ts",
      file: "src/lib/brain/__tests__/alias-proposal-logging.test.ts",
    },
    {
      // The WIRING's column, and it is mostly zeros by design: this suite owns
      // WHEN the producer is asked, not what it finds. The two rows at the
      // bottom of the table are the ones it exists for, and they are 0 in both
      // other columns — nothing else in the slice can see the trigger at all.
      name: "extract-reconcile-pg.test.ts",
      file: "src/lib/brain/__tests__/extract-reconcile-pg.test.ts",
      env: PG_ENV,
    },
  ],
  preamble: `
Source: \`${ALIAS}\` (\`ALIAS_PROPOSAL_SQL\`, \`applyHintRanks\`, \`toCandidate\`),
plus the direction vocabulary in \`${SOURCES}\`.
Mutation list: \`scripts/mutations/alias-proposal.mutations.ts\`.

The first three rows are the ones to read. Each is a *widening* — the direction
where an over-matching proposal query puts a workspace-wide re-key in front of a
reviewer wearing a confidence score, which is exactly the failure ADR-0037 §4
prohibits by name. None of them has a symptom at rest.
`,
  mutations: [
    {
      label: "the object arm relaxes from EQUAL to both-present (`=` → `IS NOT NULL`)",
      edits: [
        {
          file: ALIAS,
          oldString: `       AND \${comparableSameSql("b.object_cmp", "a.object_cmp")}`,
          newString: "       AND b.object_cmp IS NOT NULL",
        },
      ],
      note: "⭐ THE defect. It is the obvious way to make the query 'cover' #5000 — and it turns structural evidence into a near-miss detector wearing a structural hat: every `Business tier` predicate pair in the workspace becomes a candidate, ranked by nothing, and two claims that CONTRADICT each other are proposed as synonyms.",
    },
    {
      label: "the subject arm is dropped",
      edits: [
        {
          file: ALIAS,
          oldString: "       AND b.subject_key = a.subject_key\n",
          newString: "",
        },
      ],
      note: "Agreement about an object stops being agreement about a CLAIM. Four tiers that happen to cost the same would propose an alias for every pair of predicates used to describe them — and the arm is also half of what keeps `led_by`/`leads` out.",
    },
    {
      label: "the predicate arm weakens to `>=`, so every row joins itself",
      edits: [
        {
          file: ALIAS,
          oldString: "       AND b.predicate_key > a.predicate_key",
          newString: "       AND b.predicate_key >= a.predicate_key",
        },
      ],
      note: "Every predicate becomes its own alias candidate. `proposeAliasEdge` refuses the self-edge, so nothing reaches the queue — the visible damage is a counter that reports refusals forever and a `warn` per predicate per episode, and the real damage is that the pair count stops meaning anything.",
    },
    {
      label: "the repeat gate counts EVIDENCE ROWS instead of distinct subjects",
      edits: [
        {
          file: ALIAS,
          oldString: "         COUNT(DISTINCT subject_key)::int   AS subjects,",
          newString: "         COUNT(*)::int   AS subjects,",
        },
        {
          file: ALIAS,
          oldString: "  HAVING COUNT(DISTINCT subject_key) >= $2",
          newString: "  HAVING COUNT(*) >= $2",
        },
      ],
      note: "One subject repeating itself has told us about that subject. A company with two offices clears a subject-counting gate never and a row-counting gate immediately, which is the whole reason the gate counts subjects.",
    },
    {
      label: "the repeat gate is switched off (threshold 2 → 1)",
      edits: [
        {
          file: ALIAS,
          oldString: "export const ALIAS_PROPOSAL_REPEAT_THRESHOLD = 2;",
          newString: "export const ALIAS_PROPOSAL_REPEAT_THRESHOLD = 1;",
        },
      ],
      note: "A lone coincidental object match becomes work: `Acme / founded / 2019` beside `Acme / incorporated / 2019` reaches a reviewer as a proposed synonym. ADR-0037 §4's own worked example of what the gate is for.",
    },
    {
      label: "the direction rule fires when EITHER side is warehouse-derived",
      edits: [
        {
          file: ALIAS,
          oldString: "  const directed = fromWarehouse !== toWarehouse;",
          newString: "  const directed = fromWarehouse || toWarehouse;",
        },
      ],
      note: "Two warehouse columns for one quantity would be directed at whichever side the byte ordering put second — a workspace-wide re-key chosen by `<` rather than by evidence.",
    },
    {
      label: "the direction rule stops swapping, so the target is arrival order",
      edits: [
        {
          file: ALIAS,
          oldString: "  if (directed && fromWarehouse) {",
          newString: "  if (false) {",
        },
      ],
      note: "`directed: true` with the ENGLISH side as the target re-keys the warehouse's own rows onto a phrase nobody's schema contains. A test asserting only the flag cannot see it, which is why the corpus asserts the target.",
    },
    {
      label: "the direction arm is written as the NEGATED tier guard",
      edits: [
        {
          file: ALIAS,
          oldString:
            "  return `(${alias}.provenance->>'source' = ANY (${WAREHOUSE_SOURCE_ARRAY_SQL}))`;",
          // ⚠️ SPELLED WITH `NON_WAREHOUSE_SOURCES`, which is what
          // `supersedableTierSql` actually splices. The first cut of this row
          // negated the WAREHOUSE list instead — that is a different mutation
          // (it inverts the allowlist for in-vocabulary values) and it killed
          // the two warehouse cases while `unclassifiable-source`, the case
          // whose entire purpose is this row, survived it. #5060's lesson:
          // record a mutation's exact SPELLING, because two defensible readings
          // of one label produce two different numbers.
          newString:
            "  return `(NOT (NOT jsonb_exists(${alias}.provenance, 'source')\n      OR ${alias}.provenance->>'source' = ANY (" +
            // CONCATENATED, not interpolated into the string above. `${…}` inside
            // a double-quoted string is literal text, so the first cut spliced
            // `${episodeSourceArraySql(NON_WAREHOUSE_SOURCES)}` verbatim into a
            // file that imports neither — the mutant then died on a ReferenceError
            // rather than on the rule, i.e. the cell measured a CRASH. `${alias}`
            // above IS meant to stay literal: it is the TARGET file's own
            // interpolation.
            episodeSourceArraySql(NON_WAREHOUSE_SOURCES) +
            ")))`;",
        },
      ],
      note: "The tidy-looking simplification, and it is wrong in both directions: the two rules differ on EXACTLY ONE population and it is the dangerous one — a kind this region cannot classify reads as warehouse-derived, i.e. evidence of nothing becoming evidence of a direction. (A `source`-less row answers false under BOTH, because the guard's carve-out is an `OR`; measured against Postgres, not reasoned about.) #5033's allowlist argument, arriving where the consequence is a proposed target rather than a stamp. Killed by `unclassifiable-source`, which exists for this row.",
    },
    {
      label: "the direction fold is `bool_and` instead of `bool_or`",
      edits: [
        {
          file: ALIAS,
          oldString: "         COALESCE(bool_or(from_warehouse), false) AS from_warehouse,\n         COALESCE(bool_or(to_warehouse), false)   AS to_warehouse",
          newString: "         COALESCE(bool_and(from_warehouse), false) AS from_warehouse,\n         COALESCE(bool_and(to_warehouse), false)   AS to_warehouse",
        },
      ],
      note: "Invisible to a corpus whose provenance is uniform within every group, which every warehouse case was until `mixed-provenance` landed. Under `bool_and` one subject whose warehouse row has not arrived yet silently un-directs the pair and hands a human a choice the evidence could have made.",
    },
    {
      label: "the JOIN stops scoping to one workspace (the `WHERE` stays)",
      edits: [
        {
          file: ALIAS,
          oldString: "        ON b.workspace_id = a.workspace_id\n",
          newString: "        ON true\n",
        },
      ],
      note: "The REALISTIC scope leak, and the one worth reading beside the `WHERE`-deleting row below: this one is valid SQL that returns wrong rows, where deleting the `WHERE` leaves `$1` unbound and every statement errors. A workspace-wide re-key proposed from a NEIGHBOURING TENANT'S claims.",
    },
    {
      label: "a subject key graduates into the projection",
      edits: [
        {
          file: ALIAS,
          oldString: "  SELECT from_norm,\n         to_norm,\n         COUNT(DISTINCT subject_key)::int   AS subjects,",
          newString: "  SELECT from_norm,\n         to_norm,\n         MAX(subject_key) AS subject_key,\n         COUNT(DISTINCT subject_key)::int   AS subjects,",
        },
      ],
      note: "The row that measures what this module's `keys-not-on-the-wire.test.ts` exemption is worth. It dies in `alias-proposal.test.ts`'s exact-columns pin, which is the file-local replacement for the repo-wide guard the exemption switched off. ⚠️ It would NOT die in `keys-not-on-the-wire.test.ts` — that is the whole point of the exemption — but that is reasoning rather than a measured cell, since adding a fourth column to run every row against a scan this slice does not otherwise touch would cost more than it tells anyone.",
    },
    {
      label: "the cap stops ordering by evidence",
      edits: [
        {
          file: ALIAS,
          oldString: "   ORDER BY COUNT(DISTINCT subject_key) DESC, from_norm, to_norm\n",
          newString: "   ORDER BY from_norm, to_norm\n",
        },
      ],
      note: "`ALIAS_PROPOSAL_CANDIDATE_CAP`'s whole correctness claim is *a truncated run drops the WEAKEST evidence*, and it rests entirely on this clause. Without it a bounded run drops an alphabetically arbitrary slice and the reviewer's attention is allocated by `from_norm`.",
    },
    {
      label: "the object arm admits two NULLs as agreement (`=` → `IS NOT DISTINCT FROM`)",
      edits: [
        {
          file: ALIAS,
          oldString: `       AND \${comparableSameSql("b.object_cmp", "a.object_cmp")}`,
          newString: "       AND b.object_cmp IS NOT DISTINCT FROM a.object_cmp",
        },
        {
          file: ALIAS,
          oldString: "       AND a.object_cmp IS NOT NULL\n",
          newString: "",
        },
      ],
      note: "The NULL-safe spelling, which reads as a fix for the day-one zero-rows problem and is the widest possible widening: every predicate pair whose objects are both unparseable becomes a candidate. ⚠️ TWO edits, and the second is the finding: with `a.object_cmp IS NOT NULL` still in the `WHERE`, the rewrite returns nothing — the arm this module's docstring called redundant is redundant only under the `=` spelling. `prod-5000-pair` is what catches the full relaxation, which is the value that entry carries beyond the equality arm.",
    },
    {
      label: "the query stops scoping to one workspace",
      edits: [
        {
          file: ALIAS,
          oldString: "     WHERE a.workspace_id = $1\n",
          newString: "",
        },
      ],
      note: "⚠️ **Read this count as a CRASH, not as detection.** Deleting the `WHERE` leaves `$1` unreferenced, so Postgres rejects the bind and every SQL-running test errors — which is why the number is nearly the whole file. The realistic scope leak is the `ON true` row above, which is valid SQL returning wrong rows; that one is genuinely detected, by the two-tenant test.",
    },
    {
      label: "the trigger gate reads only the FIRST candidate's comparable",
      edits: [
        {
          file: RECONCILE,
          oldString: "        const item = prepared[index];",
          newString: "        const item = prepared[0];",
        },
      ],
      note: "`comparable` is the alias producer's sole trigger, and it is counted through a positional correlation the compiler cannot check. Invisible to a corpus of single-candidate episodes — which every trigger fixture was until a mixed batch landed — and the failure is silent in the expensive direction: the count reads 0, the trigger never fires, and the producer retires with a green suite.",
    },
    {
      label: "the query reads tombstoned and superseded rows as evidence",
      edits: [
        {
          file: ALIAS,
          oldString: "       AND b.invalidated_at IS NULL\n       AND b.valid_to IS NULL\n",
          newString: "",
        },
        {
          file: ALIAS,
          oldString: "\n       AND a.invalidated_at IS NULL\n       AND a.valid_to IS NULL",
          newString: "",
        },
      ],
      note: "Both sides at once, because the two arms are one decision. A belief a human retired is not evidence of what this workspace's producers say NOW, and proposing a workspace-wide re-key off one resurrects a decision somebody already made. The arms are also what put both sides of the self-join on `idx_brain_facts_subject`, which is PARTIAL on exactly this predicate — ADR-0037 §4's *costing no new index* depends on them.",
    },
    {
      label: "an extractor hint may become a candidate",
      edits: [
        {
          file: ALIAS,
          oldString: "  return candidates.map((candidate) => ({\n    candidate,\n    confidence: hintedRank(candidate, hints),\n  }));",
          newString:
            "  const minted = hints.map((hint) => ({\n    fromNorm: hint.norms[0],\n    toNorm: hint.norms[1],\n    subjects: 2 as never,\n    directed: false,\n  }));\n  return [...candidates, ...minted].map((candidate) => ({\n    candidate,\n    confidence: hintedRank(candidate, hints),\n  }));",
        },
      ],
      note: "⭐ ADR-0037 §4's prohibition, mutated directly. An extractor asked for a canonical predicate always produces one — it cannot abstain — so this fills the queue with confident, unfalsifiable noise, and `led_by`/`leads` is the first thing it queues.",
    },
    {
      label: "the pair key joins on a SPACE instead of a NUL",
      edits: [
        {
          file: ALIAS,
          oldString: "const PAIR_KEY_SEPARATOR = String.fromCharCode(0);",
          newString: 'const PAIR_KEY_SEPARATOR = " ";',
        },
      ],
      note: "`lexicalNorm` unifies every separator to a single space, so norms are full of them: `{\"is priced\", \"at cost\"}` and `{\"is\", \"priced at cost\"}` would key identically and a hint for one would rank the other. Reachable with ordinary English predicates.",
    },
    {
      label: "the reader defaults an unreadable repeat count instead of dropping the row",
      edits: [
        {
          file: ALIAS,
          oldString:
            "    typeof row.subjects !== \"number\" ||\n    !Number.isInteger(row.subjects) ||\n    row.subjects < ALIAS_PROPOSAL_REPEAT_THRESHOLD ||",
          newString: "",
        },
      ],
      note: "A statement that drifted from its reader would manufacture a repeat count nothing measured — `NaN` clears no threshold in SQL but reaches `confidence` as a value 0190's CHECK rejects, so the pair silently stops queuing while the producer reports success.",
    },
    {
      label: "the rank is a constant, so evidence stops ordering the queue",
      edits: [
        {
          file: ALIAS,
          oldString: "  return 1 - 1 / (subjects + 1);",
          newString: "  return 0.5;",
        },
      ],
      note: "The cap drops the WEAKEST evidence first, and with a flat rank it drops an arbitrary 25. The queue also stops surfacing the best-supported pair first, which is the only thing a reviewer's attention is allocated by.",
    },
    {
      label: "the hint bonus can push a rank past the CHECK",
      edits: [
        {
          file: ALIAS,
          oldString: "  return Math.min(1, isHinted ? base + ALIAS_HINT_RANK_BONUS : base);",
          newString: "  return isHinted ? base + ALIAS_HINT_RANK_BONUS : base;",
        },
      ],
      note: "Unreachable from any corpus on today's curve — see the trigger rows below for the other half of the slice — — `structuralConfidence` is asymptotic to 1 and the bonus is 0.05, so a pair would need ~19 distinct subjects to cross — which is exactly why the fast lane reaches for the arithmetic directly rather than for a fixture. A hinted pair pushed past 1 does not queue at high confidence: `proposeAliasEdge` refuses it as `confidence-out-of-range` and it does not queue at all.",
    },
    {
      label: "the statement bound is set to `0` — Postgres for NO timeout",
      edits: [
        {
          file: ALIAS,
          oldString: "export const ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '10s'`;",
          newString: "export const ALIAS_PROPOSAL_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '0'`;",
        },
      ],
      note: "⭐ Invisible to a test that compares the issued statement against the constant that produced it — both sides move together. ⚠️ `0` does NOT restore the wedge — `ALIAS_PROPOSAL_DEADLINE_MS` still advances the drain. What it destroys is the RECLAIM: the statement runs on holding one of five pooled connections and `withBrainTransaction`'s `finally` never reaches `client.release()`. The `-pg` bound test reads the value back out of the session, which is the only assertion that can see it.",
    },
    {
      label: "the bounds never reach the PROPOSE half",
      edits: [
        {
          file: ALIAS,
          oldString: "  return proposeAliasEdges(workspaceId, inputs, SEAM_PROPOSAL_PRODUCER, boundedDeps);",
          newString: "  return proposeAliasEdges(workspaceId, inputs, SEAM_PROPOSAL_PRODUCER, deps);",
        },
      ],
      note: "`proposeAliasEdge` takes the workspace vocabulary lock; unbounded, the `lock_timeout` half is gone and a human mid-approval can block the producer indefinitely. The claim *every statement this producer causes is covered* was unproven until the `-pg` bound test asserted the settings inside the propose transactions too.",
    },
    {
      label: "the JS deadline around the trigger is removed",
      edits: [
        {
          file: EXTRACT,
          // FAITHFUL: the whole race — timer arming included — collapses to a
          // bare await. TWO earlier cuts of this row were semantic no-ops: the
          // first appended a second `pending` to the race array (`Promise.race([p,
          // p, timer])` ≡ `Promise.race([p, timer])`), and the second left the
          // `new Promise` executor in place, so `setTimeout` still ran and the
          // timer recorder still saw its timer. Both published `0` cells that
          // measured nothing. #5033's lesson twice over: record the exact
          // SPELLING, and a survivor means the mutation missed.
          oldString: "    await Promise.race([\n      pending,\n      new Promise<never>((_resolve, reject) => {\n        timer = setTimeout(() => {\n          timedOut = true;\n          reject(\n            new Error(\n              `the alias-proposal producer did not answer within ${deps.aliasProposalDeadlineMs}ms \u2014 most likely an internal database that is reachable but not responding, or a batch spending its budget waiting on the workspace vocabulary lock, which ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL treats as an expected outcome`,\n            ),\n          );\n        }, deps.aliasProposalDeadlineMs);\n      }),\n    ]);\n",
          newString: "    await pending;\n",
        },
      ],
      note: "⭐ The bound that lets the DRAIN advance, and the one the `SET LOCAL` pair cannot provide — `withBrainTransaction` issues `BEGIN` before the callback, so those settings cannot bound their own arrival. Killed WITHOUT a hang by the timer recorder in `extract-reconcile-pg.test.ts`, which asserts exactly one timer is armed at `ALIAS_PROPOSAL_DEADLINE_MS` and that the fast path disarms it — the second assertion independently guards the `finally`-on-the-timer-promise bug `correction.ts` shipped once. The technique was already in `correction.test.ts` guarding the identical defect; an earlier version of this note claimed that machinery was not built here, which was the other half of the same mistake.",
    },
    {
      label: "the per-tick breaker never trips, so every stalled episode leaks a connection",
      edits: [
        {
          file: EXTRACT,
          oldString: "    if (timedOut) deps.proposalStall.stalled = true;\n",
          newString: "",
        },
      ],
      note: "⭐ Round 3's finding, and it is a hazard the DEADLINE created: a stall preceding the first `SET LOCAL` leaves `withBrainTransaction` parked on `BEGIN` with a client checked out and never released, and a drain that now advances checks out another for every later episode in the tick — `BATCH_SIZE` of them exhausts a pool bounded at 5 and takes down every unrelated internal query in the process.",
    },
    {
      label: "the breaker is consulted but never blocks",
      edits: [
        {
          file: EXTRACT,
          // RE-ANCHORED after the skip LOG landed this round. Two rows in this
          // file have now been invalidated by a later round's edit to the code
          // they mutate — which is the argument for re-running the whole spec
          // after any change to the module, not just the rows you touched.
          oldString: "  if (deps.proposalStall.stalled) {",
          newString: "  if (false) {",
        },
      ],
      note: "The read half of the same guard. Separated from the write half because a breaker that trips and is not read, and one that is read and never trips, fail identically from the outside and are two different edits.",
    },
    {
      label: "the post-deadline continuation is deleted",
      edits: [
        {
          file: EXTRACT,
          oldString: "    void pending\n      .then(",
          newString: "    void (async () => {})().then(",
        },
      ],
      note: "⚠️ MEASURED ZERO, and stated rather than hidden. `Promise.race` marks the LOSER's rejection handled, so a real store failure arriving after the deadline is dropped with no line and not even an unhandled rejection — while the timeout line an operator holds says the fate is unknown and a follow-up will say which. Falsifying it needs the LOGGER mocked on the extract path, i.e. an `extract-logging.test.ts` on `acl-logging.test.ts`'s pattern; that file does not exist and this slice does not add it. The technique is `correction.test.ts`'s late-settle fake — this is a named gap with a known closure, not an untestable one."
    },
    {
      label: "the all-rows-dropped ERROR is silenced",
      edits: [
        {
          file: ALIAS,
          oldString: "  if (rows.length > 0 && candidates.length === 0) {",
          newString: "  if (false) {",
        },
      ],
      note: "The only line distinguishing *the reader has drifted from the statement* from *the corpus supports nothing* — two states byte-identical to every caller, and under drift the `debug` line below logs the FALSE one. `extract.ts` discards the counters, so nothing else could tell.",
    },
    {
      label: "the truncation WARN is silenced",
      edits: [
        {
          file: ALIAS,
          oldString: "  if (rows.length >= cap) {",
          newString: "  if (false) {",
        },
      ],
      note: "The only line that makes a bounded run legible as bounded — `ALIAS_PROPOSAL_CANDIDATE_CAP`'s docstring sends an operator here when a proposal is missing, and without it \"25 candidates\" reads as a total rather than a floor.",
    },
    {
      label: "the producer queues only the FIRST candidate",
      edits: [
        {
          file: ALIAS,
          oldString: "  return proposeAliasEdges(workspaceId, inputs, SEAM_PROPOSAL_PRODUCER, boundedDeps);",
          newString: "  return proposeAliasEdges(workspaceId, inputs.slice(0, 1), SEAM_PROPOSAL_PRODUCER, boundedDeps);",
        },
      ],
      note: "A silent truncation to one pair. Invisible to every corpus case, because none expects MORE than one — nine fire with exactly one and five expect none — only the two-pair cap workspace can see it, and `log.info` would honestly report `candidates: 1` with no signal that the rest were dropped.",
    },
    {
      label: "the trigger's DEFAULT producer is replaced with a no-op",
      edits: [
        {
          file: EXTRACT,
          oldString: "    deps.proposeAliases ?? ((workspaceId: string) => proposeAliasesFromCorpus(workspaceId));",
          newString: "    deps.proposeAliases ?? (() => Promise.resolve(undefined));",
        },
      ],
      note: "⭐ The producer's ONE production call path. Every trigger test injects a fake and every pre-existing test has `comparable === 0`, so before the end-to-end default test this killed nothing — a wrong binding or an import cycle would have shipped green with the feature dead, and `extract.ts` catches and warns rather than failing the episode. #5022's *a store whose reader had no caller*, one indirection deeper.",
    },
    {
      label: "`COALESCE` is dropped, so an all-NULL group reads as `null`",
      edits: [
        {
          file: ALIAS,
          oldString: "         COALESCE(bool_or(from_warehouse), false) AS from_warehouse,\n         COALESCE(bool_or(to_warehouse), false)   AS to_warehouse",
          newString: "         bool_or(from_warehouse) AS from_warehouse,\n         bool_or(to_warehouse)   AS to_warehouse",
        },
      ],
      note: "The population no corpus case can reach by construction: a row carrying NO `source` key at all, so `= ANY(…)` is unknown and `bool_or` over the group answers NULL. The reader's `typeof … !== \"boolean\"` arm then DROPS the candidate rather than mis-directing it — fail-closed, and the `-pg` test that strips `provenance -> source` by hand is what shows it.",
    },
    {
      label: "the trigger runs on EVERY episode, gate or no gate",
      edits: [
        {
          file: EXTRACT,
          oldString: "  if (report.comparable === 0) return;\n",
          newString: "",
        },
      ],
      note: "A corpus-wide self-join per episode, forever, on a workspace where the query provably cannot find anything — `object_cmp` is never backfilled and there is no entity store, so today that is very nearly every episode. It has no symptom beyond latency, which is the kind that is never found.",
    },
    {
      label: "the trigger is never reached at all",
      edits: [
        {
          file: EXTRACT,
          oldString: "  await proposeAliasesAfterCommit(episode, report, deps);\n",
          newString: "",
        },
      ],
      note: "The producer keeps its whole test suite and stops having a caller — #5022's *a store whose reader had no caller* one slice over, and the only column that can see it is this one.",
    },
    {
      label: "the per-tick breaker trips on ANY failure, not only a timeout",
      edits: [
        {
          file: EXTRACT,
          oldString: "    if (timedOut) deps.proposalStall.stalled = true;",
          newString: "    deps.proposalStall.stalled = true;",
        },
      ],
      note: "⚠️ The breaker's CONDITION, which round 3 added and did not falsify. `ALIAS_PROPOSAL_LOCK_TIMEOUT_SQL` calls `55P03` a DESIGNED outcome — a human mid-approval — so under this mutant one expected lock timeout retires the producer for the rest of the tick and up to `BATCH_SIZE - 1` episodes silently skip. A rejection released its connection on the way out; only a timeout may still hold one.",
    },
    {
      label: "the breaker is allocated at MODULE scope, so it never resets",
      edits: [
        {
          file: EXTRACT,
          oldString: "    const proposalStall = { stalled: false };",
          newString: "    const proposalStall = MODULE_WIDE_PROPOSAL_STALL;",
        },
        {
          file: EXTRACT,
          oldString: "const failureLedger = new Map<string, QuarantineEntry>();",
          newString: "const failureLedger = new Map<string, QuarantineEntry>();\nconst MODULE_WIDE_PROPOSAL_STALL = { stalled: false };",
        },
      ],
      note: "⚠️ The breaker's SCOPE, the other constraint round 3 asserted and did not falsify. ONE transient stall then disables alias proposals for the PROCESS LIFETIME — silently, no log, no counter, no red test — on a producer with a single caller and no sweep. `extract.ts`'s own `Effect.suspend` comment warns that exactly this hoist is *an obviously-equivalent-looking refactor*.",
    },
    {
      label: "the cross-tenant skip is silent",
      edits: [
        {
          file: EXTRACT,
          oldString: "  if (deps.proposalStall.stalled) {",
          newString: "  if (deps.proposalStall.stalled) return;\n  if (false) {",
        },
      ],
      note: "⚠️ MEASURED ZERO, and the SECOND row with the same named closure. The drain is FLEET-wide and the breaker is TICK-wide, so the episodes this skips routinely belong to different tenants from the one that stalled — and the single timeout line names only the first; without this line a tick that skipped one and a tick that skipped 24 render identically, which is the third-state argument this file already makes at `outageRefunded`. Falsifying it needs the logger mocked on the EXTRACT path (an `extract-logging.test.ts` on `acl-logging.test.ts`'s pattern), which this slice does not add — the same gap the post-deadline-continuation row names, and the reason to build that file is now two rows rather than one.",
    },
    {
      label: "the truncation warn fires unconditionally",
      edits: [
        {
          file: ALIAS,
          oldString: "  if (rows.length >= cap) {",
          newString: "  if (true) {",
        },
      ],
      note: "The other direction of the same line: a reader that shouts on every healthy run passes the *silenced* row above it. Both directions are needed, which is the pairing every logging suite in this repo carries.",
    },
    {
      label: "the all-rows-dropped ERROR fires whenever any row drops",
      edits: [
        {
          file: ALIAS,
          oldString: "  if (rows.length > 0 && candidates.length === 0) {",
          newString: "  if (rows.length > 0) {",
        },
      ],
      note: "The partial case must NOT reach the error arm — some rows read back, so the corpus is being reported honestly and only the odd row is dropped. Getting it wrong this way puts an `error` on every run that meets one malformed row.",
    },
    {
      label: "a failed proposal run fails the episode that already committed",
      edits: [
        {
          file: EXTRACT,
          // RE-ANCHORED: round 3 inserted the breaker trip between `catch` and
          // `log.warn`, which invalidated the previous `oldString` — so this row
          // shipped as `⚠️ ANCHOR: 0 matches` in all four columns, on the
          // slice's most load-bearing safety property. The FOURTH no-op in this
          // file, created by the round that cleaned up the other three.
          oldString: "    if (timedOut) deps.proposalStall.stalled = true;\n    log.warn(",
          newString: "    if (timedOut) deps.proposalStall.stalled = true;\n    if (err) throw err;\n    log.warn(",
        },
      ],
      note: "The facts are written and the episode is stamped before the producer is asked, so this charges the failure ledger a strike against evidence there is nothing left to retry — and enough strikes quarantine an episode that was processed perfectly.",
    },
  ],
};

export default spec;
