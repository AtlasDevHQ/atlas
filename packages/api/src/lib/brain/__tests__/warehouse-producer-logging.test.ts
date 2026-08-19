/**
 * The warehouse producer's OPERATOR-FACING lines (#5042, ADR-0037 §4).
 *
 * ## MUTATIONS THIS CATCHES
 *
 * **Generated — see `packages/api/scripts/mutations/warehouse-producer.md`**, where
 * this file is the `logging` column. Four rows are non-zero there and ZERO in the
 * unit suite — a level demotion, both row-drop warns, and a dropped `err` field —
 * because the per-level sinks below are the only instrument in the repo that can
 * see them. That is this file's whole justification, measured rather than asserted.
 *
 *     cd packages/api && bun run scripts/mutate.ts scripts/mutations/warehouse-producer.mutations.ts
 *
 * Every line below is the only record of something otherwise invisible to a caller,
 * and each was deletable — or demotable — green before this file existed:
 *
 *   - the **snapshot-failure `warn`**. The refusal deliberately keeps the driver's
 *     text off the wire, so this line is the ONLY place `42P01 undefined_table`
 *     survives — and `42P01` versus `ECONNREFUSED` is the difference between *fix
 *     your YAML* and *your warehouse is down*. It must carry the Error itself, not
 *     `.message`: `scrubErrSerializer` is what emits the stack and pg's `code` with
 *     credentials already stripped.
 *   - the **unsurfaceable-cell `warn`**. A `jsonb` column enrolled by an admin
 *     produces a run that reads nine hundred rows, emits nothing, refuses nothing
 *     and — without this line — logs nothing. It is indistinguishable from an
 *     empty column, and re-runnable forever.
 *   - the **two row-drop `warn`s**. `collidingSubjectRows` and
 *     `unsurfaceableKeyRows` both reached the report and no log at all, and the
 *     degraded response withholds counters — so an operator asking why account 4471
 *     is missing from the queue had nothing to grep.
 *   - the **cardinality-refusal split, three ways**. `already-decided` is routine
 *     (`debug`); `degenerate-key` is reachable from real data and means the
 *     predicate can never carry a `single` entry (`warn`, its own message); the
 *     remaining two mean the call site drifted (`warn`). One level for all of them
 *     is a producer whose proposals silently stopped landing.
 *   - the **transaction-failure `error`**. The entity is REFUSED rather than
 *     re-thrown, so the response is a 200 naming one refusal — and this line is the
 *     only record that entities 1..N-1 had already COMMITTED drafts.
 *
 * ## ⚠️ Why per-level sinks, and not one array
 *
 * The repo's recorded failure: a capture helper that pushes every level into one
 * array asserts the payload and the message and silently cannot see the LEVEL, so
 * demoting `log.error` to `log.warn` kills zero tests. Every assertion below names
 * its sink, and the demotion cases are asserted as *absent from the other sink*
 * rather than only present in the right one.
 *
 * ## Why a separate file
 *
 * `alias-proposal-logging.test.ts`'s pattern and its constraint: mocking the
 * logger means `mock.module`ing EVERY value export of `@atlas/api/lib/logger` and
 * importing the module under test DYNAMICALLY, so the mock is installed before the
 * import binds. That is process-wide, so it cannot share a file with suites that
 * want real logging.
 */

import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";

interface Captured {
  readonly payload: unknown;
  readonly message: string;
}

const errors: Captured[] = [];
const warns: Captured[] = [];
const infos: Captured[] = [];
const debugs: Captured[] = [];

/**
 * Every value export of `lib/logger`, replaced.
 *
 * ⚠️ A PARTIAL mock is the trap this repo has recorded: `mock.module` replaces the
 * whole module, so any export left out becomes `undefined` and the module under
 * test throws on first use — which reads as a broken test rather than a missing
 * mock. The factory is SYNCHRONOUS, because an async one deadlocks `bun:test`.
 */
void mock.module("@atlas/api/lib/logger", () => {
  const record = (sink: Captured[]) => (payload: unknown, message?: unknown) =>
    sink.push({ payload, message: typeof message === "string" ? message : String(payload) });
  const capture = {
    error: record(errors),
    warn: record(warns),
    info: record(infos),
    debug: record(debugs),
    level: "info",
  };
  return {
    createLogger: () => capture,
    getLogger: () => ({
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      level: "info",
    }),
    setLogLevel: () => true,
    getRequestContext: () => undefined,
    withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
    ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
    redactPaths: [] as string[],
    scrubErrSerializer: (value: unknown) => value,
    scrubLogFormatter: (obj: unknown) => obj,
    hashShareToken: (token: string) => token,
  };
});

type ProducerModule = typeof import("@atlas/api/lib/brain/warehouse-producer");
type WarehouseSnapshotRequest =
  import("@atlas/api/lib/brain/warehouse-producer").WarehouseSnapshotRequest;
type ValidatedSnapshotRequest =
  import("@atlas/api/lib/brain/warehouse-producer").ValidatedSnapshotRequest;
type WarehouseConnectionId =
  import("@atlas/api/lib/brain/warehouse-producer").WarehouseConnectionId;
type ReconcileModule = typeof import("@atlas/api/lib/brain/reconcile");
type EnrollmentModule = typeof import("@atlas/api/lib/brain/enrollment");

let producer: ProducerModule;
let reconcile: ReconcileModule;
/**
 * The REAL reach derivation, not a hand-built literal.
 *
 * Its own type states why: a hand-built `{ pairs, entities, has }` can disagree
 * with itself about which pairs are in reach, and since #5286 it can also omit
 * `groupsByEntity` — the map the producer reads to decide whether a name is
 * enrolled under two groups at once. A fixture missing it would exercise a shape
 * the loader can never produce.
 */
let makeProducerReach: EnrollmentModule["makeProducerReach"];

beforeAll(async () => {
  // DYNAMIC, after the mock above is installed — a static import binds the real
  // logger at module-evaluation time and every assertion here reads an empty sink
  // while the lines print to stdout.
  producer = await import("@atlas/api/lib/brain/warehouse-producer");
  reconcile = await import("@atlas/api/lib/brain/reconcile");
  // Dynamic for the same reason as the two above — this module logs too.
  ({ makeProducerReach } = await import("@atlas/api/lib/brain/enrollment"));
});

afterEach(() => {
  errors.length = 0;
  warns.length = 0;
  infos.length = 0;
  debugs.length = 0;
});

const WORKSPACE = "ws-5042-logging";
const SNAPSHOT_AT = new Date("2026-08-14T10:00:00.000Z");

const ACCOUNTS_YAML: Record<string, unknown> = {
  table: "accounts",
  dimensions: [
    { name: "id", sql: "account_id", primary_key: true },
    { name: "status", sql: "lifecycle_status" },
  ],
};

/** Answers every statement the run issues; `cardinalityConflict` suppresses the proposal. */
function store(options: { cardinalityConflict?: boolean } = {}) {
  let seq = 0;
  return {
    calls: [] as string[],
    runner: async <T,>(fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }> }) => Promise<T>): Promise<T> =>
      fn({
        query: async (sql) => {
          if (sql === producer.WAREHOUSE_EPISODE_INSERT_SQL) return { rows: [{ id: `ep-${++seq}` }] };
          if (sql === reconcile.INSERT_FACT_SQL) return { rows: [{ id: `fact-${++seq}` }] };
          if (sql.includes("brain_predicate_cardinality")) {
            // An empty RETURNING is the `ON CONFLICT DO NOTHING` — i.e. the
            // predicate is already adjudicated, the routine refusal.
            return { rows: options.cardinalityConflict ? [] : [{ inserted: 1 }] };
          }
          return { rows: [] };
        },
      }),
  };
}

function deps(over: Partial<Parameters<ProducerModule["runWarehouseProducer"]>[1]> = {}) {
  return {
    loadReach: async () => makeProducerReach([{ entity: "Accounts", group: null, dimension: "status", naming: false }]),
    loadEntity: async () => ACCOUNTS_YAML,
    // Cast because the passing verdict carries a branded request — see the unit
    // suite's note. It brands the request it was HANDED: a fresh object would trip
    // the run loop's anti-replay identity check (#5230).
    // `true as const`, because this literal is NOT contextually typed — `deps()`
    // has no return annotation, so a bare `true` widens to `boolean` and the whole
    // object stops satisfying the seam.
    validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
      valid: true as const,
      request: request as ValidatedSnapshotRequest,
    }),
    runSnapshot: async () => [
      { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
    ],
    loadVocabulary: async () => (await import("@atlas/api/lib/brain/identity")).identityVocabulary,
    // The edge pass runs on EVERY run since #5232 (it was gated on this run's
    // `entitiesStored`, which skipped it on exactly the re-run where its
    // `rejected` counter matters). Stubbed empty here: this suite is about the
    // producer's own log lines, and the real loader would reach a pool that
    // does not exist and add an unrelated error line to every assertion.
    loadEntityStore: async () => [],
    withTransaction: store().runner,
    now: () => SNAPSHOT_AT,
    ...over,
  };
}

const run = (over: Partial<Parameters<ProducerModule["runWarehouseProducer"]>[1]> = {}) =>
  producer.runWarehouseProducer(
    { workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" },
    deps(over),
  );

const messages = (sink: readonly Captured[]) => sink.map((c) => c.message);

/**
 * The digest the mismatch line should carry, computed INDEPENDENTLY of the module
 * under test.
 *
 * ⚠️ Deliberately not imported from the producer, and that is this repo's recorded
 * lesson rather than a style choice: a fixture that derives its expectation from the
 * implementation agrees with it by construction, so swapping the algorithm — or
 * hashing the wrong side of the comparison — stays green. Spelled out here, changing
 * either REDs.
 */
const digest = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 16);

/**
 * The one line in `sink` whose message contains `fragment`, or a failure.
 *
 * Returns the PAYLOAD non-optionally, which is what keeps every assertion below
 * out of `x?.payload as T` — an optional chain there makes a missing line read as
 * `undefined` and quietly weakens whatever is asserted about it.
 */
function payloadOf(sink: readonly Captured[], fragment: string): Record<string, unknown> {
  const hits = sink.filter((c) => c.message.includes(fragment));
  expect(hits, `expected exactly one log line containing "${fragment}"`).toHaveLength(1);
  const [line] = hits;
  if (line === undefined) throw new Error(`no log line contains "${fragment}"`);
  return line.payload as Record<string, unknown>;
}

