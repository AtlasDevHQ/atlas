/**
 * Billing-portal path tests (#3417).
 *
 * The hand-rolled `POST /api/v1/billing/portal` route was deleted — portal
 * access now goes through the Better Auth Stripe plugin's org-aware
 * `/api/auth/subscription/billing-portal`, reading the plugin-owned
 * `organization.stripeCustomerId` and gated by `authorizeReference`.
 *
 * These tests drive that endpoint with a REAL session (memory adapter,
 * production plugin options from {@link buildStripePluginOptions}):
 *   - org with a Stripe customer + owner caller → 200 with a portal URL
 *     (the success path the old route could never reach — its column was
 *     never written)
 *   - plain member caller → 401 (authorizeReference denies billing-portal)
 *   - org without a Stripe customer → CUSTOMER_NOT_FOUND by design; the
 *     UI routes no-subscription workspaces to checkout instead (#3418)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock, type Mock } from "bun:test";
// NOT createApiTestMocks: the factory mocks @atlas/api/lib/auth/server,
// which provides the unit under test (buildStripePluginOptions).
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

// ── Mocks (must precede the server import) ──────────────────────────

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([]));

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: mockInternalQuery }),
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

const PORTAL_URL = "https://billing.stripe.com/p/session/test_123";

const portalSessionsCreate: Mock<(params: Record<string, unknown>) => Promise<unknown>> =
  mock(() => Promise.resolve({ url: PORTAL_URL }));

function makeStripeClient() {
  return {
    webhooks: {
      constructEventAsync: async (payload: string) => JSON.parse(payload),
    },
    billingPortal: {
      sessions: { create: portalSessionsCreate },
    },
    subscriptions: {
      retrieve: mock(() => Promise.resolve({})),
      list: mock(() => Promise.resolve({ data: [] })),
    },
    customers: {
      retrieve: mock(() => Promise.resolve({ id: "cus_org_1", email: "x@y.com" })),
      search: mock(() => Promise.resolve({ data: [] })),
      create: mock(() => Promise.resolve({ id: "cus_org_1" })),
      update: mock(() => Promise.resolve({ id: "cus_org_1" })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Stripe double
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

/** Sign a user up and return the session cookie for follow-up requests. */
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
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  // First cookie pair is the session token.
  return setCookie!.split(";")[0];
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

const ENV_KEYS = ["STRIPE_STARTER_PRICE_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_STARTER_PRICE_ID = "price_starter_test";
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
  portalSessionsCreate.mockClear();
  portalSessionsCreate.mockImplementation(() => Promise.resolve({ url: PORTAL_URL }));
});

describe("POST /api/auth/subscription/billing-portal (org-scoped)", () => {
  function seedOrg(db: MemoryDB, stripeCustomerId: string | null) {
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
    seedOrg(db, "cus_org_1");
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
    seedOrg(db, "cus_org_1");
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
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });

  it("returns CUSTOMER_NOT_FOUND before first checkout (UI routes to checkout instead)", async () => {
    const db = emptyDB();
    seedOrg(db, null);
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
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code ?? body.message ?? "").toContain("CUSTOMER");
    expect(portalSessionsCreate).not.toHaveBeenCalled();
  });
});
