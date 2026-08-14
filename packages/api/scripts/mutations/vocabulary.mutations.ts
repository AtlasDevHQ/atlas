/**
 * The mutation list behind `vocabulary-pg.test.ts`'s table (#5061, promoted
 * from a hand-typed table by #5060's runner).
 *
 * Twenty numbers used to live in that suite's docstring under the claim
 * "measured against THIS tree … in a single run". The claim was true when
 * written and unfalsifiable ever after, which is the whole argument for the
 * runner: the same docstring already recorded that rounds 2 and 3 of the #5051
 * panel each caught rows that had gone stale.
 *
 * ## The `&& false` convention
 *
 * Several rows here are "a guard dropped". They are spelled as
 * `if (<original condition> && false)` rather than by deleting the block,
 * because the deletion has two defensible spellings — delete the arm, or delete
 * the arm AND the state it computed — and those measure differently. Appending
 * `&& false` makes the branch unreachable without touching anything else, so
 * one label means one mutation. It is not type-correct in every case (a
 * narrowing that came from the arm's `throw` is lost); that is irrelevant here,
 * since the runner's instrument is `bun test`, which strips types, and the tree
 * is restored from an in-memory backup either way.
 *
 * ## Needs a scratch database
 *
 * Without `TEST_DATABASE_URL` this suite self-skips and the baseline is
 * DEFLATED — the runner aborts rather than publishing twenty zeros (guardrail 4):
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_5061_scratch
 */

import type { MutationSpec } from "../mutation-spec";

const SOURCE = "src/lib/brain/vocabulary.ts";

/** `loadClaimVocabulary`'s single read — the LEFT JOIN that IS the closure. */
const LOADER_SELECT = `    \`SELECT e.slot_position, e.from_norm AS norm, t.effective_target
       FROM brain_vocabulary_edge e
       LEFT JOIN brain_vocabulary_target t
         ON t.workspace_id = e.workspace_id
        AND t.slot_position = e.slot_position
        AND t.norm = e.from_norm
      WHERE e.workspace_id = $1\`,`;

