/**
 * DashboardTile.
 *
 * Merged 2026-09-04; formerly also dashboard-tile-status.test.tsx (#4321) and
 * dashboard-tile-cross-filter.test.tsx (#3213).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DashboardCard } from "@/ui/lib/types";

// Stub the dynamic ResultChart import so jsdom doesn't try to evaluate
// recharts. Bypass next/dynamic entirely so the sentinel renders synchronously
// — the dynamic loader otherwise suspends past the test's render() call. The
// stub forwards `onCategoryClick` (#3212) so a click can exercise the tile→chart
// drilldown plumbing, and surfaces `thresholds` (#3208) via a data-attribute so
// a test can assert the goal-line prop is wired through the tile — both without
// a real recharts chart.
void mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: ({
    onCategoryClick,
    thresholds,
    annotations,
    embedded,
    chartType,
  }: {
    onCategoryClick?: (value: string, categoryKey: string) => void;
    thresholds?: { value: number; color?: string; label?: string }[];
    annotations?: { x: string; label: string; color?: string }[];
    embedded?: boolean;
    chartType?: string;
  }) => (
    <>
      {/* Fires with the card's configured category column ("stage") — matches.
          #4688 — `embedded` / `chartType` surface via data-attrs so a test can
          assert the tile suppresses ResultChart's chrome + pins the type. */}
      <button
        type="button"
        data-testid="result-chart"
        data-thresholds={JSON.stringify(thresholds ?? null)}
        data-annotations={JSON.stringify(annotations ?? null)}
        data-embedded={embedded ? "true" : "false"}
        data-chart-type={chartType ?? ""}
        onClick={() => onCategoryClick?.("Discovery", "stage")}
      >
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
void mock.module("next/dynamic", () => ({
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

void mock.module("@/ui/hooks/use-dark-mode", () => ({
  useDarkMode: () => false,
}));

import { DashboardTile, distinctCategoryValues, DRILLDOWN_MENU_CAP } from "../dashboard-tile";

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
  annotations: [],
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

  test("forwards the card's goal-line thresholds (#3208) through to ResultChart", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const thresholds = [{ value: 1_500_000, label: "Target" }];
    const card: DashboardCard = {
      ...baseCard,
      chartConfig: { type: "bar", categoryColumn: "stage", valueColumns: ["amount"], thresholds },
    };
    render(<DashboardTile {...baseProps} card={card} />);
    await act(async () => {
      await Promise.resolve();
    });
    const chart = screen.getByTestId("result-chart");
    expect(JSON.parse(chart.getAttribute("data-thresholds") ?? "null")).toEqual(thresholds);
    restore();
  });

  test("forwards the card's event annotations (#3209) through to ResultChart", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const annotations = [
      { x: "2026-01-15", label: "Launch", color: "#10b981" },
      { x: "2026-03-01", label: "Campaign" },
    ];
    const card: DashboardCard = {
      ...baseCard,
      chartConfig: { type: "line", categoryColumn: "week", valueColumns: ["signups"] },
      annotations,
    };
    render(<DashboardTile {...baseProps} card={card} />);
    await act(async () => {
      await Promise.resolve();
    });
    const chart = screen.getByTestId("result-chart");
    expect(JSON.parse(chart.getAttribute("data-annotations") ?? "null")).toEqual(annotations);
    restore();
  });

  test("renders ResultChart in embedded mode and pins it to the card's chart type (#4688)", async () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    // baseCard is configured `type: "bar"` — the tile must pin ResultChart to it
    // (not the data's auto-detect) AND suppress ResultChart's own caption/toggle
    // chrome via `embedded`.
    render(<DashboardTile {...baseProps} />);
    await act(async () => {
      await Promise.resolve();
    });
    const chart = screen.getByTestId("result-chart");
    expect(chart.getAttribute("data-embedded")).toBe("true");
    expect(chart.getAttribute("data-chart-type")).toBe("bar");
    restore();
  });

  test("tile-head action buttons expose accessible names so screen readers can reach them", () => {
    const restore = setBoundingRect(600, 300);
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    // onExportCsv is wired (as the page always does) so the tile-actions menu
    // renders in View — the export is a non-mutating affordance.
    render(<DashboardTile {...baseProps} onExportCsv={noop} />);
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
  annotations: [],
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
  annotations: [],
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
    render(<DashboardTile {...baseProps} card={kpiCard} onExportCsv={noop} />);
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
// Keyboard drilldown (#4323)
// ---------------------------------------------------------------------------

describe("DashboardTile — keyboard drilldown (#4323)", () => {
  afterEach(cleanup);

  // Radix DropdownMenu opens on a real PointerEvent — activate via keyboard
  // (Enter on the focused trigger), mirroring the CSV-menu tests. This is also
  // exactly the keyboard path the feature exists to provide.
  function openDrilldownMenu() {
    const trigger = screen.getByRole("button", { name: "Drill down" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  }

  test("a chart drilldown card exposes a keyboard-navigable Drill down menu of its categories", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onDrilldown = mock((_param: string, _value: string) => {});
    render(<DashboardTile {...baseProps} card={barDrillCard} onDrilldown={onDrilldown} />);

    openDrilldownMenu();
    // Distinct category values from the card's `stage` column become menu items.
    expect(await screen.findByRole("menuitem", { name: /Discovery/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Closed Won/ }));
    expect(onDrilldown).toHaveBeenCalledTimes(1);
    expect(onDrilldown.mock.calls[0]).toEqual(["stage", "Closed Won"]);
  });

  test("no Drill down menu on a chart card without a drilldown target", () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} card={baseCard} />);
    expect(screen.queryByRole("button", { name: "Drill down" })).toBeNull();
  });

  test("the Drill down menu is hidden while editing (the chart is a drag surface)", () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} card={barDrillCard} editing onDrilldown={() => {}} />);
    expect(screen.queryByRole("button", { name: "Drill down" })).toBeNull();
  });

  test("no Drill down menu in table view — table rows are already keyboard-drillable", () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    // A table-type card with a drilldown target renders the DataTable (keyboard
    // rows), so the chart-only dropdown must not appear.
    render(<DashboardTile {...baseProps} card={tableDrillCard} onDrilldown={() => {}} />);
    expect(screen.queryByRole("button", { name: "Drill down" })).toBeNull();
  });
});

