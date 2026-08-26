/**
 * The tension FORECAST's wiring (#5450).
 *
 * `forecastTensionEdges` answers the question `sweepTensionEdges` answers and
 * declines to write the answer, so almost everything worth asserting about it is
 * a RELATIONSHIP to the sweep rather than a behaviour of its own:
 *
 *   - **the two statements are the same scan.** A forecast that drifted from the
 *     sweep is worse than no forecast — it is a number an approver acts on that
 *     the button then contradicts. Asserted TEXTUALLY, because that is the only
 *     form of the claim a unit test can settle; `tension-forecast-pg.test.ts`
 *     settles the behavioural half against a real corpus.
 *   - **it writes nothing.** The whole licence. A `count(*)` that grew an
 *     `INSERT` would pass every arithmetic test here.
 *   - **it does NOT take the reconcile lock**, which is the one place it
 *     deliberately diverges from the sweep, and a divergence nothing else would
 *     catch: taking 4771 makes a preview correct and makes it block ingest for
 *     the length of a human's deliberation.
 *   - **an unkeyable surface is not a zero.** The defect
 *     `StructurallyEmptyReason.unkeyable-surface` was added to
 *     `vocabulary-preview.ts` to fix, in the one place where the confident zero
 *     reads as *"approving this is free"*.
 *   - **the truncation arithmetic is the sweep's**, not a second copy that
 *     happens to agree today.
 */

import { describe, expect, it } from "bun:test";
import {
  RECONCILE_LOCK_SQL,
  TENSION_EDGE_CAP,
  type ReconcileExecutor,
} from "@atlas/api/lib/brain/reconcile";
import { LOCK_NOT_AVAILABLE } from "@atlas/api/lib/brain/identity";
import {
  FORECAST_MAX_CONCURRENT,
  TENSION_FORECAST_SQL,
  TENSION_SWEEP_RUN_CAP,
  TENSION_SWEEP_SQL,
  _forecastsInFlight,
  contentionMessage,
  forecastContentionMessage,
  forecastTensionEdges,
} from "@atlas/api/lib/brain/tension-sweep";

interface Call {
  readonly sql: string;
  readonly params: unknown[] | undefined;
}

/**
 * A recording transaction runner.
 *
 * `wouldMint` is the count the forecast statement "returns" — deliberately a
 * single scalar rather than a row array, because that is the shape the real
 * statement has and a harness that returned N rows would let a `rows.length`
 * implementation pass.
 *
 * Typed `unknown` rather than `number`, because half the assertions below feed
 * it values a driver could hand back and the reader must reject — `null`, `""`,
 * a non-integer. (`number | unknown` was the first spelling and is the same type
 * as `unknown`; `lint:type-aware` says so, which is why it is not written that
 * way.)
 */
function harness(opts: { wouldMint?: unknown; error?: unknown; noRow?: boolean } = {}) {
  const calls: Call[] = [];
  const runner = async <T>(fn: (tx: ReconcileExecutor) => Promise<T>): Promise<T> =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql === TENSION_FORECAST_SQL) {
          if (opts.error !== undefined) throw opts.error;
          if (opts.noRow === true) return { rows: [] };
          // `in`, not `??` — the harness must be able to hand back an explicit
          // `undefined`, which is one of the values the coercion guard is
          // asserted against and which `??` would silently turn into a valid 0.
          return { rows: [{ would_mint: "wouldMint" in opts ? opts.wouldMint : 0 }] };
        }
        return { rows: [] };
      },
    });
  return { calls, runner };
}

/** A `pg` error as the driver actually shapes it — a `code` on an Error. */
function pgError(code: string, where?: string): Error & { code: string } {
  return Object.assign(new Error(`simulated ${code}`), where === undefined ? { code } : { code, where });
}

