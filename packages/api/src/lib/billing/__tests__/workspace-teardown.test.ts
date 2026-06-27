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

/** Live Stripe subscriptions returned by `subscriptions.list` per customer id
 *  for drift detection (#3679). Default empty — only drift tests populate it. */
let liveStripeSubs: Record<string, { id: string; status: string; customer?: string }[]> = {};
const subscriptionsList: Mock<(params: Record<string, unknown>) => Promise<unknown>> = mock(
  async (params: Record<string, unknown>) => {
    callOrder.push(`subscriptions.list:${String(params.customer)}`);
    const subs = liveStripeSubs[String(params.customer)] ?? [];
    return { data: subs, has_more: false };
  },
);

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
    subscriptions: { cancel: subscriptionsCancel, update: subscriptionsUpdate, list: subscriptionsList },
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

/** Rows captured by the outbox INSERT — pins durable persistence (#3679). */
interface EnqueuedOp {
  workspaceId: string;
  op: string;
  stripeSubId: string | null;
  stripeCustomerId: string | null;
  lastError: string | null;
}

/**
 * Route `mockInternalQuery` so `FROM subscription` returns `rows` and the
 * outbox INSERTs are captured into `enqueued`. Returns the capture array.
 */
function captureOutbox(rows: Record<string, unknown>[]): EnqueuedOp[] {
  const enqueued: EnqueuedOp[] = [];
  mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM subscription")) return rows;
    if (sql.includes("INSERT INTO stripe_teardown_pending")) {
      const p = params ?? [];
      if (sql.includes("'cancel_subscription'")) {
        enqueued.push({
          workspaceId: String(p[0]),
          op: "cancel_subscription",
          stripeSubId: (p[1] as string | null) ?? null,
          stripeCustomerId: (p[2] as string | null) ?? null,
          lastError: (p[3] as string | null) ?? null,
        });
      } else {
        enqueued.push({
          workspaceId: String(p[0]),
          op: "delete_customer",
          stripeSubId: null,
          stripeCustomerId: (p[1] as string | null) ?? null,
          lastError: (p[2] as string | null) ?? null,
        });
      }
    }
    return [];
  });
  return enqueued;
}

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
  liveStripeSubs = {};
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  subscriptionsCancel.mockClear();
  subscriptionsUpdate.mockClear();
  subscriptionsList.mockClear();
  customersDel.mockClear();
  invoicesList.mockClear();
  invoicesVoid.mockClear();
  mockLogError.mockClear();
  subscriptionsList.mockImplementation(async (params: Record<string, unknown>) => {
    callOrder.push(`subscriptions.list:${String(params.customer)}`);
    const subs = liveStripeSubs[String(params.customer)] ?? [];
    return { data: subs, has_more: false };
  });
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

  it("unions extraCustomerIds (e.g. a user-level customer) into the delete set", async () => {
    // The org column is null (the #4011 shape: customer lives on user.stripeCustomerId,
    // organization."stripeCustomerId" is null). The user-level id passed via
    // extraCustomerIds must still be deleted so a verify teardown can't orphan it.
    mockSubscriptionRows([]);

    await purgeStripeBillingForWorkspace(ORG, null, ["cus_user"]);

    expect(customersDel.mock.calls.map((c) => c[0])).toEqual(["cus_user"]);
  });

  it("de-dupes extraCustomerIds already present from the org column or subscriptions", async () => {
    mockSubscriptionRows([subRow("sub_old", "canceled", "cus_acme")]);

    // cus_acme appears on both the org column and extraCustomerIds — deleted once.
    await purgeStripeBillingForWorkspace(ORG, "cus_acme", ["cus_acme", "cus_user"]);

    expect(customersDel.mock.calls.map((c) => c[0]).toSorted()).toEqual([
      "cus_acme",
      "cus_user",
    ]);
  });

  it("deletes BOTH a distinct org customer and a distinct user customer (true union)", async () => {
    // Org acquired its own customer while the signup user-level one persisted —
    // both distinct ids must be deleted, not just one.
    mockSubscriptionRows([]);

    await purgeStripeBillingForWorkspace(ORG, "cus_org", ["cus_user"]);

    expect(customersDel.mock.calls.map((c) => c[0]).toSorted()).toEqual([
      "cus_org",
      "cus_user",
    ]);
  });

  it("treats a resource_missing on an extraCustomerIds id as already-gone (multi-org re-pass is safe)", async () => {
    // The multi-org fan-out re-passes the same user customer to each owned org's
    // purge; the 2nd+ delete hits resource_missing and must be an action, not a warning.
    mockSubscriptionRows([]);
    customersDel.mockImplementation(async () => {
      throw new FakeStripeError("No such customer", "resource_missing");
    });

    const outcome = await purgeStripeBillingForWorkspace(ORG, null, ["cus_user"]);

    expect(outcome.warnings).toEqual([]);
    expect(outcome.actions.some((a) => a.includes("already absent"))).toBe(true);
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

  it("pages through ALL open invoices, not just the first page (#3475 review)", async () => {
    mockSubscriptionRows([subRow("sub_1", "active")]);
    // Two pages: the first reports has_more, the second closes it out.
    let call = 0;
    invoicesList.mockImplementation(async (params: Record<string, unknown>) => {
      callOrder.push(`invoices.list:${String(params.subscription)}`);
      call += 1;
      if (call === 1) {
        return {
          data: [{ id: "in_p1a", status: "open" }, { id: "in_p1b", status: "open" }],
          has_more: true,
        };
      }
      return { data: [{ id: "in_p2a", status: "open" }], has_more: false };
    });

    const outcome = await pauseStripeCollectionForWorkspace(ORG);

    expect(invoicesList).toHaveBeenCalledTimes(2);
    // Second page request is anchored on the last id of the first page.
    expect((invoicesList.mock.calls[1][0] as Record<string, unknown>).starting_after).toBe("in_p1b");
    expect(invoicesVoid.mock.calls.map((c) => c[0])).toEqual(["in_p1a", "in_p1b", "in_p2a"]);
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

// ── Durable teardown outbox: persist failed ops for retry (#3679) ───

describe("durable teardown outbox (#3679)", () => {
  it("persists a failed cancel to the outbox (cancel-fails → enqueue → swept later)", async () => {
    const enqueued = captureOutbox([subRow("sub_boom", "active", "cus_acme")]);
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("stripe is down");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG, "cus_acme");

    // Warning still surfaced (legacy fallback), AND the op is durable.
    expect(outcome.warnings).toHaveLength(1);
    expect(enqueued).toEqual([
      {
        workspaceId: ORG,
        op: "cancel_subscription",
        stripeSubId: "sub_boom",
        stripeCustomerId: "cus_acme",
        lastError: "stripe is down",
      },
    ]);
  });

  it("does NOT enqueue a resource_missing cancel (already gone, nothing to retry)", async () => {
    const enqueued = captureOutbox([subRow("sub_gone", "active")]);
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("No such subscription", "resource_missing");
    });

    await cancelStripeSubscriptionsForWorkspace(ORG, "cus_acme");

    expect(enqueued).toEqual([]);
  });

  it("does NOT enqueue when every cancel succeeds", async () => {
    const enqueued = captureOutbox([subRow("sub_1", "active"), subRow("sub_2", "active")]);

    await cancelStripeSubscriptionsForWorkspace(ORG, "cus_acme");

    expect(enqueued).toEqual([]);
  });

  it("GDPR purge: persists a failed customer delete to the outbox for retry", async () => {
    const enqueued = captureOutbox([]);
    customersDel.mockImplementation(async () => {
      throw new FakeStripeError("api_error");
    });

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_acme");

    expect(outcome.warnings).toHaveLength(1);
    expect(enqueued).toEqual([
      {
        workspaceId: ORG,
        op: "delete_customer",
        stripeSubId: null,
        stripeCustomerId: "cus_acme",
        lastError: "api_error",
      },
    ]);
  });

  it("falls back to a warning when the outbox INSERT itself fails — never throws", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM subscription")) return [subRow("sub_boom", "active")];
      if (sql.includes("INSERT INTO stripe_teardown_pending")) {
        throw new Error("internal db down");
      }
      return [];
    });
    subscriptionsCancel.mockImplementation(async () => {
      throw new FakeStripeError("stripe is down");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG, "cus_acme");

    // The cancel-failure warning PLUS the persistence-failure fallback warning.
    expect(outcome.attempted).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("automatic retry"))).toBe(true);
    expect(mockLogError).toHaveBeenCalled();
  });
});

