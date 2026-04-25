/**
 * F-77 — unit tests for the per-conversation step cap helpers.
 *
 * Pins the load-bearing branches in `reserveConversationBudget` and
 * `settleConversationSteps`:
 *
 *   - Atomic gate (UPDATE WHERE total_steps < cap) — no overshoot
 *     under concurrent reservations.
 *   - "Row missing" vs "row at cap" disambiguation when the UPDATE
 *     returns 0 rows.
 *   - Fail-open contract on internal-DB unavailability and read errors.
 *   - Settlement refund clamps and is a no-op when no refund is owed.
 *
 * Tests stub the internal DB at the module level so they don't require
 * a live Postgres.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

const internalQueryMock = mock(
  (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]),
);
const internalExecuteMock = mock((..._args: unknown[]): void => {});
let hasInternalDBValue = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => hasInternalDBValue,
  internalQuery: internalQueryMock,
  internalExecute: internalExecuteMock,
}));

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const {
  reserveConversationBudget,
  settleConversationSteps,
  _resetConversationBudgetWarnState,
} = await import("../conversations");

describe("reserveConversationBudget — F-77 atomic gate", () => {
  beforeEach(() => {
    internalQueryMock.mockReset();
    internalExecuteMock.mockReset();
    hasInternalDBValue = true;
    _resetConversationBudgetWarnState();
  });

  it("returns no_db when the internal DB is not configured", async () => {
    hasInternalDBValue = false;
    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("no_db");
    expect(internalQueryMock).not.toHaveBeenCalled();
  });

  it("short-circuits with ok when stepBudget is zero or negative", async () => {
    let result = await reserveConversationBudget("c1", 0, 100);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.totalStepsBefore).toBe(0);

    result = await reserveConversationBudget("c1", -5, 100);
    expect(result.status).toBe("ok");

    expect(internalQueryMock).not.toHaveBeenCalled();
  });

  it("short-circuits with ok when cap is zero or negative (gate disabled)", async () => {
    let result = await reserveConversationBudget("c1", 25, 0);
    expect(result.status).toBe("ok");

    result = await reserveConversationBudget("c1", 25, -1);
    expect(result.status).toBe("ok");

    expect(internalQueryMock).not.toHaveBeenCalled();
  });

  it("issues a single atomic UPDATE that gates on total_steps < cap", async () => {
    internalQueryMock.mockResolvedValueOnce([{ before: 50 }]);

    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.totalStepsBefore).toBe(50);

    expect(internalQueryMock).toHaveBeenCalledTimes(1);
    const calls = internalQueryMock.mock.calls as unknown as unknown[][];
    const sql = calls[0][0] as string;
    // The atomic gate is the load-bearing detail — pin it.
    expect(sql).toContain("UPDATE conversations");
    expect(sql).toContain("total_steps < $3");
    expect(sql).toContain("RETURNING total_steps - $2 AS before");
    expect(calls[0][1]).toEqual(["c1", 25, 100]);
  });

  // TOCTOU pin: chat.ts verifies the conversation exists before
  // calling reserve. If both UPDATE and follow-up SELECT come back
  // empty, the row vanished between auth check and reservation.
  // This MUST NOT return `ok` — settlement on a non-charge would
  // corrupt total_steps. Returns `error` so the caller fails open
  // visibly, with a logged warn.
  it("returns error when UPDATE and follow-up SELECT both return 0 rows (TOCTOU)", async () => {
    internalQueryMock.mockResolvedValueOnce([]); // UPDATE returned no rows
    internalQueryMock.mockResolvedValueOnce([]); // SELECT also empty — row vanished

    const result = await reserveConversationBudget("c-new", 25, 100);
    expect(result.status).toBe("error");
  });

  it("returns exceeded when UPDATE returns 0 rows AND the row exists at/over cap", async () => {
    internalQueryMock.mockResolvedValueOnce([]); // UPDATE returned no rows
    internalQueryMock.mockResolvedValueOnce([{ total_steps: 100 }]); // row exists at cap

    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("exceeded");
    if (result.status === "exceeded") expect(result.totalSteps).toBe(100);
  });

  it("returns exceeded when total_steps comes back as a string (numeric coercion)", async () => {
    internalQueryMock.mockResolvedValueOnce([]);
    internalQueryMock.mockResolvedValueOnce([{ total_steps: "150" }]);

    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("exceeded");
    if (result.status === "exceeded") expect(result.totalSteps).toBe(150);
  });

  // Race pin: a concurrent reservation can settle just before our
  // UPDATE runs, freeing capacity. The UPDATE matches 0 rows but a
  // follow-up SELECT shows total_steps below the cap. We can't tell
  // whether our row was charged — return `error` (fail-open with a
  // logged warn) rather than `ok` (which would imply a charge that
  // didn't happen). Same protection as the TOCTOU branch.
  it("returns error when UPDATE returns 0 rows but the row is below cap (concurrent race)", async () => {
    internalQueryMock.mockResolvedValueOnce([]); // UPDATE returned no rows
    internalQueryMock.mockResolvedValueOnce([{ total_steps: 50 }]); // below cap of 100

    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("error");
  });

  it("fails open with status=error when the UPDATE throws", async () => {
    internalQueryMock.mockRejectedValueOnce(new Error("connection lost"));

    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("error");
  });

  it("coerces non-numeric `before` from the UPDATE response to 0", async () => {
    internalQueryMock.mockResolvedValueOnce([{ before: "not a number" }]);

    const result = await reserveConversationBudget("c1", 25, 100);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.totalStepsBefore).toBe(0);
  });
});

describe("settleConversationSteps — F-77 refund", () => {
  beforeEach(() => {
    internalQueryMock.mockReset();
    internalExecuteMock.mockReset();
    hasInternalDBValue = true;
  });

  it("skips the write when the internal DB is not configured", () => {
    hasInternalDBValue = false;
    settleConversationSteps("c1", 25, 5);
    expect(internalExecuteMock).not.toHaveBeenCalled();
  });

  it("skips when actual >= reserved (no refund owed)", () => {
    settleConversationSteps("c1", 25, 25);
    settleConversationSteps("c1", 25, 30);
    expect(internalExecuteMock).not.toHaveBeenCalled();
  });

  it("skips when reserved or actual is non-finite", () => {
    settleConversationSteps("c1", Number.NaN, 5);
    settleConversationSteps("c1", 25, Number.POSITIVE_INFINITY);
    expect(internalExecuteMock).not.toHaveBeenCalled();
  });

  it("issues UPDATE with GREATEST(0, …) and the correct refund delta", () => {
    settleConversationSteps("c1", 25, 7);

    expect(internalExecuteMock).toHaveBeenCalledTimes(1);
    const calls = internalExecuteMock.mock.calls as unknown as unknown[][];
    const sql = calls[0][0] as string;
    // Pin the GREATEST clamp — keeps the counter from going negative
    // when settlement races with a concurrent reservation.
    expect(sql).toContain("UPDATE conversations");
    expect(sql).toContain("GREATEST(0, total_steps - $1)");
    // Refund = 25 - 7 = 18.
    expect(calls[0][1]).toEqual([18, "c1"]);
  });

  it("clamps negative actual to zero when computing the refund", () => {
    settleConversationSteps("c1", 25, -10);
    const calls = internalExecuteMock.mock.calls as unknown as unknown[][];
    expect(calls[0][1]).toEqual([25, "c1"]);
  });
});
