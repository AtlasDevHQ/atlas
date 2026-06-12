import { describe, expect, test, beforeEach, mock, type Mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";

// The Upgrade CTA navigates via next's router when the plan-picker anchor
// isn't on the current page (#3418).
const mockPush: Mock<(href: string) => void> = mock(() => {});
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { TrialCountdownBanner, TRIAL_BANNER_PLAN_ANCHOR_ID } from "../trial-countdown-banner";
import type { BillingPlan } from "@useatlas/schemas";

/**
 * Coverage maps to the decision tree in `trial-countdown-banner.tsx`:
 *
 *   tier !== "trial"      → null (regression check — paid tiers see nothing)
 *   trialEndsAt === null  → null
 *   trialEndsAt unparseable → danger (fail-closed — show upgrade nudge)
 *   daysLeft > 3          → info / blue tone, secondary Upgrade
 *   daysLeft 1..3         → warning / amber tone, primary Upgrade
 *   trialEndsAt < now     → danger / red tone, primary Upgrade
 *
 * The day=3 vs day=4 boundary is explicitly pinned so a refactor of the
 * `<= 3` comparator can't silently shift the copy.
 *
 * Each test injects a fixed `now` so the day math is deterministic.
 */

const NOW = Date.parse("2026-05-16T12:00:00Z");
const DAY = 86_400_000;

function plan(overrides: Partial<BillingPlan>): BillingPlan {
  const trialEndsAt =
    "trialEndsAt" in overrides ? overrides.trialEndsAt ?? null : new Date(NOW + 10 * DAY).toISOString();
  return {
    tier: "trial",
    displayName: "Trial",
    pricePerSeat: 0,
    defaultModel: "anthropic/claude-sonnet-4.6",
    byot: false,
    trialEndsAt,
    // Mirror the API: trialEndsAtEffective defaults to trialEndsAt unless a
    // test overrides it (the NULL-trial_ends_at fallback cases).
    trialEndsAtEffective: trialEndsAt,
    trialDays: 14,
    ...overrides,
  };
}

describe("TrialCountdownBanner", () => {
  test("hidden for non-trial tier (paid plan regression check)", () => {
    const { container } = render(
      <TrialCountdownBanner plan={plan({ tier: "pro" })} now={NOW} />,
    );
    expect(container.textContent).toBe("");
    expect(container.querySelector('[data-testid="trial-countdown-banner"]')).toBeNull();
  });

  test("hidden when both trialEndsAt and trialEndsAtEffective are null", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: null, trialEndsAtEffective: null })}
        now={NOW}
      />,
    );
    expect(container.textContent).toBe("");
  });

  test("renders from trialEndsAtEffective when trialEndsAt is null (#3434 blind spot)", () => {
    // The NULL-trial_ends_at workspace: enforcement falls back to
    // createdAt + TRIAL_DAYS, and the API surfaces that as the effective
    // end. The banner must render the same clock enforcement uses.
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({
          trialEndsAt: null,
          trialEndsAtEffective: new Date(NOW + 2 * DAY).toISOString(),
        })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("warning");
    expect(container.textContent).toContain("Trial ending in 2 days.");
  });

  test("prefers trialEndsAtEffective over trialEndsAt when both are set", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({
          trialEndsAt: new Date(NOW + 10 * DAY).toISOString(),
          trialEndsAtEffective: new Date(NOW - DAY).toISOString(),
        })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("danger");
  });

  test("falls back to trialEndsAt when the effective field is absent (older API)", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({
          trialEndsAt: new Date(NOW + 10 * DAY).toISOString(),
          trialEndsAtEffective: undefined,
        })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("info");
  });

  test("sources the trial length from the wire payload, not a hardcoded 14", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialDays: 30, trialEndsAt: new Date(NOW + 10 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("You're on a 30-day Atlas trial.");
  });

  test("omits the day count when trialDays is absent from the payload", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialDays: null, trialEndsAt: new Date(NOW + 10 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("You're on an Atlas trial. 10 days left.");
  });

  test("pluralizes correctly with 1 day left (copy nit, #3434)", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW + 0.5 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("Trial ending in 1 day.");
    expect(container.textContent).not.toContain("1 days");
  });

  test("unparseable trialEndsAt fails closed into the expired (danger) state", () => {
    // Documents the deliberate fail-closed behavior: an upstream Zod-schema
    // bug ships a malformed date, the user still sees the upgrade nudge
    // instead of a silently-skipped banner.
    const { container } = render(
      <TrialCountdownBanner plan={plan({ trialEndsAt: "not-a-date" })} now={NOW} />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("danger");
    expect(container.textContent).toContain("Your trial has expired. Upgrade to keep using Atlas.");
  });

  test("info tone with secondary Upgrade for >3 days remaining", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW + 10 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("data-tone")).toBe("info");
    expect(container.textContent).toContain("You're on a 14-day Atlas trial. 10 days left.");
    // Secondary variant — not the primary destructive Upgrade
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Upgrade");
    // shadcn Button secondary variant carries `bg-secondary` in its class list
    expect(button?.className).toContain("bg-secondary");
  });

  test("warning tone with primary Upgrade at ≤3 days remaining", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW + 2 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("warning");
    expect(container.textContent).toContain("Trial ending in 2 days.");
    const button = container.querySelector("button");
    // Primary variant — `bg-primary`, NOT `bg-secondary`
    expect(button?.className).toContain("bg-primary");
    expect(button?.className).not.toContain("bg-secondary");
  });

  test("warning tone rounds partial-day boundary up via Math.ceil", () => {
    // 2.5 days out → ceil → 3 → ending bucket
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW + 2.5 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("warning");
    expect(container.textContent).toContain("Trial ending in 3 days.");
  });

  test("exactly 3 days out lives in the warning bucket (boundary pin)", () => {
    // The `<= 3` predicate is the inclusive edge — pin it so a refactor
    // to `< 3` shifts a regression into a failing assertion instead of
    // silently flipping the copy.
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW + 3 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("warning");
    expect(container.textContent).toContain("Trial ending in 3 days.");
  });

  test("3 days + 1ms crosses into the info bucket (boundary pin)", () => {
    // Math.ceil takes (3*DAY + 1ms) / DAY → 4, which exceeds 3 and
    // routes to early. Pinning the +1ms edge guards the inverse refactor
    // (changing `<= 3` to `<= 4`) from silently widening the amber band.
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW + 3 * DAY + 1).toISOString() })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("info");
    expect(container.textContent).toContain("You're on a 14-day Atlas trial. 4 days left.");
  });

  test("danger tone with expired copy when trialEndsAt < now", () => {
    const { container } = render(
      <TrialCountdownBanner
        plan={plan({ trialEndsAt: new Date(NOW - 1 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-countdown-banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("danger");
    expect(container.textContent).toContain("Your trial has expired. Upgrade to keep using Atlas.");
    const button = container.querySelector("button");
    expect(button?.className).toContain("bg-primary");
  });
});

describe("TrialCountdownBanner — Upgrade CTA navigation (#3418)", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  test("navigates to /admin/billing#anchor when the plan-picker anchor is absent (e.g. /admin)", () => {
    const { getByRole } = render(
      <TrialCountdownBanner plan={plan({})} now={NOW} />,
    );
    fireEvent.click(getByRole("button", { name: "Upgrade" }));
    expect(mockPush).toHaveBeenCalledWith(`/admin/billing#${TRIAL_BANNER_PLAN_ANCHOR_ID}`);
  });

  test("scrolls in place when the anchor exists on the page (/admin/billing)", () => {
    const anchor = document.createElement("section");
    anchor.id = TRIAL_BANNER_PLAN_ANCHOR_ID;
    const scrollSpy = mock(() => {});
    anchor.scrollIntoView = scrollSpy as unknown as typeof anchor.scrollIntoView;
    document.body.appendChild(anchor);
    try {
      const { getByRole } = render(
        <TrialCountdownBanner plan={plan({})} now={NOW} />,
      );
      fireEvent.click(getByRole("button", { name: "Upgrade" }));
      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(mockPush).not.toHaveBeenCalled();
    } finally {
      anchor.remove();
    }
  });
});