const spec: MutationSpec = {
  title: "Mutations `vocabulary-pg.test.ts` catches",
  out: "scripts/mutations/vocabulary.md",
  targets: [{ name: "here", file: "src/lib/brain/__tests__/vocabulary-pg.test.ts" }],
  preamble: `
Source: \`${SOURCE}\`. Mutation list: \`scripts/mutations/vocabulary.mutations.ts\`.

Every property this suite guards is a property of SQL — at-most-one-parent is a
primary key, derived-ness is a RESTRICT foreign key, the closure is a recursive
CTE — so a unit fake would be a second implementation agreeing with the first by
construction. That is why the mutations below are mostly SQL edits, and why the
column needs a real Postgres to mean anything.

TWO rows are compound and the table cannot say so on its own. The unsatisfiable
-join row also removes the completeness check's input, so it is not a clean
"reads the edges" mutation — the LEFT-JOIN-dropped row above it is. Re-keying
the lock to a constant also blinds the transaction probe, because the probe is
\`objid\`-scoped; nothing here isolates workspace scoping cleanly, and the
different-workspaces control is what does.

FOUR rows share a shape worth naming — the at-most-one-parent read,
\`self-edge\`, \`degenerate-norm\`, and \`existingTarget\`: the SCHEMA also
refuses, or the code still answers plausibly, so deleting the TypeScript guard
does not make the write succeed. It turns a typed refusal into a raw constraint
violation, or a correct repair hint into a wrong one. A version of these tests
written as \`expect(await storedEdges()).toHaveLength(1)\` would pass under all
four.

NOT here, deliberately: loosening the transaction probe's polarity from \`< 1\`
back to \`=== 0\` kills nothing and cannot. \`lockCount\` is \`count(*)::int\`
past a \`Number.isFinite\` guard, so the two are equivalent over the whole
reachable domain. The \`< 1\` spelling is defensive style, not a tested property,
and a row claiming otherwise would be a fabricated measurement.
`,
  mutations: [
    {
      label: "`alias` answers from the edges alone (LEFT JOIN dropped, `to_norm` selected)",
      edits: [
        {
          file: SOURCE,
          oldString: LOADER_SELECT,
          newString: `    \`SELECT e.slot_position, e.from_norm AS norm, e.to_norm AS effective_target
       FROM brain_vocabulary_edge e
      WHERE e.workspace_id = $1\`,`,
        },
      ],
      note: "The clean version of *the loader stops reading the closure*: `alias` answers the RAW approved parent, so a compressed chain `a → b → c` resolves `a` to `b`. Only a composed vocabulary can tell the two apart, which is why a single-edge fixture is vacuous here.",
    },
    {
      label: "the closure join predicate made unsatisfiable (every `effective_target` NULL)",
      edits: [
        {
          file: SOURCE,
          oldString: `        AND t.norm = e.from_norm
      WHERE e.workspace_id = $1\`,`,
          newString: `        AND t.norm = e.from_norm
        AND FALSE
      WHERE e.workspace_id = $1\`,`,
        },
      ],
      note: "COMPOUND, and the table cannot show it: every row's join partner disappears, so this also feeds the completeness check its failing input. The row above is the clean *reads the edges* measurement.",
    },
    {
      label: "the recompute's recursive term dropped (closure is depth-1 only)",
      edits: [
        {
          file: SOURCE,
          oldString: "        WHERE w.depth < $3::int\n     ),",
          newString: "        WHERE w.depth < $3::int AND FALSE\n     ),",
        },
      ],
      note: "Spelled as `AND FALSE` on the recursive term's own WHERE rather than by deleting the `UNION ALL` block: deleting it strands `$3`, and Postgres then refuses the statement for an arity mismatch, which fails the whole suite on a bind error rather than on the truncated closure. The spelling is the input (#5033) — this one measures depth-1, which is what the label claims.",
    },
    {
      label:
        "`ORDER BY norm, depth DESC` → `depth ASC` (the closure keeps the first hop, not the root)",
      edits: [
        {
          file: SOURCE,
          oldString: "        ORDER BY norm, depth DESC",
          newString: "        ORDER BY norm, depth ASC",
        },
      ],
      note: "`DISTINCT ON (norm)` keeps whichever row sorts first, so ascending depth keeps the first HOP. The closure then points at an intermediate node — `alias` answers confidently and wrongly, which is exactly the silent truncation the convergence check exists to make loud.",
    },
    {
      label: "`removeAliasEdge` drops its final `recomputeEffectiveTargets`",
      edits: [
        {
          file: SOURCE,
          oldString: "  await recomputeEffectiveTargets(tx, workspaceId, position);\n  return true;\n}",
          newString: "  return true;\n}",
        },
      ],
      note: "The removal clears the closure and never rebuilds it, so the position degrades to `identityAlias` — byte-identical to *approved nothing*, and permanent.",
    },
    {
      label: "the at-most-one-parent read dropped (the PK still refuses — by THROWING)",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (existingRow !== undefined) {",
          newString: "  if (existingRow !== undefined && false) {",
        },
      ],
      note: "The primary key still refuses the write, so nothing corrupt commits — what is lost is the typed `already-aliased` refusal naming the existing target, replaced by a raw unique-violation. A test written as `expect(await storedEdges()).toHaveLength(1)` passes under this.",
    },
    {
      label: "the cycle walk dropped",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (chain.rows.length > 0) {",
          newString: "  if (chain.rows.length > 0 && false) {",
        },
      ],
      note: "Cycle refusal has no structural twin — a CHECK cannot read other rows, and `ck_..._not_self` covers only length 1. Without the walk a 3-cycle commits and the closure has no root at all.",
    },
    {
      label: "the cycle walk's `slot_position` arm neutered (a false cycle across positions)",
      edits: [
        {
          file: SOURCE,
          oldString: `        WHERE workspace_id = $1::text AND slot_position = $2::text AND from_norm = $3::text
       UNION ALL
       SELECT e.to_norm, c.depth + 1
         FROM chain c
         JOIN brain_vocabulary_edge e
           ON e.workspace_id = $1::text AND e.slot_position = $2::text AND e.from_norm = c.node`,
          newString: `        WHERE workspace_id = $1::text AND $2::text IS NOT NULL AND from_norm = $3::text
       UNION ALL
       SELECT e.to_norm, c.depth + 1
         FROM chain c
         JOIN brain_vocabulary_edge e
           ON e.workspace_id = $1::text AND $2::text IS NOT NULL AND e.from_norm = c.node`,
        },
      ],
      note: "`$2` is kept bound rather than removed, so the failure is the FALSE CYCLE the label names and not a parameter-arity error. The three positions are independent vocabularies; a walk blind to position refuses an approval because an unrelated position happens to close a loop over the same norms.",
    },
    {
      label: "`lexicalNorm` dropped from `approveAliasEdge`'s endpoints",
      edits: [
        {
          file: SOURCE,
          oldString:
            "  const fromNorm = lexicalNorm(input.fromNorm);\n  const toNorm = lexicalNorm(input.toNorm);",
          newString: "  const fromNorm = input.fromNorm;\n  const toNorm = input.toNorm;",
        },
      ],
      note: "A stored non-norm makes the closure's joins miss — `slotKey` re-norms the ANSWER but cannot repair an edge whose endpoints never match anything.",
    },
    {
      label: "`lexicalNorm` dropped from `removeAliasEdge`'s argument",
      edits: [
        { file: SOURCE, oldString: "  const norm = lexicalNorm(fromNorm);", newString: "  const norm = fromNorm;" },
      ],
      note: "Removal by display form silently matches nothing and returns `false` — indistinguishable from *that norm has no parent*, which is the one answer the caller acts on.",
    },
    {
      label: "the self-edge arm dropped (`ck_..._not_self` still refuses — by throwing)",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (fromNorm === toNorm) {",
          newString: "  if (fromNorm === toNorm && false) {",
        },
      ],
    },
    {
      label: "the degenerate-norm arm dropped (`ck_..._norms_present` still refuses)",
      edits: [
        {
          file: SOURCE,
          oldString: '  if (fromNorm === "" || toNorm === "") {',
          newString: '  if ((fromNorm === "" || toNorm === "") && false) {',
        },
      ],
    },
    {
      label: "`loadClaimVocabulary` reads one position's map for all three",
      edits: [
        {
          file: SOURCE,
          oldString: `  return {
    subject: lookupFor("subject"),
    predicate: lookupFor("predicate"),
    object: lookupFor("object"),
  };`,
          newString: `  return {
    subject: lookupFor("predicate"),
    predicate: lookupFor("predicate"),
    object: lookupFor("predicate"),
  };`,
        },
      ],
      note: "The three positions are independent vocabularies. A fixture that only ever aliases at one position cannot see this, which is why the suite aliases the same norm at two.",
    },
    {
      label: "`loadClaimVocabulary` loses its `workspace_id` filter",
      edits: [
        {
          file: SOURCE,
          oldString: "      WHERE e.workspace_id = $1`,",
          newString: "      WHERE $1::text IS NOT NULL`,",
        },
      ],
      note: "Cross-tenant vocabulary bleed. `$1` is kept bound so the failure is the bleed rather than an arity error.",
    },
    {
      label: "the convergence check dropped from `recomputeEffectiveTargets`",
      edits: [
        {
          file: SOURCE,
          oldString: "  if (unconverged.rows.length > 0) {",
          newString: "  if (unconverged.rows.length > 0 && false) {",
        },
      ],
      note: "A cap that merely truncates writes a closure pointing at an INTERMEDIATE node with nothing to say so. Only cycles whose length does not divide `MAX_CHAIN_DEPTH` reach here — the divisor lengths trip `ck_..._not_self` first.",
    },
    {
      label: "the completeness check dropped from `loadClaimVocabulary`",
      edits: [
        {
          file: SOURCE,
          oldString: "    if (row.effective_target === null) {",
          newString: "    if (row.effective_target === null && false) {",
        },
      ],
      note: "A half-rebuilt position degrades the norm to itself, which is byte-identical to *approved nothing* and keys the whole episode un-aliased — the one wrong answer this loader could give with no error to propagate.",
    },
    {
      label: "`VocabularyClosureError` downgraded to a bare `Error`",
      edits: [
        {
          file: SOURCE,
          oldString: "    throw new VocabularyClosureError(\n      `Vocabulary closure did not converge at the ",
          newString: "    throw new Error(\n      `Vocabulary closure did not converge at the ",
        },
        {
          file: SOURCE,
          oldString: "      throw new VocabularyClosureError(\n        `Vocabulary closure is incomplete at the ",
          newString: "      throw new Error(\n        `Vocabulary closure is incomplete at the ",
        },
      ],
      note: "BOTH throw sites, stated because one alone is a different mutation with a different number — the ambiguity the docstring this replaces could not record. The class carries `position` / `norm` / `effectiveTarget`, which is what turns a corruption alarm into a repair instruction.",
    },
    {
      label: "`existingTarget` reports the closure ROOT instead of the raw approved parent",
      edits: [
        {
          file: SOURCE,
          oldString: `    \`SELECT to_norm FROM brain_vocabulary_edge
      WHERE workspace_id = $1 AND slot_position = $2 AND from_norm = $3\`,`,
          newString: `    \`SELECT t.effective_target AS to_norm FROM brain_vocabulary_edge e
       JOIN brain_vocabulary_target t
         ON t.workspace_id = e.workspace_id
        AND t.slot_position = e.slot_position
        AND t.norm = e.from_norm
      WHERE e.workspace_id = $1 AND e.slot_position = $2 AND e.from_norm = $3\`,`,
        },
      ],
      note: "The refusal still refuses; it names the wrong edge to remove. On a compressed chain the root and the raw parent are different strings, and only a composed fixture separates them — the second form of the vacuity trap this suite's header names.",
    },
    {
      label: "the transaction-contract probe dropped",
      edits: [
        { file: SOURCE, oldString: "  if (lockCount < 1) {", newString: "  if (lockCount < 1 && false) {" },
      ],
      note: "On an autocommit executor the advisory lock is taken and dropped inside its own statement, so `removeAliasEdge` COMMITS an empty closure between its DELETE and its rebuild — a window in which every concurrent reader keys un-aliased, permanent if the process dies.",
    },
    {
      label: "the advisory lock keyed on a CONSTANT instead of the workspace",
      edits: [
        {
          file: SOURCE,
          oldString:
            "export const VOCABULARY_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext($2))`;",
          newString:
            "export const VOCABULARY_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext('brain-vocabulary')) FROM (SELECT $2::text) AS _`;",
        },
      ],
      note: "COMPOUND, and the biggest number in the table for a reason that is not coverage: the probe is `objid`-scoped on `hashtext(workspaceId)`, so a constant-keyed lock fails the probe and every mutation in the suite throws. What the row does NOT isolate is workspace scoping — the different-workspaces control is what does that.",
    },
  ],
};

export default spec;
