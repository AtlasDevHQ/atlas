/**
 * Stripe billing teardown tests (#3425).
 *
 * Drives the four workspace-lifecycle teardown helpers against a mocked
 * Stripe client + mocked internal DB:
 *   - delete  → cancels every non-terminal subscription
 *   - purge   → cancels subscriptions AND deletes the Stripe customer(s)
 *   - suspend → pauses collection (`pause_collection: { behavior: "void" }`)
 *   - unsuspend → resumes collection (clears `pause_collection`)
 *   - Stripe failure → helper returns (never throws), warning surfaced, logged
 *   - resource_missing → treated as already-gone (action, not warning)
 *   - no Stripe configured / no internal DB → clean no-op
 *   - subscription table missing (42P01) → no subscriptions, no warning
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// ── Mockable state ──────────────────────────────────────────────────

let hasDB = true;
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([]));

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => hasDB,
  }),
}));

// Logger spy — failure paths must log, not silently swallow.
const mockLogError = mock((..._args: unknown[]) => {});
const stubLogger = {
  info: () => {},
  warn: () => {},
  error: mockLogError,
  debug: () => {},
  fatal: () => {},
  trace: () => {},
};
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  setLogLevel: () => false,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  hashShareToken: (token: string) => token,
}));

// ── Mocked Stripe client ────────────────────────────────────────────

/** Records call order across the stub so ordering can be asserted. */
let callOrder: string[] = [];

const subscriptionsCancel: Mock<(id: string) => Promise<unknown>> = mock(
  async (id: string) => {
    callOrder.push(`cancel:${id}`);
    return { id, status: "canceled" };
  },
);
const subscriptionsUpdate: Mock<(id: string, params: Record<string, unknown>) => Promise<unknown>> =
  mock(async (id: string, _params: Record<string, unknown>) => {
    callOrder.push(`update:${id}`);
    return { id };
  });
const customersDel: Mock<(id: string) => Promise<unknown>> = mock(async (id: string) => {
  callOrder.push(`customer.del:${id}`);
  return { id, deleted: true };
});

/** Open invoices returned by `invoices.list` per subscription id (#3467). */
let openInvoices: Record<string, string[]> = {};

const invoicesList: Mock<(params: Record<string, unknown>) => Promise<unknown>> = mock(
  async (params: Record<string, unknown>) => {
    callOrder.push(`invoices.list:${String(params.subscription)}`);
    const ids = openInvoices[String(params.subscription)] ?? [];
    return { data: ids.map((id) => ({ id, status: "open" })) };
  },
);
const invoicesVoid: Mock<(id: string) => Promise<unknown>> = mock(async (id: string) => {
  callOrder.push(`invoices.void:${id}`);
  return { id, status: "void" };
});

let stripeAvailable = true;
function makeStripeStub() {
  return {
    subscriptions: { cancel: subscriptionsCancel, update: subscriptionsUpdate },
    customers: { del: customersDel },
    invoices: { list: invoicesList, voidInvoice: invoicesVoid },
  };
}

mock.module("@atlas/api/lib/billing/stripe-client", () => ({
  getStripeClient: () => (stripeAvailable ? makeStripeStub() : null),
  _resetStripeClientCache: () => {},
}));

const {
  cancelStripeSubscriptionsForWorkspace,
  purgeStripeBillingForWorkspace,
  pauseStripeCollectionForWorkspace,
  resumeStripeCollectionForWorkspace,
} = await import("../workspace-teardown");

// ── Fixtures ────────────────────────────────────────────────────────

const ORG = "org-acme";

function subRow(
  id: string,
  status: string,
  customerId: string | null = "cus_acme",
): Record<string, unknown> {
  return { stripeSubscriptionId: id, stripeCustomerId: customerId, status };
}

function mockSubscriptionRows(rows: Record<string, unknown>[]): void {
  mockInternalQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM subscription")) return rows;
    return [];
  });
}

class FakeStripeError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

beforeEach(() => {
  hasDB = true;
  stripeAvailable = true;
  callOrder = [];
  openInvoices = {};
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  subscriptionsCancel.mockClear();
  subscriptionsUpdate.mockClear();
  customersDel.mockClear();
  invoicesList.mockClear();
  invoicesVoid.mockClear();
  mockLogError.mockClear();
  // Restore default success implementations after failure-path tests.
  subscriptionsCancel.mockImplementation(async (id: string) => {
    callOrder.push(`cancel:${id}`);
    return { id, status: "canceled" };
  });
  subscriptionsUpdate.mockImplementation(async (id: string, _params: Record<string, unknown>) => {
    callOrder.push(`update:${id}`);
    return { id };
  });
  customersDel.mockImplementation(async (id: string) => {
    callOrder.push(`customer.del:${id}`);
    return { id, deleted: true };
  });
  invoicesList.mockImplementation(async (params: Record<string, unknown>) => {
    callOrder.push(`invoices.list:${String(params.subscription)}`);
    const ids = openInvoices[String(params.subscription)] ?? [];
    return { data: ids.map((id) => ({ id, status: "open" })) };
  });
  invoicesVoid.mockImplementation(async (id: string) => {
    callOrder.push(`invoices.void:${id}`);
    return { id, status: "void" };
  });
});

