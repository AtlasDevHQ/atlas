/**
 * Unit tests for the Stripe webhook event ledger (#3423).
 *
 * The classify→process→record protocol itself is exercised end-to-end in
 * stripe-webhook-lifecycle.test.ts; this file pins the per-function
 * contracts: SQL shapes/params, the no-internal-DB bypass, and the
 * throw-on-failure discipline that makes `onEvent` durable (a swallowed
 * ledger error would re-create the silent-loss bug).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([]));
let hasDb = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => hasDb,
  }),
}));

const {
  classifyStripeEvent,
  recordStripeEvent,
  pruneStripeEventLedger,
  STRIPE_EVENT_LEDGER_RETENTION_DAYS,
} = await import("../stripe-event-ledger");

const EVENT = {
  id: "evt_1",
  type: "customer.subscription.updated",
  created: 1_750_000_000,
  stripeSubscriptionId: "sub_1",
};

beforeEach(() => {
  hasDb = true;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

describe("classifyStripeEvent", () => {
  it("returns fresh when neither the id nor a newer same-subscription event is recorded", async () => {
    await expect(classifyStripeEvent(EVENT)).resolves.toBe("fresh");
    // Two probes: dedup by event id, then ordering by subscription id.
    expect(mockInternalQuery).toHaveBeenCalledTimes(2);
    const [dupSql, dupParams] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(dupSql).toContain("WHERE event_id = $1");
    expect(dupParams).toEqual(["evt_1"]);
    const [staleSql, staleParams] = mockInternalQuery.mock.calls[1] as [string, unknown[]];
    expect(staleSql).toContain("event_created > $2");
    expect(staleParams).toEqual(["sub_1", new Date(EVENT.created * 1000).toISOString()]);
  });

  it("returns duplicate when the event id is already recorded (replay)", async () => {
    mockInternalQuery.mockImplementation((sql) =>
      Promise.resolve(sql.includes("WHERE event_id = $1") ? [{ event_id: "evt_1" }] : []),
    );
    await expect(classifyStripeEvent(EVENT)).resolves.toBe("duplicate");
  });

  it("returns stale when a newer event for the same subscription was already applied", async () => {
    mockInternalQuery.mockImplementation((sql) =>
      Promise.resolve(sql.includes("event_created > $2") ? [{ event_id: "evt_newer" }] : []),
    );
    await expect(classifyStripeEvent(EVENT)).resolves.toBe("stale");
  });

  it("skips the ordering probe for events with no subscription scope", async () => {
    await expect(
      classifyStripeEvent({ ...EVENT, stripeSubscriptionId: null }),
    ).resolves.toBe("fresh");
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });

  it("returns fresh without querying when there is no internal DB", async () => {
    hasDb = false;
    await expect(classifyStripeEvent(EVENT)).resolves.toBe("fresh");
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("propagates ledger query failures (onEvent must 400 so Stripe retries)", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg down")));
    await expect(classifyStripeEvent(EVENT)).rejects.toThrow("pg down");
  });
});

describe("recordStripeEvent", () => {
  it("inserts the event with ON CONFLICT DO NOTHING (idempotent)", async () => {
    await recordStripeEvent(EVENT);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO stripe_webhook_events");
    expect(sql).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(params).toEqual([
      "evt_1",
      "customer.subscription.updated",
      new Date(EVENT.created * 1000).toISOString(),
      "sub_1",
    ]);
  });

  it("is a no-op without an internal DB", async () => {
    hasDb = false;
    await recordStripeEvent(EVENT);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("propagates insert failures", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg down")));
    await expect(recordStripeEvent(EVENT)).rejects.toThrow("pg down");
  });
});

describe("pruneStripeEventLedger", () => {
  it("deletes rows past the default retention and returns the count", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ event_id: "evt_a" }, { event_id: "evt_b" }]),
    );
    await expect(pruneStripeEventLedger()).resolves.toBe(2);
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("DELETE FROM stripe_webhook_events");
    expect(params).toEqual([String(STRIPE_EVENT_LEDGER_RETENTION_DAYS)]);
  });

  it("returns 0 without an internal DB", async () => {
    hasDb = false;
    await expect(pruneStripeEventLedger()).resolves.toBe(0);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
