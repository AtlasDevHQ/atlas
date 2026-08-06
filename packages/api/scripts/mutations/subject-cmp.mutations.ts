/**
 * The subject homonymy suppression, measured (#5032, ADR-0037 §5).
 *
 * ## What this table has to prove, and why the obvious mutations are not enough
 *
 * `subject_cmp` is NULL on every row this corpus writes except the four
 * `homonym-*` entries, and NULL suppresses nothing. So almost every mutation
 * below is invisible to the corpus as it stood before this slice — which is
 * exactly the trap: a suppression that fires on nothing passes every test, and
 * so does a suppression that fires on everything, if the fixtures never carry a
 * non-NULL value on both sides.
 *
 * The four `homonym-*` fixtures are what make each direction falsifiable, and
 * each kills a different class:
 *
 *   - `homonym-subject` (two DIFFERENT ids, EQUAL objects) — kills a neutralized
 *     CORROBORATION arm. Equal objects are what make it reach that consumer.
 *   - `homonym-rival` (two DIFFERENT ids, provably different objects) — kills a
 *     neutralized TENSION or SUPERSESSION arm. Added because with only the row
 *     above, deleting the subject arm from `collisionCorePredicate` killed ZERO
 *     tests: equal objects mean the collision join never matches on any
 *     implementation, so the prohibition was blocked by the wrong arm.
 *   - `homonym-control` (no ids) — kills an arm that suppresses unconditionally.
 *   - `homonym-same-entity` (the SAME id twice) — kills `both sides non-null ⇒
 *     suppress`, which no other fixture can see.
 *
 * ⚠️ **Read the corroboration column first.** It is the arm that matters:
 * `CORROBORATION_LOOKUP_SQL` has no grant arm and no cardinality arm, so a
 * homonym merge attaches a public episode as EVIDENCE to a private fact and
 * publish then overwrites `visible_to` with the union of evidence grants. The
 * supersession arm is the least important of the three and a table read
 * top-down would suggest the opposite.
 *
 * Both suites need `TEST_DATABASE_URL`; without it they skip and every cell is 0
 * for a reason that has nothing to do with coverage:
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_5021_scratch
 */

import type { MutationSpec } from "../mutation-spec";

const SUBJECT_CMP = "src/lib/brain/subject-cmp.ts";
const RECONCILE = "src/lib/brain/reconcile.ts";
const ADAPTER = "src/lib/content-mode/adapters/brain-facts.ts";