// ── Delete: cancel subscriptions ────────────────────────────────────

describe("cancelStripeSubscriptionsForWorkspace (delete path)", () => {
  it("cancels every non-terminal subscription", async () => {
    mockSubscriptionRows([subRow("sub_1", "active"), subRow("sub_2", "trialing")]);

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome.attempted).toBe(true);
    expect(subscriptionsCancel.mock.calls.map((c) => c[0])).toEqual(["sub_1", "sub_2"]);
    expect(outcome.actions).toHaveLength(2);
    expect(outcome.warnings).toEqual([]);
  });

  it("skips rows already terminal in the local subscription table", async () => {
    mockSubscriptionRows([
      subRow("sub_live", "active"),
      subRow("sub_done", "canceled"),
      subRow("sub_dead", "incomplete_expired"),
    ]);

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(subscriptionsCancel.mock.calls.map((c) => c[0])).toEqual(["sub_live"]);
    expect(outcome.warnings).toEqual([]);
  });

  it("surfaces a warning (and logs) when Stripe cancel fails — never throws", async () => {
    mockSubscriptionRows([subRow("sub_boom", "active")]);
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("stripe is down");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome.attempted).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("sub_boom");
    expect(outcome.warnings[0]).toContain("stripe is down");
    expect(mockLogError).toHaveBeenCalled();
  });

  it("treats resource_missing as already-gone (action, not warning)", async () => {
    mockSubscriptionRows([subRow("sub_gone", "active")]);
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("No such subscription", "resource_missing");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome.warnings).toEqual([]);
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0]).toContain("already absent");
  });

  it("no-ops cleanly when Stripe is not configured", async () => {
    stripeAvailable = false;
    mockSubscriptionRows([subRow("sub_1", "active")]);

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome).toEqual({ attempted: false, actions: [], warnings: [] });
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("no-ops cleanly when there is no internal DB", async () => {
    hasDB = false;

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome).toEqual({ attempted: false, actions: [], warnings: [] });
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("treats a missing subscription table (42P01) as no subscriptions", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new FakeStripeError('relation "subscription" does not exist', "42P01");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome).toEqual({ attempted: true, actions: [], warnings: [] });
  });

  it("surfaces a warning when the subscription read fails for a real reason", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection refused");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("connection refused");
    expect(mockLogError).toHaveBeenCalled();
  });
});

// ── Purge: cancel + delete customer ─────────────────────────────────

describe("purgeStripeBillingForWorkspace (GDPR purge path)", () => {
  it("cancels remaining subscriptions then deletes the Stripe customer", async () => {
    mockSubscriptionRows([subRow("sub_1", "active", "cus_acme")]);

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_acme");

    expect(outcome.attempted).toBe(true);
    expect(subscriptionsCancel).toHaveBeenCalledTimes(1);
    expect(customersDel).toHaveBeenCalledTimes(1);
    expect(customersDel.mock.calls[0][0]).toBe("cus_acme");
    // Ordering: subscription cancel BEFORE customer deletion.
    expect(callOrder).toEqual(["cancel:sub_1", "customer.del:cus_acme"]);
    expect(outcome.warnings).toEqual([]);
  });

  it("deletes the customer even when all subscriptions are already terminal", async () => {
    mockSubscriptionRows([subRow("sub_old", "canceled", "cus_acme")]);

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_acme");

    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(customersDel.mock.calls.map((c) => c[0])).toEqual(["cus_acme"]);
    expect(outcome.warnings).toEqual([]);
  });

  it("unions customer ids from the org column and subscription rows", async () => {
    mockSubscriptionRows([subRow("sub_old", "canceled", "cus_drifted")]);

    await purgeStripeBillingForWorkspace(ORG, "cus_org");

    expect(customersDel.mock.calls.map((c) => c[0]).toSorted()).toEqual([
      "cus_drifted",
      "cus_org",
    ]);
  });

  it("makes no customer call when there is no Stripe customer linkage", async () => {
    mockSubscriptionRows([]);

    const outcome = await purgeStripeBillingForWorkspace(ORG, null);

    expect(outcome.attempted).toBe(true);
    expect(customersDel).not.toHaveBeenCalled();
    expect(outcome.warnings).toEqual([]);
  });

  it("surfaces a warning (and logs) when customer deletion fails — purge proceeds", async () => {
    mockSubscriptionRows([]);
    customersDel.mockImplementation(async () => {
      throw new FakeStripeError("api_error");
    });

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_acme");

    expect(outcome.attempted).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("cus_acme");
    expect(mockLogError).toHaveBeenCalled();
  });

  it("treats a resource_missing customer as already-gone", async () => {
    mockSubscriptionRows([]);
    customersDel.mockImplementation(async () => {
      throw new FakeStripeError("No such customer", "resource_missing");
    });

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_gone");

    expect(outcome.warnings).toEqual([]);
    expect(outcome.actions.some((a) => a.includes("already absent"))).toBe(true);
  });

  it("no-ops cleanly when Stripe is not configured", async () => {
    stripeAvailable = false;

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_acme");

    expect(outcome).toEqual({ attempted: false, actions: [], warnings: [] });
    expect(customersDel).not.toHaveBeenCalled();
  });
});

