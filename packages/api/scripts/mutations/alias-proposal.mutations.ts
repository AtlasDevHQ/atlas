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
 * The two columns are complements and are worth reading against each other. The
 * `-pg` suite is the only lane that can see WHICH ROWS the three arms admit; the
 * fast lane sees binds, the ranking rules and the statement's TEXT. That is why
 * several SQL rows below are 0 in the fast lane and several TypeScript rows are
 * 0 in the `-pg` one — neither column is a superset of the other.
 *
 * Every mutation LISTED below dies in at least one column — and the word is
 * deliberate: the list is curated, not exhaustive, so it is evidence about the
 * suites' reach and never a proof that nothing else survives. The zeros that
 * remain are all of one kind — a SQL mutation invisible to a lane that never runs SQL, or a
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
      note: "⭐ Invisible to a test that compares the issued statement against the constant that produced it — both sides move together. `0` restores the wedge: the extraction drain awaits this inside a `concurrency: 1` loop, and a hang is not a falsifier. The `-pg` bound test reads the value back out of the session, which is the only assertion that can see it.",
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
          oldString: "    await Promise.race([\n      pending,",
          newString: "    await Promise.race([\n      pending,\n      // eslint-disable-next-line\n      pending,",
        },
      ],
      note: "⚠️ MEASURED ZERO, and honest — a HANG is not a falsifier, which is exactly why the deadline exists. `withBrainTransaction` issues `BEGIN` before the callback, so the two `SET LOCAL`s cannot bound their own arrival and a database that is not answering wedges the drain with no error. Nothing short of a delayed-settle fake and a timer recorder can see this, and that machinery is not built here; the `-pg` bound test covers the DATABASE half, and this row records that the JS half is covered by argument.",
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
      label: "a failed proposal run fails the episode that already committed",
      edits: [
        {
          file: EXTRACT,
          oldString: "  } catch (err) {\n    log.warn(\n      {\n        workspaceId: episode.workspaceId,\n        episodeId: episode.id,\n        comparable: report.comparable,",
          newString: "  } catch (err) {\n    if (err) throw err;\n    log.warn(\n      {\n        workspaceId: episode.workspaceId,\n        episodeId: episode.id,\n        comparable: report.comparable,",
        },
      ],
      note: "The facts are written and the episode is stamped before the producer is asked, so this charges the failure ledger a strike against evidence there is nothing left to retry — and enough strikes quarantine an episode that was processed perfectly.",
    },
  ],
};

export default spec;
