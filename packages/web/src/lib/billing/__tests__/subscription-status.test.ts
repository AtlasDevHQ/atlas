import { describe, expect, test } from "bun:test";
import type { BillingSubscription } from "@useatlas/schemas";
import {
  cancelAtPeriodEndNotice,
  hasActiveSubscription,
  subscriptionPresentation,
} from "../subscription-status";

function sub(overrides: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    stripeSubscriptionId: "sub_1",
    plan: "starter",
    status: "active",
    cancelAtPeriodEnd: false,
    periodEnd: null,
    ...overrides,
  };
}

// Identity formatter so date assertions are exact, not locale-dependent.
const fmt = (v: string) => v;

describe("subscriptionPresentation (#3429)", () => {
  test("active → healthy, secondary badge, normal portal label", () => {
    const p = subscriptionPresentation(sub({ status: "active" }));
    expect(p.statusKind).toBe("connected");
    expect(p.badgeVariant).toBe("secondary");
    expect(p.showPortal).toBe(true);
    expect(p.portalLabel).toBe("Open billing portal");
    expect(p.isDelinquent).toBe(false);
  });

  test("trialing renders as healthy, not disconnected", () => {
    const p = subscriptionPresentation(sub({ status: "trialing" }));
    expect(p.statusKind).toBe("connected");
    expect(p.isTrialing).toBe(true);
    expect(p.badgeVariant).toBe("secondary");
  });

  test.each(["past_due", "unpaid", "incomplete"])(
    "%s → unhealthy dot, destructive badge, 'Fix payment' CTA, portal shown",
    (status) => {
      const p = subscriptionPresentation(sub({ status }));
      expect(p.statusKind).toBe("unhealthy");
      expect(p.badgeVariant).toBe("destructive");
      expect(p.isDelinquent).toBe(true);
      expect(p.showPortal).toBe(true);
      expect(p.portalLabel).toBe("Fix payment");
    },
  );

  test.each(["canceled", "incomplete_expired"])(
    "%s → ended, outline badge, portal still reachable",
    (status) => {
      const p = subscriptionPresentation(sub({ status }));
      expect(p.isEnded).toBe(true);
      expect(p.statusKind).toBe("disconnected");
      expect(p.badgeVariant).toBe("outline");
      // Portal reachable whenever a subscription row exists — a canceled
      // customer may still want to resubscribe / view invoices.
      expect(p.showPortal).toBe(true);
    },
  );

  test("unknown Stripe status presents neutrally (not broken)", () => {
    const p = subscriptionPresentation(sub({ status: "paused_2027" }));
    expect(p.statusKind).toBe("connected");
    expect(p.isDelinquent).toBe(false);
    expect(p.showPortal).toBe(true);
  });
});

describe("hasActiveSubscription (#3429)", () => {
  test("null → false", () => {
    expect(hasActiveSubscription(null)).toBe(false);
  });

  test.each(["active", "trialing", "past_due", "unpaid"])(
    "%s is active for the picker (a live plan to change)",
    (status) => {
      expect(hasActiveSubscription(sub({ status }))).toBe(true);
    },
  );

  test.each(["canceled", "incomplete_expired"])(
    "%s is NOT active — picker offers Subscribe, not Upgrade",
    (status) => {
      expect(hasActiveSubscription(sub({ status }))).toBe(false);
    },
  );
});

describe("cancelAtPeriodEndNotice (#3429)", () => {
  test("returns null when not scheduled to cancel", () => {
    expect(cancelAtPeriodEndNotice(sub({ cancelAtPeriodEnd: false }), fmt)).toBeNull();
  });

  test("includes the end date when periodEnd is present", () => {
    const notice = cancelAtPeriodEndNotice(
      sub({ cancelAtPeriodEnd: true, periodEnd: "2026-07-15T00:00:00.000Z" }),
      fmt,
    );
    expect(notice).toContain("2026-07-15T00:00:00.000Z");
    expect(notice).toContain("access ends");
  });

  test("falls back to generic copy when periodEnd is absent", () => {
    const notice = cancelAtPeriodEndNotice(
      sub({ cancelAtPeriodEnd: true, periodEnd: null }),
      fmt,
    );
    expect(notice).toBe("Cancels at the end of the current billing period");
  });

  test("tolerates an older bundle where cancelAtPeriodEnd is undefined", () => {
    const { cancelAtPeriodEnd: _c, ...legacy } = sub();
    expect(cancelAtPeriodEndNotice(legacy as BillingSubscription, fmt)).toBeNull();
  });
});
