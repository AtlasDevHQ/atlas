/**
 * Webhook-lifecycle tests for the Stripe billing plugin wiring
 * (#3416/#3421/#3423).
 *
 * These drive a REAL Better Auth instance (memory adapter) configured with
 * the REAL production plugin options ({@link buildStripePluginOptions})
 * against a mocked Stripe client, then POST synthetic webhook events to
 * `/api/auth/stripe/webhook`. This closes the gap noted in
 * dispatch-conversion-crm-stamp.test.ts: the hooks are no longer
 * untestable closures — the referenceId→orgId contract is exercised
 * end-to-end (event → plugin handler → `onEvent` sync → plan-tier write).
 *
 * Covered:
 *   - config shape: org mode on, authorizeReference defined (regression
 *     guard — removing either silently reverts to user-scoped subs)
 *   - checkout.session.completed → `updateWorkspacePlanTier(orgId, plan)`
 *   - customer.subscription.deleted → locked write for the same orgId,
 *     plus the stale-deletion guard (another active sub → skip)
 *   - invoice.payment_failed (attempt 3) → workspace suspended (source
 *     'billing') via the subscription-table referenceId lookup
 *   - delinquency ladder recovery (#3424): a billing-suspended workspace is
 *     un-suspended on invoice.paid / status→active, the full
 *     past_due→unpaid→invoice.paid chain reaches the right end state, an
 *     out-of-order unpaid delivery still blocks (state-correctness), and an
 *     OPERATOR-suspended workspace is NEVER cleared by a billing recovery
 *   - event ledger (#3423): replays skipped, out-of-order deliveries for
 *     the same subscription skipped, failed sync → 400 + NOT recorded so
 *     Stripe's redelivery re-runs the sync (record-last protocol)
 *   - per-subscription serialization (#3445): concurrent same-subscription
 *     deliveries serialize around classify→sync→record (newer state wins
 *     under out-of-order completion), different subscriptions stay
 *     concurrent, and a failed sync under the lock still records nothing
 *
 * The internalQuery mock embeds a stateful in-memory `stripe_webhook_events`
 * sim (SQL-discriminated) so ledger semantics are tested for real instead
 * of being stubbed to "fresh".
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

const mockGetWorkspaceDetails: Mock<(orgId: string) => Promise<unknown>> =
  mock(() => Promise.resolve(null));

// #3445 — in-process per-key mutex standing in for the production pg
// advisory lock (`withStripeSubscriptionLock`). Faithful to its contract:
// same-key callers serialize in arrival order, different keys (and null)
// run concurrently, and a throwing callback releases the lock and
// re-throws. Backed by a promise chain per subscription id; `lockCalls`
// records the key of every invocation so tests can assert `onEvent`
// passes the per-event subscription id (not a global constant).
const lockTails = new Map<string, Promise<void>>();
const lockCalls: Array<string | null> = [];
async function mutexStripeSubscriptionLock<T>(
  stripeSubscriptionId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  lockCalls.push(stripeSubscriptionId);
  if (!stripeSubscriptionId) return fn();
  const tail = lockTails.get(stripeSubscriptionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockTails.set(stripeSubscriptionId, tail.then(() => gate));
  await tail;
  try {
    return await fn();
  } finally {
    release();
  }
}

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: mockInternalQuery }),
  updateWorkspacePlanTier: mockUpdateWorkspacePlanTier,
  updateWorkspaceStatus: mockUpdateWorkspaceStatus,
  getWorkspaceDetails: mockGetWorkspaceDetails,
  withStripeSubscriptionLock: mutexStripeSubscriptionLock,
}));

mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  runEnterprise: async () => undefined,
  getEnterpriseRuntime: () => ({ runPromise: async () => undefined }),
  EnterpriseLayer: {},
}));

const { buildStripePluginOptions } = await import("../server");
const { TIER_LIFECYCLE_EVENT_TYPES } = await import("@atlas/api/lib/billing/stripe-event-ledger");
const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { organization } = await import("better-auth/plugins");
const { stripe: stripePlugin } = await import("@better-auth/stripe");

// ── Event-ledger sim (#3423) ────────────────────────────────────────
//
// The ledger module issues three SQL shapes against the internal DB;
// this in-memory table answers them so the dedup/stale/record protocol
// runs for real. Subscription-table queries fall through to the
// per-test `extra` handler.

interface LedgerRow {
  event_id: string;
  event_type: string;
  event_created: string;
  stripe_subscription_id: string | null;
  /** Tier the sync actually wrote for this event (null when none). */
  applied_plan_tier: string | null;
}

let ledgerRows: LedgerRow[] = [];

