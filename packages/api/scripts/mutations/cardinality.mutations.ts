/**
 * Cardinality on the canonical predicate, measured (#5027, ADR-0037 §3).
 *
 * Every row here removes one part of the change and records how many tests
 * notice. That matters more than usual for this slice, because the defect it
 * fixes was INVISIBLE AT REST: `brain_facts.predicate_cardinality` looked
 * unpopulated to everyone who read the schema, and the whole map recorded it as
 * such. What was actually there was a stochastic gate on an irreversible
 * `valid_to` stamp — supersession fired at roughly P(model says `single`)², from
 * two independent model calls.
 *
 * So a `0` in this table is not a note. It means some part of the fix can be
 * reverted with the suites green, and a revert here looks like a TIGHTENING: an
 * extra `= 'single'` reads as a narrower guard, and dropping
 * `status = 'approved'` reads as a simplification.
 *
 * `cardinality-pg.test.ts` needs `TEST_DATABASE_URL`; without it the suite skips
 * and every cell in its column is 0 for a reason that has nothing to do with
 * coverage. Run it with:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_4771_scratch
 */

import type { MutationSpec } from "../mutation-spec";

const CARDINALITY = "src/lib/brain/cardinality.ts";
const RECONCILE = "src/lib/brain/reconcile.ts";
const CORRECTION = "src/lib/brain/correction.ts";

