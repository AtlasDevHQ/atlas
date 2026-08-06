/**
 * The claim-identity corpus, measured (#5021, ADR-0037 §9) — PROMOTED from the
 * hand-typed table in `identity-consumers-pg.test.ts` by #5032.
 *
 * ## Why it was promoted, stated as what actually happened
 *
 * That table's own header said *"EVERY count above was re-measured on this tree,
 * one mutation at a time, and several MOVED"* — the case fold 9→14, both
 * tension-repoint rows 2→7, the tension edge 5→10 — because #5033 had added five
 * corpus entries. #5032 then added four more (`homonym-subject`,
 * `homonym-rival`, `homonym-control`, `homonym-same-entity`), which moves the
 * same cells again for the same reason: every count here is a function of the
 * CORPUS SIZE, and the corpus is the thing this slice grows.
 *
 * That is #5060's argument arriving on the last hand-measured table in the
 * subsystem. A cell stored in a docstring is a claim nothing can falsify; three
 * of the four generated tables beside it were ALSO found stale on this tree
 * (`object-cmp.md` recorded 58 tests where there are 59, `cardinality.md`
 * recorded 47 where there are 70, and two specs had anchors that had silently
 * stopped matching), which is what a hand-maintained number does when nobody
 * re-runs it.
 *
 * ## What is NOT here
 *
 * The eight tier-guard rows the old table carried. They live in
 * `tier-guard.md`, generated from `tier-guard.mutations.ts`, and duplicating
 * them would put the same number in two places — the failure this whole
 * mechanism exists to remove. Read the two tables together: this one owns the
 * lexical layer and the three statements' identity arms, that one owns the
 * consequence ordering.
 *
 * The four `subject_cmp` rows are likewise in `subject-cmp.md`.
 *
 * Needs `TEST_DATABASE_URL`; without it the suite skips and every cell is 0 for
 * a reason that has nothing to do with coverage:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_5021_scratch
 */

import type { MutationSpec } from "../mutation-spec";

const IDENTITY = "src/lib/brain/identity.ts";
const RECONCILE = "src/lib/brain/reconcile.ts";
const OBJECT_CMP = "src/lib/brain/object-cmp.ts";
const ADAPTER = "src/lib/content-mode/adapters/brain-facts.ts";