// ── Drift detection: zero local rows but a live Stripe customer (#3679) ─

describe("drift detection — zero local rows but a live customer (#3679)", () => {
  it("queries Stripe and enqueues live subscriptions found with no local record", async () => {
    const enqueued = captureOutbox([]); // no local subscription rows
    liveStripeSubs = {
      cus_drift: [
        { id: "sub_live_a", status: "active" },
        { id: "sub_live_b", status: "trialing" },
      ],
    };

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG, "cus_drift");

    expect(subscriptionsList).toHaveBeenCalledTimes(1);
    expect(enqueued.map((e) => e.stripeSubId).toSorted()).toEqual(["sub_live_a", "sub_live_b"]);
    expect(enqueued.every((e) => e.op === "cancel_subscription")).toBe(true);
    // A warning surfaces the drift rather than silently no-op'ing.
    expect(outcome.warnings.some((w) => w.includes("no local record"))).toBe(true);
  });

  it("skips terminal Stripe subscriptions during drift detection", async () => {
    const enqueued = captureOutbox([]);
    liveStripeSubs = {
      cus_drift: [
        { id: "sub_live", status: "active" },
        { id: "sub_done", status: "canceled" },
      ],
    };

    await cancelStripeSubscriptionsForWorkspace(ORG, "cus_drift");

    expect(enqueued.map((e) => e.stripeSubId)).toEqual(["sub_live"]);
  });

  it("does NOT query Stripe for drift when an ACTIVE local row exists", async () => {
    captureOutbox([subRow("sub_1", "active")]);

    await cancelStripeSubscriptionsForWorkspace(ORG, "cus_acme");

    expect(subscriptionsList).not.toHaveBeenCalled();
  });

  it("detects drift when local rows are all terminal (a stale canceled row is no protection)", async () => {
    // Local table holds only a terminal row, but Stripe has a live sub the
    // webhook never synced — the literal-empty guard would have missed this.
    const enqueued = captureOutbox([subRow("sub_old", "canceled")]);
    liveStripeSubs = { cus_drift: [{ id: "sub_live", status: "active" }] };

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG, "cus_drift");

    expect(subscriptionsList).toHaveBeenCalledTimes(1);
    expect(enqueued.map((e) => e.stripeSubId)).toEqual(["sub_live"]);
    expect(outcome.warnings.some((w) => w.includes("no local record"))).toBe(true);
  });

  it("does NOT query Stripe for drift when no customer id is supplied", async () => {
    captureOutbox([]);

    await cancelStripeSubscriptionsForWorkspace(ORG);

    expect(subscriptionsList).not.toHaveBeenCalled();
  });

  it("surfaces a warning (and logs) when the drift query itself fails — never throws", async () => {
    captureOutbox([]);
    subscriptionsList.mockImplementation(async () => {
      throw new FakeStripeError("stripe list down");
    });

    const outcome = await cancelStripeSubscriptionsForWorkspace(ORG, "cus_drift");

    expect(outcome.attempted).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("Could not check Stripe"))).toBe(true);
    expect(mockLogError).toHaveBeenCalled();
  });

  it("GDPR purge: detects drift, enqueues the live sub, AND still deletes the customer", async () => {
    const enqueued = captureOutbox([]); // local table drifted empty
    liveStripeSubs = { cus_drift: [{ id: "sub_orphan", status: "active" }] };

    const outcome = await purgeStripeBillingForWorkspace(ORG, "cus_drift");

    expect(enqueued.some((e) => e.op === "cancel_subscription" && e.stripeSubId === "sub_orphan")).toBe(true);
    // Customer is still deleted — a purge must leave no billable linkage.
    expect(customersDel.mock.calls.map((c) => c[0])).toEqual(["cus_drift"]);
    expect(outcome.warnings.some((w) => w.includes("no local record"))).toBe(true);
  });
});
