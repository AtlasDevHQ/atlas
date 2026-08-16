/**
 * The tier-1 warehouse producer's falsifiers, as a spec CI can re-run (#5229).
 *
 * ## Why this file exists
 *
 * #5042 shipped the producer with fifteen mutations applied and measured BY HAND
 * during review — fourteen red, one explained — and every one of those numbers
 * lives in a commit message. A commit message is a claim about the tree at one
 * instant; nothing re-checks it, so the strongest evidence this module's tests can
 * actually fail was prose. That is the shape #5061 finished retiring, and the
 * runner justified itself immediately by finding 11 of 53 cells wrong in
 * `vocabulary-decide` under a docstring arguing no cell COULD have fallen.
 *
 * ## The two rows that are the whole point
 *
 * Both were measured SURVIVING on #5042's first review pass, and neither failure
 * was in the production code:
 *
 *   - **`predicate: dim.name` -> `dim.sql`.** Every fixture set a dimension's
 *     `sql:` to its `name:` — the profiler's own default — so the two spellings
 *     were the same string everywhere and emitting a COLUMN EXPRESSION as a
 *     predicate was unfalsifiable. Fixtures that agree by construction cannot
 *     falsify the rule they exist for, and this is the rule the BARE name exists
 *     to hold (ADR-0037 section 4): a qualified predicate lexically matches
 *     nothing an LLM emits, so cross-tier collision counts exactly zero.
 *   - **The production SQL gate deleted.** `test-setup.ts` strips every `ATLAS_*`
 *     var, so `detectDBType()` threw and `validateSQL` returned *"No valid
 *     datasource configured"* before it read the statement at all. The suite's
 *     positive control then asserted inside `if (!result.valid)` against a regex
 *     that string can never match, so deleting the gate left every suite green.
 *
 * Both are fixed in the source. Neither was protected from regression by anything
 * CI runs, which is what this file changes. If either ever measures 0 across the
 * whole row again, that is the same defect returning by a different door.
 *
 * ## The `-pg` column needs a database
 *
 * `warehouse-producer-pg.test.ts` self-skips without `TEST_DATABASE_URL`, and the
 * runner refuses a deflated baseline rather than writing zeros over it:
 *
 *   bun run db:up
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:5433/brain_5229_scratch
 *
 * ## What is here, and the one class that is deliberately NOT
 *
 * Every mutation #5229 enumerates has a row below. The fifteenth is not on that
 * list: it is the only edit the bypass suite can see, and without it that column
 * would be zero end to end and would read as a suite covering nothing.
 *
 * The class left out is TYPE-ONLY edits — the verdict's `error` made optional,
 * the snapshot seam's parameter widened back to a bare request. `bun test` strips
 * types, so a row for either would publish a `0` that reads as *"no test covers
 * this"* when the truth is *"this instrument cannot see it"*, which is the
 * tombstone `mutate.ts`'s header refuses. Their gate is `bun run type` and their
 * falsifiers are the `@ts-expect-error` rows in `warehouse-producer.test.ts`,
 * which INVERT: a narrowing that evaporates turns an expected error into an
 * unused directive and reds the type-check. The RUNTIME half of the `error` edit
 * — a refusing verdict that carries no reason — is measurable, and it has a row.
 */

import type { MutationSpec } from "../mutation-spec";

const PRODUCER = "src/lib/brain/warehouse-producer.ts";

