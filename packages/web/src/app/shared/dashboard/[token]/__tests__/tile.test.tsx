import type React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { SharedCard } from "../types";

// The text branch never mounts a chart, but `dynamic(...)` + `useDarkMode` run
// at import — stub them so jsdom doesn't try to evaluate recharts. The ResultChart
// stub surfaces `dark` (#4686 forced-theme threading), plus `embedded` /
// `chartType` (#4688 chrome-in-chrome) via data-attrs so the chart-card tests can
// assert both the resolved theme and the suppressed chrome / pinned type. The
// next/dynamic stub invokes the loader (so the real mocked ResultChart renders)
// and falls back until it resolves — the tests `rerender` past that.
void mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: ({
    dark,
    embedded,
    chartType,
  }: {
    dark?: boolean;
    embedded?: boolean;
    chartType?: string;
  }) => (
    <div
      data-testid="result-chart"
      data-dark={String(dark)}
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
// The VISITOR's system theme. Mutable so the unforced test can flip it and prove
// the tile actually READS it (a forced theme must win over it — the #4686
// threading contract). Mock ALL exports (mock-all-exports discipline) so a future
// importer of another symbol doesn't silently get `undefined`.
let mockSystemDark = false;
void mock.module("@/ui/hooks/use-dark-mode", () => ({
  useDarkMode: () => mockSystemDark,
  useThemeMode: () => "system",
  setTheme: () => {},
  applyBrandColor: () => {},
  DEFAULT_BRAND_COLOR: "oklch(0.4 0.115 158)",
  OKLCH_RE: /^oklch\(/,
}));

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

// Render the tile and flush the dynamic loader's promise chain (import() → .then),
// then re-render so DynStub swaps its fallback for the resolved (mocked) ResultChart.
async function renderResolvedTile(props: React.ComponentProps<typeof SharedTile>) {
  const utils = render(<SharedTile {...props} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  utils.rerender(<SharedTile {...props} />);
  return utils;
}

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

  test("renders ResultChart in embedded mode and pins it to the card's chart type", async () => {
    // The card is saved `type: "bar"`; the shared tile owns the title/frame, so
    // ResultChart renders the plot only (embedded) pinned to bar — not the data's
    // auto-detected line.
    await renderResolvedTile({
      card: chartCard,
      spanClass: "col-span-2",
      cachedLabel: null,
      cachedIso: undefined,
    });
    const chart = screen.getByTestId("result-chart");
    expect(chart.getAttribute("data-embedded")).toBe("true");
    expect(chart.getAttribute("data-chart-type")).toBe("bar");
  });
});

describe("SharedTile — forced embed theme threads into the chart (#4686)", () => {
  afterEach(cleanup);

  // The chart mounts through `next/dynamic`; renderResolvedTile flushes the loader
  // and re-renders so the stub resolves. `data-dark` echoes the `dark` prop the
  // tile hands the chart.
  test("forcedDark=true renders a dark chart even though the visitor's system is light", async () => {
    // useDarkMode() is mocked to `false` (light visitor); the forced embed theme
    // must override it so the JS-themed chart agrees with the dark chrome.
    await renderResolvedTile({
      card: chartCard,
      spanClass: "col-span-1",
      cachedLabel: null,
      cachedIso: undefined,
      forcedDark: true,
    });
    expect(screen.getByTestId("result-chart").getAttribute("data-dark")).toBe("true");
  });

  test("forcedDark=false renders a light chart regardless of the visitor's own theme", async () => {
    await renderResolvedTile({
      card: chartCard,
      spanClass: "col-span-1",
      cachedLabel: null,
      cachedIso: undefined,
      forcedDark: false,
    });
    expect(screen.getByTestId("result-chart").getAttribute("data-dark")).toBe("false");
  });

  test("no forcedDark (standalone shared page) follows the visitor's system theme", async () => {
    // Flip the mocked visitor system to DARK so this asserts the tile actually
    // READS systemDark on the unforced path (not just a hardcoded default).
    mockSystemDark = true;
    try {
      await renderResolvedTile({
        card: chartCard,
        spanClass: "col-span-1",
        cachedLabel: null,
        cachedIso: undefined,
      });
      expect(screen.getByTestId("result-chart").getAttribute("data-dark")).toBe("true");
    } finally {
      mockSystemDark = false;
    }
  });
});
