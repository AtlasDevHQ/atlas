/**
 * Self-serve checkout E2E (#3418): drives the Better Auth Stripe plugin's
 * `/api/auth/subscription/upgrade` with a REAL session against the
 * production plugin options ({@link buildStripePluginOptions}) and a
 * mocked Stripe client.
 *
 * Pins the money-critical contract of a first org subscription:
 *   - seat-only checkout: ONE line item priced per seat with
 *     quantity = member count (seatPriceId === priceId in plans.ts)
 *   - double-trial suppression: an org that consumed the Atlas
 *     pre-checkout trial gets `trial_period_days: undefined` overriding
 *     the plugin's freeTrial spread (#3426 one-trial decision)
 *   - lazy org customer creation: the plugin creates the Stripe customer
 *     with `metadata.organizationId` and persists
 *     organization."stripeCustomerId" (#3417 contract)
 *   - org scoping: client passes customerType "organization" +
 *     referenceId; non-admin members are rejected by authorizeReference
 *
 * Also owns the billing-portal half of the same surface (#3417), formerly
 * `stripe-billing-portal.test.ts`: the hand-rolled `POST /api/v1/billing/portal`
 * route was deleted, so portal access goes through the plugin's org-aware
 * `/api/auth/subscription/billing-portal`, reading the plugin-owned
 * `organization.stripeCustomerId` and gated by the same `authorizeReference`.
 * Merged here because both drive the identical harness — one `betterAuth()`
 * instance over the memory adapter with the production `buildStripePluginOptions`
 * and a structural Stripe double.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, type Mock } from "bun:test";
// NOT createApiTestMocks: the factory mocks @atlas/api/lib/auth/server,
// which provides the unit under test (buildStripePluginOptions).
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// ── Mocks (must precede the server import) ──────────────────────────

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([]));
const mockGetWorkspaceDetails: Mock<(orgId: string) => Promise<unknown>> =
  mock(() => Promise.resolve(null));

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: mockInternalQuery }),
  getWorkspaceDetails: mockGetWorkspaceDetails,
}));

void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: async () => undefined,
  getEnterpriseRuntime: () => ({ runPromise: async () => undefined }),
  EnterpriseLayer: {},
}));

const { buildStripePluginOptions } = await import("../server");
const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { organization } = await import("better-auth/plugins");
const { stripe: stripePlugin } = await import("@better-auth/stripe");

const STARTER_PRICE = "price_starter_test";
const CHECKOUT_URL = "https://checkout.stripe.com/c/cs_test_123";
const PORTAL_URL = "https://billing.stripe.com/p/session/test_123";

const checkoutSessionsCreate: Mock<(params: Record<string, unknown>) => Promise<unknown>> =
  mock((params) => Promise.resolve({ id: "cs_test_123", url: CHECKOUT_URL, ...params }));
const customersCreate: Mock<(params: Record<string, unknown>) => Promise<unknown>> =
  mock(() => Promise.resolve({ id: "cus_org_new" }));
const portalSessionsCreate: Mock<(params: Record<string, unknown>) => Promise<unknown>> =
  mock(() => Promise.resolve({ url: PORTAL_URL }));

function makeStripeClient() {
  return {
    webhooks: {
      constructEventAsync: async (payload: string) => JSON.parse(payload),
    },
    checkout: {
      sessions: { create: checkoutSessionsCreate },
    },
    billingPortal: {
      sessions: { create: portalSessionsCreate },
    },
    customers: {
      // No pre-existing org customer → forces the lazy-creation path.
      search: mock(() => Promise.resolve({ data: [] })),
      create: customersCreate,
      // Echo the requested id so a seeded org customer (the portal cases)
      // retrieves as itself rather than as the lazily-created checkout one.
      retrieve: mock((id: string) => Promise.resolve({ id, email: "owner@example.com" })),
      update: mock((id: string) => Promise.resolve({ id })),
    },
    prices: {
      retrieve: mock(() =>
        Promise.resolve({ id: STARTER_PRICE, recurring: { usage_type: "licensed" } }),
      ),
      list: mock(() => Promise.resolve({ data: [] })),
    },
    subscriptions: {
      list: mock(() => Promise.resolve({ data: [] })),
      retrieve: mock(() => Promise.resolve({})),
    },
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe double
  } as any;
}

type MemoryDB = Record<string, Record<string, unknown>[]>;

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

function makeAuth(db: MemoryDB) {
  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [
      organization(),
      stripePlugin(
        buildStripePluginOptions({
          stripeClient: makeStripeClient(),
          webhookSecret: "whsec_test",
        }),
      ),
    ],
  });
}

async function signUp(auth: ReturnType<typeof makeAuth>): Promise<string> {
  const res = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "password-123",
        name: "Owner",
      }),
    }),
  );
  expect(res.status).toBe(200);
  // createCustomerOnSignUp is OFF (org-scoped billing) — signup must NOT mint a
  // user-level Stripe customer. Assert that here, so the ORG customer-creation
  // assertions below also start from a clean call count.
  expect(customersCreate).not.toHaveBeenCalled();
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function postUpgrade(
  auth: ReturnType<typeof makeAuth>,
  cookie: string,
  body: Record<string, unknown>,
) {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/subscription/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function postPortal(
  auth: ReturnType<typeof makeAuth>,
  cookie: string,
  body: Record<string, unknown>,
) {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/subscription/billing-portal", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

/** Seed an org with N members (ids don't need user rows for adapter.count). */
function seedOrg(db: MemoryDB, memberCount: number) {
  db.organization.push({ id: "org-1", name: "Acme", slug: "acme", createdAt: new Date() });
  for (let i = 0; i < memberCount; i++) {
    db.member.push({
      id: `member-${i}`,
      organizationId: "org-1",
      userId: `user-${i}`,
      role: i === 0 ? "owner" : "member",
      createdAt: new Date(),
    });
  }
}

