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
 *     datasource configured"* before it read the statement at all. The positive
 *     control's assertion was a NEGATIVE match sitting inside `if (!result.valid)`
 *     — and that string satisfies a negative match trivially, so the test passed
 *     for `DROP TABLE users; SELECT 1` as readily as for a real statement and
 *     deleting the gate left every suite green. The block now sets a datasource so
 *     the gate is reached, asserts UNCONDITIONALLY, and carries a positive
 *     tripwire on the shipped gate's own wording plus a negative control.
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
 *   export TEST_DATABASE_URL=postgresql://atlas:atlas@localhost:<port>/brain_5229_scratch
 *
 * ⚠️ `db:up` maps **5432** (the root `docker-compose.yml`); the multi-env compose
 * maps 5433/5434/5435. Several sibling specs pair `db:up` with 5433, which is the
 * wrong port for the container that command starts.
 *
 * ## What is here, and the one class that is deliberately NOT
 *
 * #5229 enumerates fourteen mutations and each has a row below. The rest are
 * additions. Two of them earn their place structurally rather than by argument:
 * the `@sql-gate-guarded` tag deleted, and a brand-carrying export added untagged,
 * are the only edits to THIS module the bypass suite can see — one for each
 * direction of the set equality it asserts. Without them that column is zero end
 * to end and reads as a suite covering nothing.
 *
 * The class left out is TYPE-ONLY edits — the verdict's `error` made optional, and
 * the snapshot seam's parameter widened back to a bare request. `bun test` strips
 * types, so a row for either would publish a `0` that reads as *"no test covers
 * this"* when the truth is *"this instrument cannot see it"*, which is the
 * tombstone `mutate.ts`'s header refuses.
 *
 * ⚠️ **Their gate is `bun run type`, and the two are caught by DIFFERENT things —
 * measured, because an earlier draft of this paragraph attributed both to the
 * `@ts-expect-error` rows and that was true of only one.** Each was applied alone
 * against `bun x tsgo --noEmit -p packages/api/tsconfig.json`, which is the project
 * whose relative `@atlas/api/* -> ./src/*` mapping reads THIS tree:
 *
 *   - the seam's parameter widened -> `TS2578: Unused '@ts-expect-error' directive`
 *     at `warehouse-producer.test.ts` lines 1303 and 1318. Those directives INVERT,
 *     which is the mechanism the paragraph originally described.
 *   - `error` made optional -> `TS2532: Object is possibly 'undefined'` at line 578,
 *     where the negative control reads `.length` off the gate's reason. No
 *     `@ts-expect-error` covers this one; the falsifier is an ordinary assertion
 *     that happens to dereference the field the edit makes optional.
 *
 * The RUNTIME half of the `error` edit — a refusing verdict that carries no reason
 * — is measurable under `bun test`, and it has a row.
 */

import type { MutationSpec } from "../mutation-spec";

const PRODUCER = "src/lib/brain/warehouse-producer.ts";
/** The per-entity success record's writer (#5317) — one call site, in `PRODUCER`. */
const RECORD = "src/lib/brain/warehouse-run-record.ts";