describe("distinctCategoryValues (#4323)", () => {
  test("dedupes, skips null/empty cells, and preserves first-seen order", () => {
    const rows = [
      { stage: "Discovery" },
      { stage: "Discovery" },
      { stage: "" },
      { stage: null },
      { stage: "Closed Won" },
    ];
    expect(distinctCategoryValues(rows, "stage")).toEqual(["Discovery", "Closed Won"]);
  });

  test("caps the list so a high-cardinality column can't render an unbounded menu", () => {
    const rows = Array.from({ length: DRILLDOWN_MENU_CAP + 150 }, (_, i) => ({ stage: `s${i}` }));
    expect(distinctCategoryValues(rows, "stage").length).toBe(DRILLDOWN_MENU_CAP);
  });

  test("returns an empty list when the category column is unset", () => {
    expect(distinctCategoryValues([{ stage: "A" }], "")).toEqual([]);
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
    // In Edit mode the menu still opens (Rename is present) — only the CSV item
    // is gone. (In View with no export handler the menu wouldn't render at all.)
    render(<DashboardTile {...baseProps} card={baseCard} editing />);
    openTileMenu();
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

// ---------------------------------------------------------------------------
// View is read-only for the DEFINITION — mutating cluster moves to Edit (#4560)
// ---------------------------------------------------------------------------

describe("DashboardTile — View/Edit affordance gating (#4560)", () => {
  afterEach(cleanup);

  function openTileMenu() {
    const trigger = screen.getByRole("button", { name: "Tile actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  }

  test("View mode hides the mutating cluster (Rename / Duplicate / Remove); CSV stays", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} card={baseCard} editing={false} onExportCsv={noop} />);
    // The non-mutating affordances (refresh, fullscreen) are always reachable.
    expect(screen.getByRole("button", { name: "Refresh tile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
    // The actions menu opens for the non-mutating CSV export only.
    openTileMenu();
    expect(await screen.findByRole("menuitem", { name: /Download CSV/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Duplicate/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Remove/ })).toBeNull();
  });

  test("View mode with no export handler renders no actions menu at all (never an empty dropdown)", () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} card={baseCard} editing={false} />);
    expect(screen.queryByRole("button", { name: "Tile actions" })).toBeNull();
  });

  test("Edit mode exposes the full mutating cluster (Rename / Duplicate / Remove)", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    render(<DashboardTile {...baseProps} card={baseCard} editing onExportCsv={noop} />);
    openTileMenu();
    expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Remove/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Download CSV/ })).toBeTruthy();
  });

  test("Remove / Duplicate fire their handlers when selected in Edit mode", async () => {
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
    const onDelete = mock((_card: DashboardCard) => {});
    const onDuplicate = mock((_id: string) => {});
    render(
      <DashboardTile {...baseProps} card={baseCard} editing onDelete={onDelete} onDuplicate={onDuplicate} />,
    );
    openTileMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate.mock.calls[0][0]).toBe(baseCard.id);
    openTileMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].id).toBe(baseCard.id);
  });
});