/** GDPR purge tombstones (#3468) — answered for the classify probe. */
let purgedSubscriptionIds = new Set<string>();

// The production allowlist, so the sim can't drift from the real
// ordering model if TIER_LIFECYCLE_EVENT_TYPES changes.
const LIFECYCLE_TYPES: readonly string[] = TIER_LIFECYCLE_EVENT_TYPES;

function ledgerAwareQuery(
  extra?: (sql: string, params?: unknown[]) => unknown[] | null,
): (sql: string, params?: unknown[]) => Promise<unknown[]> {
  return (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM stripe_webhook_events WHERE event_id")) {
      return Promise.resolve(ledgerRows.filter((r) => r.event_id === params?.[0]));
    }
    // classify-time tombstone probe (#3468) — match the SELECT shape only,
    // NOT the record INSERT's `NOT EXISTS (SELECT 1 FROM ...)` guard below.
    if (sql.includes("SELECT stripe_subscription_id FROM stripe_purged_subscriptions")) {
      return Promise.resolve(
        purgedSubscriptionIds.has(String(params?.[0]))
          ? [{ stripe_subscription_id: params?.[0] }]
          : [],
      );
    }
    if (sql.includes("FROM stripe_webhook_events") && sql.includes("event_created > $2")) {
      // Mirrors the production stale probe: lifecycle rows only; newer
      // wins, and a same-second recorded deletion also blocks (tie-break).
      return Promise.resolve(
        ledgerRows.filter(
          (r) =>
            r.stripe_subscription_id === params?.[0] &&
            LIFECYCLE_TYPES.includes(r.event_type) &&
            (r.event_created > String(params?.[1]) ||
              (r.event_created === String(params?.[1]) &&
                r.event_type === "customer.subscription.deleted")),
        ),
      );
    }
    if (sql.includes("INSERT INTO stripe_webhook_events")) {
      const [id, type, created, subId, appliedTier] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
      ];
      // Model the record-time `WHERE NOT EXISTS (... stripe_purged_subscriptions ...)`
      // guard (#3468): a tombstoned subscription's event is never recorded.
      if (subId !== null && purgedSubscriptionIds.has(subId)) {
        return Promise.resolve([]);
      }
      if (!ledgerRows.some((r) => r.event_id === id)) {
        ledgerRows.push({
          event_id: id,
          event_type: type,
          event_created: created,
          stripe_subscription_id: subId,
          applied_plan_tier: appliedTier,
        });
      }
      return Promise.resolve([]);
    }
    return Promise.resolve(extra?.(sql, params) ?? []);
  };
}

// ── Stripe client double ────────────────────────────────────────────
//
// `constructEventAsync` echoes the request body back as the event, so each
// test fully controls the webhook payload without computing signatures.

const STARTER_PRICE = "price_starter_test";
const PRO_PRICE = "price_pro_test";
const EPOCH = Math.floor(Date.now() / 1000);

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
    // Checkout-created subscriptions carry the plugin's referenceId stamp;
    // resolveOrgIdForStripeSubscription reads it before falling back to
    // the subscription-table lookup.
    metadata: { referenceId: "org-1", subscriptionId: "subrow_1" },
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_start: EPOCH,
          current_period_end: EPOCH + 30 * 86_400,
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

