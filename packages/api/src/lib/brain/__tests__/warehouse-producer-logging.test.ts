/**
 * The warehouse producer's OPERATOR-FACING lines (#5042, ADR-0037 §4).
 *
 * Four of this module's log statements are the only record of something that is
 * otherwise invisible to every caller, and each was deletable — or demotable —
 * green before this file existed:
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
 *   - the **cardinality-refusal split**. `already-decided` is routine and belongs
 *     at `debug`; the other three mean the call site drifted and belong at `warn`.
 *     One level for both is a producer whose proposals silently stopped landing.
 *   - the **transaction-failure `error`**. The run re-throws, so the `outcomes`
 *     array is discarded — this line is the only record that entities 1..N-1 had
 *     already COMMITTED drafts while the operator was told the run failed.
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
type SnapshotSqlVerdict = import("@atlas/api/lib/brain/warehouse-producer").SnapshotSqlVerdict;
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
      pairs: [{ entity: "Accounts", dimension: "status" }],
      entities: ["Accounts"],
      has: () => true,
    }),
    loadEntity: async () => ACCOUNTS_YAML,
    // Cast because the passing verdict is branded — see the unit suite's note.
    validateSnapshotSql: async () => ({ valid: true }) as SnapshotSqlVerdict,
    runSnapshot: async () => [
      { [producer.SUBJECT_ALIAS]: "Acme Corp", [`${producer.DIMENSION_ALIAS_PREFIX}0`]: "active" },
    ],
    loadVocabulary: async () => (await import("@atlas/api/lib/brain/identity")).identityVocabulary,
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

    expect(payloadOf(warns, "no claim can be made of").unsurfaceableCells).toBe(2);
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
    expect(warns.filter((c) => c.message.includes("no claim can be made of"))).toEqual([]);
  });

  it("splits the cardinality refusal — `already-decided` at DEBUG, anything else at WARN", async () => {
    await run({ withTransaction: store({ cardinalityConflict: true }).runner });

    expect(payloadOf(debugs, "already adjudicated").refusal).toBe("already-decided");
    // ⚠️ Asserted as ABSENT from the warn sink, not merely present in debug. One
    // level for both refusal classes is a producer whose proposals silently stopped
    // landing, and a single-array capture cannot see the difference.
    expect(warns.filter((c) => c.message.includes("cardinality"))).toEqual([]);
  });

  it("logs the committed entities at ERROR before re-throwing a transaction failure", async () => {
    // The run re-throws, so `outcomes` is discarded — this line is the only record
    // that anything committed while the operator was told the run failed.
    await expect(
      run({
        withTransaction: async () => {
          throw new Error("40001 serialization failure");
        },
      }),
    ).rejects.toThrow("40001");

    const payload = payloadOf(errors, "transaction failed");
    expect(payload.committedEntities).toEqual([]);
    expect(payload.err).toBeInstanceOf(Error);
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
    for (const line of [...warns, ...infos]) {
      expect(line.payload).toMatchObject({ workspaceId: WORKSPACE, triggeredBy: "user-1", requestId: "req-1" });
    }
  });
});