const spec: MutationSpec = {
  title: "Mutations the claim-identity corpus catches",
  out: "scripts/mutations/identity-corpus.md",
  targets: [
    {
      name: "identity-consumers-pg.test.ts",
      file: "src/lib/brain/__tests__/identity-consumers-pg.test.ts",
    },
    { name: "reconcile.test.ts", file: "src/lib/brain/__tests__/reconcile.test.ts" },
  ],
  preamble: `
Source: the lexical layer (\`${IDENTITY}\`), the three consumers' identity arms
(\`${RECONCILE}\`, \`${ADAPTER}\`) and the comparison builders (\`${OBJECT_CMP}\`).
Mutation list: \`scripts/mutations/identity-corpus.mutations.ts\`.

Sibling tables, deliberately NOT duplicated here: \`tier-guard.md\` (the
consequence ordering, #5033) and \`subject-cmp.md\` (the homonymy suppression,
#5032). \`object-cmp.md\` measures the parser itself against its own unit suite.

Three rows WIDEN what collides rather than narrowing it — the \`identityAlias\`
global rule, and the two key-arm neutralizations — and those are the ones whose
failure direction is a \`valid_to\` stamp on a belief nobody retired. The
narrowing rows cost a missed corroboration, which is recoverable.

\`reconcile.test.ts\` is the second column because it is the lane that runs
WITHOUT \`TEST_DATABASE_URL\`. It can see binds and statement text and nothing
else, so a row non-zero there is one a default local run still catches.
`,
  mutations: [
    {
      label: "`lexicalNorm` loses its ASCII case fold",
      edits: [
        {
          file: IDENTITY,
          oldString: "    .replace(ASCII_UPPER, foldAscii)\n",
          newString: "",
        },
      ],
      note: "`Deploy Window` and `deploy_window` stop keying together, so a rephrased re-observation forks instead of corroborating — the #5000 symptom the whole map exists to remove.",
    },
    {
      label: "`lexicalNorm` loses its edge trim",
      edits: [
        {
          file: IDENTITY,
          oldString: "\n    .replace(EDGE_SPACE, \"\");",
          newString: ";",
        },
      ],
      note: "A norm that collapses interior separator runs but keeps the EDGE ones passes `phrasing-variant` and fails `separator-edges` — which is why that fixture exists as a second `same-claim` entry rather than being folded into the first. `_` and `-` collapse to a space that then has to be trimmed off.",
    },
    {
      label: "`identityAlias` given a global rule (`/^is /` stripped)",
      edits: [
        {
          file: IDENTITY,
          oldString: "export const identityAlias: AliasLookup = (norm) => norm;",
          newString: "export const identityAlias: AliasLookup = (norm) => norm.replace(/^is /, \"\");",
        },
      ],
      note: "⚠️ A WIDENING. `is priced at` and `priced at` become one slot with no reviewer anywhere — which is exactly what ADR-0037 §6 settles as a vocabulary ENTRY behind a human, because the same rule also folds `is owned by` into `owns`. Dies on all three of `copula-pair`'s prohibitions.",
    },
    {
      label: "`CORROBORATION_LOOKUP_SQL` repointed at the surface columns",
      edits: [
        {
          file: RECONCILE,
          oldString: `    WHERE workspace_id = $1
      AND subject_key = $2
      AND predicate_key = $3
      AND \${objectSameSql("object_key", "$4", "object_cmp", "$5")}`,
          newString: `    WHERE workspace_id = $1
      AND subject = $2
      AND predicate = $3
      AND \${objectSameSql("object", "$4", "object_cmp", "$5")}`,
        },
      ],
      note: "The #5020 pivot reverted at the STATEMENT. The fake in `reconcile.test.ts` dispatches on statement identity and reads binds positionally, so this is green there except for its lexical backstop — this corpus is where it dies behaviourally.",
    },
    {
      label: "the corroboration call site binds raw surfaces instead of the keys",
      edits: [
        {
          file: RECONCILE,
          oldString: `    ...agreementBinds(item.keys, item.comparableForLookups, item.subjectComparable),
  ]);
  const existingId = firstId(existing.rows);`,
          newString: `    item.subject,
    item.predicate,
    item.object,
    item.comparableForLookups,
    item.subjectComparable,
  ]);
  const existingId = firstId(existing.rows);`,
        },
      ],
      note: "The same pivot reverted at the BIND — the other half, and the one the unit lane can still see, because its fake records the binds it was given.",
    },
    {
      label: "`CORROBORATION_LOOKUP_SQL`'s `object_key = $4` arm neutralized",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "  return `((${keyA} = ${keyB} OR ${comparableSameSql(cmpA, cmpB)})",
          newString: "  return `((${keyA} = ${keyB} AND FALSE OR ${comparableSameSql(cmpA, cmpB)})",
        },
      ],
      note: "Arity-preserving — `AND FALSE` rather than deleting the arm, so `$4` is still referenced and still TYPED. Deleting it outright is a bind error (*supplies 5 parameters, requires 4*) that fails every test in the file for a reason that is not the behaviour. Byte-identical `Business tier` then stops corroborating the moment it is unresolvable as an entity — T3 §4's argument for why one column compared two ways cannot do this job.",
    },
    {
      label: "`CORROBORATION_LOOKUP_SQL`'s `object_cmp = $5` arm neutralized (arity-preserving)",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "  return `((${keyA} = ${keyB} OR ${comparableSameSql(cmpA, cmpB)})",
          newString: "  return `((${keyA} = ${keyB} OR ${comparableSameSql(cmpA, cmpB)} AND FALSE)",
        },
      ],
      note: "`AND FALSE` again rather than a deletion, and for a second reason beside arity: the readable spelling `${cmpA} IS NULL AND ${cmpB} IS NULL` makes `$5` an UNTYPED parameter and Postgres answers *could not determine data type*, which is the whole-suite trap the runner's own header records. ⭐ The row whose absence was MEASURED at #5030: with only key-equal `same-claim` entries this killed nothing but a lexical assertion. `same-through-value` (`499 USD` ⇄ `USD 499`) is what reaches the value arm alone.",
    },
    {
      label: "`objectSameSql` loses its difference VETO",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "      AND (${comparableDifferentSql(cmpA, cmpB)}) IS NOT TRUE)`;",
          newString: "      )`;",
        },
      ],
      note: "⚠️ `lexicalNorm` strips a leading `-`, so `-499` and `499` key IDENTICALLY. Without the veto corroboration MERGES a margin with its own negation — no new row, no tension edge, and no marker to find it by. Dies on `sign-flip-rival`.",
    },
    {
      label: "`objectNotSameSql` loses its `OR comparableDifferentSql(…)` disjunct",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "  return `((${keyA} <> ${keyB} OR ${comparableDifferentSql(cmpA, cmpB)})",
          newString: "  return `((${keyA} <> ${keyB})",
        },
      ],
      note: "The least obvious arm in the slice and the one a reader would delete as redundant: it is what carries a key-equal, provably-different pair into TENSION once the veto has kept it out of corroboration. Without it `sign-flip-rival` mints a second row and then earns no edge — worse than either verdict alone.",
    },
    {
      label: "`objectNotSameSql`'s `IS NOT TRUE` weakened to `NOT (…)`",
      edits: [
        {
          file: OBJECT_CMP,
          oldString: "      AND (${comparableSameSql(cmpA, cmpB)}) IS NOT TRUE)`;",
          newString: "      AND NOT (${comparableSameSql(cmpA, cmpB)}))`;",
        },
      ],
      note: "Reads identically and silently deletes the entire abstain band — `NOT NULL` is NULL and a WHERE treats that as false. The exact distinction `subjectNotDifferentSql` inherits one slice later.",
    },
    {
      label: "`TENSION_CANDIDATES_SQL` repointed at the surface columns",
      edits: [
        {
          file: RECONCILE,
          oldString: `    WHERE workspace_id = $1
      AND subject_key = $2
      AND predicate_key = $3
      AND \${objectNotSameSql("object_key", "$4", "object_cmp", "$5")}`,
          newString: `    WHERE workspace_id = $1
      AND subject = $2
      AND predicate = $3
      AND \${objectNotSameSql("object", "$4", "object_cmp", "$5")}`,
        },
      ],
      note: "The rival scan's half of the #5020 pivot. On the surfaces a `Ships On` / `ships_on` disagreement matched nothing and the reviewer saw two uncontested facts where there was a contradiction.",
    },
    {
      label: "the tension call site binds raw surfaces",
      edits: [
        {
          file: RECONCILE,
          oldString: `      ...agreementBinds(item.keys, item.comparableForLookups, item.subjectComparable),
      factId,`,
          newString: `      item.subject,
      item.predicate,
      item.object,
      item.comparableForLookups,
      item.subjectComparable,
      factId,`,
        },
      ],
      note: "The bind half of the same revert.",
    },
    {
      label: "`INSERT_TENSION_EDGE_SQL`'s endpoints swapped",
      edits: [
        {
          file: RECONCILE,
          oldString: `      const edge = await tx.query(INSERT_TENSION_EDGE_SQL, [
        episode.workspaceId,
        factId,
        rivalId,
      ]);`,
          newString: `      const edge = await tx.query(INSERT_TENSION_EDGE_SQL, [
        episode.workspaceId,
        rivalId,
        factId,
      ]);`,
        },
      ],
      note: "The edge DIRECTION is what the review queue renders as *this new claim contradicts that one*. Reversed, the queue says the settled incumbent contradicts the arrival. Nothing else in the repo asserts the direction — every other site counts.",
    },
    {
      label: "`supersessionCollisionJoin` repointed at the surface columns",
      edits: [
        {
          file: ADAPTER,
          oldString:
            "  return `${p}.workspace_id = ${d}.workspace_id\n     AND ${p}.subject_key = ${d}.subject_key\n     AND ${p}.predicate_key = ${d}.predicate_key",
          newString:
            "  return `${p}.workspace_id = ${d}.workspace_id\n     AND ${p}.subject = ${d}.subject\n     AND ${p}.predicate = ${d}.predicate",
        },
      ],
      note: "On the surfaces the publish gate silently no-op'd on a phrasing mismatch: a draft saying `Ships On` never collided with a published `ships_on`, so publish left two current `single` values standing and the disclosure showed nothing to disclose.",
    },
    {
      label: "`supersessionCollisionPredicate` back on `object_key <> object_key`",
      edits: [
        {
          file: ADAPTER,
          oldString: "     AND ${comparableDifferentSql(`${p}.object_cmp`, `${d}.object_cmp`)}",
          newString: "     AND ${p}.object_key <> ${d}.object_key",
        },
      ],
      note: "⚠️ The #5030 narrowing reverted, and the single largest behaviour change of the identity map. `object_key <> object_key` proves only that two surfaces did not normalize together — true of `$499` and `499 USD` — and stamping `valid_to` there destroys a fact nothing contradicted, with no inverse verb anywhere in the product.",
    },
    {
      label: "`subject_key =` dropped from the collision join",
      edits: [
        {
          file: ADAPTER,
          oldString: "     AND ${p}.subject_key = ${d}.subject_key\n",
          newString: "",
        },
      ],
      note: "⚠️ A WIDENING, and the direction that costs a stamp: two tiers priced differently would collide. Dies on `subject-differs`, whose objects are money precisely so the OBJECT arm does not block it first.",
    },
    {
      label: "`predicate_key =` dropped from the collision join",
      edits: [
        {
          file: ADAPTER,
          oldString: "     AND ${p}.predicate_key = ${d}.predicate_key\n",
          newString: "",
        },
      ],
      note: "⚠️ The same widening one slot over, and the one the repo most needed: the whole supersession section of `promotion-pg.test.ts` runs on a single predicate, so deleting this arm broke no test anywhere before `predicate-differs` existed.",
    },
    {
      label: "`comparableDifferentSql` loses its `split_part` tag equality arm",
      edits: [
        {
          file: OBJECT_CMP,
          oldString:
            "      AND split_part(${a}, '${TAG_SEPARATOR}', 1) = split_part(${b}, '${TAG_SEPARATOR}', 1)\n",
          newString: "",
        },
      ],
      note: "`number:499` and `money:USD:499` are unequal STRINGS that nothing proves are different VALUES. Dies on `cross-type-rival` here, and on `object-cmp-pg.test.ts`'s per-row parity tests at the SQL level.",
    },
  ],
};

export default spec;
