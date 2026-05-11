/**
 * Regression guard for `ByotKeyStatus` (#2172).
 *
 * Toggling BYOT on used to leave the user staring at a flipped switch with
 * no path to the actual key form. This component is the missing bridge:
 * a warning when the toggle is on but no key is configured, a confirmation
 * row when one is, and a docs link in both cases. Losing any of those is
 * the regression that #2172 was filed against.
 */

import { describe, expect, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { ByotKeyStatus } from "../page";

function rendered(props: { byot: boolean; configuredKey: { provider: string; model: string } | null }) {
  return render(createElement(ByotKeyStatus, props));
}

describe("ByotKeyStatus", () => {
  test("renders nothing when BYOT is off", () => {
    const { container } = rendered({ byot: false, configuredKey: null });
    expect(container.textContent).toBe("");
    cleanup();
  });

  test("renders the warning + CTA when BYOT is on and no key is configured", () => {
    const { container, getByRole } = rendered({ byot: true, configuredKey: null });
    const alert = getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain("no API key configured");
    expect(alert.textContent).toContain("platform default");

    const cta = container.querySelector('a[href="/platform/model-config"]');
    expect(cta).toBeTruthy();
    expect(cta?.textContent).toContain("Add your API key");

    expect(container.textContent).toContain("Learn about BYOT");
    cleanup();
  });

  test("renders the confirmation + Manage link when BYOT is on with a configured key", () => {
    const { container } = rendered({
      byot: true,
      configuredKey: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(container.textContent).toContain("Using your");
    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("claude-sonnet-4-6");

    const manage = container.querySelector('a[href="/platform/model-config"]');
    expect(manage).toBeTruthy();
    expect(manage?.textContent).toContain("Manage");

    expect(container.textContent).toContain("Learn about BYOT");
    cleanup();
  });

  test("falls back to the raw provider key when no human label exists", () => {
    const { container } = rendered({
      byot: true,
      configuredKey: { provider: "unknown-provider", model: "gpt-99" },
    });
    expect(container.textContent).toContain("unknown-provider");
    expect(container.textContent).toContain("gpt-99");
    cleanup();
  });
});
