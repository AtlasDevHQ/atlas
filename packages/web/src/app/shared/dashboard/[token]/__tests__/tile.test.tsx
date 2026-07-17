import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { SharedCard } from "../types";

// The text branch never mounts a chart, but `dynamic(...)` + `useDarkMode` run
// at import — stub them so jsdom doesn't try to evaluate recharts. The chart stub
// echoes its resolved `dark` prop so the forced-theme threading is assertable
// (#4686). `next/dynamic` returns the same stub the direct import path uses.
function ChartStub({ dark }: { dark?: boolean }) {
  return <div data-testid="result-chart" data-dark={String(dark)} />;
}
void mock.module("@/ui/components/chart/result-chart", () => ({ ResultChart: ChartStub }));
void mock.module("next/dynamic", () => ({ default: () => ChartStub }));
// The VISITOR's system theme resolves light here; a forced embed theme must win
// over it, which is exactly what the #4686 threading test pins.
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

const chartCard: SharedCard = {
  id: "c1",
  title: "Signups by week",
  kind: "chart",
  chartConfig: { type: "bar", categoryColumn: "week", valueColumns: ["signups"] },
  content: null,
  annotations: [],
  cachedColumns: ["week", "signups"],
  cachedRows: [
    { week: "2026-06-01", signups: 12 },
    { week: "2026-06-08", signups: 18 },
  ],
  cachedAt: "2026-06-08T00:00:00.000Z",
  position: 0,
  layout: null,
};

describe("SharedTile — forced embed theme threads into the chart (#4686)", () => {
  afterEach(cleanup);

  // The chart mounts through `next/dynamic`, so its stub resolves on the next
  // microtask — `findByTestId` waits it out. `data-dark` echoes the resolved
  // `dark` prop the tile hands the chart.
  test("forcedDark=true renders a dark chart even though the visitor's system is light", async () => {
    // useDarkMode() is mocked to `false` (light visitor); the forced embed theme
    // must override it so the JS-themed chart agrees with the dark chrome.
    render(
      <SharedTile card={chartCard} spanClass="col-span-1" cachedLabel={null} cachedIso={undefined} forcedDark />,
    );
    const chart = await screen.findByTestId("result-chart");
    expect(chart.getAttribute("data-dark")).toBe("true");
  });

  test("forcedDark=false renders a light chart regardless of the visitor's own theme", async () => {
    render(
      <SharedTile
        card={chartCard}
        spanClass="col-span-1"
        cachedLabel={null}
        cachedIso={undefined}
        forcedDark={false}
      />,
    );
    const chart = await screen.findByTestId("result-chart");
    expect(chart.getAttribute("data-dark")).toBe("false");
  });

  test("no forcedDark (standalone shared page) falls back to the visitor's system theme", async () => {
    render(
      <SharedTile card={chartCard} spanClass="col-span-1" cachedLabel={null} cachedIso={undefined} />,
    );
    // Mocked visitor system = light → the chart follows it when unforced.
    const chart = await screen.findByTestId("result-chart");
    expect(chart.getAttribute("data-dark")).toBe("false");
  });
});
