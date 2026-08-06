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
 * Every mutation below dies in at least one column. The zeros that remain are
 * all of one kind — a SQL mutation invisible to a lane that never runs SQL, or a
 * TypeScript one invisible to a lane whose assertions are about which rows
 * matched — and none of them is a mutation nothing catches.
 *
 * Both suites need `TEST_DATABASE_URL` for the `-pg` column; without it that
 * column is 0 for a reason that has nothing to do with coverage:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import type { MutationSpec } from "../mutation-spec";

const ALIAS = "src/lib/brain/alias-proposal.ts";
const SOURCES = "src/lib/brain/sources.ts";
const EXTRACT = "src/lib/brain/extract.ts";
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
          newString:
            "  return `(NOT (NOT jsonb_exists(${alias}.provenance, 'source')\n      OR ${alias}.provenance->>'source' = ANY (${WAREHOUSE_SOURCE_ARRAY_SQL})))`;",
        },
      ],
      note: "The tidy-looking simplification, and it is wrong in both directions: a kind this region cannot classify reads as warehouse-derived (evidence of nothing becoming evidence of a direction) while a genuine warehouse row reads as extracted. #5033's allowlist argument, arriving where the consequence is a proposed target rather than a stamp.",
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
      note: "A workspace-wide re-key proposed from a NEIGHBOURING TENANT'S claims. The three arms are all intra-pair, so `workspace_id` is the only thing holding two tenants' predicates apart.",
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
          oldString: "  const hinted = new Set(hints.map((hint) => pairKey(hint.fromNorm, hint.toNorm)));",
          newString:
            "  const hinted = new Set(hints.map((hint) => pairKey(hint.fromNorm, hint.toNorm)));\n  candidates = [\n    ...candidates,\n    ...hints.map((hint) => ({ ...hint, subjects: 2, directed: false })),\n  ];",
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
            "    typeof row.subjects !== \"number\" ||\n    !Number.isFinite(row.subjects)",
          newString: "    false",
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
          oldString:
            "    const confidence = hinted.has(pairKey(candidate.fromNorm, candidate.toNorm))\n      ? Math.min(1, base + ALIAS_HINT_RANK_BONUS)\n      : base;",
          newString:
            "    const confidence = hinted.has(pairKey(candidate.fromNorm, candidate.toNorm))\n      ? base + ALIAS_HINT_RANK_BONUS\n      : base;",
        },
      ],
      note: "Unreachable from any corpus on today's curve — see the trigger rows below for the other half of the slice — — `structuralConfidence` is asymptotic to 1 and the bonus is 0.05, so a pair would need ~19 distinct subjects to cross — which is exactly why the fast lane reaches for the arithmetic directly rather than for a fixture. A hinted pair pushed past 1 does not queue at high confidence: `proposeAliasEdge` refuses it as `confidence-out-of-range` and it does not queue at all.",
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
