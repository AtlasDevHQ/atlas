/**
 * Webhook-lifecycle tests for the Stripe billing plugin wiring (#3416).
 *
 * These drive a REAL Better Auth instance (memory adapter) configured with
 * the REAL production plugin options ({@link buildStripePluginOptions})
 * against a mocked Stripe client, then POST synthetic webhook events to
 * `/api/auth/stripe/webhook`. This closes the gap noted in
 * dispatch-conversion-crm-stamp.test.ts: the hooks are no longer
 * untestable closures — the referenceId→orgId contract is exercised
 * end-to-end (event → plugin handler → Atlas hook → plan-tier write).
 *
 * Covered:
 *   - config shape: org mode on, authorizeReference defined (regression
 *     guard — removing either silently reverts to user-scoped subs)
 *   - checkout.session.completed → `updateWorkspacePlanTier(orgId, plan)`
 *   - customer.subscription.deleted → downgrade write for the same orgId
 *   - invoice.payment_failed (attempt 3) → workspace suspended via the
 *     subscription-table referenceId lookup
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, type Mock } from "bun:test";
// NOT createApiTestMocks: the factory also mocks @atlas/api/lib/auth/server,
// which is the unit under test here. buildInternalDbMockDefaults gives the
// same complete db/internal surface (the "Mock all exports" rule) without
// touching the server module.
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// ── Mocks (must precede the server import) ──────────────────────────

const mockUpdateWorkspacePlanTier: Mock<(orgId: string, tier: string) => Promise<boolean>> =
  mock(() => Promise.resolve(true));
const mockUpdateWorkspaceStatus: Mock<(orgId: string, status: string) => Promise<boolean>> =
  mock(() => Promise.resolve(true));
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([]));

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: mockInternalQuery }),
  updateWorkspacePlanTier: mockUpdateWorkspacePlanTier,
  updateWorkspaceStatus: mockUpdateWorkspaceStatus,
}));

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: async () => undefined,
  getEnterpriseRuntime: () => ({ runPromise: async () => undefined }),
  EnterpriseLayer: {},
}));

const { buildStripePluginOptions } = await import("../server");
const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { organization } = await import("better-auth/plugins");
const { stripe: stripePlugin } = await import("@better-auth/stripe");

// ── Stripe client double ────────────────────────────────────────────
//
// `constructEventAsync` echoes the request body back as the event, so each
// test fully controls the webhook payload without computing signatures.

const STARTER_PRICE = "price_starter_test";
const PRO_PRICE = "price_pro_test";

const subscriptionsRetrieve: Mock<(id: string) => Promise<unknown>> = mock(() =>
  Promise.resolve(stripeSubscription()),
);

function makeStripeClient() {
  return {
    webhooks: {
      constructEventAsync: async (payload: string) => JSON.parse(payload),
    },
    subscriptions: {
      retrieve: subscriptionsRetrieve,
      list: mock(() => Promise.resolve({ data: [] })),
    },
    customers: {
      retrieve: mock(() => Promise.resolve({ id: "cus_1", email: "buyer@example.com" })),
      search: mock(() => Promise.resolve({ data: [] })),
      create: mock(() => Promise.resolve({ id: "cus_1" })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe double
  } as any;
}

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  const epoch = Math.floor(Date.now() / 1000);
  return {
    id: "sub_stripe_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    schedule: null,
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_start: epoch,
          current_period_end: epoch + 30 * 86_400,
          price: { id: STARTER_PRICE, recurring: { interval: "month" } },
        },
      ],
    },
    ...overrides,
  };
}

// ── Auth instance with the production plugin options ────────────────

type MemoryDB = Record<string, Record<string, unknown>[]>;

function makeAuth(db: MemoryDB) {
  const options = buildStripePluginOptions({
    stripeClient: makeStripeClient(),
    webhookSecret: "whsec_test",
  });
  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret",
    database: memoryAdapter(db),
    // The organization plugin is present in production (buildPlugins);
    // the stripe plugin's org mode looks it up at init.
    plugins: [organization(), stripePlugin(options)],
  });
}

function emptyDB(): MemoryDB {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    subscription: [],
  };
}

async function postWebhook(
  auth: { handler: (req: Request) => Promise<Response> },
  event: Record<string, unknown>,
) {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "sig_test", "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
}

const ENV_KEYS = ["STRIPE_STARTER_PRICE_ID", "STRIPE_PRO_PRICE_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_STARTER_PRICE_ID = STARTER_PRICE;
  process.env.STRIPE_PRO_PRICE_ID = PRO_PRICE;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  mockUpdateWorkspacePlanTier.mockClear();
  mockUpdateWorkspaceStatus.mockClear();
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  subscriptionsRetrieve.mockClear();
  subscriptionsRetrieve.mockImplementation(() => Promise.resolve(stripeSubscription()));
});

// ── Config-shape regression guard ───────────────────────────────────

describe("buildStripePluginOptions — org-scoped configuration (#3416)", () => {
  it("enables organization mode and defines authorizeReference", () => {
    const options = buildStripePluginOptions({
      stripeClient: makeStripeClient(),
      webhookSecret: "whsec_test",
    });
    expect(options.organization?.enabled).toBe(true);
    expect(options.subscription?.enabled).toBe(true);
    if (options.subscription?.enabled) {
      expect(typeof options.subscription.authorizeReference).toBe("function");
    }
  });
});

// ── getCheckoutSessionParams — user-scoped checkout guard ───────────

describe("getCheckoutSessionParams — org-scope guard", () => {
  function getCallback() {
    const options = buildStripePluginOptions({
      stripeClient: makeStripeClient(),
      webhookSecret: "whsec_test",
    });
    if (!options.subscription?.enabled || !options.subscription.getCheckoutSessionParams) {
      throw new Error("getCheckoutSessionParams missing from plugin options");
    }
    return options.subscription.getCheckoutSessionParams;
  }

  it("throws for a subscription whose referenceId is the calling user (user-scoped checkout)", () => {
    const cb = getCallback();
    expect(() =>
      cb(
        {
          user: { id: "user-1" },
          session: {},
          plan: { name: "starter" },
          subscription: { id: "subrow_1", referenceId: "user-1" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fixtures for the plugin callback
        } as any,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ctx unused by the guard
        {} as any,
      ),
    ).toThrow(/organization-scoped/);
  });

  it("passes org-scoped subscriptions through", () => {
    const cb = getCallback();
    const result = cb(
      {
        user: { id: "user-1" },
        session: {},
        plan: { name: "starter" },
        subscription: { id: "subrow_1", referenceId: "org-1" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fixtures for the plugin callback
      } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ctx unused by the guard
      {} as any,
    );
    expect(result).toEqual({});
  });
});

// ── checkout.session.completed → plan-tier sync ─────────────────────

describe("checkout.session.completed", () => {
  it("updates organization.plan_tier for the org referenceId", async () => {
    const db = emptyDB();
    db.subscription.push({
      id: "subrow_1",
      plan: "starter",
      referenceId: "org-1",
      stripeCustomerId: "cus_1",
      status: "incomplete",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const auth = makeAuth(db);

    const res = await postWebhook(auth, {
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          subscription: "sub_stripe_1",
          client_reference_id: "org-1",
          metadata: { referenceId: "org-1", subscriptionId: "subrow_1", userId: "user-1" },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "starter");
    // The plugin's own row sync ran too: status + stripeSubscriptionId persisted.
    expect(db.subscription[0].status).toBe("active");
    expect(db.subscription[0].stripeSubscriptionId).toBe("sub_stripe_1");
  });
});

// ── customer.subscription.deleted → downgrade ───────────────────────

describe("customer.subscription.deleted", () => {
  it("downgrades the org referenced by the deleted subscription", async () => {
    const db = emptyDB();
    db.subscription.push({
      id: "subrow_1",
      plan: "starter",
      referenceId: "org-1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_stripe_1",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const auth = makeAuth(db);

    const res = await postWebhook(auth, {
      id: "evt_deleted_1",
      type: "customer.subscription.deleted",
      data: { object: stripeSubscription({ status: "canceled" }) },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);
    // Landing tier is "free" today; #3421 moves this to the locked tier.
    const [orgId] = mockUpdateWorkspacePlanTier.mock.calls[0] as [string, string];
    expect(orgId).toBe("org-1");
    expect(db.subscription[0].status).toBe("canceled");
  });
});

// ── invoice.payment_failed → suspension after 3 attempts ────────────

describe("invoice.payment_failed", () => {
  function paymentFailedEvent(attemptCount: number) {
    return {
      id: `evt_pf_${attemptCount}`,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_1",
          customer: "cus_1",
          attempt_count: attemptCount,
          parent: { subscription_details: { subscription: "sub_stripe_1" } },
        },
      },
    };
  }

  it("suspends the workspace resolved via the subscription table on attempt 3", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ referenceId: "org-1" }]),
    );
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, paymentFailedEvent(3));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "suspended");
  });

  it("does not suspend before the third attempt", async () => {
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, paymentFailedEvent(1));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });
});
