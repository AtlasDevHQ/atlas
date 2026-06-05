/**
 * Drilldown ↔ parameter-bar URL sync (#3212).
 *
 * The whole feature rests on the page and the parameter bar sharing ONE nuqs
 * key: a drilldown click writes the override (page side), and the bar — reading
 * the same key — reflects it AND emits it via `onChange` (the trigger that
 * re-renders every card with the bound value). This drives the REAL bar + REAL
 * `withOverride` through a real nuqs adapter, so the linchpin can't silently
 * break.
 */
import { afterEach, describe, expect, test, mock } from "bun:test";
import { useState } from "react";
import { useQueryState } from "nuqs";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { DashboardParameterBar, type ParameterValues } from "@/ui/components/dashboards/dashboard-parameter-bar";
import { DASHBOARD_PARAMS_KEY, dashboardParamsParser, withOverride } from "../search-params";
import type { DashboardParameter } from "@/ui/lib/types";

afterEach(cleanup);

const REGION: DashboardParameter = { key: "region", type: "text", default: null, label: "Region" };

/**
 * Mirrors the page wiring: a page-side `useQueryState` on the shared key (the
 * drilldown writer) rendered alongside the bar (which subscribes to the same
 * key). The button stands in for a chart/table click resolved to
 * `onDrilldown("region", "us")`.
 */
function Harness({ onChange }: { onChange: (o: ParameterValues) => void }) {
  const [raw, setRaw] = useQueryState(DASHBOARD_PARAMS_KEY, dashboardParamsParser);
  return (
    <>
      <button type="button" onClick={() => void setRaw(withOverride(raw, "region", "us"))}>
        drill
      </button>
      <DashboardParameterBar parameters={[REGION]} onChange={onChange} />
    </>
  );
}

/**
 * A self-updating testing adapter: it feeds its captured URL updates straight
 * back in as `searchParams`. That reproduces the real-app round-trip — in
 * Next.js a `useQueryState` write updates the URL, which re-renders every hook
 * subscribed to that key — which the bare testing adapter doesn't do on its own.
 */
function SyncingAdapter({ children }: { children: React.ReactNode }) {
  const [search, setSearch] = useState(() => new URLSearchParams());
  return (
    <NuqsTestingAdapter searchParams={search} onUrlUpdate={(e) => setSearch(e.searchParams)}>
      {children}
    </NuqsTestingAdapter>
  );
}

describe("drilldown ↔ parameter bar URL sync", () => {
  test("a drilldown write lands in the shared key; the bar reflects it and emits the bound value", async () => {
    const onChange = mock((_: ParameterValues) => {});

    render(<Harness onChange={onChange} />, { wrapper: SyncingAdapter });

    // On mount the bar reports "no overrides" (use defaults).
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("");

    // Simulate the drilldown click → page-side write of the shared key.
    fireEvent.click(screen.getByText("drill"));

    // The bar (same key) now reflects the drilldown value...
    await waitFor(() => {
      expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("us");
    });
    // ...and emitted the bound override — the signal the page turns into a
    // single batched re-render of every card.
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us" });
  });

  test("the bar can clear a drilldown-set value (Reset)", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: SyncingAdapter });

    fireEvent.click(screen.getByText("drill"));
    await waitFor(() => {
      expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("us");
    });

    // Reset appears once an override is present; clicking it clears back to defaults.
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    });
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("");
  });
});