function checkoutCompletedEvent(id = "evt_checkout_1", created = EPOCH) {
  return {
    id,
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        mode: "subscription",
        subscription: "sub_stripe_1",
        client_reference_id: "org-1",
        metadata: { referenceId: "org-1", subscriptionId: "subrow_1", userId: "user-1" },
      },
    },
  };
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
  mockUpdateWorkspacePlanTier.mockReset();
  mockUpdateWorkspacePlanTier.mockImplementation(() => Promise.resolve(true));
  mockUpdateWorkspaceStatus.mockClear();
  mockGetWorkspaceDetails.mockReset();
  mockGetWorkspaceDetails.mockImplementation(() => Promise.resolve(null));
  ledgerRows = [];
  purgedSubscriptionIds = new Set();
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(ledgerAwareQuery());
  subscriptionsRetrieve.mockClear();
  subscriptionsRetrieve.mockImplementation(() => Promise.resolve(stripeSubscription()));
  lockTails.clear();
  lockCalls.length = 0;
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

  // Pin the org-scoped billing contract: NO user-level customer on signup.
  // Atlas bills `organization.stripeCustomerId` exclusively; a per-signup user
  // customer is never used for billing and required a plugin-managed
  // `user.stripeCustomerId` column that drifted across region DBs (US had it,
  // EU/APAC didn't → an orphaned-customer leak on EU/APAC signup). A revert to
  // `true` would reintroduce that. This is the config-shape guard; the behavioral
  // counterpart (signup mints no customer) is in stripe-checkout.test.ts. See #4012.
  it("does NOT create a user-level Stripe customer on signup (org-scoped only)", () => {
    const options = buildStripePluginOptions({
      stripeClient: makeStripeClient(),
      webhookSecret: "whsec_test",
    });
    expect(options.createCustomerOnSignUp).toBe(false);
  });

  // #3703 — pin the hot-reload contract: `plans` must be the resolver FUNCTION,
  // not an eager array snapshot. A revert to `plans: getStripePlans()` would
  // restore the redeploy-required footgun, and only this assertion would catch
  // it (every other test exercises behavior, not the handoff shape).
  it("hands the plugin the plans resolver FUNCTION, re-resolved per call (#3703)", () => {
    const options = buildStripePluginOptions({
      stripeClient: makeStripeClient(),
      webhookSecret: "whsec_test",
    });
    expect(options.subscription?.enabled).toBe(true);
    if (!options.subscription?.enabled) throw new Error("subscription disabled");
    const plans = options.subscription.plans;
    expect(typeof plans).toBe("function");
    if (typeof plans !== "function") throw new Error("plans is not a function");

    // Re-resolution proof: the resolver reads price IDs live (via getSettingAuto
    // → env fallback here), so mutating the source between calls changes the
    // output — a snapshot array could not. Restore the env after.
    const saved = process.env.STRIPE_STARTER_PRICE_ID;
    try {
      const first = plans() as Array<{ name: string; priceId: string }>;
      expect(first.find((p) => p.name === "starter")?.priceId).toBe(STARTER_PRICE);
      process.env.STRIPE_STARTER_PRICE_ID = "price_starter_rotated";
      const second = plans() as Array<{ name: string; priceId: string }>;
      expect(second.find((p) => p.name === "starter")?.priceId).toBe("price_starter_rotated");
    } finally {
      if (saved === undefined) delete process.env.STRIPE_STARTER_PRICE_ID;
      else process.env.STRIPE_STARTER_PRICE_ID = saved;
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

  it("rejects a subscription whose referenceId is the calling user (user-scoped checkout)", async () => {
    const cb = getCallback();
    await expect(
      Promise.resolve(
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
      ),
    ).rejects.toThrow(/organization-scoped/);
  });

  it("suppresses the Stripe trial for an org that consumed the Atlas pre-checkout trial (#3418)", async () => {
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", trial_ends_at: "2026-06-01T00:00:00.000Z" }),
    );
    const cb = getCallback();
    const result = await cb(
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
    // trial_period_days: undefined overrides the plugin's freeTrial spread;
    // the Stripe SDK drops undefined keys from the request.
    expect(result).toEqual({
      params: { subscription_data: { trial_period_days: undefined } },
    });
  });

  it("leaves the plugin trial in place for an org that never consumed the Atlas trial", async () => {
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", trial_ends_at: null }),
    );
    const cb = getCallback();
    const result = await cb(
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

  it("suppresses the trial when the workspace lookup fails (fail toward no double trial)", async () => {
    mockGetWorkspaceDetails.mockImplementation(() => Promise.reject(new Error("pg blip")));
    const cb = getCallback();
    const result = await cb(
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
    expect(result).toEqual({
      params: { subscription_data: { trial_period_days: undefined } },
    });
  });
});

// ── checkout.session.completed → plan-tier sync ─────────────────────

describe("checkout.session.completed", () => {
  it("updates organization.plan_tier for the org referenceId and records the event", async () => {
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

    const res = await postWebhook(auth, checkoutCompletedEvent());

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "starter");
    // The plugin's own row sync ran too: status + stripeSubscriptionId persisted.
    expect(db.subscription[0].status).toBe("active");
    expect(db.subscription[0].stripeSubscriptionId).toBe("sub_stripe_1");
    // #3423 — the sync succeeded, so the event id landed in the ledger
    // together with the tier it applied (the sweep's ordering-correct
    // source of truth).
    expect(ledgerRows.map((r) => [r.event_id, r.applied_plan_tier])).toEqual([
      ["evt_checkout_1", "starter"],
    ]);
  });
});

// ── churn lifecycle (#3421): cancel keeps tier, delete locks ────────

describe("customer.subscription.updated → pending cancel (#3421)", () => {
  it("does NOT change the tier when cancellation is merely scheduled", async () => {
    const db = emptyDB();
    db.subscription.push({
      id: "subrow_1",
      plan: "starter",
      referenceId: "org-1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_stripe_1",
      status: "active",
      cancelAtPeriodEnd: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const auth = makeAuth(db);

    // active → pending-cancel transition: the plugin fires
    // onSubscriptionCancel exactly once here (schedule time, customer
    // still paid through period end).
    const res = await postWebhook(auth, {
      id: "evt_cancel_scheduled_1",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: {
        object: stripeSubscription({
          status: "active",
          cancel_at_period_end: true,
        }),
      },
    });

    expect(res.status).toBe(200);
    // The customer is paid up — entitlements retained until period end.
    // (The onEvent sync still writes the same tier, so any write must be
    // to "starter", never a downgrade.)
    for (const call of mockUpdateWorkspacePlanTier.mock.calls) {
      const [, tier] = call as [string, string];
      expect(tier).toBe("starter");
    }
    // The plugin persisted the pending-cancel flag for UI display.
    expect(db.subscription[0].cancelAtPeriodEnd).toBe(true);
  });
});

// ── operator plan-override precedence (#3427) ───────────────────────

describe("operator plan-override precedence (#3427)", () => {
  it("does NOT clobber the plan_tier when an operator override is active", async () => {
    // A platform admin comped this org to `pro` (override window in the
    // future). The plugin's subscription row still says `starter`, so a
    // stray customer.subscription.updated would normally re-sync the org
    // to starter — the override must block that write.
    const overrideUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", plan_tier: "pro", plan_override_until: overrideUntil }),
    );

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
      id: "evt_override_active",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });

    expect(res.status).toBe(200);
    // The operator grant survives — NO Stripe-driven tier write happened.
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
    // The event is still recorded (handled, deliberately a no-op) so Stripe
    // doesn't redeliver it forever. The tier the sync WOULD have written is
    // banked so the reconcile sweep stays consistent.
    expect(ledgerRows.map((r) => [r.event_id, r.applied_plan_tier])).toEqual([
      ["evt_override_active", "starter"],
    ]);
  });

  it("applies the Stripe tier normally once the override window has lapsed", async () => {
    // Same shape, but the override is in the PAST → Stripe is authoritative
    // again and the sync proceeds.
    const overrideUntil = new Date(Date.now() - 86_400_000).toISOString();
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", plan_tier: "pro", plan_override_until: overrideUntil }),
    );

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
      id: "evt_override_lapsed",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "starter");
  });

  it("falls toward Stripe authority when the override lookup fails", async () => {
    // A DB blip reading plan_override_until must NOT silently skip the sync
    // (that would strand the org on a stale tier) — fall through to the write.
    mockGetWorkspaceDetails.mockImplementation(() => Promise.reject(new Error("pg blip")));

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
      id: "evt_override_readfail",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "starter");
  });
});

