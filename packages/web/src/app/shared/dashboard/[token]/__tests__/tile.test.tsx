import type React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { SharedCard } from "../types";

// The text branch never mounts a chart, but `dynamic(...)` + `useDarkMode` run
// at import — stub them so jsdom doesn't try to evaluate recharts. The ResultChart
// stub surfaces `embedded` / `chartType` (#4688) via data-attrs so a chart-card
// test can assert the shared tile suppresses ResultChart's chrome + pins the type.
// The next/dynamic stub invokes the loader (so the real mocked ResultChart is what
// renders) and falls back until it resolves — the test `rerender`s past that.
void mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: ({ embedded, chartType }: { embedded?: boolean; chartType?: string }) => (
    <div
      data-testid="result-chart"
      data-embedded={embedded ? "true" : "false"}
      data-chart-type={chartType ?? ""}
    >
      chart
    </div>
  ),
}));
void mock.module("next/dynamic", () => ({
  default: (loader: () => Promise<{ default: React.ComponentType }>) => {
    let Comp: React.ComponentType | null = null;
    void loader().then((m) => {
      Comp = m.default;
    });
    return function DynStub(props: Record<string, unknown>) {
      return Comp ? <Comp {...props} /> : <div data-testid="result-chart-loading">loading</div>;
    };
  },
}));
void mock.module("@/ui/hooks/use-dark-mode", () => ({ useDarkMode: () => false }));

import { SharedTile } from "../tile";

const textCard: SharedCard = {
  id: "t1",
  title: "Top of funnel",
  kind: "text",
  chartConfig: null,
  content: "## Top of funnel\n\nLeads entering the pipeline.",
  annotations: [],
  cachedColumns: null,
  cachedRows: null,
  cachedAt: null,
  position: 0,
  layout: null,
};

describe("SharedTile — text cards (#3138)", () => {
  afterEach(cleanup);

  test("renders markdown for a shared text card instead of the empty-data placeholder", () => {
    const { container } = render(
      <SharedTile card={textCard} spanClass="col-span-2" cachedLabel={null} cachedIso={undefined} />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("Top of funnel");
    expect(container.textContent).toContain("Leads entering the pipeline.");
    expect(container.textContent).not.toContain("No data available");
    expect(screen.queryByTestId("result-chart")).toBeNull();
  });

  test("spans full-width regardless of the inherited (half-width) spanClass", () => {
    // The shared view passes a half-width span for a layout-less tile; a text
    // band must override it so it reads as a banner over the charts below.
    const { container } = render(
      <SharedTile card={textCard} spanClass="md:col-span-1" cachedLabel={null} cachedIso={undefined} />,
    );
    const tile = container.querySelector('[data-card-kind="text"]');
    expect(tile?.className).toContain("md:col-span-2");
    expect(tile?.className).not.toContain("md:col-span-1");
  });

  test("strips markdown images on the public surface (no tracking-pixel fetch)", () => {
    const card = { ...textCard, content: "## Header\n\n![x](https://attacker.example/track.png)" };
    const { container } = render(
      <SharedTile card={card} spanClass="col-span-2" cachedLabel={null} cachedIso={undefined} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("SharedTile — chart cards (#4688 chrome-in-chrome)", () => {
  afterEach(cleanup);

  const chartCard: SharedCard = {
    id: "c1",
    title: "Signups by week",
    kind: "chart",
    chartConfig: { type: "bar", categoryColumn: "week", valueColumns: ["signups"] },
    content: null,
    annotations: [],
    cachedColumns: ["week", "signups"],
    cachedRows: [
      { week: "2026-01-05", signups: 10 },
      { week: "2026-01-12", signups: 24 },
    ],
    cachedAt: "2026-04-25T12:00:00Z",
    position: 0,
    layout: null,
  };

  test("renders ResultChart in embedded mode and pins it to the card's chart type", async () => {
    // The card is saved `type: "bar"`; the shared tile owns the title/frame, so
    // ResultChart renders the plot only (embedded) pinned to bar — not the data's
    // auto-detected line.
    const props = { card: chartCard, spanClass: "col-span-2", cachedLabel: null, cachedIso: undefined };
    const { rerender } = render(<SharedTile {...props} />);
    // Flush the dynamic loader's promise chain (import() → .then), then re-render
    // so DynStub swaps its fallback for the resolved (mocked) ResultChart.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender(<SharedTile {...props} />);
    const chart = screen.getByTestId("result-chart");
    expect(chart.getAttribute("data-embedded")).toBe("true");
    expect(chart.getAttribute("data-chart-type")).toBe("bar");
  });
});
