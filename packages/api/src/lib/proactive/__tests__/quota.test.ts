/**
 * Unit tests for the proactive monthly quota module (#2301).
 *
 * Covers:
 *   - Pure `isOverQuota(count, cap)` truth table
 *   - Pure `startOfMonthUTC(now)` boundary semantics + month rollover
 *   - DB-backed reads via `mock.module("@atlas/api/lib/db/internal")`
 *
 * `mock.module()` factory is intentionally sync (per CLAUDE.md) — the
 * shared helpers are stubbed up-front and each test mutates the
 * captured handles.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — sync factory; handles captured for per-test mutation.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
// Mock signature uses `unknown[]` instead of a generic so per-test
// implementations can return whatever row shape the test needs without
// fighting TS's contravariance over the generic parameter.
const mockInternalQuery: Mock<
  (sql: string, params: unknown[]) => Promise<unknown[]>
> = mock(async () => []);

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => mockHasInternalDB(),
  internalQuery: (sql: string, params: unknown[]) =>
    mockInternalQuery(sql, params),
}));

const quota = await import("../quota");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isOverQuota", () => {
  it("treats null cap as unlimited", () => {
    expect(quota.isOverQuota(0, null)).toBe(false);
    expect(quota.isOverQuota(1_000_000, null)).toBe(false);
  });

  it("treats undefined cap as unlimited", () => {
    expect(quota.isOverQuota(42, undefined)).toBe(false);
  });

  it("returns false when count is below cap", () => {
    expect(quota.isOverQuota(49, 50)).toBe(false);
  });

  it("returns true when count equals cap", () => {
    // count >= cap: the 50th classify is the one that flips the gate.
    expect(quota.isOverQuota(50, 50)).toBe(true);
  });

  it("returns true when count exceeds cap", () => {
    expect(quota.isOverQuota(51, 50)).toBe(true);
  });

  it("coerces negative caps to 0 — never silently grants unlimited", () => {
    // Misconfigured row ("-5") must fail closed: every classify is over.
    expect(quota.isOverQuota(0, -5)).toBe(true);
    expect(quota.isOverQuota(0, -1)).toBe(true);
  });

  it("cap = 0 stops the very first classify", () => {
    expect(quota.isOverQuota(0, 0)).toBe(true);
  });
});

describe("startOfMonthUTC", () => {
  it("snaps mid-month timestamps to the 1st at 00:00 UTC", () => {
    const out = quota.startOfMonthUTC(new Date(Date.UTC(2026, 4, 14, 13, 30)));
    expect(out.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("preserves the month boundary itself", () => {
    const out = quota.startOfMonthUTC(new Date(Date.UTC(2026, 4, 1, 0, 0)));
    expect(out.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("rolls over cleanly at month end", () => {
    // 2026-05-31 23:59:59 UTC → still May.
    const may = quota.startOfMonthUTC(
      new Date(Date.UTC(2026, 4, 31, 23, 59, 59)),
    );
    expect(may.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    // 2026-06-01 00:00:00 UTC → now June.
    const june = quota.startOfMonthUTC(new Date(Date.UTC(2026, 5, 1, 0, 0, 0)));
    expect(june.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("handles year boundaries", () => {
    const out = quota.startOfMonthUTC(new Date(Date.UTC(2027, 0, 5, 6, 0)));
    expect(out.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// DB-backed reads
// ---------------------------------------------------------------------------

describe("getMonthlyClassifierCap", () => {
  beforeEach(() => {
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockClear();
  });

  afterEach(() => {
    mockInternalQuery.mockClear();
  });

  it("returns null when the internal DB is unavailable", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    expect(await quota.getMonthlyClassifierCap("ws-1")).toBeNull();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns null when no row exists", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    expect(await quota.getMonthlyClassifierCap("ws-1")).toBeNull();
  });

  it("returns the row's cap when present", async () => {
    mockInternalQuery.mockImplementation(async () => [
      { monthly_classifier_cap: 1000 },
    ]);
    expect(await quota.getMonthlyClassifierCap("ws-1")).toBe(1000);
  });

  it("returns null for an explicit null column", async () => {
    mockInternalQuery.mockImplementation(async () => [
      { monthly_classifier_cap: null },
    ]);
    expect(await quota.getMonthlyClassifierCap("ws-1")).toBeNull();
  });
});

describe("getClassifyCountThisMonth", () => {
  beforeEach(() => {
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockClear();
  });

  it("returns 0 when the internal DB is unavailable", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    expect(await quota.getClassifyCountThisMonth("ws-1")).toBe(0);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns 0 when no rows exist", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    expect(await quota.getClassifyCountThisMonth("ws-1")).toBe(0);
  });

  it("coerces BIGINT-as-string return shape from pg", async () => {
    mockInternalQuery.mockImplementation(async () => [{ count: "42" }]);
    expect(await quota.getClassifyCountThisMonth("ws-1")).toBe(42);
  });

  it("accepts numeric COUNT shape (mocks / non-pg backends)", async () => {
    mockInternalQuery.mockImplementation(async () => [{ count: 7 }]);
    expect(await quota.getClassifyCountThisMonth("ws-1")).toBe(7);
  });

  it("passes the start-of-month cutoff to the SQL", async () => {
    mockInternalQuery.mockImplementation(async () => [{ count: 0 }]);
    const now = new Date(Date.UTC(2026, 4, 17, 9, 0));
    await quota.getClassifyCountThisMonth("ws-1", now);
    const params = mockInternalQuery.mock.calls[0]![1];
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("getWorkspaceQuotaStatus", () => {
  beforeEach(() => {
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockClear();
  });

  it("returns capReached=false when cap is null (unlimited)", async () => {
    // Two queries; cap then count. Use the SQL prefix to route.
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("monthly_classifier_cap")) {
        return [{ monthly_classifier_cap: null }];
      }
      return [{ count: 12345 }];
    });
    const out = await quota.getWorkspaceQuotaStatus("ws-1");
    expect(out.monthlyClassifierCap).toBeNull();
    expect(out.classifyCountThisMonth).toBe(12345);
    expect(out.capReached).toBe(false);
  });

  it("flips capReached when count >= cap", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("monthly_classifier_cap")) {
        return [{ monthly_classifier_cap: 50 }];
      }
      return [{ count: 50 }];
    });
    const out = await quota.getWorkspaceQuotaStatus("ws-1");
    expect(out.classifyCountThisMonth).toBe(50);
    expect(out.monthlyClassifierCap).toBe(50);
    expect(out.capReached).toBe(true);
  });

  it("fails open on DB error — logs but returns capReached=false (+ readFailed:true for observability)", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("internal db unreachable");
    });
    const out = await quota.getWorkspaceQuotaStatus("ws-1");
    // Post-1.5.0 polish: snapshot adds `readFailed: true` so the
    // listener can emit a `classify` meter row tagged `quota-read-failed`
    // — the bypass surfaces in the analytics rollup even though the
    // cap isn't enforced for this request.
    expect(out).toEqual({
      monthlyClassifierCap: null,
      classifyCountThisMonth: 0,
      capReached: false,
      readFailed: true,
    });
  });
});