const spec: MutationSpec = {
  title: "Mutations the warehouse producer's suites catch",
  out: "scripts/mutations/warehouse-producer.md",
  targets: [
    { name: "producer", file: "src/lib/brain/__tests__/warehouse-producer.test.ts" },
    { name: "logging", file: "src/lib/brain/__tests__/warehouse-producer-logging.test.ts" },
    { name: "bypass", file: "src/lib/brain/__tests__/warehouse-producer-bypass.test.ts" },
    { name: "mint", file: "src/lib/brain/__tests__/warehouse-producer-mint.test.ts" },
    { name: "pg", file: "src/lib/brain/__tests__/warehouse-producer-pg.test.ts" },
    { name: "record", file: "src/lib/brain/__tests__/warehouse-run-record-pg.test.ts" },
  ],
  preamble: `
Source: \`${PRODUCER}\`.
Mutation list: \`scripts/mutations/warehouse-producer.mutations.ts\`.

Read the columns against each other rather than the totals down. The six
suites are six different instruments and the interesting fact is usually
which one holds a row up:

- **producer** — what the run DECIDES against injected seams. The widest column:
  the only one that catches the collision guard, the \`LIMIT cap + 1\` arithmetic,
  both halves of the absent-cell split and the episode reader. (Not the row CAP —
  one of its two rows is caught in \`logging\` as well.)
- **logging** — PER-LEVEL sinks. A single-array capture cannot see a demotion, so
  this is the only column that can fail on \`log.error\` becoming \`log.warn\`, on
  a warn deleted outright while the counter it reports stays correct, or on a
  field dropped from a payload the operator-facing message promises. FOUR rows are
  non-zero here and 0 in \`producer\` — the demotion, both row-drop warns, and the
  edge pass losing \`err\`.
- **bypass** — the guarded-name set, pinned at its definition site. It pins which
  FILES may name the five guarded types and asserts that the tag set and the
  structurally-derived closure are equal; since #5249 an entry means *may name*,
  not *may cast*. Only the tag/closure half is reachable by editing THIS module —
  no mutation here can make a different FILE name a guarded type — so both of its
  kills are the set-equality assertion, once in each direction (a tag deleted, and
  a brand-carrying export added untagged), and the whole-file scan contributes 0
  to every row by construction rather than by omission.
- **mint** — the production mint's by-reference contract (#5230), in its own file
  because it needs \`mock.module\`, whose blast radius is the process. It never
  calls \`runWarehouseProducer\`, so it is 0 on every row except the two that edit
  \`defaultValidateSnapshotSql\` itself.
- **pg** — a live schema. It is non-zero on exactly the two rows where a stored row
  settles something a mock cannot: the emitted predicate, and the surface the
  cardinality proposal is keyed by. Both are the \`name\`/\`sql\` decision, and both
  are exercised only because this suite's fixtures give every dimension a \`sql:\`
  that differs from its \`name:\`. Its zeros elsewhere are honest for THREE
  different reasons, and collapsing them is what two earlier drafts of this bullet
  did: most rows are decisions a mock can drive that a live schema adds nothing to;
  the transaction-failure and episode-reader rows are unreachable from a real
  Postgres fixture, since this suite injects no failing transaction and a real
  \`RETURNING\` never hands back a non-string id; and the two \`buildSnapshotSql\`
  rows and every log-level row are structurally invisible here, because this suite
  injects its own snapshot runner — so the built statement is never executed — and
  captures no logs.

⚠️ **A zero here is a statement about ONE instrument, not about coverage.** The
row that would matter is one that is zero EVERYWHERE, and there is none — every
mutation below dies in at least one column, and every column kills at least one
mutation. If a future edit makes one of them survive across a whole row, the fix
is a fixture, not a deleted row.

⚠️ **A large minority of rows are held up by exactly ONE test in exactly one
column** — read the generated table for which, rather than trusting a count here;
this paragraph is hand-written prose and the counts move with every added row. The
runner has no floor warning to tell you when a row drops to 1: \`mutate.ts\` flags a
suspiciously HIGH count and says nothing about a 1. Those rows are one weakened
assertion from returning to unfalsifiable, and they are the ones to re-read first
when a count moves.

⚠️ **Several of those single points sit in PAIRS behind one test each**, which is
worse than the same number of independent single points: one deleted assertion
returns TWO rows to unfalsifiable at once, and for the two \`@sql-gate-guarded\`
rows it zeroes the whole \`bypass\` column. The pairs are the two tag/closure rows,
the two row-drop warns, and the two row-cap rows. The cap pair is the one that
still discriminates, and only through \`logging\`: at a cap of 1 with two rows,
\`>=\` still refuses while \`overCap = false\` does not.

⚠️ **The #5284 rows are the newest single points, and one of them was measured
GREEN across all four suites before its falsifier was written** — the mismatch
arm recomputing the submitted connection from the YAML hint. That is the shape
this file exists for: a fix whose defect nothing could see, sitting one binding
away from the fix that closed it.

The opposite end deserves the same suspicion. The identity-check row carries the
largest count here and was inspected rather than trusted; see its note.

- **record** — the per-entity success record (#5317), and the ONLY column that can
  fail on where that row is written. It drives the real producer through a
  transaction that does its work and then ROLLS BACK, which is the one thing no
  fake executor can express: every stub in the tree resolves whatever it is handed,
  so a writer given the module pool instead of the entity's \`tx\` looks identical
  to a correct one everywhere else. The record authorizes a DELETE in #5233, so
  "it survived a rollback" is the failure with the consequence.
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
      note: "The same `name`/`sql` confusion at the OTHER end of the pipe, and it fails in the opposite direction: here the expression is what belongs and the bare name is wrong. One fixture change closed both, which is exactly why both need a row — a later fixture that re-collapses them would put both back. ⚠️ Two of its four kills are fixture ANCHORS rather than subjects: the `logging` pair asserts a column name appears in the submitted statement as the positive half of a secrecy check, and dies because the anchor string moved. The on-subject kills are the two in `producer` — the builder's own statement test, and the run-level assertion that an unenrolled column never leaves the warehouse.",
    },
    {
      label: "`buildSnapshotSql` selects the bare primary-key NAME as the subject column",
      edits: [
        {
          file: PRODUCER,
          oldString: '    `${plan.primaryKey.sql} AS ${SUBJECT_ALIAS}`,',
          newString: '    `${plan.primaryKey.name} AS ${SUBJECT_ALIAS}`,',
        },
      ],
      note: "The adjacent field in the same array literal as the row above, and the reason it gets its own row: fixing one half of a two-element list and calling the class closed is how the same defect comes back one line over. The subject position is the worse half — a key column that is an expression (`left(id,3)`) or simply named differently from its `sql:` makes the subject arrive from a column that may not exist, or from a different one that does, silently re-keying every `subject_cmp` in the run.",
    },
    {
      label: "the cardinality proposal is keyed by the dimension's `sql:` rather than its name",
      edits: [
        {
          file: PRODUCER,
          oldString: "            predicateSurface: dim.name,",
          newString: "            predicateSurface: dim.sql,",
        },
      ],
      note: "The THIRD site of the same `name`/`sql` decision, and the quietest of the three. A `single` cardinality proposal filed under `col_status` while the emitted predicate is `status` refuses nothing and warns about nothing: the vocabulary simply never gates `in-tension-with` for the predicate that actually exists, so supersession stays dormant — the dormancy ADR-0037 section 4 spent four slices closing. It is also why the `predicate: dim.name` row measures 2 in `pg` rather than 3: the `-pg` cardinality assertion reads THIS site, not that one. ⚠️ Named rather than pointed at — an earlier draft said *“the row above”*, and the very round that added the row now sitting between the two turned that sentence into a citation of a cell measuring 0. A positional reference into a list that grows is unfalsifiable by construction.",
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
      label: "the row cap never fires — an over-cap entity emits a truncated snapshot",
      edits: [
        {
          file: PRODUCER,
          oldString: "      const overCap = rowCount > rowCap;",
          newString: "      const overCap = false;",
        },
      ],
      note: "The row above moves the boundary in the SAFE direction; this one removes the guard entirely, which is the direction `WAREHOUSE_ROW_CAP` exists for. A truncated reading looks at rest exactly like a complete one, so a reviewer publishes three hundred account statuses believing they have seen the accounts. A guard is not falsified by a test that only ever exercises its conservative side.",
    },
    {
      label: "`buildSnapshotSql` emits `LIMIT cap` — the extra row that makes the cap observable",
      edits: [
        {
          file: PRODUCER,
          oldString: "LIMIT ${rowCap + 1}`;",
          newString: "LIMIT ${rowCap}`;",
        },
      ],
      note: "The cap's evidence, deleted. At exactly `cap` rows a truncated read and a table of that size are the same result set, so the guard above it can never fire and the producer silently emits an arbitrary subset. Two edits one function apart hold one invariant between them, and only the pair of rows shows that. ⚠️ Only ONE of its two `producer` kills is on-subject: the other is a whole-statement equality assertion that dies because the `LIMIT` literal moved inside it — the same fixture-anchor class the `buildSnapshotSql` dimension row discloses. Read this row as a 1.",
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
      note: "The second row this table was filed for. It survived #5042's first review pass: the suite-wide `ATLAS_*` strip made `validateSQL` return *“No valid datasource configured”* before it read the statement, and the positive control's assertion was a NEGATIVE match inside `if (!result.valid)` — which that string satisfies trivially. The block now sets a datasource, asserts unconditionally, and carries a positive tripwire on the shipped gate's own wording, so this mutation reds it two ways: the reason becomes empty and the refusal becomes a pass. ⚠️ **The `whole-suite` flag on `mint` is honest and was checked.** That file holds exactly two tests and both are about this function — one asserts `validateSQL` was called with THIS statement, the other that a refusing gate is passed through — so deleting the gate kills its SUBJECT twice rather than its setup once. The flag fires on a ratio, and a two-test single-subject file cannot avoid tripping it.",
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
      note: "The runtime half of the `error`-made-optional edit. A permanent refusal whose whole message is *“re-running will not change this”* then tells the admin nothing about what to fix — the generic message CLAUDE.md forbids, at the position where it costs the most. The type half is a compile-time claim and has no row here — it reds `bun run type` with `TS2532: Object is possibly 'undefined'` where the negative control reads `.length` off the reason, measured rather than assumed; see the header.",
    },
    {
      label: "the anti-replay identity check deleted — a token minted for another statement is accepted",
      edits: [
        {
          file: PRODUCER,
          // ⚠️ **A DISJUNCT DELETED, not the whole guard, and the difference is
          // measured.** `if (false)` was the obvious spelling and it does not
          // COMPILE: the deleted condition is the only thing narrowing `validated`
          // from `… | undefined`, so the snapshot seam's call site reds with
          // `TS2345` — a mutant `bun run type` forbids, which is exactly the
          // objection the episode-reader row's second edit exists to answer. Two
          // rows in this file would then hold opposite standards. Dropping only the
          // `!==` disjunct keeps the narrowing, deletes precisely the anti-replay
          // comparison, and type-checks clean — and the source's own comment invites
          // it by calling the surviving disjunct "Redundant".
          oldString: "    if (validated === undefined || validated !== request) {",
          newString: "    if (validated === undefined) {",
        },
      ],
      note: "The highest-blast-radius line in the module, and the row it had none of. The gate's verdict carries the request it passed, but nothing stops a validator handing back a genuine token minted for a DIFFERENT statement — `cached ??= await validate(BENIGN_REQUEST)` forges nothing and would let one benign statement authorize every entity in the run. The type narrows the door and only this comparison closes it, which the module's own docstring says in as many words. Because `defaultRunSnapshot` selects the pool from the RETURNED `workspaceId`/`connectionId`, the residual is a cross-tenant read rather than merely a gate bypass. The deleted-gate row does not stand in for it: with the gate stubbed to pass, the mint hands back the very object it was given and this check is satisfied. ⚠️ **This row's `logging` count is the largest in the table and was INSPECTED rather than published on trust** — a count that size is usually a mutation breaking suite SETUP. It is not: every failing test sits in the #5230/#5248 mismatch block and reaches the mismatch arm, whose greppable signature is `payloadOf(errors, \"verdict for a different request\")`. Two things a bare *“the block dies”* would hide, and both are checks on the count: neighbours in that same block routing to the REJECTED or gate-threw arms sit UPSTREAM of this comparison and correctly survive, and one of the failures is an anchor rather than a subject — the request-id sweep, which asserts only that some error line exists. ⚠️ The count MOVED when the mutation was respelled (see the edit's comment), and the drop is itself evidence the respelling is more precise: the case that stopped failing is *“the verdict's request is undefined”*, which now routes through the surviving `=== undefined` arm exactly as it should.",
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
          // ⚠️ The throw goes AFTER the log, not in place of the flag. Replacing
          // `transactionAborted = true;` makes the `log.error` below it unreachable
          // too, so the row would silently also contain "the transaction-failure log
          // deleted" — one line from being the NEXT row's subject, and the two counts
          // would no longer be readable against each other.
          oldString: `      refuseEntity(
        entityPlan,
        "snapshot-failed",
        \`Writing "\${entityPlan.entity.table}"'s claims failed`,
          newString: `      throw err;
      refuseEntity(
        entityPlan,
        "snapshot-failed",
        \`Writing "\${entityPlan.entity.table}"'s claims failed`,
        },
      ],
      note: "The producer's own first stated decision, reversed at #5042's closing round. The throw reaches `runEffect`, which answers a 500, while entities 1..N-1 have COMMITTED. The admin reads *“Failed to run”*, presses Run again, `now()` yields a fresh instant so `ON CONFLICT` dedupes nothing, and every committed entity files a second full round of drafts into the review queue this producer exists to keep reviewable. ⚠️ Measured both spellings: throwing in PLACE of the flag also deletes the `log.error` below it, which is the next row's subject, and the counts are identical either way (1 / 4). So the numbers never distinguished the two — the anchor is placed after the log anyway, because a row whose label names one change should not silently contain two.",
    },
    {
      label: "the transaction-failure `log.error` demoted to `log.warn`",
      edits: [
        {
          file: PRODUCER,
          // ⚠️ **THE TRAILING COMMENT LINE IS PART OF THE ANCHOR, not decoration.**
          // The five payload lines above it are byte-identical to a sibling
          // `log.error` further down the same function — same indentation, same four
          // fields — so without that sixth line this matches TWICE and the runner
          // refuses to measure it. Reword `// ⚠️ These two` in the source and this
          // anchor dies loudly, which is the intended failure; SHORTEN it here and
          // the spec stops working for a reason nobody records.
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
        // ⚠️ SECOND EDIT, and it is what makes the mutant a regression a GREEN tree
        // could actually hold. Dropping the id check alone leaves `row.id` as
        // `unknown` against a declared `Promise<{ id: string; … } | null>`, so
        // `bun run type` reds on the mutation rather than on the defect — and a row
        // measuring a state the type-checker already forbids is weaker evidence than
        // its number reads as. Coercing instead of validating is also the more
        // plausible way someone writes this bug.
        {
          file: PRODUCER,
          oldString: "  return { id: row.id, sourceId };",
          newString: "  return { id: String(row.id), sourceId };",
        },
      ],
      note: "`WAREHOUSE_EPISODE_INSERT_SQL` is exported precisely because it is expected to be edited, and this reader is the only thing that notices when its `RETURNING` clause and this function stop agreeing. Mutated, an unreadable row travels onward as a real episode instead of being refused. ⚠️ **TWO edits, and the second is why the row is honest.** Dropping the id check alone leaves the return statement assigning an `unknown` to a declared `string`, so `bun run type` would red on the MUTATION rather than on the defect; coercing instead of validating compiles, is the likelier way someone writes this bug, and lands a plausible `\"undefined\"` in the episode table — the worse residual, so the row is strengthened rather than diluted. It kills the same single test either way. ⚠️ **It does NOT produce the *“already recorded”* report, and an earlier draft of this note said it did.** That sentence is the consequence of folding this arm together with `rows.length === 0`, which is the split the source comment above it argues for — a different edit from this one. Stated here because a note that borrows its neighbour's consequence is exactly the unfalsifiable claim this file exists to retire.",
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
      note: "One of the two rows the bypass column can see, and the pair is here so that column is a measurement rather than decoration. The tag is the human-readable half of the membership decision; the STRUCTURAL closure — every exported declaration naming the brand symbol, transitively — is the enforcing half, and the suite asserts the two equal in BOTH directions. A tag deleted while the declaration still carries the brand is exactly the drift a hand-maintained list three directories away cannot detect. ⚠️ **The anchor is the DOCSTRING rather than the declaration below it, and that is deliberate.** This directory is one of the roots that suite scans, and it fails on any file merely NAMING one of the five guarded types — so anchoring on the `export interface` line would have made this spec trip the guard it exists to protect. Reworded, never exempted; do not \"fix\" the anchor by extending it downwards.",
    },
    {
      label: "a sixth brand-carrying export added with no `@sql-gate-guarded` tag",
      edits: [
        {
          file: PRODUCER,
          oldString: "declare const validatedSnapshotSql: unique symbol;",
          newString: `declare const validatedSnapshotSql: unique symbol;

export type WarehouseBrandProbe = { readonly [validatedSnapshotSql]: true };`,
        },
      ],
      note: "The other direction of the same set equality, and the failure #5255 was actually filed for: a tag is something a person has to remember, so the interesting case is not a tag deleted but a brand-carrying export added WITHOUT one. The suite derives the guarded set structurally — the transitive closure of *names the brand symbol, or names something already in the closure* — precisely so this cannot be forgotten, and a row that only ever deletes a tag would leave the half that does the enforcing unmeasured. ⚠️ The probe type is spelled to avoid the five guarded names for the reason the row above states; the brand SYMBOL is not one of them, which is what makes this expressible here at all.",
    },
    {
      label: "the entity-edge pass's failure log drops `err`",
      edits: [
        {
          file: PRODUCER,
          oldString: "        { ...runLog, err, reached },",
          newString: "        { ...runLog, reached },",
        },
      ],
      note: "A falsifier #5042 measured once, by hand, and left unprotected — which is this file's whole subject. The refusal body deliberately keeps the driver's text off the wire and PROMISES this line carries the reason, so the two are one claim: delete `err` and the report goes on pointing operators at a log line with nothing in it. The source comment records that this was green across every suite before the logging suite existed; the row is what stops that being a fact about one afternoon.",
    },
    {
      label: "the snapshot's connection falls back to the YAML hint alone, ignoring the group",
      edits: [
        {
          file: PRODUCER,
          oldString:
            "    const resolvedConnection =\n      entityPlan.entity.connection ?? connectionIds.get(entityPlan.entity.name);",
          newString: "    const resolvedConnection = entityPlan.entity.connection;",
        },
      ],
      note: "**The #5284 defect, restored verbatim at the submitted side.** It is the shipped line as it stood through #5042, #5230 and #5228, and it reached prod: on a DB-backed semantic layer the YAML `connection:` hint is null for EVERY entity — the scope lives in the row's `connection_group_id` — so every group-scoped workspace sent every snapshot to the deployment's `default` datasource, and each entity refused with `relation \"…\" does not exist` while its pairs sat in the enrollment list looking live. ⚠️ The row exists because this class is **structurally invisible to a unit suite**: `defaultValidateSnapshotSql`'s own header notes that a test workspace has no whitelist, so the gate rejects on the table whatever the statement says, and a producer that refuses every entity in production reads from in here exactly like one that works. The single kill is the seam assertion that the request carries the RESOLVED id rather than `undefined` — thin by design, and thin is the point: nothing else in five suites notices, which is why it took a prod run on #5197 to find.",
    },
    {
      label: "the mismatch arm recomputes the submitted connection from the YAML hint",
      edits: [
        {
          file: PRODUCER,
          oldString: "            returnedConnectionId === request.connectionId,",
          newString:
            "            returnedConnectionId === (entityPlan.entity.connection ?? undefined),",
        },
      ],
      note: "**The review finding that nothing caught: the alert predicate reading benign on the case it was added for.** The submitted connection is built once at the top of the loop and handed to `Object.freeze`; this arm used to REBUILD it from `entity.connection ?? undefined` and compare against that. The moment the real expression gained the connection-group arm the two stopped agreeing — and on a DB-backed semantic layer `entity.connection` is null for every entity, so the side being compared against was `undefined` on every iteration of an ordinary group-scoped workspace. Both directions break, and the dangerous one is silent: a verdict minted for a DEFAULT-connection request — matching workspace, entity and statement, carrying `connectionId: undefined` — satisfies `returnedConnectionId === submittedConnectionId` and reports `returnedRequestMatch: true` on a token that authorizes the wrong datasource. ⚠️ Measured GREEN across all four suites before its falsifier existed; `logging`'s *\"compares the RESOLVED connection group\"* is what kills it, and it needs an entity whose group came from the RESOLVER rather than a YAML hint — the sibling test one block up reaches a grouped entity through the hint, which is the one path the broken recomputation still covered.",
    },
    {
      label: "the placement rule answers an empty placement for every catalog",
      edits: [
        {
          file: PRODUCER,
          oldString:
            "  const placed = new Map<string, WarehouseConnectionId>();\n  const unplaceable: { entity: string; cause: WarehouseUnplaceableCause }[] = [];",
          newString:
            "  const placed = new Map<string, WarehouseConnectionId>();\n  const unplaceable: { entity: string; cause: WarehouseUnplaceableCause }[] = [];\n  if (true) return { placed, unplaceable };",
        },
      ],
      note: "The whole placement rule, neutralised. ⚠️ This row exists because the rule was **uncoverable where it used to live**: inside `defaultResolveConnectionIds`, below two I/O calls that cannot run under the unit suite at all — `test-setup.ts` strips `DATABASE_URL` and points `ATLAS_SEMANTIC_ROOT` at an empty directory, so `listAdminEntities` takes its disk branch over an empty root and answers `[]`. Every run test therefore exercised a resolver that returned nothing, and passed *because* it did. Splitting the rule out as `mapEntitiesToConnectionIds` is what makes this row killable; before the split the equivalent mutation was green across the tree.",
    },
    {
      label: "a name published under two connection groups resolves instead of refusing",
      edits: [
        { file: PRODUCER, oldString: "    if (groups.size > 1) {", newString: "    if (false) {" },
      ],
      note: "The `__global__` shadow case. The catalog read is `org_id = $1 OR org_id = '__global__'` while the run loop's `getEntity` is `org_id = $1` alone, so a workspace shadowing a built-in entity with its own of the same name looks ambiguous to the resolver and resolves cleanly to the loader — which is why the original code's justification for silently omitting it (*\"the loader is about to refuse it anyway\"*) was false for exactly that population, and the entity was snapshotted against the deployment default with nothing refused and nothing logged.",
    },
    {
      label: "an unplaceable entity is snapshotted anyway rather than refused",
      edits: [
        {
          file: PRODUCER,
          oldString: "    entityShapes.set(name, { kind: \"unplaceable\", cause });",
          newString: "    void cause;",
        },
      ],
      note: "The refusal arm removed, so an entity Atlas could not place is looked up like any other and reads the deployment's default datasource — #5284 restored through the door the fix left open. This is the arm that turns *\"we could not work out which database this is\"* from a silent default into a `connection-unresolved` refusal an admin can act on. ⚠️ The anchor MOVED in #5286: the check used to sit in the emit loop, which only an entity that was published, readable and single-primary-keyed ever reached — so an unplaceable entity failing any of those was refused for that other reason and its placement cause never reached the report. It is a `WarehouseEntityLookup` arm now, ahead of every structural check, which is why the mutation targets the seeding rather than the loop.",
    },
    {
      label: "the flat scope resolves to the literal \"default\" instead of staying absent",
      edits: [
        {
          file: PRODUCER,
          oldString: "    if (group === null || group === undefined) continue;",
          newString:
            "    if (group === null || group === undefined) { placed.set(name, \"default\" as WarehouseConnectionId); continue; }",
        },
      ],
      note: "⚠️ **The regression the fix for #5284 nearly shipped, in the opposite population.** `resolveGroupPrimaryConnectionId` answers `\"default\"` for a null group, and that string is NOT interchangeable with the `undefined` a flat workspace produced before this seam existed: `validateSQL` routes it to `getDBType(\"default\")`, which does a bare `entries.get` and throws `ConnectionNotRegisteredError` until something has touched the default pool, where `undefined` takes the `detectDBType()` branch. So placing it would refuse every flat, self-hosted workspace — under the PERMANENT `snapshot-rejected` wording, *\"re-running will not change this\"* — to fix grouped ones.",
    },
    {
      label: "a YAML `connection: default` hint reaches the gate as the literal \"default\"",
      edits: [
        {
          file: PRODUCER,
          oldString: "      resolvedConnection === \"default\" ? undefined : resolvedConnection;",
          newString: "      resolvedConnection;",
        },
      ],
      note: "⚠️ **The #5284 fix's OWN second defect, caught by a `fix-vs-finding` pass.** The fix kept the literal `\"default\"` out of the GROUP arm and left the YAML-hint arm — the first operand of the same `??` chain — free to place it. `connection: default` is not exotic: it is what the flat root's implied group is called in `whitelist.ts`, and `semantic.test.ts` has a case named for it. The two spellings diverge downstream, and the module contains both halves of the divergence: `defaultRunSnapshot` collapses them (`request.connectionId ?? \"default\"`) while `defaultValidateSnapshotSql` does not — `validateSQL` takes `getDBType(\"default\")`, which throws `ConnectionNotRegisteredError` until something has touched the default pool, where `undefined` takes `detectDBType()`. So the entity took a PERMANENT `snapshot-rejected` blaming the workspace whitelist, on precisely the flat self-hosted deployment the arm exists to protect. The lesson banked with it: singleness of a sentinel is a property of the FIELD, and guarding one arm does not establish it.",
    },
    {
      label: "the catalog's authority is INFERRED from its contents instead of passed in",
      edits: [
        {
          file: PRODUCER,
          oldString:
            "      if (catalogIsAuthoritative) unplaceable.push({ entity: name, cause: \"absent-from-catalog\" });",
          newString:
            "      if (summaries.some((x) => x.connectionId !== null)) unplaceable.push({ entity: name, cause: \"absent-from-catalog\" });",
        },
      ],
      note: "⚠️ **The first cut of the #5284 fix, which reproduced the defect it was written to end — caught by a `fix-vs-finding` pass, not by any reviewer.** It asked *\"does this catalog scope anything by group?\"* and treated `false` as *\"this workspace is flat, the default is correct\"*. But the visibility clause in `listEntityRows` is exactly what REMOVES a group-scoped row from the catalog when its datasource is unpublished, while `getEntity` has no such clause. So a workspace whose only group just went invisible keeps its ungrouped `__global__` demo rows, the inference reads FALSE, and the enrolled entity — still found by the loader, still planned — is snapshotted against the demo database with nothing refused and nothing logged. The asymmetry is the tell: the SAME condition refuses `group-not-visible` when the row survives the clause and defaulted when the clause deleted it. An empty `.some()` establishes what the carried rows are and nothing about a name the catalog does not carry, which is a measured-nothing cell blessed as a determined answer.",
    },
    {
      label: "the per-entity success record is never written",
      edits: [
        {
          file: PRODUCER,
          oldString:
            "        await recordEntityRunSuccess(tx, {\n" +
            "          workspaceId,\n" +
            "          entity: entityPlan.entity.name,\n" +
            "          snapshotAt,\n" +
            "        });",
          newString: "        void recordEntityRunSuccess;",
        },
      ],
      note: "The floor for #5317, and the row that keeps the two below honest: they both assert something about WHERE the record is written, and a producer that writes none at all satisfies every negative arm in the `-pg` suite (the refusal arm, the rollback arm) perfectly. Killed in `producer` by the exact-statement dispatch on `ENTITY_RUN_SUCCESS_INSERT_SQL` — the fake executor throws on an unrecognized statement, so the assertion is on bytes rather than on a paraphrase — and in `record` by the success arm. No reader exists in this slice, so nothing else in the tree can notice.",
    },
    {
      label: "the success record escapes the entity's transaction onto the pool",
      edits: [
        {
          file: RECORD,
          oldString: 'import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";',
          newString:
            'import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";\n' +
            'import { internalQuery } from "@atlas/api/lib/db/internal";',
        },
        {
          file: RECORD,
          oldString: "  await tx.query(ENTITY_RUN_SUCCESS_INSERT_SQL, [",
          newString: "  void tx;\n  await internalQuery(ENTITY_RUN_SUCCESS_INSERT_SQL, [",
        },
      ],
      note: "⚠️ **THE row this record exists for, and the one only a database can hold up.** The whole value of the marker is that it cannot outlive the work it claims: #5233's reaper DELETES `brain_entity` rows on the strength of one. Handed the module pool instead of the entity's `tx`, the INSERT commits on its own connection and survives the rollback — so a run that failed leaves a durable claim that it succeeded, in exactly the case where the consequence is a deletion. `record`'s rolled-back-transaction arm is the only thing in the tree that fails FOR THE RIGHT REASON — it observes a committed row after a rollback. Read any other non-zero column here as an accident rather than as coverage: the unit suites reach `internalQuery` with no pool configured, so they die on a thrown connection error, which is a kill that says nothing about whether the row outlived the transaction and would vanish the moment a suite happened to have a pool. Measured by hand before this row existed, which is precisely the prose-instead-of-a-gate shape this file was filed to retire.",
    },
    {
      label: "the success record is stamped with the wall clock instead of the snapshot instant",
      edits: [
        {
          file: PRODUCER,
          oldString:
            "        await recordEntityRunSuccess(tx, {\n" +
            "          workspaceId,\n" +
            "          entity: entityPlan.entity.name,\n" +
            "          snapshotAt,\n" +
            "        });",
          newString:
            "        await recordEntityRunSuccess(tx, {\n" +
            "          workspaceId,\n" +
            "          entity: entityPlan.entity.name,\n" +
            "          snapshotAt: new Date(),\n" +
            "        });",
        },
      ],
      note: "The reach rule compares this column to `brain_entity.snapshot_at`, which the `writeEntityEntries` call three lines up writes from the SAME value. A wall clock is later than the snapshot by however long the reconcile took, so every entry reads as older than its own run — and the reaper's comparison is a DELETE, so the drift falls in the direction that reaps live entries. A `now()` DEFAULT on the column would have the identical effect, which is why 0206 declares none. Survives every assertion that merely checks a row EXISTS, which is what both rows above check.",
    },
    {
      label: "the connection resolver is asked about no entities",
      edits: [
        {
          file: PRODUCER,
          oldString: "    placement = await resolveConnectionIds(workspaceId, placementTargets);",
          newString: "    placement = await resolveConnectionIds(workspaceId, []);",
        },
      ],
      note: "Nothing is placed, so every entity falls back to the deployment default — #5284 verbatim, past a green tree. Green before its falsifier existed, because every stub in the suite ignored its arguments (`async () => new Map([...])`). The kill is the stub that RECORDS what it was passed. Its sibling — passing `\"\"` as the workspace, which sends `listAdminEntities` to its disk-root branch and resolves a SaaS workspace's connection groups from whatever YAML is on the box — is caught by the same assertion.",
    },
  ],
};

export default spec;
