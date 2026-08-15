/**
 * The warehouse producer's OPERATOR-FACING lines (#5042, ADR-0037 §4).
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
type ReconcileModule = typeof import("@atlas/api/lib/brain/reconcile");

let producer: ProducerModule;
let reconcile: ReconcileModule;

beforeAll(async () => {
  // DYNAMIC, after the mock above is installed — a static import binds the real
  // logger at module-evaluation time and every assertion here reads an empty sink
  // while the lines print to stdout.
  producer = await import("@atlas/api/lib/brain/warehouse-producer");
  reconcile = await import("@atlas/api/lib/brain/reconcile");
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
    loadReach: async () => ({
      pairs: [{ entity: "Accounts", dimension: "status", naming: false }],
      entities: ["Accounts"],
      namingDimension: new Map<string, string>(),
      has: () => true,
    }),
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
 * The one line in `sink` whose message contains `fragment`, or a failure.
 *
 * Returns the PAYLOAD non-optionally, which is what keeps every assertion below
 * out of `x?.payload as T` — an optional chain there makes a missing line read as
 * `undefined` and quietly weakens whatever is asserted about it.
 */
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
      loadReach: async () => ({
        pairs: [{ entity: "Accounts", dimension: "__", naming: false }],
        entities: ["Accounts"],
        namingDimension: new Map(),
        has: () => true,
      }),
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

    // ⚠️ The claim the two runs exist to make, asserted directly rather than left as
    // an inference from the two blocks above. A single hardcoded value satisfies
    // roughly half the assertions in each block; nothing satisfies this one.
    expect(forged.sqlDigestMatch).not.toBe(replay.sqlDigestMatch);
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

    const serialized = JSON.stringify(payload);
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

  it("logs a mismatch rather than throwing when the verdict carries no request at all (#5248)", async () => {
    // ⚠️ The mismatch arm has NO enclosing `try` — the per-entity catches wrap the
    // validator call and the snapshot, not this branch — so a `TypeError` raised while
    // BUILDING the log payload escapes `runWarehouseProducer` entirely and turns a
    // refused entity into a 500 for the whole run. `undefined.slice(0, 200)` on a
    // verdict cast from `{}` did exactly that, and the cast compiles:
    // `warehouse-producer-bypass.test.ts` pins the sites that may write one.
    const report = await run({
      validateSnapshotSql: async () => ({
        valid: true as const,
        request: {} as ValidatedSnapshotRequest,
      }),
    });
    expect(report.refusals.map((r) => r.reason)).toEqual(["snapshot-failed"]);

    const payload = payloadOf(errors, "verdict for a different request");
    // Sentinels, not silence: an operator needs to know the field was absent rather
    // than empty, and the digest must still say the statements differ.
    expect(payload.returnedEntity).toBe("<undefined>");
    expect(payload.returnedWorkspaceId).toBe("<undefined>");
    expect(payload.returnedSqlDigest).toBe("<non-string>");
    expect(payload.sqlDigestMatch).toBe(false);
    // ...and the SUBMITTED side is unaffected, so the line still identifies the run.
    expect(payload.entity).toBe("Accounts");
    expect(payload.sqlDigest).toMatch(/^[0-9a-f]{16}$/);
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