describe("customer.subscription.deleted", () => {
  it("locks the org when the subscription actually ends — never free (#3421)", async () => {
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
      created: EPOCH,
      data: { object: stripeSubscription({ status: "canceled" }) },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "locked");
    expect(db.subscription[0].status).toBe("canceled");
    expect(ledgerRows.map((r) => [r.event_id, r.applied_plan_tier])).toEqual([
      ["evt_deleted_1", "locked"],
    ]);
  });

  it("skips the lock when another active subscription exists (stale deletion guard)", async () => {
    const db = emptyDB();
    db.subscription.push({
      id: "subrow_old",
      plan: "starter",
      referenceId: "org-1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_stripe_1",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const auth = makeAuth(db);
    // The org resubscribed: a DIFFERENT subscription row is active in the
    // internal DB. A delayed deleted event for the old subscription must
    // not revoke the paying customer's access. (The ledger's stale check
    // can't catch this case — the two events concern different
    // subscription ids — hence the explicit guard.)
    mockInternalQuery.mockImplementation(
      ledgerAwareQuery((sql) =>
        sql.includes("status IN ('active', 'trialing')") ? [{ id: "subrow_new" }] : null,
      ),
    );

    const res = await postWebhook(auth, {
      id: "evt_deleted_stale",
      type: "customer.subscription.deleted",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "canceled" }) },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
  });

  it("skips and does NOT record deliveries for a GDPR-purged subscription (#3468)", async () => {
    // Purge already ran: hardDeleteWorkspace tombstoned the subscription
    // id and removed the local subscription + ledger rows. The purge's
    // own Stripe cancellation now delivers customer.subscription.deleted
    // — it must neither sync nor regrow stripe_webhook_events.
    purgedSubscriptionIds = new Set(["sub_stripe_1"]);
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, {
      id: "evt_post_purge",
      type: "customer.subscription.deleted",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "canceled" }) },
    });

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
    expect(ledgerRows).toEqual([]);
  });
});

