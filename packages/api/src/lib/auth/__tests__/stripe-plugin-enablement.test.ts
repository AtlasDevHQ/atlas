/**
 * Stripe plugin enablement gating in `buildPlugins()` (#3447).
 *
 * The auth server boots without an internal DB (`database:
 * internalDbAvailable ? getInternalDB() : undefined`), so before #3447 a
 * deployment with Stripe keys set but no `DATABASE_URL` registered the
 * plugin — and every webhook delivery then failed inside `onEvent`
 * (ledger classify/record and `syncStripeEventToWorkspace` all require
 * `internalQuery`), 400-looping through Stripe's ~3-week retry horizon.
 * Billing is structurally meaningless without the internal DB (org-scoped
 * subscriptions live in the `organization`/`subscription` tables), so the
 * plugin must refuse to enable, loudly.
 *
 * The logger is mocked so the operator-facing `log.error` lines from the
 * two refusal branches (missing webhook secret / missing internal DB) are
 * observable; `hasInternalDB()` is the real implementation reading
 * `DATABASE_URL`, manipulated per test.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ── Mocks (must precede the server import) ──────────────────────────

const errorLogs: string[] = [];

function makeStubLogger(): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    error: (...args: unknown[]) => {
      // pino signature: (obj, msg?) or (msg). Keep every string arg so
      // assertions can match the operator-facing message.
      errorLogs.push(args.filter((a): a is string => typeof a === "string").join(" "));
    },
  };
  stub.child = () => stub;
  return stub;
}

// Splat the real module so every other logger export (withRequestContext,
// scrub serializers, …) used across server.ts's import graph stays intact
// — the "mock all exports" rule.
// oxlint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("@atlas/api/lib/logger") as Record<string, unknown>;

mock.module("@atlas/api/lib/logger", () => ({
  ...realLogger,
  createLogger: () => makeStubLogger(),
}));

const { buildPlugins } = await import("../server");

// ── Env discipline: save/restore everything each test touches ───────

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "DATABASE_URL",
  "STRIPE_STARTER_PRICE_ID",
  "STRIPE_PRO_PRICE_ID",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  errorLogs.length = 0;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function findStripePlugin(plugins: Array<{ id?: string }>) {
  return plugins.find((p) => p.id === "stripe");
}

describe("Stripe plugin enablement (#3447)", () => {
  it("does NOT register the plugin when keys are set but no internal DB is configured, and logs an error", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
    delete process.env.DATABASE_URL;

    const plugins = buildPlugins();

    expect(findStripePlugin(plugins)).toBeUndefined();
    // Same operator-facing style as the webhook-secret branch: name the
    // missing piece and the fix.
    expect(
      errorLogs.some(
        (msg) => msg.includes("no internal database") && msg.includes("DATABASE_URL"),
      ),
    ).toBe(true);
  });

  it("registers the plugin in managed mode (keys + internal DB) — unchanged behavior", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.STRIPE_STARTER_PRICE_ID = "price_starter_test";
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_test";

    const plugins = buildPlugins();

    expect(findStripePlugin(plugins)).toBeDefined();
    expect(errorLogs.filter((msg) => msg.includes("Stripe"))).toEqual([]);
  });

  // #4013 — the registered stripe plugin must NOT declare user.stripeCustomerId
  // in its schema. @better-auth/stripe's getSchema declares it unconditionally,
  // and Atlas runs Better Auth's auto-migrate at boot, so an un-stripped schema
  // would re-add the column that migration 0159 drops on every restart.
  // buildPlugins() strips it via stripPluginUserStripeCustomerIdField.
  it("strips user.stripeCustomerId from the registered stripe plugin's schema (#4013)", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.STRIPE_STARTER_PRICE_ID = "price_starter_test";
    process.env.STRIPE_PRO_PRICE_ID = "price_pro_test";

    const stripe = findStripePlugin(buildPlugins()) as
      | { schema?: { [table: string]: { fields?: Record<string, unknown> } } }
      | undefined;
    expect(stripe).toBeDefined();

    // The user-level customer field is gone…
    expect(stripe?.schema?.user?.fields?.stripeCustomerId).toBeUndefined();
    // …but the org-scoped schema Atlas billing depends on is untouched. These
    // positive assertions are the load-bearing guard: if a plugin upgrade stops
    // declaring organization.stripeCustomerId / subscription (i.e. reshapes the
    // schema), they fail loudly so the strip can be re-evaluated. (A purely
    // *negative* assertion on user.stripeCustomerId can't detect a reshape — it
    // passes vacuously when the path no longer resolves; the strip helper's
    // runtime log.warn covers that version-independent case.)
    expect(stripe?.schema?.organization?.fields?.stripeCustomerId).toBeDefined();
    expect(stripe?.schema?.subscription).toBeDefined();
  });

  it("does NOT register the plugin when STRIPE_WEBHOOK_SECRET is missing, and logs an error (existing branch)", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";

    const plugins = buildPlugins();

    expect(findStripePlugin(plugins)).toBeUndefined();
    expect(errorLogs.some((msg) => msg.includes("STRIPE_WEBHOOK_SECRET"))).toBe(true);
  });

  it("does NOT touch Stripe at all when STRIPE_SECRET_KEY is unset (self-hosted default)", () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.DATABASE_URL;

    const plugins = buildPlugins();

    expect(findStripePlugin(plugins)).toBeUndefined();
    expect(errorLogs.filter((msg) => msg.includes("Stripe") || msg.includes("STRIPE"))).toEqual([]);
  });
});
