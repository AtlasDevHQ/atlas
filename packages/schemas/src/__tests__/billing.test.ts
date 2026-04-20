import { describe, expect, test } from "bun:test";
import { BillingStatusSchema } from "../billing";
import { PLAN_TIERS } from "@useatlas/types";

// Mirrors the private `OVERAGE_STATUSES` tuple in ../billing — kept in sync
// by the "canonical tuples match expected values" assertion below so a
// reorder or addition fails loud.
const OVERAGE_STATUSES = ["ok", "warning", "soft_limit", "hard_limit"] as const;

const validStatus = {
  workspaceId: "org_1",
  plan: {
    tier: "starter" as const,
    displayName: "Starter",
    pricePerSeat: 29,
    defaultModel: "claude-haiku-4-5",
    byot: false,
    trialEndsAt: null,
  },
  limits: {
    tokenBudgetPerSeat: 2_000_000,
    totalTokenBudget: 20_000_000,
    maxSeats: 10,
    maxConnections: 1,
  },
  usage: {
    queryCount: 423,
    tokenCount: 1_240_000,
    seatCount: 4,
    tokenUsagePercent: 15,
    tokenOverageStatus: "ok" as const,
    periodStart: "2026-04-01T00:00:00.000Z",
    periodEnd: "2026-04-30T23:59:59.000Z",
  },
  seats: { count: 4, max: 10 },
  connections: { count: 1, max: 1 },
  currentModel: "claude-haiku-4-5",
  overagePerMillionTokens: 1.0,
  subscription: {
    stripeSubscriptionId: "sub_123",
    plan: "starter_monthly",
    status: "active",
  },
};

const selfHostedStatus = {
  ...validStatus,
  plan: { ...validStatus.plan, tier: "free" as const, displayName: "Self-Hosted" },
  limits: {
    tokenBudgetPerSeat: null,
    totalTokenBudget: null,
    maxSeats: null,
    maxConnections: null,
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
});

// ---------------------------------------------------------------------------
// Enum strict rejection — web previously relaxed plan.tier and
// usage.tokenOverageStatus to z.string(). Pinning to z.enum(TUPLE) means a
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

  test("unknown tokenOverageStatus fails parse", () => {
    const drifted = {
      ...validStatus,
      usage: { ...validStatus.usage, tokenOverageStatus: "exceeded" },
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

  test("all OVERAGE_STATUSES values parse as tokenOverageStatus", () => {
    for (const status of OVERAGE_STATUSES) {
      expect(
        BillingStatusSchema.parse({
          ...validStatus,
          usage: { ...validStatus.usage, tokenOverageStatus: status },
        }).usage.tokenOverageStatus,
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
    expect(OVERAGE_STATUSES).toEqual(["ok", "warning", "soft_limit", "hard_limit"]);
  });
});

describe("structural rejection", () => {
  test("BillingStatusSchema rejects missing usage.tokenOverageStatus", () => {
    const { tokenOverageStatus: _t, ...partialUsage } = validStatus.usage;
    const drifted = { ...validStatus, usage: partialUsage };
    expect(BillingStatusSchema.safeParse(drifted).success).toBe(false);
  });

  test("BillingStatusSchema rejects missing subscription field", () => {
    const { subscription: _s, ...missing } = validStatus;
    expect(BillingStatusSchema.safeParse(missing).success).toBe(false);
  });

  test("BillingStatusSchema requires seats / connections / currentModel / overagePerMillionTokens", () => {
    const { seats: _s, ...missing } = validStatus;
    expect(BillingStatusSchema.safeParse(missing).success).toBe(false);
  });
});
