/**
 * Per-tile status on the tile (#4321 — the tile is the unit of trust).
 *
 * DOM coverage of the six-plus states a tile surfaces ON itself: loading, fresh,
 * stale, errored, empty, never-run — plus the color-shifting age caption and the
 * one-click retry. Table cards render synchronously (no recharts mount), so the
 * data body + status chrome are exercisable without the chart-readiness dance.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
}));
mock.module("next/dynamic", () => ({
  default: () => () => <div data-testid="result-chart">chart</div>,
}));
mock.module("@/ui/hooks/use-dark-mode", () => ({ useDarkMode: () => false }));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DashboardTile } from "../dashboard-tile";
import type { DashboardCard } from "@/ui/lib/types";

const noop = () => {};

/** A table card (renders synchronously) with the given cache state. */
function tableCard(overrides: Partial<DashboardCard> = {}): DashboardCard {
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

const baseProps = {
  editing: false,
  fullscreen: false,
  isRefreshing: false,
  onFullscreen: noop,
  onRefresh: noop,
  onDuplicate: noop,
  onDelete: noop,
  onUpdateTitle: noop,
} as const;

function statusAttr() {
  return screen.getByTestId("tile-age-caption").closest("[data-tile-status]")?.getAttribute("data-tile-status");
}

describe("DashboardTile — per-tile status (#4321)", () => {
  afterEach(cleanup);

  test("fresh: cached data with no active render shows the data body", () => {
    render(<DashboardTile {...baseProps} card={tableCard()} />);
    expect(statusAttr()).toBe("fresh");
    expect(screen.getByText("Discovery")).toBeTruthy();
    // No retry / placeholder on a fresh tile.
    expect(screen.queryByTestId("tile-retry")).toBeNull();
    expect(screen.queryByTestId("tile-state-errored")).toBeNull();
  });

  test("never-run, empty, and errored are three visually distinct blank states", () => {
    const neverRun = render(
      <DashboardTile {...baseProps} card={tableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })} />,
    );
    expect(screen.getByTestId("tile-state-never-run")).toBeTruthy();
    expect(statusAttr()).toBe("never-run");
    neverRun.unmount();

    const empty = render(
      <DashboardTile
        {...baseProps}
        card={tableCard({ cachedRows: [] })}
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
        {...baseProps}
        card={tableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
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
      <DashboardTile {...baseProps} card={tableCard()} renderPhase="error" onRetry={onRetry} />,
    );
    expect(statusAttr()).toBe("stale");
    // The old data is STILL shown — never blanked, never silently reverted.
    expect(screen.getByText("Discovery")).toBeTruthy();
    // …but labeled stale with an amber-or-worse caption.
    const caption = screen.getByTestId("tile-age-caption");
    expect(caption.textContent).toContain("Stale");
    expect(["amber", "red"]).toContain(caption.getAttribute("data-caption-tone"));
    // …and a one-click retry that re-renders THIS card.
    fireEvent.click(screen.getByTestId("tile-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe("card-table");
  });

  test("errored placeholder offers a retry that fires onRetry", () => {
    const onRetry = mock((_id: string) => {});
    render(
      <DashboardTile
        {...baseProps}
        card={tableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
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
        {...baseProps}
        card={tableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
        renderPhase="error"
        onRetry={noop}
      />,
    );
    // The errored placeholder owns the retry; the footer `tile-retry` (stale
    // only) must not also render, or the tile would show two retry buttons.
    expect(screen.getByTestId("tile-state-errored-retry")).toBeTruthy();
    expect(screen.queryByTestId("tile-retry")).toBeNull();
  });

  test("loading over existing data keeps the data (dimmed), not a blank overlay", () => {
    render(<DashboardTile {...baseProps} card={tableCard()} renderPhase="loading" />);
    expect(statusAttr()).toBe("loading");
    // Data stays visible while the render is in flight (no full-tile overlay).
    expect(screen.getByText("Discovery")).toBeTruthy();
    expect(screen.queryByTestId("tile-state-loading")).toBeNull();
  });

  test("loading with no prior data shows the loading placeholder", () => {
    render(
      <DashboardTile
        {...baseProps}
        card={tableCard({ cachedColumns: null, cachedRows: null, cachedAt: null })}
        renderPhase="loading"
      />,
    );
    expect(screen.getByTestId("tile-state-loading")).toBeTruthy();
  });

  test("the age caption shifts color with the data's age (muted → amber → red)", () => {
    const fresh = render(
      <DashboardTile {...baseProps} card={tableCard({ cachedAt: new Date().toISOString() })} />,
    );
    expect(screen.getByTestId("tile-age-caption").getAttribute("data-caption-tone")).toBe("muted");
    fresh.unmount();

    const amber = render(
      <DashboardTile
        {...baseProps}
        card={tableCard({ cachedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })}
      />,
    );
    expect(screen.getByTestId("tile-age-caption").getAttribute("data-caption-tone")).toBe("amber");
    amber.unmount();

    render(
      <DashboardTile
        {...baseProps}
        card={tableCard({ cachedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })}
      />,
    );
    expect(screen.getByTestId("tile-age-caption").getAttribute("data-caption-tone")).toBe("red");
  });
});
