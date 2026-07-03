/**
 * Tests for `runPeriodicDbCycle` (#4195) — the shared scan → guard → forEach →
 * tally → audit skeleton the BYOT + OpenAPI-rediscover jobs build on. The two
 * jobs exercise it transitively, but this suite pins the fail-soft contract
 * (`E = never`: a bad tick can never kill the enclosing `registerPeriodicFiber`
 * repeat loop) at the seam, independent of any caller — including the sync
 * callbacks (`tally`, `emitCycleAudit`) whose throws are guarded to a logged
 * error rather than a fiber-killing defect.
 *
 * `hasInternalDB` is the only `db/internal` export the module imports, so a
 * one-symbol mock is sufficient here (no partial-mock strand).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import type { createLogger } from "@atlas/api/lib/logger";
// Type-only — erased at runtime, so it does not load the module before the mock.
import type { PeriodicDbCycleSpec } from "../periodic-db-job";

let dbAvailable = true;
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => dbAvailable,
}));

const { runPeriodicDbCycle } = await import("../periodic-db-job");

// A silent logger cast to the pino shape — the skeleton only calls info/error,
// and this keeps pino (and its dev-mode worker transport) out of the test.
type Logger = ReturnType<typeof createLogger>;
const silentLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
} as unknown as Logger;

interface FakeResult {
  status: "success" | "failure";
  inspected: number;
  ok: number;
  failed: number;
  error?: string;
}
type FakeRow = { id: number };
type FakeOutcome = { kind: "ok" } | { kind: "fail"; error: string };

interface Recorder {
  scanCalls: number;
  tallied: Array<{ row: FakeRow; outcome: FakeOutcome }>;
  audits: FakeResult[];
}

function makeSpec(
  rec: Recorder,
  overrides: Partial<PeriodicDbCycleSpec<FakeRow, FakeOutcome, FakeResult>>,
): PeriodicDbCycleSpec<FakeRow, FakeOutcome, FakeResult> {
  return {
    log: silentLog,
    label: "Fake job",
    emptyResult: () => ({ status: "success", inspected: 0, ok: 0, failed: 0 }),
    failureResult: (error) => ({ status: "failure", inspected: 0, ok: 0, failed: 0, error }),
    scan: async () => {
      rec.scanCalls++;
      return [];
    },
    applyRow: async () => ({ kind: "ok" }),
    defectOutcome: (error) => ({ kind: "fail", error }),
    tally: (result, row, outcome) => {
      rec.tallied.push({ row, outcome });
      if (outcome.kind === "ok") result.ok++;
      else result.failed++;
    },
    emitCycleAudit: (result) => {
      rec.audits.push({ ...result });
    },
    ...overrides,
  };
}

function freshRecorder(): Recorder {
  return { scanCalls: 0, tallied: [], audits: [] };
}

beforeEach(() => {
  dbAvailable = true;
});
afterEach(() => {
  dbAvailable = true;
});

describe("runPeriodicDbCycle", () => {
  it("no internal DB → zeroed success + one cycle audit, and never scans", async () => {
    dbAvailable = false;
    const rec = freshRecorder();
    const result = await Effect.runPromise(runPeriodicDbCycle(makeSpec(rec, {})));

    expect(result).toEqual({ status: "success", inspected: 0, ok: 0, failed: 0 });
    expect(rec.scanCalls).toBe(0);
    expect(rec.tallied).toHaveLength(0);
    expect(rec.audits).toEqual([{ status: "success", inspected: 0, ok: 0, failed: 0 }]);
  });

  it("scan rejection → failure result carrying the error + one cycle audit, no tally", async () => {
    const rec = freshRecorder();
    const spec = makeSpec(rec, {
      scan: async () => {
        rec.scanCalls++;
        throw new Error("boom-scan");
      },
    });
    const result = await Effect.runPromise(runPeriodicDbCycle(spec));

    expect(result.status).toBe("failure");
    expect(result.error).toBe("boom-scan");
    expect(rec.tallied).toHaveLength(0);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]?.status).toBe("failure");
  });

  it("empty working set → zeroed success + one cycle audit, no tally", async () => {
    const rec = freshRecorder();
    const result = await Effect.runPromise(runPeriodicDbCycle(makeSpec(rec, {})));

    expect(result).toEqual({ status: "success", inspected: 0, ok: 0, failed: 0 });
    expect(rec.scanCalls).toBe(1);
    expect(rec.tallied).toHaveLength(0);
    expect(rec.audits).toHaveLength(1);
  });

  it("populated set → stamps inspected, tallies every row once, one final audit", async () => {
    const rec = freshRecorder();
    const rows: FakeRow[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const spec = makeSpec(rec, {
      scan: async () => {
        rec.scanCalls++;
        return rows;
      },
      applyRow: async (row) => (row.id === 2 ? { kind: "fail", error: "row-2" } : { kind: "ok" }),
    });
    const result = await Effect.runPromise(runPeriodicDbCycle(spec));

    expect(result.inspected).toBe(3);
    expect(result.ok).toBe(2);
    expect(result.failed).toBe(1);
    expect(rec.tallied.map((t) => t.row.id)).toEqual([1, 2, 3]);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]?.inspected).toBe(3);
  });

  it("per-row apply rejection is folded via defectOutcome and counted — the loop survives", async () => {
    const rec = freshRecorder();
    const spec = makeSpec(rec, {
      scan: async () => [{ id: 1 }, { id: 2 }],
      applyRow: async (row) => {
        if (row.id === 1) throw new Error("kaboom");
        return { kind: "ok" };
      },
    });
    const result = await Effect.runPromise(runPeriodicDbCycle(spec));

    // Row 1's rejection → defectOutcome({ kind: "fail" }) → counted; row 2 still runs.
    expect(result.inspected).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.ok).toBe(1);
    expect(rec.tallied[0]?.outcome).toEqual({ kind: "fail", error: "kaboom" });
  });

  it("a throwing tally callback is guarded — the cycle finishes and still audits (no fiber-killing defect)", async () => {
    const rec = freshRecorder();
    const spec = makeSpec(rec, {
      scan: async () => [{ id: 1 }, { id: 2 }],
      tally: (result, row, outcome) => {
        rec.tallied.push({ row, outcome });
        if (row.id === 1) throw new Error("tally-boom");
        result.ok++;
      },
    });

    // Must resolve (not reject) — a throw in tally would otherwise defect the
    // fiber; the skeleton catches it, logs, and moves on.
    const result = await Effect.runPromise(runPeriodicDbCycle(spec));

    expect(result.inspected).toBe(2);
    expect(rec.tallied).toHaveLength(2); // both rows attempted despite row 1 throwing
    expect(rec.audits).toHaveLength(1); // cycle still completed + audited
  });
});