const spec: MutationSpec = {
  title: "Mutations the subject-homonymy suites catch",
  out: "scripts/mutations/subject-cmp.md",
  targets: [
    {
      name: "identity-consumers-pg.test.ts",
      file: "src/lib/brain/__tests__/identity-consumers-pg.test.ts",
    },
    { name: "reconcile.test.ts", file: "src/lib/brain/__tests__/reconcile.test.ts" },
    { name: "subject-cmp.test.ts", file: "src/lib/brain/__tests__/subject-cmp.test.ts" },
    {
      name: "brain-facts.test.ts",
      file: "src/lib/content-mode/adapters/__tests__/brain-facts.test.ts",
    },
  ],
  preamble: `
Source: \`${SUBJECT_CMP}\` (\`subjectComparableValue\`, \`subjectNotDifferentSql\`),
plus its three call sites in \`${RECONCILE}\` and \`${ADAPTER}\`.
Mutation list: \`scripts/mutations/subject-cmp.mutations.ts\`.

Read the columns against each other. \`identity-consumers-pg\` is the only file
that can observe the SUPPRESSION at all — it lands claims through
\`reconcileFacts\` against a real schema, so it sees which rows merge. The other
three see BINDS and statement TEXT and nothing else, which is strictly more than
nothing: they are the lane that runs WITHOUT \`TEST_DATABASE_URL\`, so any row
non-zero outside the first column is one a default local run still catches.

⚠️ The last two columns were added by #5032's review panel, which MEASURED that
deleting the subject arm from \`collisionCorePredicate\` was green on every
default-lane suite. \`brain-facts.test.ts\` loads the publish adapter and already
pinned the OBJECT arm three lines from where the subject arm belonged, so it was
the natural owner and did not own it; \`subject-cmp.test.ts\` did not exist at
all, leaving the module's highest-blast-radius line (\`IS NOT TRUE\` versus
\`NOT (…)\`, which covers the whole abstain band) falsifiable only in the lane
that skips by default.

⚠️ **Two rows are spelled to preserve BIND ARITY, and that is not softening
the mutation — it is what makes the number mean anything.** Deleting a
\`$6\`-consuming arm outright leaves the parameter bound but unreferenced, so
Postgres refuses every statement with *bind message supplies 6 parameters, but
prepared statement requires 5*; the runner then reports ~every test in the file,
which is the whole-suite trap this repo has already paid for once and which
measures "setup broke" rather than "this behaviour is protected". Measured on
the first cut of this table: 63 of 68, twice, plus 66 of 72 on the renumbering
row.

The neutralized arms still consume \`$6\` and still remove the behaviour, which
is what a mutation has to do. The \`::text\` casts are load-bearing for a sibling
reason: a bare \`$6 IS NULL\` is an untyped parameter and Postgres answers
*could not determine data type*, which fails the suite just as totally.

The RENUMBERING row is the exception, and it is loud by nature rather than by an
unfaithful spelling — its note records both attempts and why the surviving one
is honest. Not every hazard has a quiet mutation; pretending otherwise is how a
cell ends up describing behaviour the tree does not have.

⚠️ No row is 0 in every column. Zeros in a SINGLE column are structural — a
suite that does not load the code a row mutates, or whose fixture population the
mutation cannot reach — and the notes say which.
`,
  mutations: [
    {
      label: "the subject arm neutralized in CORROBORATION_LOOKUP_SQL (arity-preserving)",
      edits: [
        {
          file: RECONCILE,
          oldString: `      AND \${subjectNotDifferentSql("subject_cmp", "$6")}
      AND invalidated_at IS NULL
      AND valid_to IS NULL
    ORDER BY ingested_at
    LIMIT 1\`;`,
          newString: `      AND ($6::text IS NULL OR TRUE)
      AND invalidated_at IS NULL
      AND valid_to IS NULL
    ORDER BY ingested_at
    LIMIT 1\`;`,
        },
      ],
      note: "⭐ THE hazard, and the row to read first. Two entities sharing a name merge into one row, the public episode becomes evidence for the private fact, and `widenGrantFromEvidence` then unions its grant in at publish — the private claim's BODY reaching a public audience. No grant arm and no cardinality arm stand in the way.",
    },
    {
      label: "the subject arm neutralized in TENSION_CANDIDATES_SQL (arity-preserving)",
      edits: [
        {
          file: RECONCILE,
          oldString: `      AND \${subjectNotDifferentSql("subject_cmp", "$6")}
      AND invalidated_at IS NULL
      AND valid_to IS NULL
      AND id <> $7::uuid`,
          newString: `      AND ($6::text IS NULL OR TRUE)
      AND invalidated_at IS NULL
      AND valid_to IS NULL
      AND id <> $7::uuid`,
        },
      ],
      note: "A permanent advisory edge asserting that two provably-different entities contradict each other. Recoverable, but it is noise a reviewer cannot resolve — there is no arbitration to make.",
    },
    {
      label: "the subject arm deleted from collisionCorePredicate",
      edits: [
        {
          file: ADAPTER,
          oldString: `     AND \${subjectNotDifferentSql(\`\${p}.subject_cmp\`, \`\${d}.subject_cmp\`)}\n`,
          newString: "",
        },
      ],
      note: "The least consequential of the three, and the one a reader assumes is the point: supersession also needs `single` cardinality and a provably different OBJECT, so a homonym rarely reaches it. ⚠️ Behaviourally it is killed by `homonym-rival` and by nothing else — the equal-object homonyms cannot reach the collision join at all. `reconcile.test.ts` and `subject-cmp.test.ts` are structurally blind to it (neither loads the publish adapter); `brain-facts.test.ts` is the default-lane owner, and it did not own it until the panel measured this row at zero everywhere but the corpus.",
    },
    {
      label: "the polarity MIRRORED — the arm becomes a positive difference test",
      edits: [
        {
          file: SUBJECT_CMP,
          oldString: "  return `(${comparableDifferentSql(a, b)}) IS NOT TRUE`;",
          newString: "  return `(${comparableDifferentSql(a, b)})`;",
        },
      ],
      note: "⚠️ THE mistake ADR-0037 §5 names by hand: reading `subject_cmp` as `object_cmp` at another position, where proven difference is what LETS a consumer match. Applied to the shared builder because that is how the mistake would really be made — one arm, three call sites — and it is both failures at once: the rival scan mints edges between provably-different entities while every genuine rival, tension and corroboration disappears.",
    },
    {
      label: "`IS NOT TRUE` weakened to `NOT (…)` in subjectNotDifferentSql",
      edits: [
        {
          file: SUBJECT_CMP,
          oldString: "  return `(${comparableDifferentSql(a, b)}) IS NOT TRUE`;",
          newString: "  return `NOT (${comparableDifferentSql(a, b)})`;",
        },
      ],
      note: "Reads identically and deletes the entire abstain band — which at THIS position is every extractor-supplied subject, i.e. essentially the whole corpus. `NOT NULL` is NULL and a WHERE treats that as false, so corroboration, tension and supersession all stop firing everywhere.",
    },
    {
      label: "suppression widened to `both sides non-null`",
      edits: [
        {
          file: SUBJECT_CMP,
          oldString: "  return `(${comparableDifferentSql(a, b)}) IS NOT TRUE`;",
          newString: "  return `(${a}::text IS NULL OR ${b}::text IS NULL)`;",
        },
      ],
      note: "⭐ The mutation `homonym-same-entity` exists for, and the ONLY fixture that can see it. A store that confirms two claims are about the SAME entity would then stop them corroborating — so wiring a real entity store would silently switch corroboration off, and a missed corroboration writes no row anyone can find.",
    },
    {
      label: "the subject's comparable value PARSED from the surface",
      edits: [
        {
          file: RECONCILE,
          oldString: "    const subjectComparable = subjectComparableValue(subjectEntityId);",
          newString:
            "    const subjectComparable = comparableValueWithReason({ surface: subject, entityId: subjectEntityId }).value;",
        },
      ],
      note: "ADR-0037 §5's *the extractor can never supply one, for any subject, ever* made false in the tree — the same class of defect this slice corrects one file over. Mutated at the CALL SITE, because `subjectComparableValue` does not take a surface: the signature is itself part of the guard, and the only faithful way to break the rule is to route around it. ⚠️ **0 in the corpus column, and that is honest rather than a gap in the FIXTURES**: every subject there is a name (`Acme Corp`, `Ada`, `business tier`), so a surface parse yields NULL and changes no verdict. The owner is `reconcile.test.ts`'s refusal test, whose subjects (`499`, `true`) are chosen to parse — a corpus entry with a numeric SUBJECT would be a claim nobody makes.",
    },
    {
      label: "the subject's comparable value built by BYPASSING the guarded seam",
      edits: [
        {
          file: RECONCILE,
          oldString: "    const subjectComparable = subjectComparableValue(subjectEntityId);",
          newString: "    const subjectComparable = entityComparable(subject);",
        },
        {
          file: RECONCILE,
          oldString: "  comparableValueWithReason,\n  objectNotSameSql,",
          newString: "  comparableValueWithReason,\n  entityComparable,\n  objectNotSameSql,",
        },
      ],
      note: "⭐ **The spelling the round-3 panel MISSED, and the reason there was a round 4.** Round 1 branded `subjectComparableValue`'s PARAMETER, and the panel then measured the spelling the compiler rejects — `subjectComparableValue(surface)` — and published it as closed. This is the one it accepts: `entityComparable` is exported and unbranded, so while the subject position's destination types spelled `EntityComparable` this compiled with no cast and reproduced round 1's defect verbatim (the raw surface as payload ⇒ `entity:Acme Corp` vs `entity:acme-corp` ⇒ proven-different ⇒ corroboration off for the exact corpus pair). Round 4 branded the OUTPUT, so this no longer type-checks — but `mutate.ts` transpiles without type-checking, which is what lets this row keep MEASURING the behaviour after the compiler stopped permitting it. Both halves are pinned at compile time too, by the `@ts-expect-error` pair in `subject-cmp.test.ts`; those are self-falsifying, since widening either guard makes the directive unused and therefore an error.",
    },
    {
      label: "the tension scan's trailing placeholders left un-renumbered",
      edits: [
        {
          file: RECONCILE,
          // ⚠️ **This row is a LOUD one and no spelling makes it quiet.** Two
          // were tried and MEASURED, and both fail ~every test in the file for
          // a reason that is not "which behaviour is protected":
          //
          //   renumber both (`$6` / `$7`)  → `$8` unreferenced
          //                                  → *bind message supplies 8
          //                                    parameters, requires 7* (66/72)
          //   renumber the self-exclusion  → `$7` unreferenced
          //     alone, keep `LIMIT $8`       → *could not determine data type
          //                                    of parameter $7* (66/76)
          //
          // The second is kept because it is the FAITHFUL one: it is exactly
          // what widening `agreementBinds` without renumbering produces, and
          // `agreementBinds`'s own docstring says so — *"in `INSERT_FACT_SQL`
          // the spread is last and pg would at least raise an arity error; in
          // the rival scan it would not."* The rival scan's failure is a type
          // one, at RUNTIME, and nothing at compile time sees it. So the count
          // is near-total by nature rather than by an unfaithful mutation, and
          // reporting it smaller would require pretending the statement still
          // runs.
          oldString: "      AND id <> $7::uuid",
          newString: "      AND id <> $6::uuid",
        },
      ],
      note: "⚠️ **The near-total count is the faithful answer here, and the note above records both spellings that were measured to get to it.** What widening `agreementBinds` without renumbering costs is not a subtly wrong verdict — it is a statement Postgres refuses (*could not determine data type of parameter $7*, measured), on every `single` candidate, at runtime. `agreementBinds`'s docstring names this row as the thing that actually enforces the renumbering, because the compiler does not: a 4-tuple and a 5-tuple spread into `unknown[]` identically. An earlier version of this note claimed the scan 'silently returns nothing' — that was reasoned rather than measured, and it was wrong.",
    },
  ],
};

export default spec;
