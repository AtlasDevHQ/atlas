/**
 * The malformed-grant sweep (#4797, ADR-0036 §Access control & residency).
 *
 * Two things are actually under test, and only one of them is "does it find the
 * broken row".
 *
 * The FIRST is that the sweep's notion of "malformed" is `acl.ts`'s parse and
 * not a cheaper lookalike. Every fixture below that matters is NEARLY VALID —
 * `['role:bogus']`, `['Audience:eng']`, `['user:']` — because a junk fixture
 * like `['zzz']` passes under a prefix check, a regex, or an empty-array test
 * just as happily as under the real parser, and would prove nothing about which
 * of them is running. `['role:bogus']` is the sharp one: valid prefix, does not
 * parse, entirely malformed, and exactly the row a SQL pre-filter over prefixes
 * would drop.
 *
 * The SECOND is the boundary between this sweep and `logGrantAnomalies`. A
 * PARTLY-malformed grant (`['user:abc', 'everyone']`) is already reported at
 * read time by the caller holding the row; flagging it here too would
 * double-count it and drown the entirely-malformed row this exists to surface.
 * So "has at least one usable principal ⇒ not this sweep's business" is a
 * behavioural contract, not an implementation detail.
 *
 * The THIRD thing under test is the log line — the sweep's actual deliverable
 * (#4797), pinned in the `the findings line` / `the fault lines are
 * distinguishable` / `the interval knob` blocks at the bottom. Formerly
 * `grant-sweep-logging.test.ts`, merged here in #5645: it was a separate file
 * only because it needed `mock.module("@atlas/api/lib/logger")` installed
 * before the module under test was imported, and this file "deliberately ran
 * with no module mocking at all". A stub that covers every value export of
 * `lib/logger.ts` is indistinguishable from the real logger to a test that
 * never reads the log, so one registration serves both halves —
 * `installLoggerMock()` from `@atlas/api/testing/logger`. The module under test
 * is imported DYNAMICALLY below so the stub is in place before
 * `createLogger()` runs at module evaluation.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AclGatedTable } from "@atlas/api/lib/brain/acl";
import type { GrantSweepDeps, GrantSweepResult } from "../grant-sweep";
import { installLoggerMock, type LogCall } from "@atlas/api/testing/logger";

const logger = installLoggerMock();

const { ACL_GATED_TABLES } = await import("@atlas/api/lib/brain/acl");
const {
  DEFAULT_GRANT_SWEEP_INTERVAL_HOURS,
  GRANT_SWEEP_ROW_CAP,
  MALFORMED_SAMPLE_CAP,
  MAX_TIMER_DELAY_MS,
  MIN_GRANT_SWEEP_INTERVAL_MS,
  getGrantSweepIntervalMs,
  grantScanSql,
  runGrantSweepCycle,
} = await import("../grant-sweep");

beforeEach(() => {
  logger.reset();
});

const WORKSPACE = "ws-1";

type Row = {
  readonly workspace_id: string;
  readonly id: string;
  readonly visible_to: readonly unknown[];
  readonly status: string | null;
};

const row = (id: string, visibleTo: readonly unknown[], overrides: Partial<Row> = {}): Row => ({
  workspace_id: WORKSPACE,
  id,
  visible_to: visibleTo,
  status: null,
  ...overrides,
});

/** `hasInternalDB()` reads DATABASE_URL; set inside tests, never at top level. */
function withDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://stub/stub";
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  });
}

/**
 * A sweep wired to per-table fixtures. Both gated tables are served, so a test
 * that only cares about facts still exercises the real two-table iteration.
 */
function harness(
  byTable: Partial<Record<AclGatedTable, readonly Row[]>>,
  extra: Omit<GrantSweepDeps, "query"> = {},
) {
  const scans: string[] = [];
  const bindings: (unknown[] | undefined)[] = [];
  const deps: GrantSweepDeps = {
    ...extra,
    query: (sql: string, params?: unknown[]) => {
      const table = ACL_GATED_TABLES.find((t) => sql.includes(`FROM ${t}`));
      if (!table) throw new Error(`scan SQL named no gated table: ${sql}`);
      // The cap must reach `$1`. Unbound, this is a Postgres bind error that
      // only the -pg suite sees — and that suite is skipped without
      // TEST_DATABASE_URL, so a local gate would go green on a broken scan.
      bindings.push(params);
      scans.push(table);
      return Promise.resolve(byTable[table] ?? []);
    },
  };
  return { deps, scans, bindings };
}