// ── event ledger (#3423): replay, ordering, record-last ─────────────

describe("event ledger (#3423)", () => {
  it("skips a replayed delivery of an already-processed event id", async () => {
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

    const first = await postWebhook(auth, checkoutCompletedEvent());
    expect(first.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);

    const replay = await postWebhook(auth, checkoutCompletedEvent());
    expect(replay.status).toBe(200);
    // The duplicate was ACKed without re-running the sync.
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);
    expect(ledgerRows).toHaveLength(1);
  });

  it("skips an out-of-order older event for a subscription that already has a newer one applied", async () => {
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

    // The subscription ended (event_created = EPOCH + 100) → locked.
    const deleted = await postWebhook(auth, {
      id: "evt_deleted_new",
      type: "customer.subscription.deleted",
      created: EPOCH + 100,
      data: { object: stripeSubscription({ status: "canceled" }) },
    });
    expect(deleted.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "locked");
    mockUpdateWorkspacePlanTier.mockClear();

    // A delayed OLDER updated event (still "active") arrives afterwards.
    // Applying it would resurrect the tier on a locked workspace.
    const stale = await postWebhook(auth, {
      id: "evt_updated_old",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });
    expect(stale.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
    expect(ledgerRows.map((r) => r.event_id)).toEqual(["evt_deleted_new"]);
  });

  it("skips a SAME-second older event after a deletion (1s-granularity tie-break)", async () => {
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

    // Deleted and updated share the same Stripe `created` second —
    // strictly-greater ordering alone would let the late updated event
    // resurrect the paid tier on the locked workspace (Codex on #3444).
    const deleted = await postWebhook(auth, {
      id: "evt_deleted_tie",
      type: "customer.subscription.deleted",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "canceled" }) },
    });
    expect(deleted.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "locked");
    mockUpdateWorkspacePlanTier.mockClear();

    const tied = await postWebhook(auth, {
      id: "evt_updated_tie",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });
    expect(tied.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
    // The stale event must not land in the ledger either — only
    // processed events are recorded.
    expect(ledgerRows.map((r) => r.event_id)).toEqual(["evt_deleted_tie"]);
  });

  it("treats an unrecognized price as retryable — 400 and NOT recorded (env misconfig)", async () => {
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
    // STRIPE_*_PRICE_ID misconfig: the subscription's price maps to no
    // Atlas tier. Recording the event would permanently no-op Stripe's
    // replays; throwing keeps the ~3-week retry window open for the
    // operator to fix the env.
    subscriptionsRetrieve.mockImplementation(() =>
      Promise.resolve(stripeSubscription({
        items: {
          data: [
            {
              id: "si_1",
              quantity: 1,
              current_period_start: EPOCH,
              current_period_end: EPOCH + 30 * 86_400,
              price: { id: "price_not_configured", recurring: { interval: "month" } },
            },
          ],
        },
      })),
    );

    const res = await postWebhook(auth, checkoutCompletedEvent());
    expect(res.status).toBe(400);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
    expect(ledgerRows).toHaveLength(0);
  });

  it("returns 400 and does NOT record the event when the sync fails, so a redelivery re-runs it", async () => {
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
    mockUpdateWorkspacePlanTier.mockImplementation(() =>
      Promise.reject(new Error("internal db down")),
    );

    const failed = await postWebhook(auth, checkoutCompletedEvent());
    // onEvent throws propagate (the plugin's named hooks swallow; onEvent
    // does not) → 400 → Stripe retries.
    expect(failed.status).toBe(400);
    // Record-last protocol: the failed event is NOT in the ledger, so the
    // retry below is classified fresh instead of duplicate.
    expect(ledgerRows).toHaveLength(0);

    // Clear so the assertions below prove the REDELIVERY reran the sync,
    // not just that the failed first attempt reached the write.
    mockUpdateWorkspacePlanTier.mockClear();
    mockUpdateWorkspacePlanTier.mockImplementation(() => Promise.resolve(true));
    const retry = await postWebhook(auth, checkoutCompletedEvent());
    expect(retry.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "starter");
    expect(ledgerRows.map((r) => r.event_id)).toEqual(["evt_checkout_1"]);
  });
});

// ── concurrent deliveries (#3445): per-subscription serialization ───