const ENV_KEYS = ["STRIPE_STARTER_PRICE_ID", "STRIPE_PRO_PRICE_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_STARTER_PRICE_ID = STARTER_PRICE;
  delete process.env.STRIPE_PRO_PRICE_ID;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockGetWorkspaceDetails.mockReset();
  // Default: org consumed the Atlas pre-checkout trial.
  mockGetWorkspaceDetails.mockImplementation(() =>
    Promise.resolve({ id: "org-1", trial_ends_at: "2026-06-01T00:00:00.000Z" }),
  );
  checkoutSessionsCreate.mockClear();
  customersCreate.mockClear();
  portalSessionsCreate.mockClear();
  portalSessionsCreate.mockImplementation(() => Promise.resolve({ url: PORTAL_URL }));
});

describe("POST /api/auth/subscription/upgrade (org-scoped first subscription)", () => {
  const upgradeBody = {
    plan: "starter",
    customerType: "organization",
    referenceId: "org-1",
    successUrl: "http://localhost:3000/admin/billing?checkout=success",
    cancelUrl: "http://localhost:3000/admin/billing?checkout=cancelled",
    disableRedirect: true,
  };

  it("creates a seat-only Checkout session with quantity = member count and a suppressed trial", async () => {
    const db = emptyDB();
    seedOrg(db, 3);
    const auth = makeAuth(db);
    const cookie = await signUp(auth);
    // authorizeReference member lookup (internal DB) — caller is an owner.
    mockInternalQuery.mockImplementation(() => Promise.resolve([{ role: "owner" }]));

    const res = await postUpgrade(auth, cookie, upgradeBody);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toBe(CHECKOUT_URL);

    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = checkoutSessionsCreate.mock.calls[0] as [Record<string, unknown>];

    // Seat-only plan: ONE line item, per-seat price, quantity = members.
    expect(params.line_items).toEqual([{ price: STARTER_PRICE, quantity: 3 }]);

    // referenceId travels as client_reference_id for the webhook.
    expect(params.client_reference_id).toBe("org-1");

    // Double-trial suppression: the plugin's freeTrial spread is overridden
    // with undefined (the Stripe SDK drops undefined keys on the wire).
    const subData = params.subscription_data as Record<string, unknown>;
    expect("trial_period_days" in subData).toBe(true);
    expect(subData.trial_period_days).toBeUndefined();

    // Lazy org customer creation (#3417): created with org metadata and
    // persisted on the plugin-owned organization."stripeCustomerId".
    expect(customersCreate).toHaveBeenCalledTimes(1);
    const [custParams] = customersCreate.mock.calls[0] as [Record<string, unknown>];
    expect((custParams.metadata as Record<string, unknown>).organizationId).toBe("org-1");
    expect(db.organization[0].stripeCustomerId).toBe("cus_org_new");
    expect(params.customer).toBe("cus_org_new");
  });

  it("keeps the plugin trial for an org that never consumed the Atlas trial", async () => {
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", trial_ends_at: null }),
    );
    const db = emptyDB();
    seedOrg(db, 1);
    const auth = makeAuth(db);
    const cookie = await signUp(auth);
    mockInternalQuery.mockImplementation(() => Promise.resolve([{ role: "owner" }]));

    const res = await postUpgrade(auth, cookie, upgradeBody);

    expect(res.status).toBe(200);
    const [params] = checkoutSessionsCreate.mock.calls[0] as [Record<string, unknown>];
    const subData = params.subscription_data as Record<string, unknown>;
    expect(subData.trial_period_days).toBe(14);
  });

  it("rejects a plain member with 401 before any Stripe call", async () => {
    const db = emptyDB();
    seedOrg(db, 2);
    const auth = makeAuth(db);
    const cookie = await signUp(auth);
    mockInternalQuery.mockImplementation(() => Promise.resolve([{ role: "member" }]));

    const res = await postUpgrade(auth, cookie, upgradeBody);

    expect(res.status).toBe(401);
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
    expect(customersCreate).not.toHaveBeenCalled();
  });

  it("rejects a bare user-mode upgrade (no customerType/referenceId) at the checkout gate", async () => {
    const db = emptyDB();
    seedOrg(db, 1);
    const auth = makeAuth(db);
    const cookie = await signUp(auth);

    const res = await postUpgrade(auth, cookie, {
      plan: "starter",
      successUrl: "http://localhost:3000/admin/billing?checkout=success",
      cancelUrl: "http://localhost:3000/admin/billing?checkout=cancelled",
      disableRedirect: true,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? "").toContain("organization-scoped");
    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Billing portal (#3417) — formerly stripe-billing-portal.test.ts
// ---------------------------------------------------------------------------

describe("POST /api/auth/subscription/billing-portal (org-scoped)", () => {
  /** Seed an org that may or may not already carry a plugin-owned Stripe customer. */
  function seedOrgWithCustomer(db: MemoryDB, stripeCustomerId: string | null) {
    db.organization.push({
      id: "org-1",
      name: "Acme",
      slug: "acme",
      createdAt: new Date(),
      ...(stripeCustomerId ? { stripeCustomerId } : {}),
    });
  }

  it("returns a portal URL for an owner of a workspace with a Stripe customer", async () => {
    const db = emptyDB();
    seedOrgWithCustomer(db, "cus_org_1");
    const auth = makeAuth(db);
    const cookie = await signUp(auth);
    // authorizeReference's member lookup hits the (mocked) internal DB.
    mockInternalQuery.mockImplementation(() => Promise.resolve([{ role: "owner" }]));

    const res = await postPortal(auth, cookie, {
      customerType: "organization",
      referenceId: "org-1",
      returnUrl: "/admin/billing",
      disableRedirect: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toBe(PORTAL_URL);
    // The portal session was created against the PLUGIN-owned org customer.
    const [params] = portalSessionsCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.customer).toBe("cus_org_1");
  });

  it("rejects a plain member with 401 (authorizeReference)", async () => {
    const db = emptyDB();
    seedOrgWithCustomer(db, "cus_org_1");
    const auth = makeAuth(db);
    const cookie = await signUp(auth);
    mockInternalQuery.mockImplementation(() => Promise.resolve([{ role: "member" }]));

    const res = await postPortal(auth, cookie, {
      customerType: "organization",
      referenceId: "org-1",
      returnUrl: "/admin/billing",
      disableRedirect: true,
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("UNAUTHORIZED");
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns CUSTOMER_NOT_FOUND before first checkout (UI routes to checkout instead)", async () => {
    const db = emptyDB();
    seedOrgWithCustomer(db, null);
    const auth = makeAuth(db);
    const cookie = await signUp(auth);
    mockInternalQuery.mockImplementation(() => Promise.resolve([{ role: "owner" }]));

    const res = await postPortal(auth, cookie, {
      customerType: "organization",
      referenceId: "org-1",
      returnUrl: "/admin/billing",
      disableRedirect: true,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("CUSTOMER_NOT_FOUND");
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });
});