describe("warehouse producer logging", () => {
  it("logs a snapshot failure at WARN, carrying the Error itself", async () => {
    await run({
      runSnapshot: async () => {
        const err = new Error("relation \"accounts\" does not exist");
        (err as Error & { code?: string }).code = "42P01";
        throw err;
      },
    });

    // ⚠️ The ERROR OBJECT, not `.message`. `scrubErrSerializer` emits the stack and
    // pg's `code` from an Error and nothing at all from a string, and `code` is what
    // separates "fix your YAML" from "your warehouse is down". This is the only
    // place either survives — the refusal keeps the driver's text off the wire.
    const payload = payloadOf(warns, "snapshot failed");
    expect(payload.err).toBeInstanceOf(Error);
    expect((payload.err as Error & { code?: string }).code).toBe("42P01");
    expect(payload.table).toBe("accounts");
    // And it is not an ERROR: a failed snapshot is a refused entity, not an incident.
    expect(messages(errors)).toEqual([]);
  });

  it("logs the entity-edge failure at ERROR carrying `err` AND how far it got (#5277)", async () => {
    // ⚠️ **THE REDACTION'S COUNTERPART, and nothing asserted it.** The report's
    // fixed sentence withholds the driver's text and promises *"the server log for
    // request X carries the reason"* — that promise is the entire justification for
    // the redaction. The unit suite asserts the handle is IN the sentence; only
    // this asserts the line it points at exists and carries a reason.
    //
    // Measured before this test existed: deleting `err` from the `log.error`
    // payload left the unit suite, the route suite and this suite all green, while
    // the report went on telling operators to read a line with no reason in it.
    // Both reviewers reached it independently in round 1.
    //
    // This suite stubs `loadEntityStore` empty precisely so the edge pass never
    // fails; this case overrides that stub, which is why it is the only place the
    // arm is reachable.
    await run({
      loadEntityStore: async () => {
        const err = new Error('FATAL: password authentication failed for user "atlas"');
        (err as Error & { code?: string }).code = "28P01";
        throw err;
      },
    });

    const payload = payloadOf(errors, "entity-edge pass failed part-way");
    // The Error OBJECT, so pino's serializer emits the stack and pg's `code` — for
    // a pool or lock failure the stack is the actionable half.
    expect(payload.err).toBeInstanceOf(Error);
    expect((payload.err as Error & { code?: string }).code).toBe("28P01");
    // ⚠️ And the STRUCTURED half travels too: the log says how far the pass got,
    // which is the same question the report's `reached` answers. The store read
    // threw, so the phase is `store-read` and NO count is present — a payload
    // carrying `entries: 0` here would be the confident-number failure one field
    // over.
    expect(payload.reached).toEqual({ phase: "store-read" });
    // The correlation handle both halves are joined by.
    expect(payload.requestId).toBe("req-1");
  });

  it("logs the entity-edge failure's LATER phase, with the census it established (#5277)", async () => {
    // ⚠️ The pair, and it is what stops `reached` being a constant. A payload
    // hard-coded to `{phase: "store-read"}` satisfies the test above; only a second
    // phase with a different shape can tell that apart from a real value.
    await run({
      loadEntityStore: async () => [
        {
          entityId: producer.warehouseRowId(WORKSPACE, "Accounts", "ACC-1"),
          entity: "Accounts",
          keySurface: "ACC-1",
          keyNorm: "acc 1",
          canonicalSurface: "Acme Corp",
          canonicalNorm: "acme corp",
        },
      ],
      proposeAliasEdges: async () => {
        throw new Error("deadlock detected on brain_vocabulary_edge");
      },
    });

    const payload = payloadOf(errors, "entity-edge pass failed part-way");
    expect(payload.err).toBeInstanceOf(Error);
    // One entry earning an edge → two positions submitted. Distinct from `entries`,
    // so the two cannot be swapped unnoticed.
    expect(payload.reached).toEqual({
      phase: "proposing",
      entries: 1,
      ambiguous: 0,
      selfEdges: 0,
      unmintedIds: 0,
      proposalsAttempted: 2,
    });
  });

  it("logs the entity-edge failure's MIDDLE phase — read, then planning threw (#5277)", async () => {
    // ⚠️ The third phase, and the one neither test above reaches. With only
    // `store-read` and `proposing` covered, a payload could still be right for the
    // two shapes that were checked and wrong for the one in between — and the
    // producer-side assignment for this phase had no falsifier at all until its
    // sibling unit test was added.
    await run({
      loadEntityStore: async () =>
        [
          {
            get entityId(): never {
              throw new Error("hostile getter");
            },
            entity: "Accounts",
            keySurface: "ACC-1",
            keyNorm: "acc 1",
            canonicalSurface: "Acme Corp",
            canonicalNorm: "acme corp",
          },
        ] as never,
    });

    const payload = payloadOf(errors, "entity-edge pass failed part-way");
    expect(payload.err).toBeInstanceOf(Error);
    // `entries` established, nothing handed over — a shape that is neither of the
    // other two phases.
    expect(payload.reached).toEqual({ phase: "planning", entries: 1 });
  });

  it("logs unsurfaceable cells at WARN — the enrollment mistake that is otherwise silent", async () => {
    await run({
      runSnapshot: async () => [
        { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: { nested: true } },
        { [producer.SUBJECT_ALIAS]: "Globex", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: [1, 2] },
      ],
    });

    const cellWarn = payloadOf(warns, "no claim surface can be made of");
    expect(cellWarn.unsurfaceableCells).toBe(2);
    // ⚠️ And it must name the GUILTY dimension. The first cut listed every enrolled
    // dimension, which stops one step short of the operator's actual action —
    // un-enrolling ONE pair.
    expect(cellWarn.unsurfaceableByDimension).toEqual({ status: 2 });
  });

  it("does NOT warn when the cells are merely NULL", async () => {
    // The counterpart of the case above, and the reason the two are split: an empty
    // column is the ordinary case and nobody should hear about it. Without this,
    // folding the two together passes the test above.
    await run({
      runSnapshot: async () => [
        { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: null },
      ],
    });
    expect(warns.filter((c) => c.message.includes("no claim surface can be made of"))).toEqual([]);
  });

  it("splits the cardinality refusal — `already-decided` at DEBUG, anything else at WARN", async () => {
    await run({ withTransaction: store({ cardinalityConflict: true }).runner });

    expect(payloadOf(debugs, "already adjudicated").refusal).toBe("already-decided");
    // ⚠️ Asserted as ABSENT from the warn sink, not merely present in debug. One
    // level for both refusal classes is a producer whose proposals silently stopped
    // landing, and a single-array capture cannot see the difference.
    expect(warns.filter((c) => c.message.includes("cardinality"))).toEqual([]);
  });

  it("logs the two row-drop counters at WARN — both were reported and never logged", async () => {
    // ⚠️ Dropping a row is a data-affecting decision. Both of these were counted
    // into the report and logged NOWHERE, while their sibling in the same object
    // literal got a warn — so an operator asking "why is account 4471 missing from
    // the queue" had nothing to grep, and under a degraded response the counters are
    // withheld too, which makes the drop fully silent.
    await run({
      runSnapshot: async () => [
        { [producer.SUBJECT_ALIAS]: "dup", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
        { [producer.SUBJECT_ALIAS]: " dup ", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "churned" },
        { [producer.SUBJECT_ALIAS]: { bad: "key" }, [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
      ],
    });

    expect(payloadOf(warns, "the declared key is not unique").collidingSubjectRows).toBe(1);
    expect(payloadOf(warns, "nothing about this entity can be emitted").unsurfaceableKeyRows).toBe(1);
  });

  it("logs a degenerate predicate at WARN, with its own message — not `refused unexpectedly`", async () => {
    // ⚠️ The warn side of the cardinality split had NO test: every fixture produced
    // `already-decided`, so demoting this arm to `debug` was green. `degenerate-key`
    // is reachable from real data — `lexicalNorm` collapses `_`/`-`/whitespace — and
    // it means this predicate can never carry a `single` entry, so supersession
    // stays dormant for it. That is not "unexpected", and it is not routine either.
    await run({
      loadReach: async () => makeProducerReach([{ entity: "Accounts", group: null, dimension: "__", naming: false }]),
      loadEntity: async () => ({
        table: "accounts",
        dimensions: [
          { name: "id", sql: "account_id", primary_key: true },
          { name: "__", sql: "weird_column" },
        ],
      }),
      runSnapshot: async () => [
        { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
      ],
    });

    const payload = payloadOf(warns, "can never carry a `single` cardinality entry");
    expect(payload.refusal).toBe("degenerate-key");
    expect(payload.dimension).toBe("__");
    // `cardinality.ts` puts the operator-facing text on `message`; the first cut
    // discarded it.
    expect(String(payload.detail ?? "")).not.toBe("");
    // And it must NOT be filed as drift — that arm's remedy is "this call site
    // changed", which is wrong advice for a workspace's own column name.
    expect(warns.filter((c) => c.message.includes("call site drifted"))).toEqual([]);
  });

  it("logs the committed entities at ERROR when a transaction fails, and refuses rather than re-throwing", async () => {
    // The run no longer PROPAGATES — it refuses that entity, because a 500 while
    // earlier entities have committed invites the retry that doubles the queue. The
    // error line is what survives, and it is the only record that anything committed.
    const report = await run({
      withTransaction: async () => {
        throw new Error("40001 serialization failure");
      },
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);

    const payload = payloadOf(errors, "transaction failed");
    expect(payload.committedEntities).toEqual([]);
    expect(payload.err).toBeInstanceOf(Error);
  });

  it("logs a gate/request mismatch at ERROR, naming what came BACK (#5230)", async () => {
    // ⚠️ One of TWO ERROR-level per-entity refusals — the transaction-rollback case
    // directly above is the other, and it also files `snapshot-failed`. Every
    // remaining sibling is a WARN, and the first case in this file asserts the error
    // sink is empty for one of them. Without this case, demoting this line to `warn`
    // (or deleting it) is green, which is the demotion this file's header names as
    // the failure it exists to refuse.
    //
    // ⚠️ The token names ANOTHER TENANT and ANOTHER ENTITY, and both differences are
    // load-bearing. With a plain `{ ...request }` the returned values equal the
    // submitted ones, so a payload that logged the SUBMITTED entity under both keys
    // passed — measured: replacing `validated.entity` with `entityPlan.entity.name`
    // and `validated.workspaceId` with `workspaceId` left this suite green, which is
    // precisely the defect these two keys were added to close.
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: {
          ...request,
          entity: "Impostor",
          workspaceId: "ws-other-tenant",
        } as ValidatedSnapshotRequest,
      }),
    });

    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.entity).toBe("Accounts");
    // NOT shadowed by the returned one — the keys are separate for this reason.
    expect(payload.workspaceId).toBe(WORKSPACE);
    expect(payload.table).toBe("accounts");
    // ⚠️ What CAME BACK, under its own keys. A payload carrying only the submitted
    // entity cannot tell a same-workspace replay from a token minted against another
    // tenant's statement, and the second is the one that has to be greppable.
    expect(payload.returnedEntity).toBe("Impostor");
    expect(payload.returnedWorkspaceId).toBe("ws-other-tenant");
    // ⚠️ The only case that ASSERTS `returnedEntityMatch` against a real,
    // non-throwing, DIFFERENT string. Without this, `returnedEntityMatch` was satisfiable by
    // `returnedEntity !== SEAM_THREW` — measured green — because every other case
    // either matches by construction or threw, so the comparison was never tested
    // against a genuine difference.
    expect(payload.returnedEntityMatch).toBe(false);
    expect(payload.returnedRequestMatch).toBe(false);
    expect(payload.requestId).toBe("req-1");
    // ABSENT from warn, not merely present in error — a demotion is how this line
    // stops being an incident while still being "logged".
    expect(messages(warns).filter((m) => m.includes("different request"))).toEqual([]);
  });

  it("separates a forged statement from a benign replay on the mismatch line (#5248)", async () => {
    // ⚠️ **THE COLLAPSE FALSIFIER.** Identity is the acceptance test, so BOTH of these
    // land on the same arm and were logged identically before #5248: a token minted
    // for a different statement (the aliased case, worth paging on) and the same
    // statement arriving under a fresh object (a retry, routine). Refused either way,
    // so nothing here is a correctness hole — but an alert that cannot tell them apart
    // fires on the routine one and stays quiet for the other. Deleting either digest
    // field, or hardcoding `sqlDigestMatch`, collapses the two shapes back onto one
    // and REDs below.
    const FORGED_SQL = "SELECT 1 AS forged";
    let submitted = "";

    // (1) a genuine-looking verdict minted for a DIFFERENT statement.
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => {
        submitted = request.sql;
        return {
          valid: true as const,
          request: { ...request, sql: FORGED_SQL } as ValidatedSnapshotRequest,
        };
      },
    });
    const forged = payloadOf(errors, "verdict for a different request");
    expect(forged.sqlDigestMatch).toBe(false);
    expect(forged.sqlDigest).toBe(digest(submitted));
    // ⚠️ Derived from what came BACK. The measured sibling of this file's
    // `returnedEntity` note: a field that digests the SUBMITTED statement under a
    // `returned*` name passes every other assertion here and reports every forgery as
    // a replay, which is the exact inversion of the signal.
    expect(forged.returnedSqlDigest).toBe(digest(FORGED_SQL));
    expect(forged.returnedSqlDigest).not.toBe(forged.sqlDigest);

    errors.length = 0;

    // (2) THE SAME statement, under a different object — the benign replay.
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request } as ValidatedSnapshotRequest,
      }),
    });
    const replay = payloadOf(errors, "verdict for a different request");
    expect(replay.sqlDigestMatch).toBe(true);
    expect(replay.returnedSqlDigest).toBe(replay.sqlDigest);
    // The same fixture builds the same statement, so the replay's digest is the
    // forged run's SUBMITTED one — which is what "the same statement" means here.
    expect(replay.sqlDigest).toBe(digest(submitted));

    // ⚠️ **THE PREMISE, ASSERTED RATHER THAN NARRATED.** The comment at the top of
    // this case claims the two shapes were logged identically before #5248; nothing
    // proved it. The forged fixture keeps `entity` and `workspaceId` IDENTICAL and
    // varies only the statement — so the pre-existing `returned*` fields are blind to
    // it, which is exactly what makes the digest load-bearing. Measured: the two
    // payloads are byte-identical apart from these two keys. A reader arriving from
    // the #5230 case above (whose fixture DOES forge entity and workspace) would
    // otherwise reasonably assume the older fields already separate them.
    const differing = [...new Set([...Object.keys(forged), ...Object.keys(replay)])]
      .filter((k) => JSON.stringify(forged[k]) !== JSON.stringify(replay[k]))
      .sort();
    expect(differing).toEqual(["returnedSqlDigest", "sqlDigestMatch"]);

    // ⚠️ The claim the two runs exist to make, asserted directly rather than left as
    // an inference from the two blocks above. A single hardcoded value satisfies
    // roughly half the assertions in each block; nothing satisfies this one.
    expect(forged.sqlDigestMatch).not.toBe(replay.sqlDigestMatch);
  });

  it("catches a cross-tenant forgery whose statement text MATCHES (#5248)", async () => {
    // ⚠️ **THE CASE THAT NEARLY SHIPPED MISCLASSIFIED, and it is the worst forgery
    // this arm can see.** `buildSnapshotSql` emits no workspace and no connection, so
    // two workspaces enrolled on the same table with the same dimension names build
    // BYTE-IDENTICAL statements — the ordinary outcome for tenants onboarded from one
    // connector template. A token minted against ANOTHER workspace's request therefore
    // arrives with `sqlDigestMatch: TRUE`. An operator alerting only on
    // `sqlDigestMatch: false` would never see it, while `defaultRunSnapshot` selects the pool
    // from the returned workspace and connection, i.e. the cross-tenant read the
    // capture note names as the residual.
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: {
          ...request,
          workspaceId: "ws-other-tenant",
          connectionId: "other-group",
        } as ValidatedSnapshotRequest,
      }),
    });

    const payload = payloadOf(errors, "verdict for a different request");
    // The statement text genuinely matches — this is the whole trap.
    expect(payload.sqlDigestMatch).toBe(true);
    // ...and these are what an alert must actually key on. Delete either and a
    // cross-tenant mint is indistinguishable from a re-wrap.
    expect(payload.returnedWorkspaceIdMatch).toBe(false);
    expect(payload.returnedConnectionIdMatch).toBe(false);
    // The entity is untouched, so its own match field must NOT fire — otherwise a
    // single always-false constant would satisfy the two assertions above.
    expect(payload.returnedEntityMatch).toBe(true);
    expect(payload.returnedWorkspaceId).toBe("ws-other-tenant");
    expect(payload.returnedConnectionId).toBe("other-group");
  });

  it("reads a legitimately absent connection as a MATCH on both sides (#5248)", async () => {
    // ⚠️ The other half of the field above, and the reason both sides normalise
    // through one expression. `ACCOUNTS_YAML` names no `connection:`, so the submitted
    // id is `undefined` — and a submitted `"(default)"` compared against a returned
    // `undefined` would report every benign replay as a connection mismatch, turning
    // the new alert into noise on its first day.
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request } as ValidatedSnapshotRequest,
      }),
    });

    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.returnedConnectionIdMatch).toBe(true);
    // Both sides render through the same helper, so both read `<undefined>` rather
    // than one of them inventing a placeholder.
    expect(payload.connectionId).toBe("<undefined>");
    expect(payload.returnedConnectionId).toBe("<undefined>");
    // ⚠️ **THE `true` DIRECTIONS, and nothing pinned them.** Hardcoding
    // `returnedWorkspaceIdMatch: false` was measured green across all four warehouse
    // suites — only the cross-tenant case asserted it, and only in the `false`
    // direction. Stuck false, the alert those fields exist for fires on every benign
    // replay too, which is the same "noise on its first day" outcome this case was
    // written to prevent one field over.
    expect(payload.returnedWorkspaceIdMatch).toBe(true);
    expect(payload.returnedEntityMatch).toBe(true);
    expect(payload.returnedRequestMatch).toBe(true);
  });

  it("compares the connection group itself, not just its absence (#5248)", async () => {
    // ⚠️ `ACCOUNTS_YAML` names no `connection:`, so every other case in this file
    // leaves the SUBMITTED side `undefined` and the comparison degenerates to "is the
    // returned connection absent". Measured: replacing `submittedConnectionId` with a
    // literal `undefined` stayed green across all four suites. A workspace whose
    // entity DOES name a group is the population that breaks under that, and it is an
    // ordinary workspace.
    const GROUPED_YAML: Record<string, unknown> = { ...ACCOUNTS_YAML, connection: "grp-a" };

    // (1) a benign replay from a grouped entity — the connection MATCHES.
    await run({
      loadEntity: async () => GROUPED_YAML,
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request } as ValidatedSnapshotRequest,
      }),
    });
    const replay = payloadOf(errors, "verdict for a different request");
    expect(replay.connectionId).toBe("grp-a");
    expect(replay.returnedConnectionId).toBe("grp-a");
    expect(replay.returnedConnectionIdMatch).toBe(true);
    expect(replay.returnedRequestMatch).toBe(true);

    errors.length = 0;

    // (2) same workspace, same entity, same statement — a DIFFERENT connection group.
    // This is the same-workspace wrong-datasource read: `defaultRunSnapshot` selects
    // the pool from the returned connection, and nothing else on the line differs.
    await run({
      loadEntity: async () => GROUPED_YAML,
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request, connectionId: "grp-b" } as ValidatedSnapshotRequest,
      }),
    });
    const crossGroup = payloadOf(errors, "verdict for a different request");
    expect(crossGroup.returnedConnectionId).toBe("grp-b");
    expect(crossGroup.returnedConnectionIdMatch).toBe(false);
    // Everything else about the request matches — which is exactly what makes this
    // the case the field was added for.
    expect(crossGroup.sqlDigestMatch).toBe(true);
    expect(crossGroup.returnedWorkspaceIdMatch).toBe(true);
    expect(crossGroup.returnedEntityMatch).toBe(true);
    expect(crossGroup.returnedRequestMatch).toBe(false);
  });

  it("compares the RESOLVED connection group, not just the YAML hint (#5284)", async () => {
    // ⚠️ **The test above is not enough, and the gap is measured.** It reaches a
    // grouped entity through a YAML `connection:` hint — the one path the mismatch
    // arm's own recomputation still covered. On a DB-backed semantic layer NO entity
    // carries that hint (that is the whole of #5284): the group arrives from the
    // connection resolver instead. The submitted side is built once at the top of the
    // loop and gained that arm; the mismatch arm went on recomputing
    // `entity.connection ?? undefined` and so compared against `undefined` on every
    // iteration of an ordinary group-scoped workspace.
    //
    // Measured before this test existed: reverting the hoist and letting the arm
    // recompute from the hint alone was GREEN across all four producer suites.
    const RESOLVED = {
      // A ONE-member group (#5326): this case is about the connection the mismatch
      // arm compares, and a second member would add a second read whose verdict is
      // a second payload — a different case, covered in `warehouse-producer.test.ts`.
      placed: new Map([["Accounts", ["eu-prod" as WarehouseConnectionId]]]),
      unplaceable: [],
    };

    // (1) THE MISSED ALARM, and it is the one that matters. A verdict minted for a
    // DEFAULT-connection request — matching workspace, entity and statement, carrying
    // `connectionId: undefined` — against an entity that actually reads `eu-prod`.
    // With the submitted side recomputed from the (absent) hint, both sides read
    // `undefined`, `returnedRequestMatch` reports TRUE, and the predicate an alert
    // keys on calls a token authorizing the wrong datasource benign.
    await run({
      resolveConnectionIds: async () => RESOLVED,
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request, connectionId: undefined } as ValidatedSnapshotRequest,
      }),
    });
    const missed = payloadOf(errors, "verdict for a different request");
    expect(missed.connectionId).toBe("eu-prod");
    // `"<undefined>"` is how this line renders an absent field — the file's existing
    // convention, and the reason the assertion is not `toBeUndefined()`.
    expect(missed.returnedConnectionId).toBe("<undefined>");
    expect(missed.returnedConnectionIdMatch).toBe(false);
    expect(missed.returnedRequestMatch).toBe(false);
    // Everything else agrees — which is what makes the connection the only signal.
    expect(missed.returnedWorkspaceIdMatch).toBe(true);
    expect(missed.returnedEntityMatch).toBe(true);
    expect(missed.sqlDigestMatch).toBe(true);

    errors.length = 0;

    // (2) THE FALSE ALARM, the same defect in the other direction: an honest re-wrap
    // that returns the real resolved connection. Recomputing from the hint reports
    // this benign replay with the signature of a cross-datasource forgery.
    await run({
      resolveConnectionIds: async () => RESOLVED,
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request } as ValidatedSnapshotRequest,
      }),
    });
    const benign = payloadOf(errors, "verdict for a different request");
    expect(benign.connectionId).toBe("eu-prod");
    expect(benign.returnedConnectionId).toBe("eu-prod");
    expect(benign.returnedConnectionIdMatch).toBe(true);
    expect(benign.returnedRequestMatch).toBe(true);
  });

  it("fingerprints the statements and never carries one (#5248)", async () => {
    let submitted = "";
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => {
        submitted = request.sql;
        return { valid: true as const, request: { ...request } as ValidatedSnapshotRequest };
      },
    });

    const payload = payloadOf(errors, "verdict for a different request");
    // ⚠️ POSITIVE ANCHOR first. Without it every `not.toContain` below is satisfied by
    // a fixture that built no statement at all, and the whole case goes vacuous.
    expect(submitted).toContain("SELECT");
    expect(submitted).toContain("lifecycle_status");

    // ⚠️ EVERY sink, not just the mismatch payload. Scoped to one line, the case's own
    // title ("never carries one") overclaimed — a future line elsewhere in the run
    // logging the raw statement would pass. The positive anchors above keep the
    // widening non-vacuous.
    const serialized = JSON.stringify([...errors, ...warns, ...infos, ...debugs]);
    expect(serialized).not.toContain(submitted);
    // ⚠️ And not a FRAGMENT of it. The statement is assembled from admin-authored
    // `table:` and `sql:` expressions, so the identifying part is the column names
    // rather than the whole string — a line that truncated the SELECT to 200
    // characters would pass the assertion above and still put a customer's schema in
    // the log, which is what CLAUDE.md forbids.
    expect(serialized).not.toContain("lifecycle_status");
    expect(payload.sqlDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.returnedSqlDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reads the returned statement ONCE, so a getter cannot answer the digest and the comparison differently (#5248, #5230)", async () => {
    // ⚠️ #5230's aliasing finding, one level down and inside the line written to
    // report it. `validation.request` is captured once — but its PROPERTIES are still
    // expressions the seam controls, so a getter that answers honestly for the digest
    // and dishonestly for the comparison puts a forged statement's mismatch on the log
    // as a benign replay. A per-site read proves nothing about the next site; only the
    // count does.
    const SECOND_READ = "SELECT 1 AS second_read";
    let sqlReads = 0;
    let honest = "";

    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => {
        honest = request.sql;
        const copy = { ...request } as Record<string, unknown>;
        Object.defineProperty(copy, "sql", {
          enumerable: true,
          get() {
            sqlReads += 1;
            return sqlReads === 1 ? honest : SECOND_READ;
          },
        });
        return { valid: true as const, request: copy as unknown as ValidatedSnapshotRequest };
      },
    });

    const payload = payloadOf(errors, "verdict for a different request");
    // ⚠️ The whole case. Two reads — one for the digest field, one for the comparison
    // — makes this 2 and is the defect; the assertions below cannot see it on their
    // own, because a second read that happens to agree looks identical.
    expect(sqlReads).toBe(1);
    expect(payload.returnedSqlDigest).toBe(digest(honest));
    expect(payload.returnedSqlDigest).not.toBe(digest(SECOND_READ));
    // The first read IS the submitted statement, so this mismatch is a replay.
    expect(payload.sqlDigestMatch).toBe(true);
  });

  // ⚠️ The mismatch arm has NO enclosing `try` — the per-entity catches wrap the
  // validator call, the snapshot and the transaction, and this branch sits BETWEEN
  // them — so anything raised while building the log payload escapes
  // `runWarehouseProducer` entirely, reaches the route's `Effect.tryPromise`, and
  // turns ONE refused entity into a 500 for the whole run with no log line at all.
  // Every cast below compiles; `warehouse-producer-bypass.test.ts` pins the sites
  // that may write one.
  //
  // ⚠️ `{}` alone does NOT exercise the container guard, and that was measured: `{}`
  // IS a record, so `isRecord`'s false arm is never taken and deleting the guard
  // leaves the suite green while a `null` verdict throws. `null` and `undefined` are
  // the load-bearing classes — a bare string survives without the guard too.
  // `expectedType` is spelled out per fixture rather than derived, so the assertion
  // cannot agree with the implementation by construction.
  const MALFORMED_VERDICTS: readonly {
    readonly label: string;
    readonly request: unknown;
    readonly expectedType: string;
    /**
     * ⚠️ `true` ONLY for the empty record, and that is the honest answer rather than
     * a hole. Both sides are absent — the submitted connection is `undefined` for
     * this default-connection fixture — so the comparison is literally satisfied.
     * Demanding presence instead would report every benign default-connection replay
     * as a connection mismatch. `returnedRequestMatch` is the field that separates
     * them, and it is asserted `false` for every fixture here.
     */
    readonly expectedConnectionMatch: boolean;
  }[] = [
    { label: "an object with no fields", request: {}, expectedType: "<record>", expectedConnectionMatch: true },
    { label: "null", request: null, expectedType: "<null>", expectedConnectionMatch: false },
    { label: "undefined", request: undefined, expectedType: "<undefined>", expectedConnectionMatch: false },
    // ⚠️ The TYPE, never the content — see the privacy case below. An array is
    // `<object>` rather than `<record>`, which is the one distinction `isRecord`'s
    // `Array.isArray` clause carries and nothing else pinned.
    { label: "a string", request: "SELECT 1", expectedType: "<string>", expectedConnectionMatch: false },
    { label: "an array", request: [], expectedType: "<object>", expectedConnectionMatch: false },
    { label: "a number", request: 42, expectedType: "<number>", expectedConnectionMatch: false },
  ];

  for (const { label, request, expectedType, expectedConnectionMatch } of MALFORMED_VERDICTS) {
    it(`logs a mismatch rather than throwing when the verdict's request is ${label} (#5248)`, async () => {
      const report = await run({
        validateSnapshotSql: async () => ({
          valid: true as const,
          request: request as ValidatedSnapshotRequest,
        }),
      });
      // The BEHAVIOURAL outcome, not only the log line: a throw fails here first.
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);

      const payload = payloadOf(errors, "verdict for a different request");
      // Sentinels, not silence: an operator needs to know the field was absent rather
      // than empty, and the digest must still say the statements differ.
      expect(payload.returnedEntity).toBe("<undefined>");
      expect(payload.returnedWorkspaceId).toBe("<undefined>");
      // ⚠️ `<undefined>`, NOT a `<non-string>` catch-all. `sql` is the field that
      // identifies the forgery class, so it is the last one that should collapse
      // absent / null / numeric into one sentinel — the collapse this arm exists to
      // undo, one level down.
      expect(payload.returnedSqlDigest).toBe("<undefined>");
      expect(payload.sqlDigestMatch).toBe(false);
      expect(payload.returnedReadThrew).toBe(false);
      // ⚠️ Which malformation it was. Without this field the non-record verdicts —
      // null, undefined, a string, an array, a number — produce one identical payload
      // of sentinels, so several different wiring faults become one line.
      expect(payload.returnedRequestType).toBe(expectedType);
      // ⚠️ **THE MATCH BOOLEANS, on the fixtures where they used to LIE.** A match
      // claim needs a readable container: `seamRead` answers `undefined` for an
      // absent field and for a non-record alike, and the submitted connection is
      // `undefined` for this default-connection fixture — so `returnedConnectionIdMatch`
      // read TRUE for a verdict that carried no request at all. Measured on all four
      // of these before the guard, and asserted on none of them, which is why it
      // shipped green.
      expect(payload.returnedConnectionIdMatch).toBe(expectedConnectionMatch);
      expect(payload.returnedWorkspaceIdMatch).toBe(false);
      expect(payload.returnedEntityMatch).toBe(false);
      // ⚠️ The alert key, `false` on EVERY malformation including the empty record
      // whose connection comparison is satisfied. This is the assertion that makes
      // the per-field booleans safe to be diagnostic rather than authoritative.
      expect(payload.returnedRequestMatch).toBe(false);
      // ...and the SUBMITTED side is unaffected, so the line still identifies the run.
      expect(payload.entity).toBe("Accounts");
      expect(payload.sqlDigest).toMatch(/^[0-9a-f]{16}$/);
    });
  }

  it("logs <threw> rather than dying when a verdict's accessor THROWS (#5248)", async () => {
    // ⚠️ Narrowing the container closes a verdict that is the wrong SHAPE; it does
    // nothing about one whose getter runs hostile code. `isRecord` answers true for
    // `{ get entity() { throw } }` — the container IS the right shape and the read
    // still escaped, measured before `seamRead` existed as the TypeError propagating
    // out of `runWarehouseProducer`. A getter is not exotic here: the read-once case
    // above builds one. (A revoked Proxy is a different failure — `isRecord` itself
    // throws on one; see the revoked-Proxy case below.)
    let entityReads = 0;
    const report = await run({
      validateSnapshotSql: async (req: WarehouseSnapshotRequest) => {
        const copy = { ...req } as Record<string, unknown>;
        Object.defineProperty(copy, "entity", {
          enumerable: true,
          get() {
            entityReads += 1;
            throw new TypeError("hostile getter");
          },
        });
        return { valid: true as const, request: copy as unknown as ValidatedSnapshotRequest };
      },
    });
    // A throw would have taken the whole run, so this line is the case.
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
    expect(entityReads).toBe(1);

    const payload = payloadOf(errors, "verdict for a different request");
    // ⚠️ `<threw>`, distinct from `<undefined>`. "The getter blew up" and "the field
    // was absent" are different faults, and a helper that folded them together would
    // pass a laxer assertion here.
    expect(payload.returnedEntity).toBe("<threw>");
    expect(payload.returnedReadThrew).toBe(true);
    expect(payload.returnedEntityMatch).toBe(false);
    // ⚠️ The OTHER fields survive, which is why each read is guarded individually
    // rather than the whole payload wrapped in one `try`. A single outer catch would
    // lose the statement comparison — the forensic payload this line exists for — to
    // an unrelated field's getter.
    expect(payload.returnedWorkspaceId).toBe(WORKSPACE);
    expect(payload.sqlDigestMatch).toBe(true);
  });

  it("never lets an Error's message pose as a digest (#5248)", async () => {
    // ⚠️ **A hole the closing round's own fix opened.** `seamString` renders an Error
    // by its message, and `seamSqlDigest` used to route every non-string through it —
    // so a verdict carrying `sql: new Error("<16 hex chars>")` put an ATTACKER-CHOSEN
    // string in `returnedSqlDigest`, indistinguishable from a real digest, and equal
    // to the submitted one if they copy it. `seamKind` brackets every non-string,
    // which is what makes "nothing in this field can be mistaken for a digest" true
    // rather than merely claimed.
    let submitted = "";
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => {
        submitted = request.sql;
        return {
          valid: true as const,
          request: {
            ...request,
            sql: new Error(digest(request.sql)),
          } as unknown as ValidatedSnapshotRequest,
        };
      },
    });

    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.sqlDigest).toBe(digest(submitted));
    // The forgery's whole point: it chose a value equal to the submitted digest.
    expect(payload.returnedSqlDigest).not.toBe(digest(submitted));
    expect(payload.returnedSqlDigest).toBe("<record>");
    expect(String(payload.returnedSqlDigest)).not.toMatch(/^[0-9a-f]{16}$/);
    expect(payload.sqlDigestMatch).toBe(false);
  });

  it("never echoes a STRING verdict's content, only its type (#5248)", async () => {
    // ⚠️ **A MEASURED PRIVACY HOLE, not a hypothetical.** `returnedRequestType` used
    // to fall through to `seamString` for non-records, which echoes a string verbatim
    // up to 200 characters. A validator that crosses a wire — or a serialising proxy
    // — answers `JSON.stringify(request)`, and that is the whole SELECT with its
    // table and column names, landing in the log two hundred lines below the
    // docstring that says the statement is never an option. The privacy sweep below
    // could not see it: its fixture returns an OBJECT, so the echo was in the wrong
    // fixture rather than the wrong sink.
    let submitted = "";
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => {
        submitted = request.sql;
        return {
          valid: true as const,
          // The realistic hostile shape: the request, serialised.
          request: JSON.stringify(request) as unknown as ValidatedSnapshotRequest,
        };
      },
    });

    const payload = payloadOf(errors, "verdict for a different request");
    expect(submitted).toContain("lifecycle_status");
    expect(payload.returnedRequestType).toBe("<string>");
    const serialized = JSON.stringify([...errors, ...warns, ...infos, ...debugs]);
    expect(serialized).not.toContain("lifecycle_status");
    expect(serialized).not.toContain(submitted);
  });

  it("reports WHICH seam read threw, one key at a time (#5248)", async () => {
    // ⚠️ Only two fixtures existed — `entity` throws, or everything throws — so three
    // of `returnedReadThrew`'s five disjuncts were individually unfalsifiable (the
    // fifth, a throwing `.request`, has its own case below):
    // dropping the `sql` one, or the `workspaceId` + `connectionId` pair, was
    // measured green. The contradiction that produces is a payload reading
    // `returnedSqlDigest: "<threw>"` beside `returnedReadThrew: false`, on the field
    // that identifies the forgery class.
    const KEYS = ["entity", "workspaceId", "connectionId", "sql"] as const;
    const FIELD: Record<(typeof KEYS)[number], string> = {
      entity: "returnedEntity",
      workspaceId: "returnedWorkspaceId",
      connectionId: "returnedConnectionId",
      sql: "returnedSqlDigest",
    };

    for (const key of KEYS) {
      errors.length = 0;
      const report = await run({
        validateSnapshotSql: async (req: WarehouseSnapshotRequest) => {
          const copy = { ...req } as Record<string, unknown>;
          Object.defineProperty(copy, key, {
            enumerable: true,
            get() {
              throw new TypeError(`hostile ${key}`);
            },
          });
          return { valid: true as const, request: copy as unknown as ValidatedSnapshotRequest };
        },
      });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      const payload = payloadOf(errors, "verdict for a different request");
      expect(payload.returnedReadThrew, `${key} should set returnedReadThrew`).toBe(true);
      expect(payload[FIELD[key]], `${key} should render <threw>`).toBe("<threw>");
    }
  });

  it("keeps the forensic line when the verdict's REQUEST getter throws (#5248)", async () => {
    // ⚠️ **A hostile validator must not be able to choose the quiet arm.** Reading
    // `verdict.request` unguarded inside the gate-call `try` sent this to the
    // gate-threw arm: a `warn` reading "the SQL gate threw rather than answering",
    // with no digests and no match booleans — so throwing from `.request` demoted a
    // forgery to something that looks like a transient module-init blip. Detectability
    // is this change's whole deliverable, so the read is guarded separately and an
    // unreadable request falls through to the arm that reports it.
    const report = await run({
      validateSnapshotSql: async (req: WarehouseSnapshotRequest) => {
        const verdict = { valid: true as const };
        Object.defineProperty(verdict, "request", {
          enumerable: true,
          get() {
            throw new TypeError("hostile request getter");
          },
        });
        void req;
        return verdict as unknown as { valid: true; request: ValidatedSnapshotRequest };
      },
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
    // The ERROR line, not the gate-threw warn — that is the case.
    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.returnedReadThrew).toBe(true);
    expect(payload.returnedRequestMatch).toBe(false);
    expect(payload.sqlDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(messages(warns).filter((m) => m.includes("threw rather than answering"))).toEqual([]);
  });

  it("renders a throwing `error` getter as <threw>, keeping the verdict's permanence (#5248)", async () => {
    // An unguarded read landed this on the gate-threw arm, demoting the entity from
    // permanent to transient. The gate DID answer invalid; only its reason was
    // unreadable, so it keeps that verdict's permanence.
    const report = await run({
      validateSnapshotSql: async () => {
        const verdict = { valid: false as const };
        Object.defineProperty(verdict, "error", {
          enumerable: true,
          get() {
            throw new TypeError("hostile error getter");
          },
        });
        return verdict as { valid: false; error: string };
      },
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-rejected"]);
    expect(report.refusals[0]?.message).toContain("<threw>");
    expect(payloadOf(warns, "did not pass SQL validation").reason).toBe("<threw>");
  });

  it("renders an Error `error` by its message, not as <object> (#5248)", async () => {
    // `<object>` is `undefined` with extra steps, on a PERMANENT refusal whose own
    // text says re-running will not help — the generic message CLAUDE.md forbids,
    // arriving through the renderer added to remove it. An Error is the likeliest
    // non-string a plugin-supplied validator puts here.
    const report = await run({
      validateSnapshotSql: async () =>
        ({ valid: false, error: new Error('relation "accounts" does not exist') }) as unknown as {
          valid: false;
          error: string;
        },
    });
    expect(report.refusals[0]?.message).toContain('relation "accounts" does not exist');
    expect(report.refusals[0]?.message).not.toContain("<object>");
  });

  it("bounds the REJECTED arm's reason too, not only the mismatch arm's (#5248)", async () => {
    // The bound was pinned on the mismatch arm only; the rejected arm's `reason`
    // reaches a 200-response message, which is the one that leaves the process.
    const report = await run({
      validateSnapshotSql: async () => ({ valid: false as const, error: "X".repeat(5000) }),
    });
    expect(report.refusals[0]?.message).toContain(`${"X".repeat(200)}…(5000)`);
    expect(report.refusals[0]?.message).not.toContain("X".repeat(201));
  });

  it("treats a non-boolean `valid` as a gate that did not answer (#5248)", async () => {
    // ⚠️ Routing this to `snapshot-rejected` would be a REGRESSION — that arm tells
    // the admin "re-running will not change this" and to un-enroll a pair that is
    // fine. Tightening `if (verdict.valid)` to `=== true` produces exactly that, and
    // was green across all four warehouse suites until this case existed.
    const report = await run({
      validateSnapshotSql: async () =>
        ({ valid: "yes" }) as unknown as { valid: false; error: string },
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
    // ⚠️ It reaches the MISMATCH arm — a truthy-but-not-boolean `valid` carries no
    // `request`, so the identity check refuses it — and that arm is `snapshot-failed`
    // too. Both routes are transient, which is the property the behaviour table
    // claimed; this assertion names which one actually happens rather than asserting
    // the gate-threw wording and passing for the wrong reason.
    expect(report.refusals[0]?.message).toContain("could not confirm its SQL gate checked");
    expect(payloadOf(errors, "verdict for a different request").returnedRequestMatch).toBe(false);
  });

  it("survives a REVOKED PROXY verdict, where the narrowing itself throws (#5248)", async () => {
    // ⚠️ **THE THIRD INSTANCE OF ONE PRINCIPLE IN THIS CHANGE, and the one that
    // looked safest.** `isRecord` calls `Array.isArray`, which THROWS on a revoked
    // Proxy rather than answering — measured in this runtime: *"Array.isArray cannot
    // be called on a Proxy that has been revoked"* — while `typeof` and `!== null`
    // pass it cleanly first. So the guard written to make the seam read total was
    // itself an unguarded seam operation, sitting one line ABOVE the `try` meant to
    // cover it. Nothing about the shape of that code looks wrong, which is exactly
    // why it needs a test rather than a comment.
    const { proxy, revoke } = Proxy.revocable({ entity: "x" }, {});
    revoke();

    const report = await run({
      validateSnapshotSql: async () => ({
        valid: true as const,
        request: proxy as unknown as ValidatedSnapshotRequest,
      }),
    });
    // A throw anywhere in the arm takes the whole run, so this is the case.
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);

    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.returnedEntity).toBe("<threw>");
    expect(payload.returnedReadThrew).toBe(true);
    // ⚠️ And the SHAPE field too — it is computed by its own `isRecord` call, which
    // was the second unguarded instance and would have escaped independently of the
    // four property reads.
    expect(payload.returnedRequestType).toBe("<threw>");
    expect(payload.sqlDigestMatch).toBe(false);
  });

  it("survives a verdict whose DISCRIMINANT throws, before any arm is chosen (#5248)", async () => {
    // The same class one step earlier: `verdict.valid` is a seam-controlled read that
    // used to happen outside every `try`, so a hostile discriminant took the run down
    // before either refusal arm could be reached. It now lands on the gate-threw arm,
    // which is the honest one — a gate that cannot say `valid` has not answered.
    const report = await run({
      validateSnapshotSql: async () => {
        const verdict = {};
        Object.defineProperty(verdict, "valid", {
          enumerable: true,
          get() {
            throw new TypeError("hostile discriminant");
          },
        });
        return verdict as { valid: false; error: string };
      },
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
    // TRANSIENT, not permanent: "re-running will not change this" is the wrong advice
    // for a broken gate implementation, and it tells the admin to un-enroll a pair
    // that is fine.
    const refusal = report.refusals[0];
    expect(refusal?.message).toContain("the next run");
    expect(payloadOf(warns, "threw rather than answering").err).toBeInstanceOf(Error);
  });

  it("survives a NULL verdict, which throws on the discriminant read (#5248)", async () => {
    const report = await run({
      validateSnapshotSql: async () => null as unknown as { valid: false; error: string },
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
    expect(payloadOf(warns, "threw rather than answering").err).toBeInstanceOf(Error);
  });

  it("bounds a seam string and says so, rather than truncating silently (#5248)", async () => {
    // ⚠️ The bound was prose until now: deleting `.slice(0, 200)` left the suite green,
    // measured. It matters on THIS line specifically — the line's whole job is
    // comparing what came back against what was sent, and a silently truncated
    // 5,000-character value reads as a genuine 200-character one.
    await run({
      validateSnapshotSql: async (req: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...req, entity: "E".repeat(5000) } as ValidatedSnapshotRequest,
      }),
    });

    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.returnedEntity).toBe(`${"E".repeat(200)}…(5000)`);
    // The suffix is what makes truncation visible; without it this is 200 chars of E
    // and no way to tell it from a real one.
    expect(String(payload.returnedEntity)).not.toBe("E".repeat(200));
  });

  it("distinguishes an explicitly null seam field from an absent one (#5248)", async () => {
    // Deleting the `<null>` arm leaves `<object>` — measured green before this case.
    // Cheap to pin, and `null` is what a JSON round-trip through a region bundle
    // produces where `undefined` would have been.
    await run({
      validateSnapshotSql: async (req: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...req, entity: null, sql: null } as unknown as ValidatedSnapshotRequest,
      }),
    });

    const payload = payloadOf(errors, "verdict for a different request");
    expect(payload.returnedEntity).toBe("<null>");
    expect(payload.returnedSqlDigest).toBe("<null>");
    expect(payload.sqlDigestMatch).toBe(false);
  });

  it("reads the REJECTED arm's reason once, guarded and bounded (#5248)", async () => {
    // ⚠️ **THE SIBLING SWEEP'S CATCH — the same seam, the same two defects, one arm
    // up.** `validation.error` was read TWICE, once into the log and once into the
    // operator-facing refusal, so a getter could make them disagree about why the
    // entity was refused. It was also unguarded and unbounded: `{ valid: false }`
    // rendered *"does not pass its SQL gate: undefined"*, the generic message
    // CLAUDE.md forbids, and a throwing accessor escaped the template literal as a
    // 500 for the whole run.
    let errorReads = 0;
    const report = await run({
      validateSnapshotSql: async () => {
        const verdict = { valid: false as const };
        Object.defineProperty(verdict, "error", {
          enumerable: true,
          get() {
            errorReads += 1;
            return `reason-read-${errorReads}`;
          },
        });
        return verdict as { valid: false; error: string };
      },
    });

    expect(errorReads).toBe(1);
    const refusal = report.refusals.find((r) => r.reason === "snapshot-rejected");
    const payload = payloadOf(warns, "did not pass SQL validation");
    // ⚠️ The two sites AGREE, which is the whole claim. A second read makes the log
    // say `reason-read-1` while the admin reads `reason-read-2`.
    expect(payload.reason).toBe("reason-read-1");
    expect(refusal?.message).toContain("reason-read-1");
    expect(refusal?.message).not.toContain("reason-read-2");
  });

  it("never puts the word undefined in the REJECTED arm's operator message (#5248)", async () => {
    // The `{ valid: false }` cast, which `SnapshotSqlVerdict`'s docstring argues the
    // type forbids — the same argument this PR's neighbour disproves.
    const report = await run({
      validateSnapshotSql: async () => ({ valid: false }) as { valid: false; error: string },
    });
    const refusal = report.refusals.find((r) => r.reason === "snapshot-rejected");
    expect(refusal?.message).toContain("<undefined>");
    expect(refusal?.message).not.toContain(": undefined.");
  });

  it("carries the request id and the trigger on every line, including the failures", async () => {
    // The failures that matter here return 200 — a refusal is a successful response
    // — so without this an operator holding one has workspace plus wall-clock and
    // nothing else to give support.
    await run({
      runSnapshot: async () => {
        throw new Error("connection refused");
      },
    });
    // ⚠️ TWO runs, because the first emits no ERROR line at all. Adding `...errors`
    // to the sweep without this was measured VACUOUS — `warns=1 infos=1 errors=0` —
    // so the widening proved nothing and its own justification described a line the
    // fixture never emitted. The mismatch arm is what populates the error sink, and
    // it is mutually exclusive with a throwing runner on one entity.
    await run({
      validateSnapshotSql: async (request: WarehouseSnapshotRequest) => ({
        valid: true as const,
        request: { ...request } as ValidatedSnapshotRequest,
      }),
    });
    // ⚠️ The count assertions first. `for (const line of [...warns, ...infos])` over
    // EMPTY sinks passes while proving nothing, which is the shape this file exists
    // to refuse — and the per-sink assertion is what stops `errors` sliding back to
    // zero while the total stays satisfied by warns and infos.
    //
    // `errors` is in the sweep since #5230: the mismatch refusal is the one line
    // that TELLS the operator to quote the request id, so an error line without it
    // is the one place the instruction is unfollowable.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const lines = [...warns, ...infos, ...errors];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.payload).toMatchObject({
        workspaceId: WORKSPACE,
        triggeredBy: "user-1",
        requestId: "req-1",
      });
    }
  });
});

