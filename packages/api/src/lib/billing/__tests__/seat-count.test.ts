/**
 * Tests for the shared seat-count source (#3430).
 *
 * The per-seat token budget is read on three surfaces — enforcement,
 * GET /billing, GET /admin/usage/summary — that must agree on "seats" or the
 * usage page advertises a budget the 429 threshold doesn't enforce. This pins
 * the helper's contract: live count on success, last-known value on a transient
 * blip, explicit failure (never a silent collapse to 1 seat) when nothing is
 * known.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Mocks ---

/** Rows the `internalQuery` mock returns for the seat-count query. */
let mockSeatRows: unknown[] = [];
/** When true, the `internalQuery` mock throws (DB blip path). */
let mockSeatQueryShouldThrow = false;

void mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: async () => {
    if (mockSeatQueryShouldThrow) throw new Error("db error");
    return mockSeatRows;
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Import under test ---

import {
  getSeatCount,
  SeatCountUnavailableError,
  _resetSeatCountCache,
} from "@atlas/api/lib/billing/seat-count";

describe("getSeatCount", () => {
  beforeEach(() => {
    mockSeatRows = [];
    mockSeatQueryShouldThrow = false;
    _resetSeatCountCache();
  });

  it("returns the live member count on success", async () => {
    mockSeatRows = [{ count: 10 }];
    expect(await getSeatCount("org-1")).toBe(10);
  });

  it("serves the last-known value when a later query fails (no collapse to 1)", async () => {
    mockSeatRows = [{ count: 10 }];
    expect(await getSeatCount("org-1")).toBe(10);

    // Transient DB blip — must NOT shrink the budget to 1 seat.
    mockSeatQueryShouldThrow = true;
    expect(await getSeatCount("org-1")).toBe(10);
  });

  it("throws SeatCountUnavailableError when the query fails with no last-known value", async () => {
    mockSeatQueryShouldThrow = true;
    await expect(getSeatCount("org-cold")).rejects.toBeInstanceOf(SeatCountUnavailableError);
  });

  it("treats an empty result as a lookup failure rather than 0 seats", async () => {
    mockSeatRows = [];
    await expect(getSeatCount("org-empty")).rejects.toBeInstanceOf(SeatCountUnavailableError);
  });

  it("falls back to last-known value when a later query returns an empty result", async () => {
    mockSeatRows = [{ count: 7 }];
    expect(await getSeatCount("org-1")).toBe(7);

    mockSeatRows = [];
    expect(await getSeatCount("org-1")).toBe(7);
  });

  it("keeps last-known values per organization", async () => {
    mockSeatRows = [{ count: 3 }];
    expect(await getSeatCount("org-a")).toBe(3);
    mockSeatRows = [{ count: 12 }];
    expect(await getSeatCount("org-b")).toBe(12);

    // A blip serves each org its own last-known value.
    mockSeatQueryShouldThrow = true;
    expect(await getSeatCount("org-a")).toBe(3);
    expect(await getSeatCount("org-b")).toBe(12);
  });

  it("refreshes the live count when the query recovers", async () => {
    mockSeatRows = [{ count: 4 }];
    expect(await getSeatCount("org-1")).toBe(4);
    mockSeatRows = [{ count: 9 }];
    expect(await getSeatCount("org-1")).toBe(9);
  });
});
