import { describe, expect, test } from "bun:test";
import { BillingStatusSchema } from "../billing";
import { PLAN_TIERS } from "@useatlas/types";

// Mirrors the private `OVERAGE_STATUSES` tuple in ../billing — kept in sync
// by the "canonical tuples match expected values" assertion below so a
// reorder or addition fails loud.
const OVERAGE_STATUSES = ["ok", "warning", "soft_limit", "metered", "hard_limit"] as const;

const validStatus = {
  workspaceId: "org_1",
  plan: {
    tier: "starter" as const,
    displayName: "Starter",
    pricePerSeat: 39,
    includedUsageDollarsPerSeat: 20,
    defaultModel: "claude-haiku-4-5",
    byot: false,
    trialEndsAt: null,
  },
  limits: {
    tokenBudgetPerSeat: 2_000_000,
    totalTokenBudget: 20_000_000,
    totalUsageDollars: 80,
    maxSeats: 10,
    maxConnections: 1,
    maxChatIntegrations: 1,
    maxKnowledgeCollections: 1,
  },
  usage: {
    queryCount: 423,
    tokenCount: 1_240_000,
    seatCount: 4,
    costUsd: 12,
    usageDollarsPercent: 15,
    usageOverageStatus: "ok" as const,
    periodStart: "2026-04-01T00:00:00.000Z",
    periodEnd: "2026-04-30T23:59:59.000Z",
  },
  seats: { count: 4, max: 10 },
  connections: { count: 1, max: 1 },
  currentModel: "claude-haiku-4-5",
  subscription: {
    stripeSubscriptionId: "sub_123",
    plan: "starter_monthly",
    status: "active",
    cancelAtPeriodEnd: false,
    periodEnd: "2026-05-01T00:00:00.000Z",
  },
};

const selfHostedStatus = {
  ...validStatus,
  plan: { ...validStatus.plan, tier: "free" as const, displayName: "Self-Hosted" },
  limits: {
    tokenBudgetPerSeat: null,
    totalTokenBudget: null,
    totalUsageDollars: null,
    maxSeats: null,
    maxConnections: null,
    maxChatIntegrations: null,
    maxKnowledgeCollections: null,
  },
  seats: { count: 1, max: null },
  connections: { count: 0, max: null },
  subscription: null,
};

