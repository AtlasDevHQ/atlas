/**
 * The "log" half of #4797 — the sweep's actual deliverable.
 *
 * Split into its own file for the same reason as `acl-logging.test.ts`: it
 * needs `mock.module("@atlas/api/lib/logger")` installed before the module
 * under test is imported, and the sibling suites deliberately run with no
 * module mocking at all.
 *
 * Why it exists rather than trusting the log calls to stay put: EVERY
 * `log.warn` in `grant-sweep.ts` could be deleted and both sibling suites
 * would stay green — verified by replacing the module's logger with a no-op,
 * which left `22 pass / 0 fail`. That is a worse hole here than in `acl.ts`.
 * There, the log is the reporting half of an enforcement that is structural
 * either way; HERE the log IS the product. The module writes nothing, gates
 * nothing, and repairs nothing — a count on a span and this line are its
 * entire output, and the line is the only half that names the rows an operator
 * has to go fix.
 *
 * The digest contract is also a behavioural claim and is pinned here: the
 * module's whole cadence argument (daily, not the audience sync's 30m) rests on
 * a clean cycle being SILENT. A sweep that warned every cycle regardless would
 * be the alert fatigue the design went out of its way to avoid.
 *
 * Every VALUE export of `lib/logger.ts` is stubbed, per the mock-all-exports
 * rule — a partial factory works right up until some module in the import
 * graph reaches a missing name and fails at link time with `Export named 'X'
 * not found` in a file that has nothing to do with this one.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

type LogCall = { level: "error" | "warn" | "info" | "debug"; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (obj: unknown) => obj,
  hashShareToken: (token: string) => token,
}));

const { runGrantSweepCycle, getGrantSweepIntervalMs, MAX_TIMER_DELAY_MS } = await import(
  "@atlas/api/lib/brain/grant-sweep"
);
const { ACL_GATED_TABLES } = await import("@atlas/api/lib/brain/acl");
type AclGatedTable = (typeof ACL_GATED_TABLES)[number];

type Row = {
  readonly workspace_id: string;
  readonly id: string;
  readonly visible_to: readonly unknown[];
  readonly status: string | null;
};

const row = (id: string, visibleTo: readonly unknown[], workspaceId = "ws-1"): Row => ({
  workspace_id: workspaceId,
  id,
  visible_to: visibleTo,
  status: null,
});

function withDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://stub/stub";
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  });
}

// Keyed on `AclGatedTable`, NOT `string`: a typo'd fixture key would otherwise
// compile, serve zero rows, and make the silence assertion below pass for the
// wrong reason. The sibling suite was fixed here first; this file inherited the
// hole when it was written.
const sweep = (byTable: Partial<Record<AclGatedTable, readonly Row[]>>, rowCap?: number) =>
  withDatabaseUrl(() =>
    runGrantSweepCycle({
      ...(rowCap !== undefined ? { rowCap } : {}),
      query: (sql: string) => {
        const table = ACL_GATED_TABLES.find((t) => sql.includes(`FROM ${t}`));
        return Promise.resolve(table ? (byTable[table] ?? []) : []);
      },
    }),
  );

/** Warn lines whose message contains `needle`. */
const warns = (needle: string) =>
  logCalls.filter((c) => c.level === "warn" && c.message.includes(needle));

const payloadOf = (call: LogCall | undefined) => call?.payload as Record<string, unknown> | undefined;

beforeEach(() => {
  logCalls.length = 0;
});