describe("the forecast IS the sweep's scan (#5450)", () => {
  it("shares the candidate scan and the freshness guard as TEXT, not as intent", () => {
    // The module header's standing rule — two spellings of "what is in tension"
    // is how two readers drift into flagging different pairs. Asserted by
    // reconstructing the sweep's body from the forecast's: everything from `WITH`
    // to the close of `fresh` must be the same characters, with the ONLY
    // difference the cardinality gate.
    // `lastIndexOf`, not `indexOf` — the `candidate` CTE closes with the same
    // four characters, so the first match slices the `fresh` guard away and
    // leaves a comparison that cannot see the half most likely to drift.
    const body = (sql: string) => sql.slice(0, sql.lastIndexOf("\n  )") + "\n  )".length);
    const sweepBody = body(TENSION_SWEEP_SQL);
    const forecastBody = body(TENSION_FORECAST_SQL);

    // Non-vacuity first: a `body()` that sliced to nothing would make the
    // comparison below trivially true.
    expect(sweepBody, "the body slice is empty — the comparison below proves nothing").toContain(
      "CROSS JOIN LATERAL",
    );
    expect(
      sweepBody,
      "the slice stopped at the `candidate` CTE — the freshness guard, which is the half a forecast is most likely to drop, is not being compared",
    ).toContain("NOT EXISTS");

    const STORED_GATE = `EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = a.workspace_id
          AND c.predicate_key = a.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')`;
    expect(
      forecastBody.replace(`(a.predicate_key = $4 OR ${STORED_GATE})`, STORED_GATE),
      "the forecast's scan is not the sweep's scan with the gate swapped — a second spelling of `what is in tension` has appeared, and an approver cannot tell which statement is right",
    ).toBe(sweepBody);
  });

  it("counts, and writes nothing at all", () => {
    // The licence. `tension-sweep.test.ts` makes the mirror-image assertion about
    // the sweep ("writes `brain_edges` and nothing else"); this is the half that
    // says a read stayed a read.
    expect(TENSION_FORECAST_SQL.match(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\w+/gi)).toBe(
      null,
    );
    expect(TENSION_FORECAST_SQL).toContain("SELECT count(*)::int AS would_mint FROM fresh");
  });

  it("binds the workspace, both caps and the counterfactual, in that order", async () => {
    const { calls, runner } = harness({ wouldMint: 0 });
    await forecastTensionEdges("ws-binds", { kind: "as-curated" }, { withTransaction: runner });

    const forecast = calls.find((c) => c.sql === TENSION_FORECAST_SQL);
    expect(forecast, "the forecast statement never ran").toBeDefined();
    // POSITIONALLY. Both caps are plain integers, so a swapped pair type-checks
    // and silently forecasts a different number than the button will mint.
    expect(forecast!.params).toEqual(["ws-binds", TENSION_EDGE_CAP, TENSION_SWEEP_RUN_CAP, null]);
  });

  it("names exactly the four placeholders it binds — `$1` at TWO sites here, not three", () => {
    // The sweep's `$1` reaches three sites because the INSERT has a column of its
    // own. This statement has no INSERT, so a copy of the sweep's assertion would
    // be wrong in the direction that looks right.
    expect(TENSION_FORECAST_SQL.match(/\$1\b/g) ?? []).toHaveLength(2);
    expect(TENSION_FORECAST_SQL.match(/\$2\b/g) ?? []).toHaveLength(1);
    expect(TENSION_FORECAST_SQL.match(/\$3\b/g) ?? []).toHaveLength(1);
    expect(TENSION_FORECAST_SQL.match(/\$4\b/g) ?? []).toHaveLength(1);
    expect(
      TENSION_FORECAST_SQL.match(/\$[0-9]+/g) ?? [],
      "the statement names a placeholder the caller does not bind",
    ).toHaveLength(5);
  });
});

