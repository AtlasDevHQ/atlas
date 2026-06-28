/**
 * Tests for billing-period resolution (#3431).
 *
 * Covers:
 *   - `startOfMonthUTC` / `endOfMonthUTC` boundary + rollover semantics.
 *   - `resolveBillingPeriod`: Stripe anchoring for active subscriptions,
 *     UTC calendar-month fallback for trial / past_due / unsubscribed /
 *     no-DB, and missing-bounds degradation.
 *   - A TZ-offset server must not shift the UTC-month boundary by its
 *     local offset (set via process.env.TZ — `??=` hoist per testing
 *     rules, no top-level reassignment of an existing var).
 */

// A non-UTC server timezone is the whole point of the regression: if the
// month math read local fields the boundary would shift by the offset.
// `??=` so we never clobber a TZ the CI runner already pinned.
process.env.TZ ??= "America/Los_Angeles";

import { describe, it, expect, beforeEach, mock } from "bun:test";

// --- Internal DB mock ---

let mockHasInternalDB = true;
let mockQueryShouldThrow = false;
let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: unknown[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async (sql: string, params?: unknown[]) => {
    if (mockQueryShouldThrow) throw new Error("relation \"subscription\" does not exist");
    queryCalls.push({ sql, params });
    const result = queryResults.shift();
    return result ?? [];
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import {
  startOfMonthUTC,
  endOfMonthUTC,
  resolveBillingPeriod,
} from "@atlas/api/lib/billing/period";

describe("billing/period", () => {
  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    mockHasInternalDB = true;
    mockQueryShouldThrow = false;
  });

  describe("startOfMonthUTC / endOfMonthUTC", () => {
    it("truncates to the first of the UTC month at 00:00:00.000Z", () => {
      const now = new Date("2026-06-25T18:30:00.000Z");
      expect(startOfMonthUTC(now).toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(endOfMonthUTC(now).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    });

    it("rolls December → January of the next year", () => {
      const now = new Date("2026-12-15T00:00:00.000Z");
      expect(startOfMonthUTC(now).toISOString()).toBe("2026-12-01T00:00:00.000Z");
      expect(endOfMonthUTC(now).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("does NOT shift the boundary by the server's local TZ offset", () => {
      // 2026-06-01T03:00:00Z is still May 31 in America/Los_Angeles. A
      // local-field implementation would bucket this into May; UTC keeps
      // it in June.
      const justAfterUtcMonthStart = new Date("2026-06-01T03:00:00.000Z");
      expect(startOfMonthUTC(justAfterUtcMonthStart).toISOString()).toBe(
        "2026-06-01T00:00:00.000Z",
      );
    });
  });

  describe("resolveBillingPeriod", () => {
    it("anchors on an active subscription's Stripe period", async () => {
      const periodStart = new Date("2026-05-25T00:00:00.000Z");
      const periodEnd = new Date("2026-06-25T00:00:00.000Z");
      queryResults = [[{ periodStart, periodEnd }]];

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-10T00:00:00.000Z"),
      );

      expect(period.source).toBe("stripe");
      expect(period.start.toISOString()).toBe(periodStart.toISOString());
      expect(period.end.toISOString()).toBe(periodEnd.toISOString());
      // Only active rows anchor.
      expect(queryCalls[0]?.sql).toContain("status = 'active'");
    });

    it("accepts ISO-string period columns (pg may hand back strings)", async () => {
      queryResults = [[
        { periodStart: "2026-05-25T00:00:00.000Z", periodEnd: "2026-06-25T00:00:00.000Z" },
      ]];

      const period = await resolveBillingPeriod("org-1", new Date("2026-06-10T00:00:00.000Z"));

      expect(period.source).toBe("stripe");
      expect(period.start.toISOString()).toBe("2026-05-25T00:00:00.000Z");
      expect(period.end.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    });

    it("falls back to the UTC calendar month when no active subscription exists", async () => {
      queryResults = [[]]; // trialing/past_due/canceled/unsubscribed all filtered out

      const period = await resolveBillingPeriod(
        "org-trial",
        new Date("2026-06-10T18:00:00.000Z"),
      );

      expect(period.source).toBe("utc-month");
      expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(period.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    });

    it("falls back to the UTC month when the active period is STALE (now past periodEnd)", async () => {
      // Renewal webhook lag: the stored bounds still describe the previous
      // cycle, and `now` has advanced past `periodEnd`. Anchoring here would
      // window usage over a dead past range → 0 usage + under-counted budget.
      const periodStart = new Date("2026-04-25T00:00:00.000Z");
      const periodEnd = new Date("2026-05-25T00:00:00.000Z");
      queryResults = [[{ periodStart, periodEnd }]];

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-10T00:00:00.000Z"), // a full cycle past periodEnd
      );

      expect(period.source).toBe("utc-month");
      expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(period.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    });

    it("falls back to the UTC month when now is BEFORE the active period start", async () => {
      // Defensive symmetry: a future-dated period would otherwise window over
      // a range that doesn't yet contain `now`.
      queryResults = [[
        { periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z" },
      ]];

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-10T00:00:00.000Z"),
      );

      expect(period.source).toBe("utc-month");
      expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    });

    it("anchors when now is exactly at periodStart (inclusive lower bound)", async () => {
      queryResults = [[
        { periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-07-01T00:00:00.000Z" },
      ]];

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-01T00:00:00.000Z"),
      );

      expect(period.source).toBe("stripe");
    });

    it("falls back when the active row is missing period bounds", async () => {
      queryResults = [[{ periodStart: null, periodEnd: null }]];

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-10T00:00:00.000Z"),
      );

      expect(period.source).toBe("utc-month");
      expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    });

    it("falls back without querying when no internal DB is configured", async () => {
      mockHasInternalDB = false;

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-10T00:00:00.000Z"),
      );

      expect(period.source).toBe("utc-month");
      expect(queryCalls).toHaveLength(0);
    });

    it("falls back (not throws) when the subscription table read fails", async () => {
      mockQueryShouldThrow = true;

      const period = await resolveBillingPeriod(
        "org-1",
        new Date("2026-06-10T00:00:00.000Z"),
      );

      expect(period.source).toBe("utc-month");
      expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    });

    // The proactive quota module's month-boundary agreement with billing
    // (it re-exports `startOfMonthUTC` from this module) is now asserted on
    // the EE side, next to the relocated quota impl
    // (`ee/src/proactive/__tests__/quota.test.ts`, #3999) — keeping this
    // core billing test free of an `@atlas/ee` import so the ee-stub build
    // (which replaces `ee/` with a minimal stub) still type-checks.
  });
});
