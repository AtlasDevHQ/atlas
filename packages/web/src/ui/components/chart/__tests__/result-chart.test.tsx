import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ResultChart } from "../result-chart";

// recharts' ResponsiveContainer measures via ResizeObserver, which jsdom lacks.
// A no-op stub lets the component mount; the plot itself renders at 0×0 (recharts
// warns, doesn't throw) — fine here, since every assertion targets the CHROME
// (caption + type toggle) that renders OUTSIDE the responsive container.
class StubResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver =
    StubResizeObserver;
});

// date + numeric data auto-detects to a time-series `line` first, with `area` and
// `bar` also recommended — so the type toggle has >1 option and a pin to `bar`
// is meaningfully DIFFERENT from the auto-detected default.
const headers = ["week", "signups"];
const rows = [
  ["2026-01-05", "10"],
  ["2026-01-12", "24"],
  ["2026-01-19", "31"],
];
const AUTO_CAPTION = "Time-series: week vs signups";

describe("ResultChart — chat surface (chrome kept, #4688 AC3)", () => {
  afterEach(cleanup);

  test("renders its caption bar and the Line/Area/Bar type toggle by default", () => {
    render(<ResultChart headers={headers} rows={rows} dark={false} />);
    // Caption (the top recommendation's `reason`) is shown.
    expect(screen.getByText(AUTO_CAPTION)).toBeTruthy();
    // The type toggle renders a button per unique recommended type.
    expect(screen.getByRole("button", { name: "Line" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Area" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bar" })).toBeTruthy();
  });
});

describe("ResultChart — dashboard tile (embedded, #4688 AC1)", () => {
  afterEach(cleanup);

  test("suppresses the caption bar and the type toggle in embedded mode", () => {
    render(<ResultChart headers={headers} rows={rows} dark={false} embedded />);
    // No chat-explainer caption on a titled tile.
    expect(screen.queryByText(AUTO_CAPTION)).toBeNull();
    // No inner Line/Area/Bar toggle — the tile fixes the type.
    expect(screen.queryByRole("button", { name: "Line" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Area" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bar" })).toBeNull();
  });

  test("still renders the plot when pinned to a type that diverges from auto-detect", () => {
    // Data auto-detects to `line`; pinning `bar` must render (not blank the tile
    // or fall into the error boundary), with no toggle/caption chrome. (The plot
    // itself paints at 0×0 in jsdom, so we assert on the mount + the absence of
    // the error fallback rather than the SVG.)
    render(<ResultChart headers={headers} rows={rows} dark={false} embedded chartType="bar" />);
    expect(screen.queryByText(AUTO_CAPTION)).toBeNull();
    expect(screen.queryByRole("button", { name: "Line" })).toBeNull();
    // The ErrorBoundary fallback would appear only if the pinned render threw.
    expect(screen.queryByText(/Unable to render chart/)).toBeNull();
  });
});
