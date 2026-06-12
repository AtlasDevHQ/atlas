import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";

import { TrialStatusBannerView } from "../trial-status-banner";
import type { TrialInfo } from "@/ui/hooks/use-trial-status";

/**
 * Tests the pure presentational half (#3434). The container half
 * (TrialStatusBanner) only wires useTrialStatus + useIsAdmin and hides on
 * loading/null — covered by the hook's null-collapsing contract.
 */

const NOW = Date.parse("2026-06-12T12:00:00Z");
const DAY = 86_400_000;

function trial(overrides: Partial<TrialInfo> = {}): TrialInfo {
  return {
    startedAt: new Date(NOW - 9 * DAY).toISOString(),
    endsAt: new Date(NOW + 5 * DAY).toISOString(),
    trialDays: 14,
    expired: false,
    ...overrides,
  };
}

describe("TrialStatusBannerView", () => {
  test("active trial shows the end date and days left", () => {
    const { container } = render(
      <TrialStatusBannerView trial={trial()} isAdmin={false} now={NOW} />,
    );
    const banner = container.querySelector('[data-testid="trial-status-banner"]');
    expect(banner?.getAttribute("data-state")).toBe("active");
    expect(container.textContent).toContain("Free trial — ends");
    expect(container.textContent).toContain("5 days left");
  });

  test("pluralizes a single remaining day", () => {
    const { container } = render(
      <TrialStatusBannerView
        trial={trial({ endsAt: new Date(NOW + 0.5 * DAY).toISOString() })}
        isAdmin={false}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("1 day left");
    expect(container.textContent).not.toContain("1 days");
  });

  test("expired trial tells a member to ask an admin (no Upgrade button)", () => {
    const { container } = render(
      <TrialStatusBannerView
        trial={trial({ endsAt: new Date(NOW - DAY).toISOString(), expired: true })}
        isAdmin={false}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-status-banner"]');
    expect(banner?.getAttribute("data-state")).toBe("expired");
    expect(container.textContent).toContain("Ask a workspace admin to upgrade");
    expect(container.querySelector('a[href="/admin/billing"]')).toBeNull();
  });

  test("expired trial gives an admin the Upgrade link into /admin/billing", () => {
    const { container } = render(
      <TrialStatusBannerView
        trial={trial({ endsAt: new Date(NOW - DAY).toISOString(), expired: true })}
        isAdmin={true}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("Upgrade to restore access");
    const link = container.querySelector('a[href="/admin/billing"]');
    expect(link?.textContent).toBe("Upgrade");
  });

  test("trusts the server's expired flag even if the clock disagrees", () => {
    // Server-side expiry decision (enforcement parity) wins over local clock
    // skew.
    const { container } = render(
      <TrialStatusBannerView
        trial={trial({ endsAt: new Date(NOW + DAY).toISOString(), expired: true })}
        isAdmin={false}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-status-banner"]');
    expect(banner?.getAttribute("data-state")).toBe("expired");
  });

  test("unparseable end date fails closed into expired", () => {
    const { container } = render(
      <TrialStatusBannerView
        trial={trial({ endsAt: "not-a-date" })}
        isAdmin={true}
        now={NOW}
      />,
    );
    const banner = container.querySelector('[data-testid="trial-status-banner"]');
    expect(banner?.getAttribute("data-state")).toBe("expired");
  });
});
