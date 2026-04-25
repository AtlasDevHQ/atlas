import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DashboardCard } from "@/ui/lib/types";

// Drive the `useContainerWidth` hook + GridLayout shim so the branching logic
// in DashboardGrid (mobile single-column vs RGL freeform) is the only thing
// under test.
let widthOverride = 1024;
mock.module("react-grid-layout", () => ({
  GridLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rgl-root">{children}</div>
  ),
  useContainerWidth: () => ({ width: widthOverride, mounted: true, containerRef: { current: null } }),
  noCompactor: () => [],
}));
mock.module("react-grid-layout/css/styles.css", () => ({}));

mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
}));

mock.module("@/ui/hooks/use-dark-mode", () => ({
  useDarkMode: () => false,
}));

import { DashboardGrid } from "../dashboard-grid";

const noop = () => {};

const card: DashboardCard = {
  id: "card-1",
  dashboardId: "dash-1",
  position: 0,
  title: "Pipeline by stage",
  sql: "SELECT 1",
  chartConfig: null,
  cachedColumns: ["stage", "amount"],
  cachedRows: [{ stage: "Discovery", amount: 1 }],
  cachedAt: "2026-04-25T12:00:00Z",
  connectionId: null,
  layout: { x: 0, y: 0, w: 12, h: 8 },
  createdAt: "2026-04-25T12:00:00Z",
  updatedAt: "2026-04-25T12:00:00Z",
};

const baseProps = {
  cards: [card],
  editing: false,
  refreshingId: null,
  onLayoutChange: noop,
  onRefresh: noop,
  onDuplicate: noop,
  onDelete: noop,
  onUpdateTitle: noop,
} as const;

describe("DashboardGrid", () => {
  afterEach(cleanup);

  test("returns null when there are no cards (empty state is the page's responsibility)", () => {
    widthOverride = 1024;
    const { container } = render(<DashboardGrid {...baseProps} cards={[]} />);
    expect(container.querySelector(".dashboard-app")).toBeNull();
  });

  test("renders a single-column mobile stack when measured width is below MOBILE_BREAKPOINT", () => {
    widthOverride = 500;
    const { container } = render(<DashboardGrid {...baseProps} editing={true} />);
    expect(container.querySelector(".dash-mobile-tile")).toBeTruthy();
    expect(screen.queryByTestId("rgl-root")).toBeNull();
  });

  test("forces editing=false on tiles in the mobile stack so drag handles never render at <sm", () => {
    widthOverride = 500;
    const { container } = render(<DashboardGrid {...baseProps} editing={true} />);
    expect(container.querySelector(".dash-drag-handle")).toBeNull();
  });

  test("renders the RGL freeform grid when measured width is at or above MOBILE_BREAKPOINT", () => {
    widthOverride = 1024;
    render(<DashboardGrid {...baseProps} />);
    expect(screen.getByTestId("rgl-root")).toBeTruthy();
  });

  test("Esc closes a fullscreen tile and prevents the page-level handler from also firing", () => {
    widthOverride = 1024;
    render(<DashboardGrid {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeTruthy();

    let bubbleHandlerCalled = false;
    const bubbleSpy = (e: KeyboardEvent) => {
      if (e.key === "Escape") bubbleHandlerCalled = true;
    };
    window.addEventListener("keydown", bubbleSpy);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(bubbleHandlerCalled).toBe(false);
    expect(screen.getByRole("button", { name: "Fullscreen" })).toBeTruthy();
    window.removeEventListener("keydown", bubbleSpy);
  });
});
