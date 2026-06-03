import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { SharedCard } from "../types";

// The text branch never mounts a chart, but `dynamic(...)` + `useDarkMode` run
// at import — stub them so jsdom doesn't try to evaluate recharts.
mock.module("@/ui/components/chart/result-chart", () => ({
  ResultChart: () => <div data-testid="result-chart">chart</div>,
}));
mock.module("next/dynamic", () => ({
  default: () => () => <div data-testid="result-chart">chart</div>,
}));
mock.module("@/ui/hooks/use-dark-mode", () => ({ useDarkMode: () => false }));

import { SharedTile } from "../tile";

const textCard: SharedCard = {
  id: "t1",
  title: "Top of funnel",
  kind: "text",
  sql: "",
  chartConfig: null,
  content: "## Top of funnel\n\nLeads entering the pipeline.",
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
});
