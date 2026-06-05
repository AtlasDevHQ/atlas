/**
 * Cross-filter chips bar (#3213) — presentational behavior.
 *
 * Covers the chip render (label + value), per-chip remove, and clear-all. The
 * URL round-trip + batched-refetch wiring is exercised at the page-integration
 * level (cross-filter-sync.test.tsx); here we pin the dumb component's contract.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DashboardFilterChips } from "../dashboard-filter-chips";
import type { ActiveFilter } from "@/app/(workspace)/dashboards/[id]/cross-filter";

afterEach(cleanup);

const FILTERS: ActiveFilter[] = [
  { key: "stage", label: "Stage", value: "Discovery" },
  { key: "region", label: "Region", value: "us" },
];

describe("DashboardFilterChips", () => {
  test("renders nothing when there are no active filters", () => {
    const { container } = render(
      <DashboardFilterChips filters={[]} onRemove={() => {}} onClearAll={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders a chip per active filter with its label and value", () => {
    render(<DashboardFilterChips filters={FILTERS} onRemove={() => {}} onClearAll={() => {}} />);
    const bar = screen.getByRole("group", { name: "Active filters" });
    expect(bar.textContent).toContain("Stage:");
    expect(bar.textContent).toContain("Discovery");
    expect(bar.textContent).toContain("Region:");
    expect(bar.textContent).toContain("us");
  });

  test("the remove button calls onRemove with the filter's key", () => {
    const onRemove = mock((_key: string) => {});
    render(<DashboardFilterChips filters={FILTERS} onRemove={onRemove} onClearAll={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Region filter" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0]).toEqual(["region"]);
  });

  test("Clear all calls onClearAll once", () => {
    const onClearAll = mock(() => {});
    render(<DashboardFilterChips filters={FILTERS} onRemove={() => {}} onClearAll={onClearAll} />);
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
