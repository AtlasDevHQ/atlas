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
    { name: "cardinality.test.ts", file: "src/lib/brain/__tests__/cardinality.test.ts" },
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
          oldString: "  return `${collisionCorePredicate(d, p)}\n     AND ${cardinalitySingleSql(d)}`;",
          newString:
            "  return `${collisionCorePredicate(d, p)}\n     AND ${p}.predicate_cardinality = 'single'\n     AND ${d}.predicate_cardinality = 'single'`;",
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
          oldString: '  if ((input.cardinality as string) !== "single") {',
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
     RETURNING 1 AS inserted\`,`,
          newString: `     ON CONFLICT (workspace_id, predicate_key) DO UPDATE
        SET status = 'pending', proposed_at = now()
     RETURNING 1 AS inserted\`,`,
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
          // ⚠️ Spelled to KEEP `$3` referenced. Deleting the arm outright leaves
          // the caller binding three parameters against a two-parameter
          // statement, which Postgres refuses at Bind — so every test in the
          // repeat-gate block dies on a crash rather than on the semantics, and
          // the cell reads 7 where the honest figure is 1. That is
          // `mutation-core.ts`'s own recorded whole-suite trap (an untyped
          // parameter making the count 51 where the truth was 1) wearing a
          // different parameter error, and the runner cannot see it: its
          // WHOLE_SUITE_WARN_RATIO is measured against the FILE, and this kills
          // one describe block.
          oldString: "     AND ep.source = $3\n",
          newString: "     AND ($3::text = $3::text)\n",
        },
      ],
      note: "Closes the loop on itself: an approved `single` produces `supersedes` edges at the publish gate, and the gate would report the system's own arbitrations back to it as human evidence. The tautology keeps `$3` bound so the statement still PARSES — what is removed is the source filter and nothing else.",
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
          // The REALISTIC revert: the column back in the list AND back on the
          // bind, with the candidate's value flowing into it again. An earlier
          // spelling bound the literal `'multi'` "to isolate the mutation" —
          // which made the note below false (with every row forced to `multi`,
          // restoring the both-sides clause is still a silent no-op) and, worse,
          // never exercised the two assertions whose own comments call a
          // PARAMETER COUNT the only thing that catches this. A statement that
          // is still valid SQL with an unchanged row is precisely the shape a
          // lexical assertion misses.
          // Re-anchored by #5032, which added `subject_cmp` as `$14`. The
          // mutation is unchanged in substance: the column back in the list AND
          // back on the bind, so every placeholder after it shifts by one.
          oldString: `          source_episode_id, provenance, visible_to,
          subject_key, predicate_key, object_key, object_cmp, subject_cmp)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)),
               $10, $11, $12, $13, $14)`,
          newString: `          source_episode_id, provenance, visible_to, predicate_cardinality,
          subject_key, predicate_key, object_key, object_cmp, subject_cmp)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), $10,
               $11, $12, $13, $14, $15)`,
        },
        {
          file: RECONCILE,
          // ⚠️ This anchor was ALREADY stale before #5032 and the mutation had
          // been ANCHOR-failing silently: the field became `comparableAtRest` at
          // #5030 and nobody re-ran the spec. Now spelled off the INSERT's own
          // call site, which is the only one binding the at-rest value.
          oldString: "    ...agreementBinds(item.keys, item.comparableAtRest, item.subjectComparable),",
          newString: `    item.candidate.predicateCardinality ?? "multi",
    ...agreementBinds(item.keys, item.comparableAtRest, item.subjectComparable),`,
        },
      ],
      note: "The other half of the revert, and the half that makes restoring the both-sides clause a WORKING change rather than a silent no-op. Caught by parameter COUNT in two suites — the only instrument that sees it, since the mutated statement is valid SQL that writes an unchanged-looking row.",
    },
    {
      label: "`retract` feeds the proposer too",
      edits: [
        {
          file: CORRECTION,
          oldString: `        case "retract":
          return noSupersededPredicate(
            applyRetract(tx, ctx.workspaceId, target, episodeId, at, base),
          );`,
          newString: `        case "retract":
          return withSupersededPredicate(
            slotKey(target.predicate, vocabulary.predicate),
            applyRetract(tx, ctx.workspaceId, target, episodeId, at, base),
          );`,
        },
      ],
      note: "The realistic drift — a later reader wiring one more verb into the gate. Retracting a claim WITHDRAWS it and says nothing about how many values could have coexisted, so counting it turns \"this was wrong\" into evidence that the slot holds one value.",
    },
    {
      label: "the post-commit proposer loses its deadline",
      edits: [
        {
          file: CORRECTION,
          oldString: `    await proposeUnderDeadline(
      () => withTransaction((tx) => proposeFromCorrectionEvents(tx, ctx.workspaceId, supersededPredicate)),
      resolveAuditDeadline(deps.auditWriteTimeoutMs),
      { workspaceId: ctx.workspaceId, factId: result.factId, requestId },
    );`,
          newString: `    try {
      await withTransaction((tx) =>
        proposeFromCorrectionEvents(tx, ctx.workspaceId, supersededPredicate),
      );
    } catch {
      // intentionally ignored: the mutation removes the deadline, not the absorb
    }`,
        },
      ],
      note: "A DEGRADED internal DB — reachable, not answering — never throws, so the catch never runs and `correctFact` never returns. The caller's own timeout then reports *\"nothing was changed — retry\"* about a correction that IS committed, and the retry mints a second correction episode for one human decision. Unbounded is worse than failing, and `Promise.race` with a REJECTING timer is what routes it into the existing catch.",
    },
    {
      label: "the deadline's timer is never cleared",
      edits: [
        {
          file: CORRECTION,
          oldString: `  } finally {
    // Around the RACE, so it runs whoever wins. This is the whole fix: a
    // \`finally\` on the TIMER PROMISE settles only when the timer fires, so
    // \`clearTimeout\` was always a no-op and the fast path left it armed.
    if (timer !== undefined) clearTimeout(timer);
  }`,
          newString: `  }`,
        },
      ],
      note: "Round 1's own defect, respelled as the edit that reproduces it: a `finally` attached to the TIMER PROMISE settles only when the timer fires, so `clearTimeout` was always a no-op and the fast path left a 5s timer armed per correction. Round 2 published this row as an honest `0` (`bun test` force-exits); round 3 falsified it with the technique already in `correction-audit.test.ts`, which had stayed green only because it drives `pin` — a verb that never reaches the proposer.",
    },
    {
      label: "the post-deadline continuation is deleted",
      edits: [
        {
          file: CORRECTION,
          oldString: "    void pending\n",
          newString: "    void 0 && pending\n",
        },
      ],
      note: "`Promise.race` marks the loser's rejection HANDLED, so a store error arriving after the deadline is dropped with no line and not even an unhandled rejection — while the only record an operator holds says the statement *may still commit*. Round 3 wrote this block and shipped nothing that could reach it: the hang knob never settles, so both arms were structurally unfalsifiable until a DELAYED-settle knob existed.",
    },
    {
      label: "the late-SUCCESS arm's guard is inverted",
      edits: [
        {
          file: CORRECTION,
          oldString: `        () => {
          if (!timedOut) return;`,
          newString: `        () => {
          if (timedOut) return;`,
        },
      ],
      note: "Fires *COMPLETED after its deadline* on every ordinary supersede — alert fatigue on the happy path, and the reason the arm needs a prohibition as well as an assertion. Deleting the arm outright is the milder mutation; inverting it is the one a reader would call a typo.",
    },
    {
      label: "`logDegeneratePredicate` fires for every verb, not only `supersede`",
      edits: [
        {
          file: CORRECTION,
          oldString: '    if (verb === "supersede") {\n      logDegeneratePredicate(',
          newString: "    if (true) {\n      logDegeneratePredicate(",
        },
      ],
      note: "A `retract` or a vouch would then log *superseded a claim whose predicate normalizes away* about a verb that superseded nothing. The guard is the whole content of the line.",
    },
    {
      label: "`logDegeneratePredicate`'s call is removed",
      edits: [
        {
          file: CORRECTION,
          oldString: `    if (verb === "supersede") {
      logDegeneratePredicate({ workspaceId: ctx.workspaceId, factId: result.factId, requestId });
    }`,
          newString: "    void verb;",
        },
      ],
      note: "The case is legal and permanent (`identityKey`'s ⚠️), produces no proposal, and without this line produces no record either — a supersede that vanished.",
    },
    {
      label: "the proposer runs INSIDE the correction's transaction",
      edits: [
        {
          file: CORRECTION,
          oldString: `      () => withTransaction((tx) => proposeFromCorrectionEvents(tx, ctx.workspaceId, supersededPredicate)),`,
          newString: `      () => proposeFromCorrectionEvents({ query: async () => ({ rows: [] }) }, ctx.workspaceId, supersededPredicate),`,
        },
      ],
      note: "Stands in for the placement change rather than reproducing it literally (the real one cannot be expressed as a local edit). What it removes is the proposer's access to the committed `supersedes` edge — which is why the placement is post-commit rather than a `SAVEPOINT`.",
    },
  ],
};

export default spec;