const spec: MutationSpec = {
  title: "Mutations the warehouse producer's suites catch",
  out: "scripts/mutations/warehouse-producer.md",
  targets: [
    { name: "producer", file: "src/lib/brain/__tests__/warehouse-producer.test.ts" },
    { name: "logging", file: "src/lib/brain/__tests__/warehouse-producer-logging.test.ts" },
    { name: "bypass", file: "src/lib/brain/__tests__/warehouse-producer-bypass.test.ts" },
    { name: "mint", file: "src/lib/brain/__tests__/warehouse-producer-mint.test.ts" },
    { name: "pg", file: "src/lib/brain/__tests__/warehouse-producer-pg.test.ts" },
  ],
  preamble: `
Source: \`${PRODUCER}\`.
Mutation list: \`scripts/mutations/warehouse-producer.mutations.ts\`.

Read the columns against each other rather than the totals down. The five
suites are five different instruments and the interesting fact is usually
which one holds a row up:

- **producer** — what the run DECIDES against injected seams. The widest column:
  the only one that catches the row cap, the collision guard, the absent-cell
  split and the episode reader.
- **logging** — PER-LEVEL sinks. A single-array capture cannot see a demotion, so
  this is the only column that can fail on \`log.error\` becoming \`log.warn\` —
  and the only one that fails on a warn deleted outright while the counter it
  reports stays correct. Both of those rows are 0 in \`producer\`.
- **bypass** — the \`@sql-gate-guarded\` closure. It pins WHICH names may assert a
  passing SQL verdict and is blind to what the gate DECIDES, so it is 0 on every
  behavioural row and non-zero only on the last one — which is there to prove
  the column is a measurement rather than decoration.
- **mint** — the production mint's by-reference contract (#5230), in its own file
  because it needs \`mock.module\`, whose blast radius is the process.
- **pg** — a live schema, and the reason it is here is the FIRST row. Everything
  it settles that a mock cannot — a fact landing \`draft\`, \`subject_cmp\`
  populated, re-emission staying tension-only — it settles through fixtures whose
  \`sql:\` now differs from their \`name:\`, so the predicate split is exercised
  against real rows as well as injected ones. It catches nothing else here, and
  that is the honest shape of a six-test integration suite: the other fourteen
  mutations are decisions the run makes before any row is written.

⚠️ **A zero here is a statement about ONE instrument, not about coverage.** The
row that would matter is one that is zero EVERYWHERE, and there is none — every
mutation below dies in at least one column, and every column kills at least one
mutation. If a future edit makes one of them survive across a whole row, the fix
is a fixture, not a deleted row.
`,
  mutations: [
    {
      label:
        "`predicate: dim.name` -> `dim.sql` — the qualified column expression emitted as the predicate",
      edits: [
        {
          file: PRODUCER,
          oldString: "        predicate: dim.name,",
          newString: "        predicate: dim.sql,",
        },
      ],
      note: "The row this table was filed for. It survived #5042's first review pass because every fixture set `sql:` equal to `name:`; both suites now derive a DIFFERENT column per dimension, so the split is exercised by every test rather than by one that remembers to.",
    },
    {
      label: "`buildSnapshotSql` selects the bare NAME instead of the dimension's `sql:` expression",
      edits: [
        {
          file: PRODUCER,
          oldString:
            '    ...plan.dimensions.map((dim, index) => `${dim.sql} AS ${DIMENSION_ALIAS_PREFIX}${index}`),',
          newString:
            '    ...plan.dimensions.map((dim, index) => `${dim.name} AS ${DIMENSION_ALIAS_PREFIX}${index}`),',
        },
      ],
      note: "The same `name`/`sql` confusion at the OTHER end of the pipe, and it fails in the opposite direction: here the expression is what belongs and the bare name is wrong. One fixture change closed both, which is exactly why both need a row — a later fixture that re-collapses them would put both back.",
    },
    {
      label: "the subject-collision guard compares ids again, so a duplicate primary key emits twice",
      edits: [
        {
          file: PRODUCER,
          oldString: `    if (subjectIds.has(subject)) {
      collidingSubjectRows++;`,
          newString: `    if (subjectIds.has(subject) && subjectIds.get(subject) !== rowId) {
      collidingSubjectRows++;`,
        },
      ],
      note: "The pre-#5042-review guard. Two rows with the SAME declared key mint the same id, fall through, and emit a second full candidate set for one subject — while `single` cardinality is proposed for those predicates in the same transaction. Nothing guarantees a declared key is unique: `primary_key: true` is admin-authored YAML, the table may be a view, and `sql:` may be an expression.",
    },
    {
      label: "the row cap becomes `>=`, refusing every entity of exactly `cap` rows",
      edits: [
        {
          file: PRODUCER,
          oldString: "      const overCap = rowCount > rowCap;",
          newString: "      const overCap = rowCount >= rowCap;",
        },
      ],
      note: "An off-by-one that refuses a legal table rather than admitting an illegal one, so it is silent in production: the operator sees `row-cap-exceeded` on a table that is exactly at the bound and narrows an enrollment that did not need narrowing. `buildSnapshotSql` emits `LIMIT cap + 1` precisely so the boundary is observable.",
    },
    {
      label: "the production SQL gate deleted — `defaultValidateSnapshotSql` passes everything",
      edits: [
        {
          file: PRODUCER,
          oldString: `  const { validateSQL } = await import("@atlas/api/lib/tools/sql");
  const result = await validateSQL(request.sql, request.connectionId, request.workspaceId);`,
          newString: `  const result: { valid: boolean; error: string } = { valid: true, error: "" };`,
        },
      ],
      note: "The second row this table was filed for. It survived #5042's first review pass: the suite-wide `ATLAS_*` strip made `validateSQL` return before it read the statement, and the positive control asserted inside a branch that could never be false. The gate is SELECT-only, single-statement and whitelist-scoped over a string assembled from admin-authored `table:` and `sql:` text, which is the one input it exists for. ⚠️ **The `whole-suite` flag on `mint` is honest and was checked.** That file holds exactly two tests and both are about this function — one asserts `validateSQL` was called with THIS statement, the other that a refusing gate is passed through — so deleting the gate kills its SUBJECT twice rather than its setup once. The flag fires on a ratio, and a two-test single-subject file cannot avoid tripping it.",
    },
    {
      label: "the gate's refusing verdict carries no reason",
      edits: [
        {
          file: PRODUCER,
          oldString: "      { valid: false, error: result.error };",
          newString: "      { valid: false, error: undefined as unknown as string };",
        },
      ],
      note: "The runtime half of the `error`-made-optional edit. A permanent refusal whose whole message is *“re-running will not change this”* then tells the admin nothing about what to fix — the generic message CLAUDE.md forbids, at the position where it costs the most. The type half is a compile-time claim and has no row here; see the header.",
    },
    {
      label: "a validator THROW reported as `snapshot-rejected` — the permanence inversion",
      edits: [
        {
          file: PRODUCER,
          oldString: `        entityPlan,
        "snapshot-failed",
        \`Atlas could not check the query it would run against`,
          newString: `        entityPlan,
        "snapshot-rejected",
        \`Atlas could not check the query it would run against`,
        },
      ],
      note: "A throw is not a verdict of invalid. The shipped gate dynamically imports a module and reads settings, so a module-init failure or a briefly-unavailable internal DB lands here — transient — and the rejected arm tells the admin to un-enroll a pair that is fine. One message cannot carry both *“retry”* and *“retrying will never work”*, which is why the two reasons exist.",
    },
    {
      label: "a transaction failure re-thrown instead of refusing its entity",
      edits: [
        {
          file: PRODUCER,
          oldString: "      transactionAborted = true;",
          newString: "      throw err;",
        },
      ],
      note: "The producer's own first stated decision, reversed at #5042's closing round. The throw reaches `runEffect`, which answers a 500, while entities 1..N-1 have COMMITTED. The admin reads *“Failed to run”*, presses Run again, `now()` yields a fresh instant so `ON CONFLICT` dedupes nothing, and every committed entity files a second full round of drafts into the review queue this producer exists to keep reviewable.",
    },
    {
      label: "the transaction-failure `log.error` demoted to `log.warn`",
      edits: [
        {
          file: PRODUCER,
          oldString: `      log.error(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          committedEntities: outcomes.map((o) => o.entity),
          committedCreated: outcomes.reduce((sum, o) => sum + o.created, 0),
          // ⚠️ These two`,
          newString: `      log.warn(
        {
          ...runLog,
          entity: entityPlan.entity.name,
          committedEntities: outcomes.map((o) => o.entity),
          committedCreated: outcomes.reduce((sum, o) => sum + o.created, 0),
          // ⚠️ These two`,
        },
      ],
      note: "The one mutation only PER-LEVEL sinks can see. A single-array capture asserts the payload and the message and is structurally blind to the level — measured on #5042, where the same demotion killed zero tests in two of three logging files in the very commit that fixed it in the third. This is a partial rollback whose blast radius is an alert that never fires.",
    },
    {
      label: "the colliding-subject row-drop warn deleted",
      edits: [
        {
          file: PRODUCER,
          oldString: `    if (claims.collidingSubjectRows > 0) {
      log.warn(`,
          newString: `    if (false) {
      log.warn(`,
        },
      ],
      note: "Both row-drop counters reached the report and neither reached a log, while their sibling in the same object literal got a warn. Dropping a row is a data-affecting decision, and an operator asking *“why is account 4471 missing from the queue”* had nothing to grep — and under a degraded response the counters are withheld too, which makes the drop fully silent.",
    },
    {
      label: "the unsurfaceable-key row-drop warn deleted",
      edits: [
        {
          file: PRODUCER,
          oldString: `    if (claims.unsurfaceableKeyRows > 0) {
      log.warn(`,
          newString: `    if (false) {
      log.warn(`,
        },
      ],
      note: "The sibling of the row above, and the reason they are two rows rather than one: fixing the reported instance and not the class is how the same defect returns one counter over. A `bytea` primary key makes every row of the entity unemittable, which is the case an operator most needs named.",
    },
    {
      label: "`isAbsentCell` loses its blank-string arm",
      edits: [
        {
          file: PRODUCER,
          oldString: '  return typeof value === "string" && value.trim() === "";',
          newString: "  return false;",
        },
      ],
      note: "`''` and `'   '` are what a CSV or ETL load writes where a source system has a NOT NULL text default — the ordinary empty cell. Filed as an enrollment mistake, a benign column inflates `unsurfaceableCells` on every run forever AND makes a real `jsonb` enrollment indistinguishable from it, while the warn sends the operator hunting a `jsonb` column that need not exist.",
    },
    {
      label: "`isAbsentCell` loses its non-finite / invalid-Date arms",
      edits: [
        {
          file: PRODUCER,
          oldString: `  if (typeof value === "number" && !Number.isFinite(value)) return true;
  if (value instanceof Date && Number.isNaN(value.getTime())) return true;`,
          newString: `  if (typeof value === "bigint" && value === 0n) return true;`,
        },
      ],
      note: "The blank-string argument, one member short: `NaN` out of a `double precision` column is that column's null and `0000-00-00` out of MySQL is an Invalid Date. The COLUMN is fine and one row is bad. Replaced with an arm that is live TypeScript and reachable by nothing in the fixtures, so what is measured is the loss of these two rather than a syntax change.",
    },
    {
      label: "the episode reader accepts a row whose `id` it cannot parse",
      edits: [
        {
          file: PRODUCER,
          oldString: '  if (!isRecord(row) || typeof row.id !== "string") {',
          newString: "  if (!isRecord(row)) {",
        },
      ],
      note: "`WAREHOUSE_EPISODE_INSERT_SQL` is exported precisely because it is expected to be edited, and a `RETURNING` clause the reader cannot parse would otherwise make every entity of every run report *“this snapshot instant is already recorded”* — a false sentence, at `info`, on a producer that would then look like a well-behaved no-op forever. This is the module's own contract, so it stays fatal rather than becoming a per-entity refusal.",
    },
    {
      label: "the `@sql-gate-guarded` tag deleted from the producer's deps interface",
      edits: [
        {
          file: PRODUCER,
          oldString: ` * Every I/O seam the run touches, each defaulted to its production wiring.
 *
 * @sql-gate-guarded
 */`,
          newString: ` * Every I/O seam the run touches, each defaulted to its production wiring.
 */`,
        },
      ],
      note: "The only row the bypass column can see, and it is here so that column is a measurement rather than decoration. The tag is the human-readable half of the membership decision; the STRUCTURAL closure — every exported declaration naming the brand symbol, transitively — is the enforcing half, and the suite asserts the two equal in BOTH directions. A tag deleted while the declaration still carries the brand is exactly the drift a hand-maintained list three directories away cannot detect. ⚠️ **The anchor is the DOCSTRING rather than the declaration below it, and that is deliberate.** This directory is one of the roots that suite scans, and it fails on any file merely NAMING one of the five guarded types — so anchoring on the `export interface` line would have made this spec trip the guard it exists to protect. Reworded, never exempted; do not \"fix\" the anchor by extending it downwards.",
    },
  ],
};

export default spec;
