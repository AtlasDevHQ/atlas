import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { TrialCountdownBanner } from "../trial-countdown-banner";
import type { BillingPlan } from "@useatlas/schemas";

/**
 * Coverage maps to the decision tree in `trial-countdown-banner.tsx`:
 *
 *   tier !== "trial"      → null (regression check — paid tiers see nothing)
 *   trialEndsAt === null  → null
 *   trialEndsAt unparseable → null
 *   daysLeft > 3          → info / blue tone, secondary Upgrade
 *   daysLeft 1..3         → warning / amber tone, primary Upgrade
 *   trialEndsAt < now     → danger / red tone, primary Upgrade
 *
 * Each test injects a fixed `now` so the day math is deterministic.
 */

const NOW = Date.parse("2026-05-16T12:00:00Z");
const DAY = 86_400_000;

function plan(overrides: Partial<BillingPlan>): BillingPlan {
  return {
    tier: "trial",
    displayName: "Trial",
    pricePerSeat: 0,
    defaultModel: "anthropic/claude-sonnet-4.6",
    byot: false,
    trialEndsAt: new Date(NOW + 10 * DAY).toISOString(),
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

  test("hidden when trialEndsAt is null", () => {
    const { container } = render(
      <TrialCountdownBanner plan={plan({ trialEndsAt: null })} now={NOW} />,
    );
    expect(container.textContent).toBe("");
  });

  test("hidden when trialEndsAt is unparseable", () => {
    const { container } = render(
      <TrialCountdownBanner plan={plan({ trialEndsAt: "not-a-date" })} now={NOW} />,
    );
    expect(container.textContent).toBe("");
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