/** Drive the registry knob through its env mirror; restored on the way out. */
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

describe("runGrantSweepCycle — what counts as malformed", () => {
  it("flags a grant whose only token has a VALID PREFIX but does not parse", async () => {
    // The fixture with no cover. A prefix check, a regex over `role:|user:|
    // audience:|org`, or a SQL narrow that looks for "no element with a known
    // prefix" all call this row clean. Only `parsePrincipal`'s role-membership
    // test calls it malformed — which is the whole claim of this module.
    const { deps } = harness({ brain_facts: [row("f_1", ["role:bogus"])] });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.status).toBe("success");
    expect(result.malformedRows).toBe(1);
    expect(result.malformedWorkspaces).toBe(1);
    expect(result.sample).toEqual([
      { table: "brain_facts", workspaceId: WORKSPACE, rowId: "f_1", status: null, grant: ["role:bogus"] },
    ]);
  });

  it("flags case-variant and bare-prefix tokens — the parser is byte-exact", async () => {
    // `Audience:eng` and `ROLE:admin` differ from a valid token by one byte, and
    // `user:` is a valid prefix with nothing after it. All three are malformed
    // because Postgres's `&&` is byte-exact and the parser must not be kinder
    // than the operator that enforces the grant.
    const { deps } = harness({
      brain_facts: [row("f_1", ["Audience:eng"]), row("f_2", ["ROLE:admin"])],
      brain_episodes: [row("e_1", ["user:"]), row("e_2", ["org "])],
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(4);
    expect(result.sample.map((s) => s.rowId).toSorted()).toEqual(["e_1", "e_2", "f_1", "f_2"]);
  });

  it("flags `role:platform_admin` — a platform role is not an org grant", async () => {
    const { deps } = harness({ brain_facts: [row("f_1", ["role:platform_admin"])] });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(1);
  });

  it("does NOT flag a grant with one usable principal — that is logGrantAnomalies' remit", async () => {
    // The double-count guard. `['user:abc', 'everyone']` is reported at read
    // time by the caller holding the row; repeating it here would bury the
    // entirely-malformed row in the noise of every partly-sloppy grant.
    const { deps } = harness({
      brain_facts: [row("f_1", ["user:abc", "everyone"]), row("f_2", ["role:member", "team:eng"])],
      brain_episodes: [row("e_1", ["audience:chat-channel:slack:C1", null, ""])],
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(0);
    expect(result.sample).toEqual([]);
    // Non-vacuity: `toBe(0)` also holds when the harness served NOTHING (a
    // typo'd fixture key used to do exactly that). Pin the rows actually
    // examined so this test can only pass by parsing them.
    expect(result.rowsScanned).toBe(3);
  });

  it("flags `['', 'everyone']` — legal at rest, usable by nobody", async () => {
    // 0180's CHECK admits `[NULL, '']`? No — it requires one non-NULL non-empty
    // element. But `['', 'everyone']` IS admitted, and parses to zero
    // principals. The CHECK is a cardinality test; this is a grammar test, and
    // the gap between them is exactly what this sweep reports.
    const { deps } = harness({ brain_facts: [row("f_1", ["", "everyone"])] });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(1);
  });
});

describe("runGrantSweepCycle — scope", () => {
  it("scans BOTH gated tables, iterating the registry", async () => {
    const { deps, scans } = harness({});

    await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(scans.toSorted()).toEqual([...ACL_GATED_TABLES].toSorted());
  });

  it("flags DRAFT facts — an unreviewable row is the most stuck one, not the least", async () => {
    // `loadFactCandidates` ANDs the ACL predicate, so a malformed draft is
    // invisible to the reviewer too: it can never be reviewed or promoted. A
    // published-only sweep would hide the one class with a decision pending.
    const { deps } = harness({
      brain_facts: [
        row("f_draft", ["everyone"], { status: "draft" }),
        row("f_pub", ["team:eng"], { status: "published" }),
        row("f_arch", ["role:bogus"], { status: "archived" }),
      ],
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(3);
    // Status rides along so an operator can deprioritise `archived` — it is a
    // triage field in the log line, never a filter in the query.
    expect(result.sample.map((s) => [s.rowId, s.status])).toEqual([
      ["f_draft", "draft"],
      ["f_pub", "published"],
      ["f_arch", "archived"],
    ]);
  });

  it("does NOT flag a grammatical grant that happens to match nobody", async () => {
    // The other invisible-to-everyone class, and deliberately out of scope.
    // `audience: eng` (leading space) and `user:deleted-id` PARSE — `acl.ts`
    // accepts any non-empty remainder, because it has no business assuming a
    // shape for Better Auth ids or source-derived audience ids. They may still
    // match no reader token, but deciding that needs existence checks against
    // `user` / `fact_audience_member` — a per-row cross-table read this sweep
    // must not acquire. "Parses to a principal" is the whole boundary.
    const { deps } = harness({
      brain_facts: [row("f_1", ["audience: eng"]), row("f_2", ["user:deleted-id"])],
      brain_episodes: [row("e_1", ["audience:archived-channel"])],
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(0);
    expect(result.rowsScanned).toBe(3);
  });

  it("counts distinct workspaces, not rows", async () => {
    const { deps } = harness({
      brain_facts: [
        row("f_1", ["everyone"], { workspace_id: "ws-a" }),
        row("f_2", ["everyone"], { workspace_id: "ws-a" }),
        row("f_3", ["everyone"], { workspace_id: "ws-b" }),
      ],
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(3);
    expect(result.malformedWorkspaces).toBe(2);
  });

  it("no-ops cleanly without an internal DB", async () => {
    const prior = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { deps, scans } = harness({ brain_facts: [row("f_1", ["everyone"])] });
      const result = await runGrantSweepCycle(deps);

      // `skipped`, not `success`: nothing ran. `success` here would pair an
      // all-clear status with all-null ("we do not know") counters.
      expect(result.status).toBe("skipped");
      // `null`, not 0 — the sweep did not run, and 0 would read as all-clear.
      expect(result.malformedRows).toBeNull();
      expect(scans).toEqual([]);
    } finally {
      if (prior !== undefined) process.env.DATABASE_URL = prior;
    }
  });
});

describe("runGrantSweepCycle — the scan SQL", () => {
  it("narrows on the exact `org` token and nothing else", () => {
    for (const table of ACL_GATED_TABLES) {
      const sql = grantScanSql(table);
      expect(sql).toContain("NOT (visible_to @> ARRAY['org'])");
      // `= ANY` is the NULL-UNSAFE spelling of the same idea and reads as a
      // synonym: over an array with a NULL element and no match it yields NULL,
      // `NOT NULL` is NULL, and `WHERE NULL` drops the row — so every
      // entirely-malformed grant carrying a NULL element went unreported. The
      // pg cross-check proves the behaviour; this stops the text coming back.
      expect(sql).not.toContain("= ANY(");
      // The grammar-duplication guard. A predicate mentioning any
      // PARAMETERISED arm is a second derivation of `parsePrincipal`, and the
      // obvious version of it ("no element has a known prefix") silently drops
      // `['role:bogus']` — under-reporting, in the direction that matters.
      expect(sql).not.toContain("role:");
      expect(sql).not.toContain("user:");
      expect(sql).not.toContain("audience:");
      expect(sql).not.toMatch(/LIKE|SIMILAR TO|~/);
    }
  });

  it("projects status from brain_facts and NULL from brain_episodes", () => {
    // `brain_episodes` has no status column; a shared projection would make the
    // scan fail on one of the two tables at runtime.
    expect(grantScanSql("brain_facts")).toMatch(/SELECT workspace_id, id, visible_to, status/);
    expect(grantScanSql("brain_episodes")).toContain("NULL::text AS status");
  });

  it("orders the capped prefix stably", () => {
    // Without an ORDER BY, a truncated sweep reports a different arbitrary
    // slice each cycle and the count wanders for no reason.
    for (const table of ACL_GATED_TABLES) {
      expect(grantScanSql(table)).toContain("ORDER BY workspace_id, id");
    }
  });
});

describe("runGrantSweepCycle — degradation is visible", () => {
  it("reports a partial scan as `degraded`, keeping the counters it has", async () => {
    const deps: GrantSweepDeps = {
      query: (sql: string) => {
        if (sql.includes("FROM brain_episodes")) return Promise.reject(new Error("relation gone"));
        return Promise.resolve([row("f_1", ["everyone"])]);
      },
    };

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.status).toBe("degraded");
    expect(result.malformedRows).toBe(1);
    expect(result.error).toContain("relation gone");
    // The whole reason this field is not just `scanTruncated`: a half-scan is
    // not a complete one. Without this arm the span reports a partial count as
    // a total, which is the fabricated all-clear the rename exists to remove.
    expect(result.countIsFloor).toBe(true);
    // ...and the cap was NOT the cause, which is what the span discriminates.
    expect(result.scanTruncated).toBe(false);
  });

  it("reports all-null counters when EVERY table's scan fails", async () => {
    const deps: GrantSweepDeps = { query: () => Promise.reject(new Error("db down")) };

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.status).toBe("failure");
    // Not 0. A failed sweep reporting zero is indistinguishable from a healthy
    // deployment on the span, hiding exactly the number this module exists for.
    expect(result.malformedRows).toBeNull();
    expect(result.malformedWorkspaces).toBeNull();
    expect(result.rowsScanned).toBeNull();
    // The cycle that scanned NOTHING is the strongest case for "not a total".
    expect(result.countIsFloor).toBe(true);
  });

  it("keeps the FIRST error when both tables fail", async () => {
    // `firstError ??=` — the earlier fault is usually the cause and the later
    // one the consequence. With one failing table this arm is unreachable.
    const deps: GrantSweepDeps = {
      query: (sql: string) =>
        Promise.reject(new Error(`${ACL_GATED_TABLES.find((t) => sql.includes(`FROM ${t}`))}-gone`)),
    };

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.status).toBe("failure");
    // Derived from the registry, not hardcoded: a reorder of ACL_GATED_TABLES
    // must not fail this test while first-wins still holds.
    expect(result.error).toContain(`${ACL_GATED_TABLES[0]}-gone`);
  });

  it("never throws — a rejected scan is a result, not an exception", async () => {
    const deps: GrantSweepDeps = { query: () => Promise.reject(new Error("boom")) };
    // The fiber routes this through `Effect.tryPromise`, but the contract the
    // scheduler relies on is that the cycle itself resolves.
    await expect(withDatabaseUrl(() => runGrantSweepCycle(deps))).resolves.toBeDefined();
  });

  it("flags truncation when the row cap is reached", async () => {
    const { deps } = harness({ brain_facts: [row("f_1", ["everyone"]), row("f_2", ["org"])] }, {
      rowCap: 2,
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.countIsFloor).toBe(true);
    // The count is a FLOOR — reported, not silently presented as a total.
    expect(result.malformedRows).toBe(1);
  });

  it("caps the RESULT's sample, not only the log payload", async () => {
    // Two independent `.slice` call sites. The logging suite pins the log
    // payload; without this the returned `sample` could go unbounded and only
    // the -pg suite would notice — and that suite is silently skipped without
    // TEST_DATABASE_URL, so every local gate would stay green.
    const many = Array.from({ length: MALFORMED_SAMPLE_CAP + 5 }, (_, i) =>
      row(`f_${i}`, ["everyone"]),
    );
    const { deps } = harness({ brain_facts: many });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(MALFORMED_SAMPLE_CAP + 5);
    expect(result.sample).toHaveLength(MALFORMED_SAMPLE_CAP);
    expect(result.sampleTruncated).toBe(true);
  });

  it("keeps `scanTruncated ⇒ countIsFloor` on every return path", async () => {
    // A cross-field invariant that no single test above covers: the cap is one
    // of the fold's three causes, so the unfolded flag can never be the more
    // optimistic of the two. Drift here would let an alert reading
    // `countIsFloor` miss a capped scan — the exact case the fold exists for.
    const cases: GrantSweepResult[] = [
      // skipped — nothing ran
      await (async () => {
        const prior = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;
        try {
          return await runGrantSweepCycle(harness({}).deps);
        } finally {
          if (prior !== undefined) process.env.DATABASE_URL = prior;
        }
      })(),
      // failure — every table's scan threw
      await withDatabaseUrl(() =>
        runGrantSweepCycle({ query: () => Promise.reject(new Error("down")) }),
      ),
      // success, capped
      await withDatabaseUrl(() =>
        runGrantSweepCycle(harness({ brain_facts: [row("f_1", ["everyone"])] }, { rowCap: 1 }).deps),
      ),
      // success, clean
      await withDatabaseUrl(() =>
        runGrantSweepCycle(harness({ brain_facts: [row("f_1", ["org"])] }).deps),
      ),
    ];

    for (const result of cases) {
      if (result.scanTruncated) expect(result.countIsFloor).toBe(true);
    }
    // Non-vacuity: at least one case must actually have been truncated, or the
    // implication above is satisfied by an empty antecedent every time.
    expect(cases.some((r) => r.scanTruncated)).toBe(true);
  });

  it("does not flag truncation on a short scan", async () => {
    const { deps } = harness({ brain_facts: [row("f_1", ["everyone"])] }, { rowCap: 10 });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.countIsFloor).toBe(false);
  });

  it("neither clears nor flags a row whose shape it cannot read", async () => {
    // Query drift, not a data defect. Counting it as malformed would send the
    // investigation to the wrong file; counting it as clean would let a
    // projection change silently zero the sweep out.
    const { deps } = harness({
      brain_facts: [
        { workspace_id: WORKSPACE, id: "f_1", visible_to: "not-an-array", status: null } as never,
        row("f_2", ["everyone"]),
      ],
    });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.malformedRows).toBe(1);
    expect(result.sample.map((s) => s.rowId)).toEqual(["f_2"]);
    expect(result.rowsScanned).toBe(2);
    expect(result.unreadableRows).toBe(1);
    // A row that could not be READ is not a row the sweep cleared, so the
    // cycle's count is unverified rather than clean. Reporting `success` here
    // is how a projection change that made EVERY row unreadable would have
    // shown up as a healthy deployment.
    expect(result.status).toBe("degraded");
  });
});

describe("getGrantSweepIntervalMs", () => {
  it("defaults to daily — a permanent defect is a digest, not an event stream", () => {
    expect(withInterval(undefined, getGrantSweepIntervalMs)).toBe(
      DEFAULT_GRANT_SWEEP_INTERVAL_HOURS * 3_600_000,
    );
    expect(DEFAULT_GRANT_SWEEP_INTERVAL_HOURS).toBe(24);
  });

  it("honours a set value", () => {
    // Asserted so the fallback cases below are not vacuously passing on a knob
    // that is never read at all.
    expect(withInterval("6", getGrantSweepIntervalMs)).toBe(6 * 3_600_000);
    expect(withInterval("0.5", getGrantSweepIntervalMs)).toBe(1_800_000);
  });

  it("falls back to the default on unparseable or non-positive — never to disabled", () => {
    // Unlike the staleness bound, `0` does NOT disable here: there is no
    // enforcement to escape from, so a "disabled" arm would buy nothing but a
    // way to lose the only observer of a permanent defect class by typo.
    for (const bad of ["", "nonsense", "0", "-4", "NaN"]) {
      expect({ bad, ms: withInterval(bad, getGrantSweepIntervalMs) }).toEqual({
        bad,
        ms: DEFAULT_GRANT_SWEEP_INTERVAL_HOURS * 3_600_000,
      });
    }
  });

  it("clamps an over-large interval instead of letting the fiber stop ticking", () => {
    // Past MAX_TIMER_DELAY_MS Effect's clock treats the duration as INFINITE:
    // `Schedule.spaced` runs one boot tick and never re-arms. 600h is a
    // plausible "dial this way down" keystroke, and unclamped it would produce
    // permanent silence indistinguishable from a dead fiber — the exact
    // outcome the fiber registration comment says it exists to avoid.
    expect(withInterval("600", getGrantSweepIntervalMs)).toBe(MAX_TIMER_DELAY_MS);
    expect(600 * 3_600_000).toBeGreaterThan(MAX_TIMER_DELAY_MS);
    // Just under the bound is honoured, so the clamp is not swallowing sane values.
    expect(withInterval("500", getGrantSweepIntervalMs)).toBe(500 * 3_600_000);
  });

  it("clamps an interval below the floor — cadence is this module's control", async () => {
    // The upper clamp alone left the knob able to defeat the property the whole
    // design rests on: 0.0001h is ~3 full two-table scans per second, each able
    // to emit a findings line.
    expect(withInterval("0.0001", getGrantSweepIntervalMs)).toBe(MIN_GRANT_SWEEP_INTERVAL_MS);
    // Just above the floor is honoured, so the clamp is not eating sane values.
    expect(withInterval("1", getGrantSweepIntervalMs)).toBe(3_600_000);
  });

  it("binds the DEFAULT row cap when no override is injected", async () => {
    // Every truncation test injects `rowCap`, so the production default was
    // exercised only by the -pg suite — which is skipped without a database.
    const { deps, bindings } = harness({ brain_facts: [row("f_1", ["org"])] });
    await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(bindings).toHaveLength(ACL_GATED_TABLES.length);
    expect(bindings.every((b) => b?.[0] === GRANT_SWEEP_ROW_CAP)).toBe(true);
  });
});

// ── The log line (#4797) — formerly grant-sweep-logging.test.ts ──────────────
//
// Why these exist rather than trusting the log calls to stay put: EVERY
// `log.warn` in `grant-sweep.ts` could be deleted and every suite above would
// stay green — verified by replacing the module's logger with a no-op, which
// failed nothing. That is a worse hole here than in `acl.ts`. There,
// the log is the reporting half of an enforcement that is structural either
// way; HERE the log IS the product. The module writes nothing, gates nothing,
// and repairs nothing — a count on a span and this line are its entire output,
// and the line is the only half that names the rows an operator has to go fix.
//
// The digest contract is also a behavioural claim and is pinned here: the
// module's whole cadence argument (daily, not the audience sync's 30m) rests on
// a clean cycle being SILENT. A sweep that warned every cycle regardless would
// be the alert fatigue the design went out of its way to avoid.

// A sweep wired straight to per-table rows, with no scan bookkeeping — the
// logging tests read the log, not the query. Keyed on `AclGatedTable`, NOT
// `string`: a typo'd fixture key would otherwise compile, serve zero rows, and
// make the silence assertion below pass for the wrong reason.
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

const payloadOf = (call: LogCall | undefined) => call?.payload as Record<string, unknown> | undefined;

describe("the findings line", () => {
  it("names the rows, the grant, and the scope — one line per cycle", async () => {
    await sweep({
      brain_facts: [row("f_1", ["everyone"]), row("f_2", ["role:bogus"], { workspace_id: "ws-2" })],
      brain_episodes: [row("e_1", ["team:eng"])],
    });

    const found = logger.warns("no parseable principal");
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
    expect(logger.warns("no parseable principal")).toHaveLength(0);
    expect(logger.warns()).toHaveLength(0);
  });

  it("bounds the sample and says so when it clipped", async () => {
    // Without the cap this line carries one object per malformed row, verbatim
    // grants included — on the fiber whose stated property is that its cost is
    // bounded by CADENCE rather than by row count. Deleting the `.slice` left
    // every other test green.
    const many = Array.from({ length: 25 }, (_, i) => row(`f_${i}`, ["everyone"]));
    await sweep({ brain_facts: many });

    const payload = payloadOf(logger.warns("no parseable principal")[0]);
    expect(payload?.malformedRows).toBe(25);
    expect(payload?.sample).toHaveLength(20);
    expect(payload?.sampleTruncated).toBe(true);
  });

  it("does not claim truncation when the sample fits", async () => {
    await sweep({ brain_facts: [row("f_1", ["everyone"])] });

    const payload = payloadOf(logger.warns("no parseable principal")[0]);
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

    const drift = logger.warns("unreadable shape");
    expect(drift).toHaveLength(1);
    expect(payloadOf(drift[0])?.table).toBe("brain_episodes");
    expect(payloadOf(drift[0])?.unreadable).toBe(1);
    // Not counted as a finding.
    expect(logger.warns("no parseable principal")).toHaveLength(0);
  });

  it("reports the row cap as a floor, not a total", async () => {
    // `countIsFloor` reaches the span, but "the count is a floor" as something
    // an operator can read exists only here.
    await sweep({ brain_facts: [row("f_1", ["everyone"]), row("f_2", ["everyone"])] }, 2);

    const capped = logger.warns("row cap was reached");
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

    const failed = logger.warns("scan failed");
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])?.table).toBe("brain_episodes");
    expect(payloadOf(failed[0])?.err).toContain("relation gone");
  });
});

describe("the interval knob's two fallback arms are distinguishable", () => {
  it("stays silent on an EMPTY knob but warns on an unparseable one", async () => {
    // `""`, not undefined: the registry defines `default: "24"`, so
    // `getSettingAuto` never returns undefined for this key and the empty
    // string is the reachable "operator cleared the field" arm.
    //
    // Both return the default, so the return value alone cannot tell them
    // apart — an operator whose typo is being ignored has only this line.
    withInterval("", () => getGrantSweepIntervalMs());
    expect(logger.warns()).toHaveLength(0);

    withInterval("nonsense", () => getGrantSweepIntervalMs());
    expect(logger.warns("non-positive or unparseable")).toHaveLength(1);
  });

  it("warns when clamping an over-large interval", async () => {
    // Unclamped this value stops the fiber ticking entirely, so the clamp
    // changes behaviour silently unless it says so.
    expect(withInterval("600", () => getGrantSweepIntervalMs())).toBe(MAX_TIMER_DELAY_MS);
    expect(logger.warns("exceeds the max timer delay")).toHaveLength(1);
  });
});