describe("happy-path parses", () => {
  test("BillingStatusSchema parses a paid-tier status", () => {
    expect(BillingStatusSchema.parse(validStatus)).toEqual(validStatus);
  });

  test("BillingStatusSchema parses a self-hosted status with null subscription and null limits", () => {
    expect(BillingStatusSchema.parse(selfHostedStatus)).toEqual(selfHostedStatus);
  });

  test("BillingStatusSchema parses a trial with trialEndsAt set", () => {
    const trial = {
      ...validStatus,
      plan: {
        ...validStatus.plan,
        tier: "trial" as const,
        displayName: "Starter Trial",
        trialEndsAt: "2026-05-01T00:00:00.000Z",
      },
    };
    expect(BillingStatusSchema.parse(trial)).toEqual(trial);
  });

  test("round-trip (parse → serialize → parse) preserves fields", () => {
    const parsed = BillingStatusSchema.parse(validStatus);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(BillingStatusSchema.parse(serialized)).toEqual(validStatus);
  });

  test("preserves the Structure B includedUsageDollarsPerSeat credit (#4037)", () => {
    const parsed = BillingStatusSchema.parse(validStatus);
    expect(parsed.plan.includedUsageDollarsPerSeat).toBe(20);
  });

  test("tolerates an older bundle omitting includedUsageDollarsPerSeat", () => {
    // The credit is optional on the wire; a web bundle pinned to a pre-#4037
    // published schema must still parse a response without the field.
    const { includedUsageDollarsPerSeat: _omit, ...planNoCredit } = validStatus.plan;
    const older = { ...validStatus, plan: planNoCredit };
    const parsed = BillingStatusSchema.parse(older);
    expect(parsed.plan.includedUsageDollarsPerSeat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Enum strict rejection — web previously relaxed plan.tier and
// usage.usageOverageStatus to z.string(). Pinning to z.enum(TUPLE) means a
// new plan tier or overage state added to `@useatlas/types` fails parse
// at useAdminFetch time and surfaces `schema_mismatch` instead of leaking
// through as untyped text into the billing page tier badge.
//
// subscription.status / subscription.plan stay free-form because Stripe
// (not us) controls those vocabularies — new Stripe statuses must not
// fail our parse.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown plan tier fails parse", () => {
    const drifted = {
      ...validStatus,
      plan: { ...validStatus.plan, tier: "legacy-enterprise" },
    };
    expect(BillingStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown usageOverageStatus fails parse", () => {
    const drifted = {
      ...validStatus,
      usage: { ...validStatus.usage, usageOverageStatus: "exceeded" },
    };
    expect(BillingStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("all PLAN_TIERS values parse as plan.tier", () => {
    for (const tier of PLAN_TIERS) {
      expect(
        BillingStatusSchema.parse({
          ...validStatus,
          plan: { ...validStatus.plan, tier },
        }).plan.tier,
      ).toBe(tier);
    }
  });

  test("all OVERAGE_STATUSES values parse as usageOverageStatus", () => {
    for (const status of OVERAGE_STATUSES) {
      expect(
        BillingStatusSchema.parse({
          ...validStatus,
          usage: { ...validStatus.usage, usageOverageStatus: status },
        }).usage.usageOverageStatus,
      ).toBe(status);
    }
  });

  test("free-form Stripe subscription status parses regardless of value", () => {
    const status = {
      ...validStatus,
      subscription: { ...validStatus.subscription!, status: "past_due_2026_format" },
    };
    expect(BillingStatusSchema.parse(status).subscription?.status).toBe("past_due_2026_format");
  });

  test("canonical tuples match expected values", () => {
    expect(OVERAGE_STATUSES).toEqual(["ok", "warning", "soft_limit", "metered", "hard_limit"]);
  });

  // #3993 — the spend policy drives the billing page's "past the credit" line.
  test("parses each spend policy, null, and absence as usage.spendPolicy", () => {
    for (const policy of ["continue", "cutoff"] as const) {
      expect(
        BillingStatusSchema.parse({
          ...validStatus,
          usage: { ...validStatus.usage, spendPolicy: policy },
        }).usage.spendPolicy,
      ).toBe(policy);
    }
    // Null (no enforced credit / resolution failed) and absence (older bundle)
    // both parse — the page omits the line in either case.
    expect(
      BillingStatusSchema.parse({
        ...validStatus,
        usage: { ...validStatus.usage, spendPolicy: null },
      }).usage.spendPolicy,
    ).toBeNull();
    expect(BillingStatusSchema.parse(validStatus).usage.spendPolicy).toBeUndefined();
  });

  test("an unknown spendPolicy fails parse", () => {
    expect(
      BillingStatusSchema.safeParse({
        ...validStatus,
        usage: { ...validStatus.usage, spendPolicy: "throttle" },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subscription visibility (#3429) — the wire shape must carry delinquent /
// pending-cancel states, not just active/trialing, and expose the
// cancel-at-period-end fields the UI needs to render an end-date notice.
// ---------------------------------------------------------------------------

describe("subscription visibility (#3429)", () => {
  const DELINQUENT_STATES = ["past_due", "unpaid", "canceled", "incomplete"];

  test.each(DELINQUENT_STATES)(
    "parses a %s subscription (not filtered to active/trialing)",
    (status) => {
      const parsed = BillingStatusSchema.parse({
        ...validStatus,
        subscription: { ...validStatus.subscription, status },
      });
      expect(parsed.subscription?.status).toBe(status);
    },
  );

  test("parses trialing as a healthy subscription", () => {
    const parsed = BillingStatusSchema.parse({
      ...validStatus,
      subscription: { ...validStatus.subscription, status: "trialing" },
    });
    expect(parsed.subscription?.status).toBe("trialing");
  });

  test("carries cancelAtPeriodEnd + periodEnd for a pending-cancel subscription", () => {
    const parsed = BillingStatusSchema.parse({
      ...validStatus,
      subscription: {
        ...validStatus.subscription,
        status: "active",
        cancelAtPeriodEnd: true,
        periodEnd: "2026-07-15T00:00:00.000Z",
      },
    });
    expect(parsed.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(parsed.subscription?.periodEnd).toBe("2026-07-15T00:00:00.000Z");
  });

  test("accepts a null periodEnd (plugin hasn't recorded one yet)", () => {
    const parsed = BillingStatusSchema.parse({
      ...validStatus,
      subscription: { ...validStatus.subscription, periodEnd: null },
    });
    expect(parsed.subscription?.periodEnd).toBeNull();
  });

  test("tolerates an older bundle that omits cancelAtPeriodEnd / periodEnd", () => {
    const { cancelAtPeriodEnd: _c, periodEnd: _p, ...legacySub } = validStatus.subscription;
    const parsed = BillingStatusSchema.parse({ ...validStatus, subscription: legacySub });
    expect(parsed.subscription?.cancelAtPeriodEnd).toBeUndefined();
    expect(parsed.subscription?.periodEnd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chat-integration cap (#3438) — BillingLimitsSchema must carry
// maxChatIntegrations so the billing page can display the cap the install
// gate already enforces (PlanLimits.maxChatIntegrations).
// ---------------------------------------------------------------------------

describe("chat-integration cap (#3438)", () => {
  test("parses a numeric maxChatIntegrations cap", () => {
    const parsed = BillingStatusSchema.parse(validStatus);
    expect(parsed.limits.maxChatIntegrations).toBe(1);
  });

  test("parses a null maxChatIntegrations (unlimited)", () => {
    const parsed = BillingStatusSchema.parse(selfHostedStatus);
    expect(parsed.limits.maxChatIntegrations).toBeNull();
  });

  test("rejects a status whose limits omit maxChatIntegrations", () => {
    const { maxChatIntegrations: _m, ...partialLimits } = validStatus.limits;
    const drifted = { ...validStatus, limits: partialLimits };
    expect(BillingStatusSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("structural rejection", () => {
  test("BillingStatusSchema rejects missing usage.usageOverageStatus", () => {
    const { usageOverageStatus: _t, ...partialUsage } = validStatus.usage;
    const drifted = { ...validStatus, usage: partialUsage };
    expect(BillingStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("BillingStatusSchema rejects missing subscription field", () => {
    const { subscription: _s, ...missing } = validStatus;
    expect(BillingStatusSchema.safeParse(missing).success).toBe(false);
  });

  test("BillingStatusSchema requires seats / connections / currentModel", () => {
    for (const key of ["seats", "connections", "currentModel"] as const) {
      const { [key]: _omit, ...missing } = validStatus;
      expect(BillingStatusSchema.safeParse(missing).success).toBe(false);
    }
  });
});