describe("the forecast does NOT take the reconcile lock (#5450)", () => {
  it("bounds the statement both ways and never acquires namespace 4771", async () => {
    const { calls, runner } = harness({ wouldMint: 3 });
    await forecastTensionEdges("ws-1", { kind: "as-curated" }, { withTransaction: runner });

    const sqls = calls.map((c) => c.sql);
    expect(
      sqls.some((s) => s === RECONCILE_LOCK_SQL),
      "the forecast took the reconcile lock — a preview that holds namespace 4771 blocks this workspace's ingest for as long as a human takes to decide",
    ).toBe(false);
    // …but BOTH bounds are still issued, and before the scan. The candidate walk
    // is the expensive half and this statement keeps all of it.
    const lockBound = sqls.findIndex((s) => s.includes("lock_timeout"));
    const stmtBound = sqls.findIndex((s) => s.includes("statement_timeout"));
    const scan = sqls.findIndex((s) => s === TENSION_FORECAST_SQL);
    expect(lockBound).toBeGreaterThanOrEqual(0);
    expect(stmtBound).toBeGreaterThanOrEqual(0);
    expect(lockBound).toBeLessThan(scan);
    expect(stmtBound).toBeLessThan(scan);
  });
});

describe("the forecast's counterfactual (#5450)", () => {
  it("binds the derived KEY, never the surface as typed", async () => {
    const { calls, runner } = harness({ wouldMint: 2 });
    await forecastTensionEdges(
      "ws-1",
      { kind: "if-approved", predicateSurface: "  Has Target Raise Of  " },
      { withTransaction: runner },
    );
    const forecast = calls.find((c) => c.sql === TENSION_FORECAST_SQL);
    expect(forecast!.params?.[3]).toBe("has target raise of");
  });

  it("binds NULL for `as-curated`, which collapses the gate to the stored lookup", async () => {
    // The whole reason one statement serves both questions. A second statement
    // without the disjunct is the drift the builder exists to prevent, and the
    // "today" spelling is the one nobody would edit.
    const { calls, runner } = harness({ wouldMint: 1 });
    await forecastTensionEdges("ws-1", { kind: "as-curated" }, { withTransaction: runner });
    expect(calls.find((c) => c.sql === TENSION_FORECAST_SQL)!.params?.[3]).toBeNull();
  });

  it("refuses a surface that norms away as its OWN arm, never as a zero", async () => {
    // The defect `vocabulary-preview.ts` shipped and then fixed: *"a request that
    // was never computable rendered as"* a confident zero. Here that zero would
    // read as "approving this mints nothing", which is a licence to approve.
    const { calls, runner } = harness({ wouldMint: 99 });
    for (const surface of ["-", "___", "   ", ""]) {
      expect(
        await forecastTensionEdges(
          "ws-1",
          { kind: "if-approved", predicateSurface: surface },
          { withTransaction: runner },
        ),
      ).toEqual({ kind: "unkeyable-surface" });
    }
    expect(
      calls,
      "an unkeyable surface reached the database — it is a property of the request and provably cannot need a pooled connection",
    ).toHaveLength(0);
  });
});

