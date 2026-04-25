import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DashboardCard } from "@/ui/lib/types";

// Stub the dynamic ResultChart import so jsdom doesn't try to evaluate
// recharts. Bypass next/dynamic entirely so the sentinel renders synchronously
// — the dynamic loader otherwise suspends past the test's render() call.
mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
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
  sql: "SELECT 1",
  chartConfig: { type: "bar", categoryColumn: "stage", valueColumns: ["amount"] },
  cachedColumns: ["stage", "amount"],
  cachedRows: [
    { stage: "Discovery", amount: 1240000 },
    { stage: "Closed Won", amount: 1920000 },
  ],
  cachedAt: "2026-04-25T12:00:00Z",
  connectionId: null,
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
