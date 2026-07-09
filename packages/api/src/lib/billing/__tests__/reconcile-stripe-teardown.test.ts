/**
 * Unit tests for the Stripe teardown outbox sweep (#3679).
 *
 * The sweep drains `stripe_teardown_pending`, retrying each op until success
 * or `resource_missing`. Covers:
 *   - cancel-fails-then-sweep-succeeds (the headline durability guarantee)
 *   - GDPR purge customer-delete retry
 *   - resource_missing → resolved (target already gone)
 *   - non-terminal failure → attempts bumped, row kept
 *   - no Stripe / no internal DB → clean no-op
 *   - internal-DB failure propagates so the scheduler tick retries
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// ── In-memory outbox the mocked internalQuery operates over ─────────

interface StoredRow {
  id: string;
  workspace_id: string;
  stripe_sub_id: string | null;
  stripe_customer_id: string | null;
  op: string;
  attempts: number;
}
let store: StoredRow[] = [];
let hasDb = true;

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    const p = params ?? [];
    const trimmed = sql.trimStart();
    // Order matters: DELETE/UPDATE statements also contain
    // "FROM stripe_teardown_pending", so match the verb first.
    if (trimmed.startsWith("DELETE")) {
      store = store.filter((r) => r.id !== String(p[0]));
      return [];
    }
    if (trimmed.startsWith("UPDATE")) {
      const row = store.find((r) => r.id === String(p[0]));
      if (row) row.attempts += 1;
      return [];
    }
    if (trimmed.startsWith("SELECT")) {
      // SELECT … ORDER BY attempts ASC, created_at ASC LIMIT $1
      return [...store].sort((a, b) => a.attempts - b.attempts).slice(0, Number(p[0]));
    }
    return [];
  },
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => hasDb,
  }),
}));

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
};
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  setLogLevel: () => false,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  hashShareToken: (token: string) => token,
}));

// ── Mocked Stripe client ────────────────────────────────────────────

const subscriptionsCancel: Mock<(id: string) => Promise<unknown>> = mock(async (id: string) => ({
  id,
  status: "canceled",
}));
const customersDel: Mock<(id: string) => Promise<unknown>> = mock(async (id: string) => ({
  id,
  deleted: true,
}));
let stripeAvailable = true;
void mock.module("@atlas/api/lib/billing/stripe-client", () => ({
  getStripeClient: () =>
    stripeAvailable
      ? { subscriptions: { cancel: subscriptionsCancel }, customers: { del: customersDel } }
      : null,
  _resetStripeClientCache: () => {},
}));

// Real `isStripeResourceMissing` (a pure predicate) is imported transitively
// by the sweep — NOT mocked, so the resource_missing branch is exercised
// end-to-end.
const { sweepStripeTeardownPending } = await import("../reconcile-stripe-teardown");

class FakeStripeError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

function cancelRow(id: string, subId: string, attempts = 0): StoredRow {
  return {
    id,
    workspace_id: "org-acme",
    stripe_sub_id: subId,
    stripe_customer_id: "cus_acme",
    op: "cancel_subscription",
    attempts,
  };
}
function customerRow(id: string, customerId: string, attempts = 0): StoredRow {
  return {
    id,
    workspace_id: "org-acme",
    stripe_sub_id: null,
    stripe_customer_id: customerId,
    op: "delete_customer",
    attempts,
  };
}

beforeEach(() => {
  store = [];
  hasDb = true;
  stripeAvailable = true;
  mockInternalQuery.mockClear();
  subscriptionsCancel.mockReset();
  subscriptionsCancel.mockImplementation(async (id: string) => ({ id, status: "canceled" }));
  customersDel.mockReset();
  customersDel.mockImplementation(async (id: string) => ({ id, deleted: true }));
});

describe("sweepStripeTeardownPending", () => {
  it("no-ops without an internal DB", async () => {
    hasDb = false;
    await expect(sweepStripeTeardownPending()).resolves.toEqual({ scanned: 0, resolved: 0, failed: 0 });
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("no-ops when Stripe is not configured", async () => {
    stripeAvailable = false;
    store = [cancelRow("r1", "sub_1")];
    await expect(sweepStripeTeardownPending()).resolves.toEqual({ scanned: 0, resolved: 0, failed: 0 });
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("cancels a pending subscription and removes the row", async () => {
    store = [cancelRow("r1", "sub_1")];

    const result = await sweepStripeTeardownPending();

    expect(subscriptionsCancel).toHaveBeenCalledWith("sub_1");
    expect(result).toEqual({ scanned: 1, resolved: 1, failed: 0 });
    expect(store).toEqual([]); // row removed
  });

  it("deletes a pending Stripe customer and removes the row (GDPR purge retry)", async () => {
    store = [customerRow("r1", "cus_acme")];

    const result = await sweepStripeTeardownPending();

    expect(customersDel).toHaveBeenCalledWith("cus_acme");
    expect(result).toEqual({ scanned: 1, resolved: 1, failed: 0 });
    expect(store).toEqual([]);
  });

  it("cancel-fails-then-sweep-succeeds: keeps + bumps the row on failure, removes it once it succeeds", async () => {
    store = [cancelRow("r1", "sub_flaky")];
    subscriptionsCancel.mockImplementationOnce(async () => {
      throw new FakeStripeError("stripe 503");
    });

    // First pass: Stripe is down → row kept, attempts bumped.
    const first = await sweepStripeTeardownPending();
    expect(first).toEqual({ scanned: 1, resolved: 0, failed: 1 });
    expect(store).toHaveLength(1);
    expect(store[0].attempts).toBe(1);

    // Second pass: Stripe recovers → cancel succeeds, row removed.
    const second = await sweepStripeTeardownPending();
    expect(second).toEqual({ scanned: 1, resolved: 1, failed: 0 });
    expect(store).toEqual([]);
  });

  it("treats resource_missing as resolved and removes the row (target already gone)", async () => {
    store = [cancelRow("r1", "sub_gone")];
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("No such subscription", "resource_missing");
    });

    const result = await sweepStripeTeardownPending();

    expect(result).toEqual({ scanned: 1, resolved: 1, failed: 0 });
    expect(store).toEqual([]);
  });

  it("keeps a row failing for a non-terminal reason, bumping its attempts", async () => {
    store = [cancelRow("r1", "sub_1"), customerRow("r2", "cus_1")];
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("rate_limited");
    });
    customersDel.mockImplementation(async () => {
      throw new FakeStripeError("api_error");
    });

    const result = await sweepStripeTeardownPending();

    expect(result).toEqual({ scanned: 2, resolved: 0, failed: 2 });
    expect(store).toHaveLength(2);
    expect(store.every((r) => r.attempts === 1)).toBe(true);
  });

  it("drops a malformed row instead of retrying a no-op forever", async () => {
    store = [
      { id: "bad", workspace_id: "o", stripe_sub_id: null, stripe_customer_id: null, op: "cancel_subscription", attempts: 0 },
    ];

    const result = await sweepStripeTeardownPending();

    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(result.resolved).toBe(1);
    expect(store).toEqual([]);
  });

  it("requests a bounded batch ordered by attempts", async () => {
    store = [cancelRow("r1", "sub_1")];
    await sweepStripeTeardownPending();
    const [sql, params] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ORDER BY attempts ASC");
    expect(sql).toContain("LIMIT $1");
    expect(typeof params[0]).toBe("number");
  });

  it("propagates an internal-DB read failure so the scheduler tick retries", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM stripe_teardown_pending")) throw new Error("pg down");
      return [];
    });
    await expect(sweepStripeTeardownPending()).rejects.toThrow("pg down");
  });
});