/**
 * The seam-read ratchet, applied past the validator (#5257).
 *
 * #5248 closed one class for `validateSnapshotSql`: *narrowing is an OPERATION on
 * the seam value, not a fact about it.* These are the same principle on the SIBLING
 * seams of the same loop — the snapshot runner's return value, the entity loader's
 * return value, and the value `withTransaction` rejects with.
 *
 * Falsifiers here were measured against the unfixed producer by restoring it from a
 * backup and re-running — not reasoned about. **Not every case is one:** several are
 * counter-cases or pins that were GREEN before the fix and are killed instead by a
 * targeted mutation of it, and each says so at its own site. Reasoning has been wrong
 * on this principle repeatedly in this file's history.
 *
 * A `runWarehouseProducer` that REJECTS is the failure this describe exists for: one
 * refused entity becoming a 500 for the whole run, with no log line at all. That is
 * why the cases assert a resolved report AND a log line rather than only the first.
 */
describe("warehouse producer seam reads past the validator (#5257)", () => {
  /**
   * A snapshot runner returning `value`, with the seam's return type asserted away.
   *
   * The whole point of these cases is a runner that does NOT honour its declared
   * return type — a substituted implementation, a plugin, a wire — so the assertion
   * is the fixture, not a shortcut around one.
   */
  const returning = (value: unknown) => async () =>
    value as readonly Record<string, unknown>[];

  /** The `tx` shape {@link store}'s runner hands its callback. */
  type TestTx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }> };

  describe("the snapshot runner's return value", () => {
    // ⚠️ The rendered kinds are DELIBERATELY not all distinct — two records render
    // `<record>` — but the shapes are, and each one escaped through a different
    // expression before the fix: `.length` on `null`, a `length` GETTER, and
    // `valueOf` during the `>` comparison. Collapsing them into one case would let a
    // guard that closes only the first stay green.
    const nonArrays: readonly { readonly label: string; readonly kind: string; readonly make: () => unknown }[] = [
      { label: "null", kind: "<null>", make: () => null },
      { label: "undefined", kind: "<undefined>", make: () => undefined },
      { label: "a string", kind: "<string>", make: () => "rows" },
      {
        label: "an object whose `length` getter throws",
        kind: "<record>",
        make: () => {
          const hostile = {};
          Object.defineProperty(hostile, "length", {
            enumerable: true,
            get() {
              throw new TypeError("hostile length getter");
            },
          });
          return hostile;
        },
      },
      {
        label: "an object whose `length` coerces by throwing",
        kind: "<record>",
        make: () => ({
          length: {
            valueOf() {
              throw new TypeError("hostile length valueOf");
            },
          },
        }),
      },
    ];

    for (const { label, kind, make } of nonArrays) {
      it(`refuses ONE entity when the runner answers ${label}, rather than 500ing the run`, async () => {
        const report = await run({ runSnapshot: returning(make()) });

        // Resolved at all — the pre-fix producer REJECTED here, so this line is the
        // falsifier and the payload assertions below are the diagnosis.
        expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
        expect(report.entities).toEqual([]);

        const payload = payloadOf(warns, "snapshot failed");
        expect(payload.entity).toBe("Accounts");
        // ⚠️ The message NAMES what came back. Without it the five shapes above
        // produce one identical line, which is the collapse `seamKind` exists to
        // undo — and an operator cannot tell a runner returning `null` from one
        // returning a hostile object.
        expect(payload.err).toBeInstanceOf(Error);
        expect((payload.err as Error).message).toContain(kind);
        // A shape fault is not an incident for the whole run.
        expect(messages(errors)).toEqual([]);
      });
    }

    it("survives an array whose `Symbol.iterator` throws", async () => {
      // ⚠️ `Array.isArray` answers TRUE here and `.length` is honest, so the shape
      // check alone does not save this one — the claim builder's `for…of` is where it
      // throws, which is why the whole consumption of the returned rows moved inside
      // the `try` rather than only the length read.
      const rows: Record<string, unknown>[] = [
        { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
      ];
      Object.defineProperty(rows, Symbol.iterator, {
        get() {
          throw new TypeError("hostile iterator");
        },
      });

      const report = await run({ runSnapshot: returning(rows) });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);
      expect(payloadOf(warns, "snapshot failed").entity).toBe("Accounts");
      expect(messages(errors)).toEqual([]);
    });

    it("survives a REVOKED PROXY array, where `Array.isArray` itself throws", async () => {
      // ⚠️ **A PIN, not a falsifier, and saying so is the honest half.** Measured
      // GREEN against the unfixed producer: a revoked Proxy is trapped by the `await`
      // inside the existing `try`, so this case survived by luck rather than by
      // design. No local mutation of the fix REDs it, which is the shape of "covered by
      // construction" worth recording rather than dressing up as a measurement.
      //
      // ⚠️ The first draft of this comment justified that with *"every consumption of
      // the returned rows is now guarded"*, which was FALSE when written: the
      // no-candidates arm read `rows.length` outside every `try`. The case below is
      // the falsifier for it. A pin's justification is a claim like any other.
      const { proxy, revoke } = Proxy.revocable([{ [producer.SUBJECT_ALIAS]: "Acme Corp" }], {});
      revoke();

      const report = await run({ runSnapshot: returning(proxy) });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);
      expect(payloadOf(warns, "snapshot failed").entity).toBe("Accounts");
      expect(messages(errors)).toEqual([]);
    });

    it("survives an array that answers `length` and THEN throws, after the claims are built", async () => {
      // ⚠️ **THE ROUND-1 FIX'S OWN DEFECT, ONE STATEMENT OVER.** `Array.isArray`
      // answers TRUE for a Proxy over an array, so the shape check passes and `length`
      // stays under the seam's control for every later read. The first fix guarded the
      // cap read and the claim build, then handed the array back out and read
      // `rows.length` again in the no-candidates arm, where nothing encloses it.
      //
      // ⚠️ **The threshold is MEASURED, and the premise is asserted below rather than
      // assumed.** Against the round-1 code an empty returned array took THREE
      // `length` reads — cap check, the `for…of` iterator, and the no-candidates arm —
      // and a trap throwing from #3 gave `REJECTED: hostile length read #3`: the
      // whole-run 500 with no log line, from inside the fix written to stop it.
      // Against this code there are TWO, both inside the `try`, so #3 never happens.
      let reads = 0;
      const counted = new Proxy([] as Record<string, unknown>[], {
        get(target, key, receiver) {
          if (key === "length" && ++reads >= 3) throw new TypeError(`hostile length read #${reads}`);
          return Reflect.get(target, key, receiver);
        },
      });

      const report = await run({ runSnapshot: returning(counted) });

      // The behavioural claim: the run RESOLVED. Pre-fix it rejected.
      expect(report.refusals).toEqual([]);
      expect(report.entities.map((e) => e.rows)).toEqual([0]);
      // ⚠️ And the premise, pinned. Without this the case goes vacuous the day an
      // internal read is added — the trap would stop firing for a reason that has
      // nothing to do with the guard, and a green test would prove nothing.
      expect(reads).toBe(2);
    });

    it("reports the row count the CAP accepted, not a later answer", async () => {
      // ⚠️ The same seam, lying rather than throwing — the half a `try` cannot catch.
      // A trap that answers honestly for the cap check and inflates afterwards made
      // the report say 999,999 rows for an entity the cap had just accepted. Reading
      // `length` once, beside the comparison, makes the two the same number by
      // construction.
      // Read #3 for the same measured reason as the case above — reads #1 and #2 are
      // the cap check and the `for…of`, and an inflated answer to EITHER would make
      // the claim builder iterate a million absent rows rather than test the report.
      let reads = 0;
      const lying = new Proxy([] as Record<string, unknown>[], {
        get(target, key, receiver) {
          if (key === "length" && ++reads >= 3) return 999_999;
          return Reflect.get(target, key, receiver);
        },
      });

      const report = await run({ rowCap: 5, runSnapshot: returning(lying) });
      expect(report.entities.map((e) => e.rows)).toEqual([0]);
      // ⚠️ The same premise pin as the case above, and without it this one is INERT:
      // with only two reads the trap never fires, so a plain `[]` satisfies the
      // assertion and the Proxy proves nothing.
      expect(reads).toBe(2);
    });

    it("refuses a snapshot whose `length` is not a usable count", async () => {
      // ⚠️ Making the cap check and the report the same number does not make that
      // number VALID. `NaN > rowCap` is false, so a trap answering `NaN` sailed past
      // the cap into `WarehouseEntityOutcome.rows`, where the run report's schema
      // requires a non-negative int — so one bad `length` blanked the ENTIRE run
      // report, every other entity's outcome included. Bigger blast radius than the
      // entity it came from, which is why it is refused at the read.
      for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
        warns.length = 0;
        const hostile = new Proxy([] as Record<string, unknown>[], {
          get(target, key, receiver) {
            if (key === "length") return bad;
            return Reflect.get(target, key, receiver);
          },
        });
        const report = await run({ runSnapshot: returning(hostile) });
        expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
        expect(report.entities).toEqual([]);
        // Blamed on Atlas, not the entity — the shape phase, not the read.
        expect(payloadOf(warns, "snapshot failed").phase).toBe("shape");
      }
    });

    it("survives a NULL row inside a well-formed array", async () => {
      // ⚠️ A hostile CELL is IN scope, and this case plus the next are what make that
      // sentence in the producer a claim rather than a hope. Two rows, not one, so a
      // fix that merely dropped the bad row would still have to explain the survivor.
      const report = await run({
        runSnapshot: returning([
          { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
          null,
        ]),
      });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);
      expect(payloadOf(warns, "snapshot failed").entity).toBe("Accounts");
      expect(messages(errors)).toEqual([]);
    });

    it("survives a row whose SUBJECT getter throws", async () => {
      const hostileRow = {};
      Object.defineProperty(hostileRow, producer.SUBJECT_ALIAS, {
        enumerable: true,
        get() {
          throw new TypeError("hostile subject getter");
        },
      });

      const report = await run({ runSnapshot: returning([hostileRow]) });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);
      // ⚠️ `phase: "claims"` — the ONLY signal separating "the seam answered a bad
      // shape" from "our own claim builder is defective", which is the stated cost of
      // widening the `try`. Nothing else asserts it, so deleting the assignment was
      // green until this line.
      const payload = payloadOf(warns, "snapshot failed");
      expect(payload.entity).toBe("Accounts");
      expect(payload.phase).toBe("claims");
      expect(messages(errors)).toEqual([]);
    });

    it("survives a row whose DIMENSION cell getter throws", async () => {
      // ⚠️ A DIFFERENT expression from the subject case above — `row[SUBJECT_ALIAS]`
      // and `row[DIMENSION_ALIAS_PREFIX + i]` are separate reads behind separate
      // branches, and the subject one runs first. A row with a valid subject and a
      // hostile dimension reaches the second read only, so this is the case that
      // proves the guard covers the per-dimension loop rather than just the key.
      const hostileRow: Record<string, unknown> = { [producer.SUBJECT_ALIAS]: "Acme Corp" };
      Object.defineProperty(hostileRow, `${producer.DIMENSION_ALIAS_PREFIX}0`, {
        enumerable: true,
        get() {
          throw new TypeError("hostile dimension getter");
        },
      });

      const report = await run({ runSnapshot: returning([hostileRow]) });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);
      expect(payloadOf(warns, "snapshot failed").entity).toBe("Accounts");
    });

    it("does NOT refuse a primitive row — it stays an unidentified row (#5257 scope)", async () => {
      // ⚠️ **The boundary of "a hostile CELL is IN scope", pinned because the first
      // draft of that comment overstated it.** A row that is a primitive answers
      // `undefined` for every alias instead of THROWING, so nothing reaches the guard
      // and the pre-existing unidentified-row counter takes it. Measured identical
      // before and after the fix — `rows: 1, unidentifiedRows: 1`, no refusal.
      //
      // Whether an unreadable ROW should cost a refusal is a real question and a
      // different one; #5257 deliberately does not move it. This case is what makes
      // that a recorded decision rather than an unnoticed gap, and it REDs the day
      // someone changes it silently.
      const report = await run({ runSnapshot: returning([42, "x"]) });
      expect(report.refusals).toEqual([]);
      expect(report.entities.map((e) => ({ rows: e.rows, unidentified: e.unidentifiedRows }))).toEqual([
        { rows: 2, unidentified: 2 },
      ]);
    });

    it("blames ATLAS, not the entity, when the fault is the runner's shape", async () => {
      // ⚠️ Widening the `try` made two Atlas-side faults reachable on an arm whose
      // message says "usually a table or a dimension's column that no longer exists.
      // Fix the entity YAML" — advice that sends an admin to edit a correct entity.
      // The `phase` split is what keeps the sentence honest, and this is its falsifier:
      // collapsing the ternary back to one message passes every other case here.
      const shape = await run({ runSnapshot: returning(null) });
      expect(shape.refusals[0]?.message).toContain("This is an Atlas fault");
      expect(shape.refusals[0]?.message).toContain("req-1");
      expect(shape.refusals[0]?.message).not.toContain("Fix the entity YAML");
      expect(payloadOf(warns, "snapshot failed").phase).toBe("shape");

      warns.length = 0;
      // And the datasource read keeps the entity-facing advice it always had.
      const read = await run({
        runSnapshot: async () => {
          throw new Error("relation does not exist");
        },
      });
      // ⚠️ It points at the LOG rather than asserting the cause. `phase: "run"` covers
      // more than the datasource read — `defaultRunSnapshot` imports a module and looks
      // up a pool first — so naming "a table or column that no longer exists" as THE
      // cause was unfollowable for the Atlas-side half of its own arm.
      expect(read.refusals[0]?.message).toContain("a table or a dimension's column");
      expect(read.refusals[0]?.message).toContain("The server log for this run names what");
      expect(read.refusals[0]?.message).not.toContain("This is an Atlas fault rather than a problem");
      expect(payloadOf(warns, "snapshot failed").phase).toBe("run");
    });

    it("still refuses an over-cap snapshot under its OWN reason, not `snapshot-failed`", async () => {
      // ⚠️ The shape check moved the cap read inside the `try`, and a `try` that
      // swallowed the cap arm would relabel a routine, well-diagnosed refusal as a
      // failed snapshot — advice that sends an admin to check their warehouse instead
      // of their enrollment. Measured: deleting the `row-cap` arm and letting the
      // catch handle it passes every OTHER case in this describe.
      const report = await run({
        rowCap: 1,
        runSnapshot: returning([
          { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
          { [producer.SUBJECT_ALIAS]: "Globex", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "churned" },
        ]),
      });
      expect(report.refusals.map((r) => r.reason)).toEqual(["row-cap-exceeded"]);
      expect(payloadOf(warns, "exceeds the row cap").rowCap).toBe(1);
      expect(warns.filter((c) => c.message.includes("snapshot failed"))).toEqual([]);
    });
  });

  describe("the entity loader's return value", () => {
    it("refuses ONE entity whose YAML shape throws, leaving its neighbour's run intact", async () => {
      // ⚠️ TWO enrolled entities, and the second one is the whole assertion. The
      // parse sat outside the `try` whose own comment says an uncaught throw *"rejects
      // the whole `Promise.all`, killing the run for every unrelated enrolled
      // entity"* — so a one-entity fixture would prove only that the run resolved,
      // never that the unrelated entity survived.
      const hostileYaml: Record<string, unknown> = {};
      Object.defineProperty(hostileYaml, "table", {
        enumerable: true,
        get() {
          throw new TypeError("hostile table getter");
        },
      });

      const report = await run({
        loadReach: async () => makeProducerReach([
            { entity: "Accounts", group: null, dimension: "status", naming: false },
            { entity: "Hostile", group: null, dimension: "status", naming: false },
          ]),
        loadEntity: async (_workspaceId: string, name: string) =>
          name === "Hostile" ? hostileYaml : ACCOUNTS_YAML,
      });

      // The hostile one is refused, and the message is the PERMANENT one: the lookup
      // succeeded, so `load-threw`'s "audit your connection groups / wait and retry"
      // would be advice this admin can follow forever.
      expect(report.refusals.map((r) => `${r.entity}:${r.reason}`)).toEqual([
        "Hostile:entity-unreadable",
      ]);
      expect(report.refusals[0]?.message).toContain("fix the entity YAML");
      // ⚠️ And the UNRELATED entity still produced its outcome — with a POSITIVE
      // CONTROL on what it produced. `entities` containing "Accounts" is satisfied by
      // an entity that ran and emitted nothing, so without `created` this stays green
      // for a fix that leaves the neighbour reachable but broken.
      expect(report.entities.map((e) => e.entity)).toEqual(["Accounts"]);
      expect(report.created).toBe(1);
      // ⚠️ Its OWN message, not the loader's. Asserted as absent from the loader's
      // line too, because sharing one arm is exactly what this split undid.
      expect(payloadOf(warns, "YAML could not be read").entity).toBe("Hostile");
      expect(warns.filter((c) => c.message.includes("entity lookup failed"))).toEqual([]);
    });

    it("keeps a THROWING loader distinct from an unreadable SHAPE", async () => {
      // ⚠️ The counter-case for the split above, and without it the two arms can be
      // folded back together and every other case here stays green. A loader that
      // THREW says nothing about whether the entity is fixable — the ambiguous-name
      // and transient-blip causes are both live — so its prose points at the server
      // log, not at the YAML.
      const report = await run({
        loadEntity: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      });

      expect(report.refusals.map((r) => r.reason)).toEqual(["entity-unreadable"]);
      expect(report.refusals[0]?.message).toContain("connection group");
      // And NOT the permanent remedy — the two arms must not converge on one sentence.
      expect(report.refusals[0]?.message).not.toContain("fix the entity YAML");
      expect(payloadOf(warns, "entity lookup failed").err).toBeInstanceOf(Error);
      expect(warns.filter((c) => c.message.includes("YAML could not be read"))).toEqual([]);
    });

    it("blames ATLAS when the loader answers something that is not a record", async () => {
      // ⚠️ **This case previously PINNED THE DEFECT.** A loader answering a string or an
      // array does not throw — `nonEmptyString(raw.table)` just answers `undefined` — so
      // it fell through to the `no-table` arm and told the admin *"its YAML declares no
      // `table:` … Fix the entity YAML"*, with ZERO log lines. That is the same
      // misdirection the `unreadable-shape` split removed, one arm over, and the
      // quietest instance of it: the other two arms at least warn.
      for (const answer of ["yaml", 42, [], true]) {
        warns.length = 0;
        const report = await run({
          loadEntity: async () => answer as unknown as Record<string, unknown>,
        });

        expect(report.refusals.map((r) => r.reason)).toEqual(["entity-unreadable"]);
        expect(report.refusals[0]?.message).toContain("This is an Atlas fault");
        expect(report.refusals[0]?.message).not.toContain("declares no `table:`");
        expect(payloadOf(warns, "not an entity record").entity).toBe("Accounts");
      }
    });

    it("keeps the genuine `no-table` arm silent for a record that simply omits it", async () => {
      // The counter-case: a real entity record with no `table:` is an ordinary YAML
      // mistake whose remedy is already right, and it stays SILENT by design. Without
      // this, the shape guard above could be widened to swallow the genuine case too.
      const report = await run({ loadEntity: async () => ({ dimensions: [] }) });

      expect(report.refusals.map((r) => r.reason)).toEqual(["entity-unreadable"]);
      expect(report.refusals[0]?.message).toContain("declares no `table:`");
      expect(warns.filter((c) => c.message.includes("not an entity record"))).toEqual([]);
      expect(warns.filter((c) => c.message.includes("YAML could not be read"))).toEqual([]);
      expect(warns.filter((c) => c.message.includes("entity lookup failed"))).toEqual([]);
    });

    it("keeps `not-published` distinct from a throwing shape", async () => {
      // The arm the move must not swallow: `null` is an ordinary unpublished entity
      // and gets `entity-not-published`, not the loader's failure arm. Without this,
      // folding the null check into the catch passes the case above.
      const report = await run({ loadEntity: async () => null });
      expect(report.refusals.map((r) => r.reason)).toEqual(["entity-not-published"]);
      expect(warns.filter((c) => c.message.includes("entity lookup failed"))).toEqual([]);
    });
  });

  describe("the value the transaction rejects with", () => {
    it("cannot escape the `instanceof` in the transaction handler", async () => {
      // ⚠️ `err instanceof WarehouseProducerContractError` walks the prototype chain,
      // so it is an operation on a value the transaction seam chose. Measured before
      // the fix: a revoked Proxy escaped `runWarehouseProducer` with ZERO log lines,
      // out of the handler written to stop precisely that.
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();

      // ⚠️ TWO enrolled entities, the first committing, so `committedEntities` is
      // asserted against a NON-EMPTY list. With the one-entity fixture the pre-existing
      // case uses, `toEqual([])` is true by construction and cannot tell a correct
      // payload from a hardcoded one — and this key exists precisely to be the only
      // record that earlier entities had already filed drafts.
      let calls = 0;
      const report = await run({
        loadReach: async () => makeProducerReach([
            { entity: "Accounts", group: null, dimension: "status", naming: false },
            { entity: "Second", group: null, dimension: "tier", naming: false },
          ]),
        // ⚠️ Distinct DIMENSION NAMES, not just distinct tables. One dimension name
        // owned by two entities is `ambiguous-dimension`, and the plan refuses both
        // before a transaction is ever opened — which would make this case green for
        // a reason that has nothing to do with the transaction seam.
        loadEntity: async (_workspaceId: string, name: string) =>
          name === "Second"
            ? {
                table: "contacts",
                dimensions: [
                  { name: "contact_id", sql: "contact_id", primary_key: true },
                  { name: "tier", sql: "tier" },
                ],
              }
            : ACCOUNTS_YAML,
        withTransaction: async <T,>(fn: (tx: TestTx) => Promise<T>): Promise<T> => {
          if (++calls === 1) return store().runner(fn);
          throw proxy;
        },
      });
      expect(report.refusals.map((r) => `${r.entity}:${r.reason}`)).toEqual([
        "Second:snapshot-failed",
      ]);

      const payload = payloadOf(errors, "transaction failed");
      expect(payload.committedEntities).toEqual(["Accounts"]);
      expect(payload.committedCreated).toBe(1);
      // ⚠️ The two fields that survive a hostile value. `scrubErrSerializer` renders
      // one as `[log scrub failed]`, so without these the operator's entire diagnosis
      // is that string — and `contractCheckThrew` is the bit a bare boolean swallowed.
      expect(payload.errKind).toBe("<threw>");
      expect(payload.contractCheckThrew).toBe(true);
    });

    it("cannot escape on the value the transaction RESOLVES with", async () => {
      // ⚠️ **THE MIRROR HALF, and the round-1 fix hardened only the rejection.**
      // `withTransaction`'s `T` is inferred from OUR callback, so the declared type is
      // a claim about a substitutable seam rather than a fact about it — nothing
      // checked that the resolved value was the object the callback built. Measured
      // against the round-1 code: an outcome with a throwing `created` getter rejected
      // the whole run from `outcomes.reduce(…)`, AFTER every entity had committed,
      // with no log line naming the entity.
      const hostileOutcome = {};
      Object.defineProperty(hostileOutcome, "created", {
        enumerable: true,
        get() {
          throw new TypeError("hostile outcome getter");
        },
      });

      const report = await run({ withTransaction: async () => hostileOutcome as never });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);
      expect(report.created).toBe(0);
      // ⚠️ Recorded: this fixture's runner never invokes the callback, so post-fix the
      // hostile getter is read ZERO times and this lands on the same arm as the
      // `undefined` case below. It still kills a `resolved ?? producedOutcome`
      // weakening, but the genuinely distinct class — a runner that RUNS the callback
      // and then resolves something else — is the next case, not this one.
      expect(payloadOf(errors, "resolved without running").entity).toBe("Accounts");
    });

    it("ignores a plausible outcome the runner resolves AFTER running the callback", async () => {
      // ⚠️ The distinct class the case above does not reach: the callback runs and
      // commits, and the seam then resolves its OWN object. Nothing about that object
      // is hostile — it is exactly the shape we build — so only reading the closure
      // local tells the two apart. `created: 99` is deliberately not a number this run
      // can produce, so a fix that trusted the returned value would report it.
      const report = await run({
        withTransaction: (async (fn: (tx: TestTx) => Promise<unknown>) => {
          await store().runner(fn);
          return { entity: "Accounts", rows: 7, candidates: 7, created: 99 };
        }) as never,
      });
      expect(report.created).toBe(1);
      expect(report.entities.map((e) => ({ entity: e.entity, rows: e.rows }))).toEqual([
        { entity: "Accounts", rows: 1 },
      ]);
      expect(report.refusals).toEqual([]);
    });

    it("treats a plain non-thenable return as work never done", async () => {
      // The sibling of the revoked-Proxy return: `.catch` is simply UNDEFINED on a
      // number, so the old form died with `x.catch is not a function` outside every
      // guard. It is the shape a naive substituted runner actually has.
      const report = await run({ withTransaction: (() => 5) as never });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.refusals[0]?.message).toContain("either of its exits");
    });

    it("cannot escape on the RETURNED value either, before it is ever awaited", async () => {
      // ⚠️ **The third read on this one seam, and the one a `.catch(…)` chain cannot
      // guard — because `.catch` is itself a property access on the returned value.**
      // A runner handing back a revoked Proxy threw at the `.catch` lookup, outside
      // every `try`, after earlier entities had committed. `await` inside a `try/catch`
      // has no such read: the revoked Proxy throws on the `.then` lookup instead, where
      // it is caught.
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();

      const report = await run({ withTransaction: (() => proxy) as never });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.entities).toEqual([]);

      // ⚠️ A REAL Error, and `contractCheckThrew: false` — asserted because the first
      // draft of this case guessed `true` and was measured wrong. What reaches the
      // catch is the `TypeError` the runtime raises for the `.then` lookup on a revoked
      // Proxy, NOT the Proxy itself, so the classification never touches a hostile
      // value here. The distinction matters: it is why this case does not duplicate the
      // revoked-Proxy REJECTION case above, which does hand one straight to
      // `instanceof`.
      const payload = payloadOf(errors, "transaction failed");
      expect(payload.err).toBeInstanceOf(Error);
      expect(payload.contractCheckThrew).toBe(false);
      expect(payload.errKind).toBe("<record>");
    });

    it("refuses when the runner resolves WITHOUT running the entity's work", async () => {
      // The same class with no hostility at all: a substituted runner that simply
      // forgets to invoke the callback resolves `undefined`, which passed both
      // identity checks and reached `o.created`. It is now its own refusal, because
      // dropping the entity from both lists reads as "never enrolled" — the silence
      // this report exists to remove.
      const report = await run({ withTransaction: async () => undefined as never });
      expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);
      expect(report.refusals[0]?.message).toContain("either of its exits");
      // ⚠️ It must NOT claim a clean rollback. The callback may have run and committed
      // an episode before a swallowed throw — only the final assignment is known not to
      // have happened — so the sibling abort arm's "nothing at all was recorded"
      // guarantee does not travel here.
      expect(report.refusals[0]?.message).toContain("cannot confirm what");
      expect(report.refusals[0]?.message).not.toContain("nothing at all was recorded");
      expect(payloadOf(errors, "resolved without running").entity).toBe("Accounts");
    });

    it("resets its per-entity state — an entity AFTER a failed one still commits", async () => {
      // ⚠️ **`producedOutcome` and `transactionAborted` are new mutable state this fix
      // introduced, and every other case puts the FAILING entity last** — so neither
      // flag is ever observed being reset. Hoisting either declaration out of the loop
      // body, the classic refactor, is green without this case and produces exactly the
      // silence this module argues against:
      //   - `transactionAborted` hoisted → every entity after an abort hits `continue`
      //     and vanishes from BOTH lists: no facts, and no refusal naming it.
      //   - `producedOutcome` hoisted → the next entity pushes the PREVIOUS entity's
      //     outcome, double-counting `created` in the operator report.
      let calls = 0;
      const report = await run({
        loadReach: async () => makeProducerReach([
            { entity: "A", group: null, dimension: "status", naming: false },
            { entity: "B", group: null, dimension: "tier", naming: false },
            { entity: "C", group: null, dimension: "band", naming: false },
          ]),
        loadEntity: async (_workspaceId: string, name: string) => ({
          table: `t_${name.toLowerCase()}`,
          dimensions: [
            { name: `${name.toLowerCase()}_id`, sql: "id", primary_key: true },
            { name: name === "A" ? "status" : name === "B" ? "tier" : "band", sql: "col" },
          ],
        }),
        withTransaction: async <T,>(fn: (tx: TestTx) => Promise<T>): Promise<T> => {
          // B is the MIDDLE entity, which is the whole point.
          if (++calls === 2) throw new Error("40001 serialization failure");
          return store().runner(fn);
        },
      });

      // A and C both committed; only B is refused — and B is named, not dropped.
      expect(report.entities.map((e) => e.entity)).toEqual(["A", "C"]);
      expect(report.refusals.map((r) => `${r.entity}:${r.reason}`)).toEqual([
        "B:snapshot-failed",
      ]);
      expect(report.created).toBe(2);
      // ⚠️ And the error line proves the "earlier entities had already committed" story
      // end to end: A is in the list, C is not, because C had not run yet.
      expect(payloadOf(errors, "transaction failed").committedEntities).toEqual(["A"]);
    });

    it("does not carry one entity's outcome onto the next", async () => {
      // The `producedOutcome` half of the case above, isolated: B's runner resolves
      // without ever invoking the callback. A hoisted `producedOutcome` would push A's
      // outcome a second time under B's turn.
      let calls = 0;
      const report = await run({
        loadReach: async () => makeProducerReach([
            { entity: "A", group: null, dimension: "status", naming: false },
            { entity: "B", group: null, dimension: "tier", naming: false },
          ]),
        loadEntity: async (_workspaceId: string, name: string) => ({
          table: `t_${name.toLowerCase()}`,
          dimensions: [
            { name: `${name.toLowerCase()}_id`, sql: "id", primary_key: true },
            { name: name === "A" ? "status" : "tier", sql: "col" },
          ],
        }),
        withTransaction: (async (fn: (tx: TestTx) => Promise<unknown>) => {
          if (++calls === 2) return undefined;
          return store().runner(fn);
        }) as never,
      });

      expect(report.entities.map((e) => e.entity)).toEqual(["A"]);
      expect(report.created).toBe(1);
      expect(report.refusals.map((r) => `${r.entity}:${r.reason}`)).toEqual([
        "B:snapshot-failed",
      ]);
    });

    it("still lets this module's OWN contract defect stay fatal", async () => {
      // ⚠️ **The anti-constant falsifier, and without it the guard is satisfiable by
      // `() => false`.** Every other case in this describe wants the classification
      // to answer "not a contract error"; only this one wants a `true`, and it is the
      // one that keeps the fatal/operational split from collapsing into "nothing is
      // ever fatal".
      await expect(
        run({
          withTransaction: async () => {
            throw new producer.WarehouseProducerContractError("RETURNING clause and reader disagree");
          },
        }),
      ).rejects.toThrow("RETURNING clause and reader disagree");
    });
  });
});