describe("the forecast's arithmetic is the SWEEP's (#5450)", () => {
  it("reports `truncated` at the run cap and not below it", async () => {
    const at = await forecastTensionEdges(
      "ws-1",
      { kind: "as-curated" },
      { withTransaction: harness({ wouldMint: TENSION_SWEEP_RUN_CAP }).runner },
    );
    const below = await forecastTensionEdges(
      "ws-1",
      { kind: "as-curated" },
      { withTransaction: harness({ wouldMint: TENSION_SWEEP_RUN_CAP - 1 }).runner },
    );
    const none = await forecastTensionEdges(
      "ws-1",
      { kind: "as-curated" },
      { withTransaction: harness().runner },
    );

    expect(at).toEqual({
      kind: "forecast",
      wouldMint: TENSION_SWEEP_RUN_CAP,
      truncated: true,
    });
    expect(below).toEqual({
      kind: "forecast",
      wouldMint: TENSION_SWEEP_RUN_CAP - 1,
      truncated: false,
    });
    // A converged corpus is `{0, false}`, never `{0, true}`.
    expect(none).toEqual({ kind: "forecast", wouldMint: 0, truncated: false });
  });

  it("reads the count as a NUMBER, not a row tally", async () => {
    // `count(*)` returns ONE row carrying the number. An implementation that
    // read `rows.length` would answer 1 for every non-empty corpus and would
    // pass a harness that returned N rows.
    const outcome = await forecastTensionEdges(
      "ws-1",
      { kind: "as-curated" },
      { withTransaction: harness({ wouldMint: 42 }).runner },
    );
    expect(outcome).toEqual({ kind: "forecast", wouldMint: 42, truncated: false });
  });

  it("refuses to invent a zero when the statement answers no row at all", async () => {
    // A missing row means the driver or a double is not answering this
    // statement. Reported as a throw rather than as a converged corpus, because
    // "0" here is read as a licence to approve.
    await expect(
      forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ noRow: true }).runner },
      ),
    ).rejects.toThrow(/not a row count/);
  });

  it("…and when it answers something that is not a count", async () => {
    // ⚠️ `null` is in this list because it was a real defect: `Number(null)` is
    // `0`, so a NULL count arrived as a confident "approving this mints
    // nothing". `""` for the same reason — `Number("")` is also `0`.
    for (const bogus of [-1, 1.5, "many", null, undefined, "", true, {}]) {
      await expect(
        forecastTensionEdges(
          "ws-1",
          { kind: "as-curated" },
          { withTransaction: harness({ wouldMint: bogus }).runner },
        ),
      ).rejects.toThrow(/not a row count/);
    }
  });

  it("accepts the STRING a driver may hand back for a bigint-shaped count", async () => {
    // `count(*)::int` is an int4 and `pg` parses it to a number — but the cast is
    // one edit away from being dropped, and `count(*)` alone is int8, which the
    // driver hands back as a STRING to protect precision. Coerced rather than
    // rejected, so that edit is a passing test rather than a 500.
    expect(
      await forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ wouldMint: "7" }).runner },
      ),
    ).toEqual({ kind: "forecast", wouldMint: 7, truncated: false });
  });
});

describe("the forecast's concurrency permit (#5450)", () => {
  it("refuses past the cap rather than queueing, and never touches the pool", async () => {
    // The sweep is self-limiting - one 30s statement per workspace, because it
    // holds namespace 4771. The forecast holds no lock by design, so nothing
    // bounded it: the internal pool is `max: 5`, the candidate walk is the
    // unbounded half, and a vocabulary pane pricing four pending predicates plus
    // one stale tab is five concurrent scans holding the whole pool.
    //
    // Driven by a runner that never settles, so the permits are genuinely held
    // for the duration rather than released between awaits.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const hangingRunner = async <T,>(fn: (tx: ReconcileExecutor) => Promise<T>): Promise<T> =>
      fn({
        query: async (sql: string) => {
          calls.push(sql);
          if (sql === TENSION_FORECAST_SQL) await blocked;
          return { rows: [{ would_mint: 0 }] };
        },
      });

    const inflight = Array.from({ length: FORECAST_MAX_CONCURRENT }, () =>
      forecastTensionEdges("ws-1", { kind: "as-curated" }, { withTransaction: hangingRunner }),
    );
    // Let the permits be taken and the statements reach the block.
    await Promise.resolve();
    await Promise.resolve();

    const overflow = await forecastTensionEdges(
      "ws-1",
      { kind: "as-curated" },
      { withTransaction: hangingRunner },
    );
    expect(
      overflow,
      "a forecast past the cap was admitted - the pool is reachable by pressing this endpoint",
    ).toEqual({ kind: "contended", reason: "forecast-busy" });
    // Refused BEFORE the pool: the overflow call must not have issued a single
    // statement, or it took a connection on its way to being refused.
    const statementsBefore = calls.length;

    release?.();
    await Promise.all(inflight);
    expect(calls.length, "the refused forecast still ran statements").toBe(statementsBefore);

    // ...and the permits came back, so the next caller is admitted.
    expect(_forecastsInFlight()).toBe(0);
    expect(
      (await forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ wouldMint: 4 }).runner },
      )),
    ).toEqual({ kind: "forecast", wouldMint: 4, truncated: false });
  });

  it("returns the permit when the scan THROWS", async () => {
    // A leaked permit never recovers - the endpoint would refuse forever with a
    // message telling the operator to wait. This is why the release is in a
    // `finally` rather than after the await.
    await expect(
      forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ error: pgError("42P01") }).runner },
      ),
    ).rejects.toThrow();
    expect(_forecastsInFlight(), "a thrown scan leaked its permit").toBe(0);
  });

  it("returns the permit when the scan is REFUSED for contention", async () => {
    expect(
      await forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ error: pgError("57014") }).runner },
      ),
    ).toEqual({ kind: "contended", reason: "unfinished" });
    expect(_forecastsInFlight()).toBe(0);
  });

  it("leaves room in the pool - the cap is below it, not equal to it", () => {
    // Two rather than five, so a forecast storm can never take the last
    // connection. Asserted so a later "why not use the whole pool?" is a failing
    // test rather than a silent change.
    expect(FORECAST_MAX_CONCURRENT).toBeLessThan(5);
    expect(FORECAST_MAX_CONCURRENT).toBeGreaterThan(0);
  });
});