/**
 * Per-tile status on the tile (#4321 — the tile is the unit of trust).
 *
 * DOM coverage of the six-plus states a tile surfaces ON itself: loading, fresh,
 * stale, errored, empty, never-run — plus the color-shifting age caption and the
 * one-click retry. Table cards render synchronously (no recharts mount), so the
 * data body + status chrome are exercisable without the chart-readiness dance.
 */

const statusNoop = () => {};

/** A table card (renders synchronously) with the given cache state. */
function statusTableCard(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    id: "card-table",
    dashboardId: "dash-1",
    position: 0,
    title: "Pipeline by stage",
    kind: "chart",
    sql: "SELECT stage, amount FROM deals WHERE region = :region",
    chartConfig: { type: "table", categoryColumn: "stage", valueColumns: ["amount"] },
    content: null,
    annotations: [],
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
    ...overrides,
  };
}

const statusBaseProps = {
  editing: false,
  fullscreen: false,
  isRefreshing: false,
  onFullscreen: statusNoop,
  onRefresh: statusNoop,
  onDuplicate: statusNoop,
  onDelete: statusNoop,
  onUpdateTitle: statusNoop,
} as const;

function statusAttr() {
  return screen.getByTestId("tile-age-caption").closest("[data-tile-status]")?.getAttribute("data-tile-status");
}

describe("DashboardTile — per-tile status (#4321)", () => {
  afterEach(cleanup);

  test("fresh: cached data with no active render shows the data body", () => {
    render(<DashboardTile {...statusBaseProps} card={statusTableCard()} />);
    expect(statusAttr()).toBe("fresh");
    expect(screen.getByText("Discovery")).toBeTruthy();
    // No retry / placeholder on a fresh tile.
    expect(screen.queryByTestId("tile-retry")).toBeNull();
    expect(screen.queryByTestId("tile-state-errored")).toBeNull();
  });

  test("never-run, empty, and errored are three visually distinct blank states", () => {
    const neverRun = render(
      <DashboardTile {...statusBaseProps} card={statusTableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })} />,
    );
    expect(screen.getByTestId("tile-state-never-run")).toBeTruthy();
    expect(statusAttr()).toBe("never-run");
    neverRun.unmount();

    const empty = render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedRows: [] })}
        renderPhase="ok"
      />,
    );
    expect(screen.getByTestId("tile-state-empty")).toBeTruthy();
    expect(statusAttr()).toBe("empty");
    // empty is NOT never-run and NOT errored.
    expect(screen.queryByTestId("tile-state-never-run")).toBeNull();
    expect(screen.queryByTestId("tile-state-errored")).toBeNull();
    empty.unmount();

    render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
        renderPhase="error"
      />,
    );
    expect(screen.getByTestId("tile-state-errored")).toBeTruthy();
    expect(statusAttr()).toBe("errored");
    expect(screen.queryByTestId("tile-state-empty")).toBeNull();
    expect(screen.queryByTestId("tile-state-never-run")).toBeNull();
  });

  test("a FAILED update over existing data → stale: keeps the data, labels it, offers retry", () => {
    const onRetry = mock((_id: string) => {});
    render(
      <DashboardTile {...statusBaseProps} card={statusTableCard()} renderPhase="error" onRetry={onRetry} />,
    );
    expect(statusAttr()).toBe("stale");
    // The old data is STILL shown — never blanked, never silently reverted.
    expect(screen.getByText("Discovery")).toBeTruthy();
    // …but labeled stale with an amber-or-worse caption.
    const caption = screen.getByTestId("tile-age-caption");
    expect(caption.textContent).toContain("Stale");
    expect<Array<string | null>>(["amber", "red"]).toContain(caption.getAttribute("data-caption-tone"));
    // …and a one-click retry that re-renders THIS card.
    fireEvent.click(screen.getByTestId("tile-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe("card-table");
  });

  test("errored placeholder offers a retry that fires onRetry", () => {
    const onRetry = mock((_id: string) => {});
    render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
        renderPhase="error"
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByTestId("tile-state-errored-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe("card-table");
  });

  test("an errored tile shows exactly ONE retry (placeholder only, no duplicate footer retry)", () => {
    render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
        renderPhase="error"
        onRetry={statusNoop}
      />,
    );
    // The errored placeholder owns the retry; the footer `tile-retry` (stale
    // only) must not also render, or the tile would show two retry buttons.
    expect(screen.getByTestId("tile-state-errored-retry")).toBeTruthy();
    expect(screen.queryByTestId("tile-retry")).toBeNull();
  });

  test("loading over existing data keeps the data (dimmed), not a blank overlay", () => {
    render(<DashboardTile {...statusBaseProps} card={statusTableCard()} renderPhase="loading" />);
    expect(statusAttr()).toBe("loading");
    // Data stays visible while the render is in flight (no full-tile overlay).
    expect(screen.getByText("Discovery")).toBeTruthy();
    expect(screen.queryByTestId("tile-state-loading")).toBeNull();
  });

  test("loading with no prior data shows the loading placeholder", () => {
    render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
        renderPhase="loading"
      />,
    );
    expect(screen.getByTestId("tile-state-loading")).toBeTruthy();
  });

  test("the age caption shifts color with the data's age (muted → amber → red)", () => {
    const fresh = render(
      <DashboardTile {...statusBaseProps} card={statusTableCard({ cachedAt: new Date().toISOString() })} />,
    );
    expect(screen.getByTestId("tile-age-caption").getAttribute("data-caption-tone")).toBe("muted");
    fresh.unmount();

    const amber = render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })}
      />,
    );
    expect(screen.getByTestId("tile-age-caption").getAttribute("data-caption-tone")).toBe("amber");
    amber.unmount();

    render(
      <DashboardTile
        {...statusBaseProps}
        card={statusTableCard({ cachedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })}
      />,
    );
    expect(screen.getByTestId("tile-age-caption").getAttribute("data-caption-tone")).toBe("red");
  });
});

