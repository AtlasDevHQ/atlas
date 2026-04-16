import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import type { ModeStatusResponse } from "@useatlas/types/mode";

// Controls for the mocked hooks — mutate per-test before rendering.
const modeState = {
  isAdmin: false,
  isLoading: false,
};
let modeStatusState: {
  data: ModeStatusResponse | null;
  loading: boolean;
} = { data: null, loading: false };

mock.module("@/ui/hooks/use-mode", () => ({
  useMode: () => ({ ...modeState, mode: "published", setMode: () => {} }),
}));

mock.module("@/ui/hooks/use-mode-status", () => ({
  useModeStatus: () => modeStatusState,
}));

// Import AFTER mocks so the module binds to the mocked hooks.
import { DemoIndicatorChip } from "../components/demo-indicator-chip";

function activeMode(industry: string | null): ModeStatusResponse {
  return {
    mode: "published",
    canToggle: false,
    demoIndustry: industry,
    demoConnectionActive: industry !== null,
    hasDrafts: false,
    draftCounts: null,
  };
}

describe("DemoIndicatorChip", () => {
  beforeEach(() => {
    modeState.isAdmin = false;
    modeState.isLoading = false;
    modeStatusState = { data: null, loading: false };
  });

  afterEach(() => {
    cleanup();
  });

  test("renders label when demoConnectionActive with known industry", () => {
    modeStatusState = { data: activeMode("cybersecurity"), loading: false };
    const { container, getByLabelText } = render(<DemoIndicatorChip />);
    expect(container.textContent).toContain("Sentinel Security demo");
    // Assert the accessibility attributes so a regression that drops them
    // (e.g. switching to a generic span) fails loudly.
    const chip = getByLabelText("Demo dataset: Sentinel Security");
    expect(chip.getAttribute("title")).toBe("You are viewing the Sentinel Security demo dataset");
  });

  test("renders SaaS CRM label for saas industry", () => {
    modeStatusState = { data: activeMode("saas"), loading: false };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toContain("SaaS CRM demo");
  });

  test("renders NovaMart label for ecommerce industry", () => {
    modeStatusState = { data: activeMode("ecommerce"), loading: false };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toContain("NovaMart demo");
  });

  test("hides when no demo connection is active (archived)", () => {
    modeStatusState = {
      data: {
        mode: "published",
        canToggle: false,
        demoIndustry: "cybersecurity",
        demoConnectionActive: false,
        hasDrafts: false,
        draftCounts: null,
      },
      loading: false,
    };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");
  });

  test("hides when org never selected demo data (null industry)", () => {
    modeStatusState = { data: activeMode(null), loading: false };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");
  });

  test("hides for admin users", () => {
    modeState.isAdmin = true;
    modeStatusState = { data: activeMode("cybersecurity"), loading: false };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");
  });

  test("hides while session is loading to avoid flash of wrong state", () => {
    modeState.isLoading = true;
    modeStatusState = { data: activeMode("cybersecurity"), loading: false };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");
  });

  test("hides while mode status is loading", () => {
    modeStatusState = { data: null, loading: true };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");
  });

  test("hides for unknown industry slug to avoid leaking raw slugs", () => {
    modeStatusState = { data: activeMode("unknown-vertical"), loading: false };
    const { container } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");
  });

  test("updates when mode status transitions to active", async () => {
    modeStatusState = { data: activeMode(null), loading: false };
    const { container, rerender } = render(<DemoIndicatorChip />);
    expect(container.textContent).toBe("");

    modeStatusState = { data: activeMode("cybersecurity"), loading: false };
    rerender(<DemoIndicatorChip />);
    await waitFor(() => {
      expect(container.textContent).toContain("Sentinel Security demo");
    });
  });
});