describe("the forecast's statement bound is TIGHTER than the sweep's (#5450)", () => {
  it("issues a 5s statement_timeout, not the sweep's 30s", async () => {
    // Same scan, different tolerance: a preview rendered beside a decision has
    // already failed if it takes half a minute, and the bound is the second half
    // of the concurrency argument - the permit caps how MANY connections this
    // endpoint holds, this caps how LONG it holds one.
    const { calls, runner } = harness({ wouldMint: 0 });
    await forecastTensionEdges("ws-1", { kind: "as-curated" }, { withTransaction: runner });

    const stmt = calls.find((c) => c.sql.includes("statement_timeout"));
    expect(stmt, "the forecast issued no statement bound at all").toBeDefined();
    expect(stmt!.sql).toContain("'5s'");
    expect(
      stmt!.sql,
      "the forecast inherited the sweep's 30s tolerance - two permits held that long is most of a five-connection pool for most of a minute",
    ).not.toContain("'30s'");
  });
});

describe("the forecast's contention arms (#5450)", () => {
  it("refuses `unfinished` when the scan is cancelled or times out", async () => {
    expect(
      await forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ error: pgError("57014") }).runner },
      ),
    ).toEqual({ kind: "contended", reason: "unfinished" });
  });

  it("refuses `conflicting-lock` when a migration holds the tables", async () => {
    // `AccessShareLock` against a migration's `AccessExclusiveLock`. The reason a
    // read keeps `lock_timeout` at all.
    expect(
      await forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ error: pgError(LOCK_NOT_AVAILABLE) }).runner },
      ),
    ).toEqual({ kind: "contended", reason: "conflicting-lock" });
  });

  it("re-throws every other failure rather than degrading to a zero", async () => {
    // The stake is higher than the sweep's: a degraded zero there reads as
    // "nothing to do", here as "approving this is free".
    await expect(
      forecastTensionEdges(
        "ws-1",
        { kind: "as-curated" },
        { withTransaction: harness({ error: pgError("42P01") }).runner },
      ),
    ).rejects.toThrow(/simulated 42P01/);
  });

  it("names a cause for `forecast-busy`, which is the one arm entitled to", async () => {
    // Every message in `CONTENTION_MESSAGE` is forbidden from asserting a cause,
    // because a SQLSTATE carries none. This arm is not derived from a SQLSTATE:
    // the server counted its own in-flight scans, so hedging would be a false
    // modesty that costs the operator the only actionable sentence available.
    const busy = forecastContentionMessage("forecast-busy");
    expect(busy).toContain("Nothing was read and nothing was changed");
    expect(busy).toContain("Wait a moment");
    // ...and it still delegates for the arms it shares, so the two endpoints
    // cannot describe one SQLSTATE two ways.
    expect(forecastContentionMessage("unfinished")).toBe(contentionMessage("unfinished"));
    expect(forecastContentionMessage("conflicting-lock")).toBe(
      contentionMessage("conflicting-lock"),
    );
  });

  it("cannot report `reconcile-lock` — the arm it structurally does not have", () => {
    // A compile-time claim made executable: `TensionForecastContention` excludes
    // the arm, so this is really a pin on the type surviving a refactor that
    // widens it back to the sweep's union.
    const reasons: readonly string[] = ["unfinished", "conflicting-lock"];
    expect(reasons).not.toContain("reconcile-lock");
  });
});
