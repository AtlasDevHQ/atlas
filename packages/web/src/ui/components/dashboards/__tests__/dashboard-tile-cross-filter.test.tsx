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
import { afterEach, describe, expect, mock, test } from "bun:test";

// Keep the dynamic ResultChart import inert — these table-card tests never mount
// a chart, but dashboard-tile imports it at module load.
mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
}));
mock.module("next/dynamic", () => ({
  default: () => () => <div data-testid="result-chart">chart</div>,
}));
mock.module("@/ui/hooks/use-dark-mode", () => ({ useDarkMode: () => false }));

import { cleanup, render, screen } from "@testing-library/react";
import { DashboardTile } from "../dashboard-tile";
import type { DashboardCard } from "@/ui/lib/types";

const noop = () => {};

const tableCard: DashboardCard = {
  id: "card-table",
  dashboardId: "dash-1",
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

const baseProps = {
  card: tableCard,
  editing: false,
  fullscreen: false,
  isRefreshing: false,
  onFullscreen: noop,
  onRefresh: noop,
  onDuplicate: noop,
  onDelete: noop,
  onUpdateTitle: noop,
} as const;

describe("DashboardTile — cross-filter affordances (#3213)", () => {
  afterEach(cleanup);

  test("an incompatible card shows the 'Not filtered' badge and marks the tile", () => {
    const { container } = render(<DashboardTile {...baseProps} incompatible />);
    expect(screen.getByTestId("tile-not-filtered").textContent).toContain("Not filtered");
    expect(container.querySelector('[data-filter-incompatible="true"]')).toBeTruthy();
  });

  test("a compatible card (default) shows no incompatible badge", () => {
    const { container } = render(<DashboardTile {...baseProps} />);
    expect(screen.queryByTestId("tile-not-filtered")).toBeNull();
    expect(container.querySelector('[data-filter-incompatible="true"]')).toBeNull();
  });

  test("selectedValue marks the matching table row aria-selected", () => {
    const { container } = render(<DashboardTile {...baseProps} selectedValue="Discovery" />);
    const rows = container.querySelectorAll("tbody tr");
    // First cached row's stage is "Discovery" → selected; the other is not.
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBeNull();
  });

  test("no selectedValue leaves every row unselected", () => {
    const { container } = render(<DashboardTile {...baseProps} />);
    for (const row of container.querySelectorAll("tbody tr")) {
      expect(row.getAttribute("aria-selected")).toBeNull();
    }
  });
});