const spec: MutationSpec = {
  title: "Mutations the #5027 cardinality suites catch",
  out: "scripts/mutations/cardinality.md",
  targets: [
    { name: "cardinality-pg.test.ts", file: "src/lib/brain/__tests__/cardinality-pg.test.ts" },
    { name: "correction.test.ts", file: "src/lib/brain/__tests__/correction.test.ts" },
    {
      name: "brain-facts.test.ts",
      file: "src/lib/content-mode/adapters/__tests__/brain-facts.test.ts",
    },
    { name: "reconcile.test.ts", file: "src/lib/brain/__tests__/reconcile.test.ts" },
  ],
  preamble: `
Sources: \`${CARDINALITY}\`, \`${RECONCILE}\`, \`${CORRECTION}\`. Mutation list:
\`scripts/mutations/cardinality.mutations.ts\`.

The first two rows are the ones to read. Both restore the shape ADR-0037 §3
deleted, and both read as SAFETY when you find them in a diff — an extra
\`= 'single'\` is a narrower guard, and \`status = 'approved'\` looks like a
filter you could drop. Neither has any symptom at rest: the corpus goes on
looking correct while supersession either stops firing or starts firing with no
human behind it.
`,
  mutations: [
    {
      label: "the collision reads a per-ROW cardinality again (the both-sides clause restored)",
      edits: [
        {
          file: "src/lib/content-mode/adapters/brain-facts.ts",
          oldString: "     AND ${cardinalitySingleSql(d)}\n",
          newString:
            "     AND ${p}.predicate_cardinality = 'single'\n     AND ${d}.predicate_cardinality = 'single'\n",
        },
      ],
      note: "The defect itself. Every row written since this slice falls to the schema default `'multi'`, so the restored clause supersedes NOTHING, forever, with no error anywhere — and against a corpus written before it, it supersedes at roughly P(model says `single`)².",
    },
    {
      label: "`cardinalitySingleSql` stops filtering entries to `approved`",
      edits: [
        {
          file: CARDINALITY,
          oldString: "          AND c.cardinality = 'single'\n          AND c.status = 'approved')",
          newString: "          AND c.cardinality = 'single')",
        },
      ],
      note: "Hands the repeat-gated correction-event proposer the irreversible write: a PENDING proposal would retire published beliefs with no human decision behind it, which is the whole thing ADR-0037 §3(d) exists to prevent.",
    },
    {
      label: "`cardinalitySingleSql` reads `single` from anywhere in the workspace",
      edits: [
        {
          file: CARDINALITY,
          oldString: "          AND c.predicate_key = ${alias}.predicate_key\n",
          newString: "",
        },
      ],
      note: "One curated predicate would license supersession across EVERY slot in the workspace. The arm is what makes the entry a property of the predicate rather than of the tenant.",
    },
    {
      label: "the producer path may write `approved` instead of `pending`",
      edits: [
        {
          file: CARDINALITY,
          oldString: "     VALUES ($1, $2, $3, 'pending', $4, $5)",
          newString: "     VALUES ($1, $2, $3, 'approved', $4, $5)",
        },
      ],
      note: "Source 2 stops proposing and starts deciding — a repeat gate over a workspace's correction history would then make every published pair at that predicate destructively collidable, with nobody asked.",
    },
    {
      label: "the producer path accepts a `multi` proposal",
      edits: [
        {
          file: CARDINALITY,
          oldString: '  if (input.cardinality === "multi") {',
          newString: "  if (false) {",
        },
      ],
      note: "A `multi` proposal asserts nothing (absent already means `multi`) while OCCUPYING the predicate's only slot, so it silently blocks the `single` proposal that carries information.",
    },
    {
      label: "the rejection memory is dropped (`ON CONFLICT DO NOTHING` → `DO UPDATE`)",
      edits: [
        {
          file: CARDINALITY,
          oldString: `     ON CONFLICT (workspace_id, predicate_key) DO NOTHING
     RETURNING predicate_key\`,`,
          newString: `     ON CONFLICT (workspace_id, predicate_key) DO UPDATE
        SET status = 'pending', proposed_at = now()
     RETURNING predicate_key\`,`,
        },
      ],
      note: "#4507's memory. Without it the next producer run re-proposes what a human rejected, and the vocabulary stops being reversible for exactly the population the proposer adds.",
    },
    {
      label: "the repeat gate counts CORRECTIONS instead of distinct subjects",
      edits: [
        {
          file: CARDINALITY,
          oldString: "  SELECT COUNT(DISTINCT n.subject_key)::int AS n",
          newString: "  SELECT COUNT(*)::int AS n",
        },
      ],
      note: "A reviewer fixing one slot repeatedly is most likely correcting their own typing. Counting corrections makes the loudest evidence the least informative kind, and it is the single change that reopens the typo risk ADR-0037 §3(d) carries.",
    },
    {
      label: "the repeat gate drops its provable-difference arm",
      edits: [
        {
          file: CARDINALITY,
          oldString:
            '     AND ${comparableDifferentSql("n.object_cmp", "o.object_cmp")}\n',
          newString: "",
        },
      ],
      note: "The other half of the typo defence, and the half only real Postgres can exercise: two entity-valued names are `unknown`, never *different*. Without it three `Bob` → `Bobby` fixes across three subjects propose a workspace-wide `single`.",
    },
    {
      label: "the repeat gate counts machine supersessions too",
      edits: [
        {
          file: CARDINALITY,
          oldString: "     AND ep.source = $3\n",
          newString: "",
        },
      ],
      note: "Closes the loop on itself: an approved `single` produces `supersedes` edges at the publish gate, and the gate would report the system's own arbitrations back to it as human evidence.",
    },
    {
      label: "the repeat threshold drops to 1",
      edits: [
        {
          file: CARDINALITY,
          oldString: "export const CORRECTION_REPEAT_THRESHOLD = 3;",
          newString: "export const CORRECTION_REPEAT_THRESHOLD = 1;",
        },
      ],
      note: "One correction is an anecdote. It is a proposal either way, so this is the least costly row here — but a queue that proposes on every first supersede is a queue nobody reads.",
    },
    {
      label: "`INSERT_FACT_SQL` feeds `predicate_cardinality` again",
      edits: [
        {
          file: RECONCILE,
          oldString: `          source_episode_id, provenance, visible_to,
          subject_key, predicate_key, object_key, object_cmp)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)),
               $10, $11, $12, $13)`,
          newString: `          source_episode_id, provenance, visible_to, predicate_cardinality,
          subject_key, predicate_key, object_key, object_cmp)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), 'multi',
               $10, $11, $12, $13)`,
        },
      ],
      note: "Half of the revert: with the column fed again, restoring the both-sides clause becomes a working change rather than a silent no-op. Bound to a literal here so the mutation is isolated to the statement.",
    },
    {
      label: "`retract` feeds the proposer too",
      edits: [
        {
          file: CORRECTION,
          oldString: '        case "retract":\n          return applyRetract(',
          newString:
            '        case "retract":\n          supersededPredicateKey = slotKey(target.predicate, vocabulary.predicate);\n          return applyRetract(',
        },
      ],
      note: "The realistic drift — a later reader wiring one more verb into the gate. Retracting a claim WITHDRAWS it and says nothing about how many values could have coexisted, so counting it turns \"this was wrong\" into evidence that the slot holds one value.",
    },
    {
      label: "the proposer runs INSIDE the correction's transaction",
      edits: [
        {
          file: CORRECTION,
          oldString: `      await withTransaction((tx) =>
        proposeFromCorrectionEvents(tx, ctx.workspaceId, supersededPredicateKey),
      );`,
          newString: `      await proposeFromCorrectionEvents(
        { query: async () => ({ rows: [] }) },
        ctx.workspaceId,
        supersededPredicateKey,
      );`,
        },
      ],
      note: "Stands in for the placement change rather than reproducing it literally (the real one cannot be expressed as a local edit). What it removes is the proposer's access to the committed `supersedes` edge — which is why the placement is post-commit rather than a `SAVEPOINT`.",
    },
  ],
};

export default spec;