/**
 * Cross-filter tile affordances (#3213).
 *
 * Two tile-level behaviors built on the #3212 drilldown plumbing:
 *   - `incompatible` → the tile is marked "Not filtered" + dimmed (an active
 *     cross-filter binds none of its SQL params, so it can't change).
 *   - `selectedValue` → the matching table row renders `aria-selected` (the
 *     active filter element; re-clicking it deselects via the page's toggle).
 *
 * Table cards render synchronously (no recharts), so both are exercisable
 * without the chart-mount dance.
 */

const xfNoop = () => {};

const xfTableCard: DashboardCard = {
  id: "card-table",
  dashboardId: "dash-1",
  annotations: [],
  position: 0,
  title: "Pipeline by stage",
  kind: "chart",
  sql: "SELECT stage, amount FROM deals WHERE region = :region",
  chartConfig: { type: "table", categoryColumn: "stage", valueColumns: ["amount"] },
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

const xfBaseProps = {
  card: xfTableCard,
  editing: false,
  fullscreen: false,
  isRefreshing: false,
  onFullscreen: xfNoop,
  onRefresh: xfNoop,
  onDuplicate: xfNoop,
  onDelete: xfNoop,
  onUpdateTitle: xfNoop,
} as const;

describe("DashboardTile — cross-filter affordances (#3213)", () => {
  afterEach(cleanup);

  test("an incompatible card shows the 'Not filtered' badge and marks the tile", () => {
    const { container } = render(<DashboardTile {...xfBaseProps} incompatible />);
    expect(screen.getByTestId("tile-not-filtered").textContent).toContain("Not filtered");
    expect(container.querySelector('[data-filter-incompatible="true"]')).toBeTruthy();
  });

  test("a compatible card (default) shows no incompatible badge", () => {
    const { container } = render(<DashboardTile {...xfBaseProps} />);
    expect(screen.queryByTestId("tile-not-filtered")).toBeNull();
    expect(container.querySelector('[data-filter-incompatible="true"]')).toBeNull();
  });

  test("selectedValue marks the matching table row aria-selected", () => {
    const { container } = render(<DashboardTile {...xfBaseProps} selectedValue="Discovery" />);
    const rows = container.querySelectorAll("tbody tr");
    // First cached row's stage is "Discovery" → selected; the other is not.
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBeNull();
  });

  test("no selectedValue leaves every row unselected", () => {
    const { container } = render(<DashboardTile {...xfBaseProps} />);
    for (const row of container.querySelectorAll("tbody tr")) {
      expect(row.getAttribute("aria-selected")).toBeNull();
    }
  });
});
