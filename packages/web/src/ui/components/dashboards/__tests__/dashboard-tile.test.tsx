import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DashboardCard } from "@/ui/lib/types";

// Stub the dynamic ResultChart import so jsdom doesn't try to evaluate
// recharts. Bypass next/dynamic entirely so the sentinel renders synchronously
// — the dynamic loader otherwise suspends past the test's render() call. The
// stub forwards `onCategoryClick` (#3212) so a click can exercise the tile→chart
// drilldown plumbing without a real recharts chart.
mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: ({ onCategoryClick }: { onCategoryClick?: (value: string, categoryKey: string) => void }) => (
    <>
      {/* Fires with the card's configured category column ("stage") — matches. */}
      <button type="button" data-testid="result-chart" onClick={() => onCategoryClick?.("Discovery", "stage")}>
        chart
      </button>
      {/* Fires with a DIFFERENT detected column — the tile must reject this. */}
      <button
        type="button"
        data-testid="result-chart-other-col"
        onClick={() => onCategoryClick?.("Discovery", "other_col")}
      >
        chart-other
      </button>
    </>
  ),
}));
mock.module("next/dynamic", () => ({
  default: (loader: () => Promise<{ default: React.ComponentType }>) => {
    let Comp: React.ComponentType | null = null;
    void loader().then((m) => {
      Comp = m.default;
    });
    return function DynStub(props: Record<string, unknown>) {
      return Comp ? <Comp {...props} /> : <div data-testid="result-chart">chart</div>;
    };
  },
}));

mock.module("@/ui/hooks/use-dark-mode", () => ({
  useDarkMode: () => false,
}));

import { DashboardTile } from "../dashboard-tile";

const noop = () => {};

const baseCard: DashboardCard = {
  id: "card-1",
  dashboardId: "dash-1",
  position: 0,
  title: "Pipeline by stage",
  kind: "chart",
  sql: "SELECT 1",
  chartConfig: { type: "bar", categoryColumn: "stage", valueColumns: ["amount"] },
  content: null,
  cachedColumns: ["stage", "amount"],
  cachedRows: [
    { stage: "Discovery", amount: 1240000 },
    { stage: "Closed Won", amount: 1920000 },
  ],
  cachedAt: "2026-04-25T12:00:00Z",
  connectionGroupId: null,
  layout: { x: 0, y: 0, w: 12, h: 8 },
  createdAt: "2026-04-25T12:00:00Z",
  updatedAt: "2026-04-25T12:00:00Z",
};

const baseProps = {
  card: baseCard,
  editing: false,
  fullscreen: false,
  isRefreshing: false,
  onFullscreen: noop,
  onRefresh: noop,
  onDuplicate: noop,
  onDelete: noop,
  onUpdateTitle: noop,
} as const;

