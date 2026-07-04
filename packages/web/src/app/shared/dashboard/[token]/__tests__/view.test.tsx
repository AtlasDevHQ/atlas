import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { SharedDashboard } from "../types";

// SharedTile mounts a dynamic chart + useDarkMode at import; stub them so an
// empty-card board renders in jsdom without pulling recharts. (The summary UI
// under test lives in the header and renders regardless of the card grid.)
mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
}));
mock.module("next/dynamic", () => ({
  default: () => () => <div data-testid="result-chart">chart</div>,
}));
mock.module("@/ui/hooks/use-dark-mode", () => ({ useDarkMode: () => false }));

import { SharedDashboardView } from "../view";

function dashboard(over: Partial<SharedDashboard> = {}): SharedDashboard {
  return {
    title: "Revenue",
    description: null,
    shareMode: "public",
    cards: [],
    parameterSummary: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    lastRefreshAt: null,
    ...over,
  };
}

describe("SharedDashboardView — frozen parameter summary (#4316)", () => {
  afterEach(cleanup);

  test("renders each { label, displayValue } as a static chip", () => {
    render(
      <SharedDashboardView
        dashboard={dashboard({
          parameterSummary: [
            { label: "Date", displayValue: "Jun 1 – Jul 1" },
            { label: "Region", displayValue: "All" },
          ],
        })}
      />,
    );
    const summary = screen.getByLabelText("Snapshot parameters");
    expect(summary.textContent).toContain("Date");
    expect(summary.textContent).toContain("Jun 1 – Jul 1");
    expect(summary.textContent).toContain("Region");
    expect(summary.textContent).toContain("All");
    // Display-only: no interactive controls on the shared surface.
    expect(summary.querySelector("input")).toBeNull();
    expect(summary.querySelector("button")).toBeNull();
    expect(summary.querySelector("select")).toBeNull();
  });

  test("omits the summary block entirely when there are no parameters", () => {
    render(<SharedDashboardView dashboard={dashboard({ parameterSummary: [] })} />);
    expect(screen.queryByLabelText("Snapshot parameters")).toBeNull();
  });

  test("tolerates an older API payload that omits parameterSummary (deploy overlap)", () => {
    const legacy = dashboard();
    delete (legacy as { parameterSummary?: unknown }).parameterSummary;
    // Must not throw on the `.map` — the `?? []` fallback covers the missing field.
    render(<SharedDashboardView dashboard={legacy} />);
    expect(screen.queryByLabelText("Snapshot parameters")).toBeNull();
  });
});
