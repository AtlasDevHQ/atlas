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
 */

import { describe, expect, it } from "bun:test";
import { ACL_GATED_TABLES } from "@atlas/api/lib/brain/acl";
import {
  DEFAULT_GRANT_SWEEP_INTERVAL_HOURS,
  GRANT_SWEEP_ROW_CAP,
  getGrantSweepIntervalMs,
  grantScanSql,
  runGrantSweepCycle,
  type GrantSweepDeps,
} from "../grant-sweep";

const WORKSPACE = "ws-1";

interface Row {
  readonly workspace_id: string;
  readonly id: string;
  readonly visible_to: readonly unknown[];
  readonly status: string | null;
}

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
  byTable: Partial<Record<string, readonly Row[]>>,
  extra: Omit<GrantSweepDeps, "query"> = {},
) {
  const scans: string[] = [];
  const deps: GrantSweepDeps = {
    ...extra,
    query: (<T>(sql: string) => {
      const table = ACL_GATED_TABLES.find((t) => sql.includes(`FROM ${t}`));
      if (!table) throw new Error(`scan SQL named no gated table: ${sql}`);
      scans.push(table);
      return Promise.resolve((byTable[table] ?? []) as unknown as T[]);
    }) as GrantSweepDeps["query"],
  };
  return { deps, scans };
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
  });

  it("flags a grant of only NULL/'' elements — legal at rest, usable by nobody", async () => {
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

      expect(result.status).toBe("success");
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
      expect(sql).toContain("NOT ('org' = ANY(visible_to))");
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
      query: (<T>(sql: string) => {
        if (sql.includes("FROM brain_episodes")) return Promise.reject(new Error("relation gone"));
        return Promise.resolve([row("f_1", ["everyone"])] as unknown as T[]);
      }) as GrantSweepDeps["query"],
    };

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.status).toBe("degraded");
    expect(result.malformedRows).toBe(1);
    expect(result.error).toContain("relation gone");
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

    expect(result.scanTruncated).toBe(true);
    // The count is a FLOOR — reported, not silently presented as a total.
    expect(result.malformedRows).toBe(1);
  });

  it("does not flag truncation on a short scan", async () => {
    const { deps } = harness({ brain_facts: [row("f_1", ["everyone"])] }, { rowCap: 10 });

    const result = await withDatabaseUrl(() => runGrantSweepCycle(deps));

    expect(result.scanTruncated).toBe(false);
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
  });
});

describe("getGrantSweepIntervalMs", () => {
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

  it("keeps a generous default row cap", () => {
    expect(GRANT_SWEEP_ROW_CAP).toBeGreaterThanOrEqual(10_000);
  });
});