describe("the findings line", () => {
  it("names the rows, the grant, and the scope — one line per cycle", async () => {
    await sweep({
      brain_facts: [row("f_1", ["everyone"]), row("f_2", ["role:bogus"], "ws-2")],
      brain_episodes: [row("e_1", ["team:eng"])],
    });

    const found = warns("no parseable principal");
    expect(found).toHaveLength(1);

    const payload = payloadOf(found[0]);
    expect(payload?.malformedRows).toBe(3);
    expect(payload?.malformedWorkspaces).toBe(2);
    expect(payload?.rowsScanned).toBe(3);
    // The fix list: an operator debugging "the agent doesn't know X" has to be
    // able to go from this line to the rows without another query.
    expect(payload?.sample).toEqual([
      { table: "brain_facts", workspaceId: "ws-1", rowId: "f_1", status: null, grant: ["everyone"] },
      { table: "brain_facts", workspaceId: "ws-2", rowId: "f_2", status: null, grant: ["role:bogus"] },
      { table: "brain_episodes", workspaceId: "ws-1", rowId: "e_1", status: null, grant: ["team:eng"] },
    ]);
    // The message has to say what an operator should DO, not just what happened.
    expect(found[0]?.message).toContain("invisible to every reader");
    expect(found[0]?.message).toContain("Re-grant");
  });

  it("is SILENT on a clean cycle — the digest contract the daily cadence rests on", async () => {
    // The whole "1 line/day/replica is a digest, 48 is noise" argument assumes
    // a healthy deployment says nothing at all. A sweep that logged every cycle
    // regardless would be the alert fatigue the design exists to avoid.
    const result = await sweep({
      brain_facts: [row("f_1", ["org"]), row("f_2", ["user:u1"])],
    });

    // Non-vacuity backstop: silence is also what an EMPTY scan produces, so the
    // claim means nothing without proof that rows were actually examined.
    expect(result.rowsScanned).toBe(2);
    expect(warns("no parseable principal")).toHaveLength(0);
    expect(logCalls.filter((c) => c.level === "warn")).toHaveLength(0);
  });

  it("bounds the sample and says so when it clipped", async () => {
    // Without the cap this line carries one object per malformed row, verbatim
    // grants included — on the fiber whose stated property is that its cost is
    // bounded by CADENCE rather than by row count. Deleting the `.slice` left
    // every other test green.
    const many = Array.from({ length: 25 }, (_, i) => row(`f_${i}`, ["everyone"]));
    await sweep({ brain_facts: many });

    const payload = payloadOf(warns("no parseable principal")[0]);
    expect(payload?.malformedRows).toBe(25);
    expect(payload?.sample).toHaveLength(20);
    expect(payload?.sampleTruncated).toBe(true);
  });

  it("does not claim truncation when the sample fits", async () => {
    await sweep({ brain_facts: [row("f_1", ["everyone"])] });

    const payload = payloadOf(warns("no parseable principal")[0]);
    expect(payload?.sampleTruncated).toBe(false);
  });
});

describe("the fault lines are distinguishable", () => {
  it("reports an unreadable row shape separately, naming the table", async () => {
    // The "wrong file" argument: an unreadable shape is query drift and a
    // malformed grant is a data defect. Reporting them alike would send the
    // investigation to the wrong place — and the two tables' projections
    // deliberately differ, so the line has to say WHICH one drifted.
    await sweep({
      brain_episodes: [
        { workspace_id: "ws-1", id: "e_1", visible_to: "not-an-array", status: null } as never,
      ],
    });

    const drift = warns("unreadable shape");
    expect(drift).toHaveLength(1);
    expect(payloadOf(drift[0])?.table).toBe("brain_episodes");
    expect(payloadOf(drift[0])?.unreadable).toBe(1);
    // Not counted as a finding.
    expect(warns("no parseable principal")).toHaveLength(0);
  });

  it("reports the row cap as a floor, not a total", async () => {
    // `countIsFloor` reaches the span, but "the count is a floor" as something
    // an operator can read exists only here.
    await sweep({ brain_facts: [row("f_1", ["everyone"]), row("f_2", ["everyone"])] }, 2);

    const capped = warns("row cap was reached");
    expect(capped).toHaveLength(1);
    expect(payloadOf(capped[0])?.rowCap).toBe(2);
    expect(capped[0]?.message).toContain("floor, not a total");
  });

  it("names the table whose scan failed", async () => {
    await withDatabaseUrl(() =>
      runGrantSweepCycle({
        query: (sql: string) =>
          sql.includes("FROM brain_episodes")
            ? Promise.reject(new Error("relation gone"))
            : Promise.resolve([]),
      }),
    );

    const failed = warns("scan failed");
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])?.table).toBe("brain_episodes");
    expect(payloadOf(failed[0])?.err).toContain("relation gone");
  });
});

describe("the interval knob's two fallback arms are distinguishable", () => {
  function withInterval<T>(value: string | undefined, fn: () => T): T {
    const key = "ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS";
    const prior = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }

  it("stays silent on an EMPTY knob but warns on an unparseable one", async () => {
    // `""`, not undefined: the registry defines `default: "24"`, so
    // `getSettingAuto` never returns undefined for this key and the empty
    // string is the reachable "operator cleared the field" arm.
    //
    // Both return the default, so the return value alone cannot tell them
    // apart — an operator whose typo is being ignored has only this line.
    withInterval("", () => getGrantSweepIntervalMs());
    expect(logCalls.filter((c) => c.level === "warn")).toHaveLength(0);

    withInterval("nonsense", () => getGrantSweepIntervalMs());
    expect(warns("non-positive or unparseable")).toHaveLength(1);
  });

  it("warns when clamping an over-large interval", async () => {
    // Unclamped this value stops the fiber ticking entirely, so the clamp
    // changes behaviour silently unless it says so.
    expect(withInterval("600", () => getGrantSweepIntervalMs())).toBe(MAX_TIMER_DELAY_MS);
    expect(warns("exceeds the max timer delay")).toHaveLength(1);
  });
});