describe("concurrent deliveries (#3445)", () => {
  function activeSubRow(suffix: "1" | "2") {
    return {
      id: `subrow_${suffix}`,
      plan: "starter",
      referenceId: `org-${suffix}`,
      stripeCustomerId: `cus_${suffix}`,
      stripeSubscriptionId: `sub_stripe_${suffix}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("serializes out-of-order concurrent deliveries for the same subscription — the newer state wins", async () => {
    const db = emptyDB();
    db.subscription.push(activeSubRow("1"));
    const auth = makeAuth(db);

    // OLDER `updated` event (created = EPOCH, writes "starter") whose
    // sync is gated mid-flight; NEWER `deleted` event (created =
    // EPOCH + 100, writes "locked") delivered while the older sync is
    // still running. Without the per-subscription lock, both classify
    // `fresh` concurrently and the OLDER sync finishes LAST, regressing
    // the locked workspace back to a paid tier. Under the lock the newer
    // delivery waits its turn, sees the world the older one left behind,
    // and its "locked" write lands last.
    let oldSyncStarted!: () => void;
    const oldSyncStartedP = new Promise<void>((resolve) => {
      oldSyncStarted = resolve;
    });
    let releaseOldSync!: () => void;
    const oldSyncGate = new Promise<void>((resolve) => {
      releaseOldSync = resolve;
    });
    mockUpdateWorkspacePlanTier.mockImplementation(async (_orgId: string, tier: string) => {
      if (tier === "starter") {
        oldSyncStarted();
        await oldSyncGate;
      }
      return true;
    });

    const oldP = postWebhook(auth, {
      id: "evt_updated_old",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });
    // The older delivery now holds the lock, mid-sync.
    await oldSyncStartedP;
    const newP = postWebhook(auth, {
      id: "evt_deleted_new",
      type: "customer.subscription.deleted",
      created: EPOCH + 100,
      data: { object: stripeSubscription({ status: "canceled" }) },
    });
    // Give the newer delivery time to reach (and block on) the lock,
    // then complete the OLDER sync LAST — the out-of-order completion.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseOldSync();
    const [oldRes, newRes] = await Promise.all([oldP, newP]);

    expect(oldRes.status).toBe(200);
    expect(newRes.status).toBe(200);
    // The FINAL tier write is the newer lifecycle state — without the
    // lock this is ["org-1", "starter"] (the older slow sync lands last).
    expect(mockUpdateWorkspacePlanTier.mock.calls.at(-1)).toEqual(["org-1", "locked"]);
    // Serialized order: the older event recorded first, then the newer
    // one classified fresh (it IS newer) and recorded after it.
    expect(ledgerRows.map((r) => r.event_id)).toEqual(["evt_updated_old", "evt_deleted_new"]);
  });

  it("does not serialize deliveries for different subscriptions (no global lock)", async () => {
    const db = emptyDB();
    db.subscription.push(activeSubRow("1"), activeSubRow("2"));
    const auth = makeAuth(db);

    // Gate org-1's tier write to keep subscription 1's lock held, then
    // deliver an event for subscription 2 — it must complete while the
    // first is still mid-sync. A global lock key would chain the second
    // delivery behind the gate and hang this test.
    let firstSyncStarted!: () => void;
    const firstSyncStartedP = new Promise<void>((resolve) => {
      firstSyncStarted = resolve;
    });
    let releaseFirstSync!: () => void;
    const firstSyncGate = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    mockUpdateWorkspacePlanTier.mockImplementation(async (orgId: string) => {
      if (orgId === "org-1") {
        firstSyncStarted();
        await firstSyncGate;
      }
      return true;
    });

    const firstP = postWebhook(auth, {
      id: "evt_updated_sub1",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });
    await firstSyncStartedP;

    const secondRes = await postWebhook(auth, {
      id: "evt_updated_sub2",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: {
        object: stripeSubscription({
          id: "sub_stripe_2",
          customer: "cus_2",
          status: "active",
          metadata: { referenceId: "org-2", subscriptionId: "subrow_2" },
        }),
      },
    });

    // Subscription 2 completed end-to-end while subscription 1's lock
    // was still held.
    expect(secondRes.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-2", "starter");
    expect(ledgerRows.map((r) => r.event_id)).toEqual(["evt_updated_sub2"]);

    releaseFirstSync();
    const firstRes = await firstP;
    expect(firstRes.status).toBe(200);

    // The lock was keyed on each event's OWN subscription id — a
    // constant key would have produced two identical entries.
    expect(lockCalls).toEqual(["sub_stripe_1", "sub_stripe_2"]);
  });

  it("a failed sync under the lock still records nothing — the lock serializes, it does not claim", async () => {
    const db = emptyDB();
    db.subscription.push(activeSubRow("1"));
    const auth = makeAuth(db);
    mockUpdateWorkspacePlanTier.mockImplementation(() =>
      Promise.reject(new Error("internal db down")),
    );

    const failed = await postWebhook(auth, {
      id: "evt_updated_fail",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });

    // The throw propagated THROUGH the lock wrapper → 400 → Stripe
    // redelivers; nothing recorded (record-last preserved, #3444
    // accepted rebuttal), and the lock was taken for the attempt.
    expect(failed.status).toBe(400);
    expect(ledgerRows).toHaveLength(0);
    expect(lockCalls).toEqual(["sub_stripe_1"]);

    // The redelivery is classified fresh and re-runs the sync.
    mockUpdateWorkspacePlanTier.mockClear();
    mockUpdateWorkspacePlanTier.mockImplementation(() => Promise.resolve(true));
    const retry = await postWebhook(auth, {
      id: "evt_updated_fail",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "active" }) },
    });
    expect(retry.status).toBe(200);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-1", "starter");
    expect(ledgerRows.map((r) => r.event_id)).toEqual(["evt_updated_fail"]);
  });
});

// ── invoice.payment_failed → suspension after 3 attempts ────────────

describe("invoice.payment_failed", () => {
  function paymentFailedEvent(attemptCount: number) {
    return {
      id: `evt_pf_${attemptCount}`,
      type: "invoice.payment_failed",
      created: EPOCH,
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
    mockInternalQuery.mockImplementation(
      ledgerAwareQuery((sql) =>
        sql.includes(`"stripeSubscriptionId" = $1`) ? [{ referenceId: "org-1" }] : null,
      ),
    );
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, paymentFailedEvent(3));

    expect(res.status).toBe(200);
    // Sourced 'billing' so a later recovery is allowed to clear it (#3424).
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "suspended", "billing");
  });

  it("does not suspend before the third attempt", async () => {
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, paymentFailedEvent(1));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });
});

// ── invoice.payment_succeeded / paid → recovery (#3424) ─────────────

describe("invoice payment recovery (#3424)", () => {
  function invoicePaidEvent(type: "invoice.payment_succeeded" | "invoice.paid") {
    return {
      id: `evt_${type.replace(/\./g, "_")}`,
      type,
      created: EPOCH,
      data: {
        object: {
          id: "in_paid_1",
          customer: "cus_1",
          parent: { subscription_details: { subscription: "sub_stripe_1" } },
        },
      },
    };
  }

  /** The subscription-table lookup resolves the org for the paid invoice. */
  function resolveOrgQuery(sql: string) {
    return sql.includes(`"stripeSubscriptionId" = $1`) ? [{ referenceId: "org-1" }] : null;
  }

  it("unsuspends a billing-suspended workspace when the failed invoice is paid", async () => {
    mockInternalQuery.mockImplementation(ledgerAwareQuery(resolveOrgQuery));
    // The workspace was suspended by the billing ladder (earlier 3-attempt failure).
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "billing" }),
    );
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, invoicePaidEvent("invoice.payment_succeeded"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "active");
  });

  it("treats invoice.paid the same as invoice.payment_succeeded", async () => {
    mockInternalQuery.mockImplementation(ledgerAwareQuery(resolveOrgQuery));
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "billing" }),
    );
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, invoicePaidEvent("invoice.paid"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "active");
  });

  it("does NOT unsuspend an OPERATOR-suspended workspace on a billing recovery (#3424 blocker)", async () => {
    // The workspace is suspended for a non-billing reason (e.g. ToS abuse) —
    // an operator set it. A delinquent invoice later being paid must NOT
    // silently clear the operator's deliberate suspension.
    mockInternalQuery.mockImplementation(ledgerAwareQuery(resolveOrgQuery));
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "operator" }),
    );
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, invoicePaidEvent("invoice.paid"));

    expect(res.status).toBe(200);
    // The operator suspension is untouched — no status write of any kind.
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("does NOT change status when the workspace is already active (idempotent recovery)", async () => {
    mockInternalQuery.mockImplementation(ledgerAwareQuery(resolveOrgQuery));
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "active" }),
    );
    const auth = makeAuth(emptyDB());

    const res = await postWebhook(auth, invoicePaidEvent("invoice.paid"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("end-to-end: fail→suspend→pay→unsuspend (billing-sourced)", async () => {
    mockInternalQuery.mockImplementation(ledgerAwareQuery(resolveOrgQuery));
    const auth = makeAuth(emptyDB());

    // 1. Third failed attempt suspends the workspace, sourced 'billing'.
    const failed = await postWebhook(auth, {
      id: "evt_pf_3_e2e",
      type: "invoice.payment_failed",
      created: EPOCH,
      data: {
        object: {
          id: "in_e2e",
          customer: "cus_1",
          attempt_count: 3,
          parent: { subscription_details: { subscription: "sub_stripe_1" } },
        },
      },
    });
    expect(failed.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "suspended", "billing");

    // 2. The customer fixes their card and the invoice is paid. The
    //    workspace is billing-suspended, so recovery flips it back to active.
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "billing" }),
    );
    const recovered = await postWebhook(auth, invoicePaidEvent("invoice.payment_succeeded"));
    expect(recovered.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenLastCalledWith("org-1", "active");
  });

  it("end-to-end full chain: past_due → unpaid → invoice.paid → unsuspend", async () => {
    mockInternalQuery.mockImplementation(ledgerAwareQuery(resolveOrgQuery));
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

    // 1. past_due — entitlements retained, no suspension.
    const pastDue = await postWebhook(auth, {
      id: "evt_chain_past_due",
      type: "customer.subscription.updated",
      created: EPOCH,
      data: { object: stripeSubscription({ status: "past_due" }) },
    });
    expect(pastDue.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();

    // 2. unpaid — Stripe stopped retrying this cycle; block, sourced 'billing'.
    const unpaid = await postWebhook(auth, {
      id: "evt_chain_unpaid",
      type: "customer.subscription.updated",
      created: EPOCH + 10,
      data: { object: stripeSubscription({ status: "unpaid" }) },
    });
    expect(unpaid.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "suspended", "billing");

    // 3. The invoice is paid — the billing suspension is auto-cleared.
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "billing" }),
    );
    const paid = await postWebhook(auth, invoicePaidEvent("invoice.paid"));
    expect(paid.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenLastCalledWith("org-1", "active");
  });
});

// ── customer.subscription.updated → status-aware policy (#3424) ─────

describe("subscription status policy (#3424)", () => {
  function statusUpdatedEvent(status: string, id = `evt_status_${status}`, created = EPOCH) {
    return {
      id,
      type: "customer.subscription.updated",
      created,
      data: { object: stripeSubscription({ status }) },
    };
  }

  /** A live subscription row so the plugin's own row-update handler finds it. */
  function seededDB() {
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
    return db;
  }

  it("retains entitlements on past_due (warn only, no suspension)", async () => {
    const auth = makeAuth(seededDB());

    const res = await postWebhook(auth, statusUpdatedEvent("past_due"));

    expect(res.status).toBe(200);
    // past_due never touches workspace_status — the customer keeps working.
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("blocks the workspace on unpaid (soft-suspend, sourced 'billing')", async () => {
    const auth = makeAuth(seededDB());

    const res = await postWebhook(auth, statusUpdatedEvent("unpaid"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "suspended", "billing");
  });

  it("auto-recovers a billing-suspended workspace when the subscription returns to active", async () => {
    // Belt-and-braces: even if the invoice.paid signal is dropped, the
    // status transition back to active unsuspends the workspace.
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "billing" }),
    );
    const auth = makeAuth(seededDB());

    const res = await postWebhook(auth, statusUpdatedEvent("active"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "active");
  });

  it("does NOT auto-recover an operator-suspended workspace on a status→active transition", async () => {
    // The belt-and-braces `active` recovery path must respect the suspension
    // source too — an operator suspension survives a status→active.
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "suspended", suspension_source: "operator" }),
    );
    const auth = makeAuth(seededDB());

    const res = await postWebhook(auth, statusUpdatedEvent("active"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("blocks on a delayed unpaid even after an earlier active recovery (out-of-order delivery, state-correctness)", async () => {
    // Webhook ordering is not guaranteed (#3423). The status policy is
    // state-driven off each event's own status, so a late `unpaid` delivery
    // still produces the correct end state (blocked + sourced 'billing')
    // rather than depending on arrival order.
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "active", suspension_source: null }),
    );
    const auth = makeAuth(seededDB());

    // An `active` update lands first (no suspension to clear).
    const active = await postWebhook(auth, statusUpdatedEvent("active", "evt_ooo_active", EPOCH));
    expect(active.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();

    // A delayed `unpaid` update arrives afterwards (later Stripe `created`) —
    // it must still block.
    const unpaid = await postWebhook(auth, statusUpdatedEvent("unpaid", "evt_ooo_unpaid", EPOCH + 50));
    expect(unpaid.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith("org-1", "suspended", "billing");
  });

  it("does nothing to status for an active subscription on an already-active workspace", async () => {
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ id: "org-1", workspace_status: "active" }),
    );
    const auth = makeAuth(seededDB());

    const res = await postWebhook(auth, statusUpdatedEvent("active"));

    expect(res.status).toBe(200);
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });
});
