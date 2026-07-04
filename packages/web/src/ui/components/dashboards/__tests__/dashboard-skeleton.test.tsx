/**
 * Dashboard loading skeletons (#4323).
 *
 * The skeletons exist to kill CLS + blank `null` screens: they reserve the
 * top-bar, banner, and tile-grid regions so the real content lands in place.
 * These tests pin that they render a non-empty, layout-shaped placeholder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  DashboardDetailSkeleton,
  DashboardListSkeleton,
} from "../dashboard-skeleton";

describe("dashboard skeletons (#4323)", () => {
  afterEach(cleanup);

  test("the detail skeleton reserves a top-bar, a banner strip, and a tile grid", () => {
    const { container } = render(<DashboardDetailSkeleton />);
    expect(screen.getByTestId("dashboard-detail-skeleton")).toBeTruthy();
    // Four tile placeholders matching the default 2-up grid.
    const tiles = container.querySelectorAll(".rounded-xl.border");
    expect(tiles.length).toBe(4);
    // It's a real placeholder, not a blank null frame.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(4);
  });

  test("the list skeleton renders a top-bar and tile grid", () => {
    const { container } = render(<DashboardListSkeleton />);
    expect(screen.getByTestId("dashboard-list-skeleton")).toBeTruthy();
    expect(container.querySelectorAll(".rounded-xl.border").length).toBe(4);
  });
});