// ── Suspend / unsuspend: pause / resume collection ──────────────────

describe("pause/resumeStripeCollectionForWorkspace (suspend policy)", () => {
  it("suspend pauses collection with behavior: void", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(outcome.attempted).toBe(true);
    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(subscriptionsUpdate.mock.calls[0][0]).toBe("sub_1");
    expect(subscriptionsUpdate.mock.calls[0][1]).toEqual({
      pause_collection: { behavior: "void" },
    });
    expect(outcome.warnings).toEqual([]);
  });

  it("unsuspend clears pause_collection", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);

    const outcome = await resumeStripeCollectionForWorkspace(ORG);

    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(subscriptionsUpdate.mock.calls[0][1]).toEqual({ pause_collection: "" });
    expect(outcome.warnings).toEqual([]);
  });

  it("skips terminal subscriptions", async () => {
    mockSubscriptionRows([subRow("sub_done", "canceled")]);

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ attempted: true, actions: [], warnings: [] });
  });

  it("surfaces a warning (and logs) when the pause fails — suspend proceeds", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    subscriptionsUpdate.mockImplementation(async () => {
      throw new FakeStripeError("rate_limited");
    });

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(outcome.attempted).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("sub_1");
    expect(mockLogError).toHaveBeenCalled();
  });

  it("no-ops cleanly when Stripe is not configured", async () => {
    stripeAvailable = false;

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(outcome).toEqual({ attempted: false, actions: [], warnings: [] });
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });
});

// ── Suspend: void invoices already open at pause time (#3467) ───────

describe("pauseStripeCollectionForWorkspace — voids open invoices (#3467)", () => {
  it("voids every open invoice on the paused subscription, after the pause", async () => {
    mockSubscriptionRows([subRow("sub_1", "past_due")]);
    openInvoices = { sub_1: ["in_1", "in_2"] };

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(invoicesVoid.mock.calls.map((c) => c[0])).toEqual(["in_1", "in_2"]);
    // Pause lands before the invoice sweep for the same subscription.
    expect(callOrder.indexOf("update:sub_1")).toBeLessThan(callOrder.indexOf("invoices.void:in_1"));
    expect(outcome.actions.filter((a) => a.includes("voided open invoice"))).toHaveLength(2);
    expect(outcome.warnings).toEqual([]);
  });

  it("resume never touches invoices — voiding is terminal, next cycle bills fresh", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    openInvoices = { sub_1: ["in_1"] };

    await resumeStripeCollectionForWorkspace(ORG);

    expect(invoicesList).not.toHaveBeenCalled();
    expect(invoicesVoid).not.toHaveBeenCalled();
  });

  it("surfaces a warning (and logs) when the invoice list fails — pause stands", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    invoicesList.mockImplementation(async () => {
      throw new FakeStripeError("api_error");
    });

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(outcome.actions.some((a) => a.includes("paused collection"))).toBe(true);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("list open invoices");
    expect(mockLogError).toHaveBeenCalled();
  });

  it("surfaces a per-invoice warning when a void fails — other invoices still voided", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    openInvoices = { sub_1: ["in_bad", "in_ok"] };
    invoicesVoid.mockImplementation(async (id: string) => {
      if (id === "in_bad") throw new FakeStripeError("invoice_locked");
      callOrder.push(`invoices.void:${id}`);
      return { id, status: "void" };
    });

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain("in_bad");
    expect(outcome.actions.some((a) => a.includes("in_ok"))).toBe(true);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("treats a resource_missing invoice as already-gone (action, not warning)", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    openInvoices = { sub_1: ["in_gone"] };
    invoicesVoid.mockImplementation(async () => {
      throw new FakeStripeError("No such invoice", "resource_missing");
    });

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(outcome.warnings).toEqual([]);
    expect(outcome.actions.some((a) => a.includes("already absent"))).toBe(true);
  });

  it("skips the invoice sweep when the pause itself failed", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    subscriptionsUpdate.mockImplementation(async () => {
      throw new FakeStripeError("rate_limited");
    });

    await pauseStripeCollectionForWorkspace(ORG);

    expect(invoicesList).not.toHaveBeenCalled();
    expect(invoicesVoid).not.toHaveBeenCalled();
  });
});