function setBoundingRect(width: number, height: number) {
  // jsdom's getBoundingClientRect returns 0×0 by default; ChartSlot needs a
  // real measurement to flip its `ready` gate.
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

class StubResizeObserver {
  observe = noop;
  disconnect = noop;
  unobserve = noop;
}

describe("DashboardTile", () => {
  afterEach(cleanup);

  test("ChartSlot does not mount ResultChart when measured size is below the readiness threshold", () => {
    const restore = setBoundingRect(40, 40);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} />);
    expect(screen.queryByTestId("result-chart")).toBeNull();
    restore();
  });

  test("ChartSlot mounts ResultChart once the slot has real width and height", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} />);
    // Flush the post-useLayoutEffect setReady → re-render.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("result-chart")).toBeTruthy();
    restore();
  });

  test("tile-head action buttons expose accessible names so screen readers can reach them", () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} />);
    expect(screen.getByRole("button", { name: "Refresh tile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tile actions" })).toBeTruthy();
    restore();
  });

  test("Fullscreen button label flips to 'Exit fullscreen' when fullscreen is active", () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} fullscreen={true} />);
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
    restore();
  });

  test("drag handle only renders when editing", () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const { rerender, container } = render(<DashboardTile {...baseProps} editing={false} />);
    expect(container.querySelector(".dash-drag-handle")).toBeNull();
    rerender(<DashboardTile {...baseProps} editing={true} />);
    expect(container.querySelector(".dash-drag-handle")).toBeTruthy();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Text / section cards (#3138)
// ---------------------------------------------------------------------------

const textCard: DashboardCard = {
  id: "card-text",
  dashboardId: "dash-1",
  position: 0,
  title: "Top of funnel",
  kind: "text",
  sql: "",
  chartConfig: null,
  content: "## Top of funnel\n\nLeads entering the pipeline this quarter.",
  cachedColumns: null,
  cachedRows: null,
  cachedAt: null,
  connectionGroupId: null,
  layout: { x: 0, y: 0, w: 24, h: 4 },
  createdAt: "2026-04-25T12:00:00Z",
  updatedAt: "2026-04-25T12:00:00Z",
};

describe("DashboardTile — text cards", () => {
  afterEach(cleanup);

  test("renders the card's markdown content (heading + body), no chart", () => {
    const { container } = render(<DashboardTile {...baseProps} card={textCard} />);
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe("Top of funnel");
    expect(container.textContent).toContain("Leads entering the pipeline this quarter.");
    // No chart, no data fetch — the chart slot never mounts for a text card.
    expect(screen.queryByTestId("result-chart")).toBeNull();
  });

  test("omits chart chrome — no refresh / fullscreen / view toggle", () => {
    render(<DashboardTile {...baseProps} card={textCard} />);
    expect(screen.queryByRole("button", { name: "Refresh tile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
  });

  test("exposes a drag handle only when editing", () => {
    const { rerender, container } = render(
      <DashboardTile {...baseProps} card={textCard} editing={false} />,
    );
    expect(container.querySelector(".dash-drag-handle")).toBeNull();
    rerender(<DashboardTile {...baseProps} card={textCard} editing={true} />);
    expect(container.querySelector(".dash-drag-handle")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// KPI / scorecard cards (#3137)
// ---------------------------------------------------------------------------

const kpiCard: DashboardCard = {
  id: "card-kpi",
  dashboardId: "dash-1",
  position: 0,
  title: "Revenue",
  kind: "chart",
  sql: "SELECT 'Revenue' AS label, SUM(amount) AS total FROM orders",
  chartConfig: {
    type: "kpi",
    categoryColumn: "label",
    valueColumns: ["total"],
    kpi: { valueFormat: "currency", comparisonLabel: "vs. last month" },
  },
  content: null,
  cachedColumns: ["label", "total"],
  cachedRows: [{ label: "Revenue", total: 1200000 }],
  cachedAt: "2026-04-25T12:00:00Z",
  connectionGroupId: null,
  layout: { x: 0, y: 0, w: 6, h: 4 },
  createdAt: "2026-04-25T12:00:00Z",
  updatedAt: "2026-04-25T12:00:00Z",
};

describe("DashboardTile — KPI cards", () => {
  afterEach(cleanup);

  test("routes a kpi card to the KpiCard body (big number, no chart, no view toggle)", () => {
    render(<DashboardTile {...baseProps} card={kpiCard} />);
    expect(screen.getByTestId("kpi-value").textContent).toBe("$1.2M");
    // The big number is the view — no chart mount, no Chart/Table toggle.
    expect(screen.queryByTestId("result-chart")).toBeNull();
    expect(screen.queryByRole("button", { name: "Chart" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Table" })).toBeNull();
  });

  test("renders the delta chip from the comparison prop", () => {
    render(
      <DashboardTile
        {...baseProps}
        card={kpiCard}
        comparison={{ columns: ["total"], rows: [{ total: 1000000 }] }}
      />,
    );
    expect(screen.getByTestId("kpi-delta").getAttribute("data-direction")).toBe("up");
  });

  test("keeps the tile chrome — refresh / fullscreen / actions reachable", () => {
    render(<DashboardTile {...baseProps} card={kpiCard} />);
    expect(screen.getByRole("button", { name: "Refresh tile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tile actions" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Click-to-drilldown (#3212)
// ---------------------------------------------------------------------------

// A table-type card renders the DataTable view immediately (no chart mount /
// recharts), so the table drilldown path is exercisable synchronously.
const tableCard: DashboardCard = {
  ...baseCard,
  id: "card-table",
  chartConfig: { type: "table", categoryColumn: "stage", valueColumns: ["amount"] },
};

const tableDrillCard: DashboardCard = {
  ...tableCard,
  chartConfig: { ...tableCard.chartConfig!, drilldown: { targetParam: "stage" } },
};

const barDrillCard: DashboardCard = {
  ...baseCard,
  id: "card-bar-drill",
  chartConfig: { type: "bar", categoryColumn: "stage", valueColumns: ["amount"], drilldown: { targetParam: "stage" } },
};

describe("DashboardTile — drilldown (#3212)", () => {
  afterEach(cleanup);

  test("clicking a table row on a drilldown card fires onDrilldown(targetParam, categoryValue)", () => {
    const onDrilldown = mock((_param: string, _value: string) => {});
    const { container } = render(
      <DashboardTile {...baseProps} card={tableDrillCard} onDrilldown={onDrilldown} />,
    );
    const firstRow = container.querySelector("tbody tr");
    expect(firstRow?.getAttribute("role")).toBe("button");
    fireEvent.click(firstRow!);
    expect(onDrilldown).toHaveBeenCalledTimes(1);
    // categoryColumn is "stage"; first cached row's stage is "Discovery".
    expect(onDrilldown.mock.calls[0]).toEqual(["stage", "Discovery"]);
  });

  test("a card without a drilldown target is inert on row click (no regression)", () => {
    const onDrilldown = mock((_param: string, _value: string) => {});
    const { container } = render(
      <DashboardTile {...baseProps} card={tableCard} onDrilldown={onDrilldown} />,
    );
    const firstRow = container.querySelector("tbody tr");
    expect(firstRow?.getAttribute("role")).toBeNull();
    fireEvent.click(firstRow!);
    expect(onDrilldown).not.toHaveBeenCalled();
  });

  test("clicking a chart data point on a drilldown card fires onDrilldown with the clicked category", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onDrilldown = mock((_param: string, _value: string) => {});
    render(<DashboardTile {...baseProps} card={barDrillCard} onDrilldown={onDrilldown} />);
    // Flush the readiness gate + dynamic ResultChart load.
    await act(async () => {
      await Promise.resolve();
    });
    // The stubbed ResultChart forwards onCategoryClick("Discovery", "stage").
    fireEvent.click(screen.getByTestId("result-chart"));
    expect(onDrilldown).toHaveBeenCalledTimes(1);
    expect(onDrilldown.mock.calls[0]).toEqual(["stage", "Discovery"]);
    restore();
  });

  test("a chart click from a column other than the configured categoryColumn is rejected", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onDrilldown = mock((_param: string, _value: string) => {});
    // Card's drilldown column is "stage"; the stub's second button fires with
    // "other_col" (a divergent detected axis) — the tile must not bind it.
    render(<DashboardTile {...baseProps} card={barDrillCard} onDrilldown={onDrilldown} />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("result-chart-other-col"));
    expect(onDrilldown).not.toHaveBeenCalled();
    restore();
  });

  test("drilldown is disabled while editing (chart body is a drag surface)", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onDrilldown = mock((_param: string, _value: string) => {});
    render(<DashboardTile {...baseProps} card={barDrillCard} editing={true} onDrilldown={onDrilldown} />);
    await act(async () => {
      await Promise.resolve();
    });
    // onCategoryClick is undefined while editing → the stub's click is a no-op.
    fireEvent.click(screen.getByTestId("result-chart"));
    expect(onDrilldown).not.toHaveBeenCalled();
    restore();
  });
});

// ---------------------------------------------------------------------------
// Per-card CSV export (#3210)
// ---------------------------------------------------------------------------

describe("DashboardTile — CSV export (#3210)", () => {
  afterEach(cleanup);

  // Radix DropdownMenu opens on a real PointerEvent — JSDOM swallows
  // fireEvent.click on the trigger. Activate via keyboard (Enter on the focused
  // trigger), the same pattern the dashboard-switcher test uses.
  function openTileMenu() {
    const trigger = screen.getByRole("button", { name: "Tile actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  }

  test("a chart card with data offers Download CSV, firing onExportCsv with the card", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onExportCsv = mock((_card: DashboardCard) => {});
    render(<DashboardTile {...baseProps} card={baseCard} onExportCsv={onExportCsv} />);
    openTileMenu();
    const item = await screen.findByRole("menuitem", { name: /Download CSV/ });
    fireEvent.click(item);
    expect(onExportCsv).toHaveBeenCalledTimes(1);
    expect(onExportCsv.mock.calls[0][0].id).toBe(baseCard.id);
  });

  test("a KPI card also offers Download CSV (chart / table / kpi all do)", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onExportCsv = mock((_card: DashboardCard) => {});
    render(<DashboardTile {...baseProps} card={kpiCard} onExportCsv={onExportCsv} />);
    openTileMenu();
    expect(await screen.findByRole("menuitem", { name: /Download CSV/ })).toBeTruthy();
  });

  test("the item is hidden when no onExportCsv handler is wired", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} card={baseCard} />);
    openTileMenu();
    // The menu still opens (Rename is always present) — only the CSV item is gone.
    await screen.findByRole("menuitem", { name: /Rename/ });
    expect(screen.queryByRole("menuitem", { name: /Download CSV/ })).toBeNull();
  });

  test("a text card has no actions menu, so no CSV affordance", () => {
    const onExportCsv = mock((_card: DashboardCard) => {});
    render(<DashboardTile {...baseProps} card={textCard} onExportCsv={onExportCsv} />);
    // Text tiles render no tile-actions menu at all — the affordance can't appear.
    expect(screen.queryByRole("button", { name: "Tile actions" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Download CSV/ })).toBeNull();
  });
});
