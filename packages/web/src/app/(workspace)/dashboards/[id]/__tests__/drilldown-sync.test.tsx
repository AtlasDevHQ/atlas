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
 * A real-app round-trip adapter for the shared key. `hasMemory` makes
 * NuqsTestingAdapter retain each write in an internal synchronous ref (its
 * built-in stand-in for a real URL), so a `useQueryState` write re-renders every
 * hook subscribed to that key — the Next.js round-trip the bare adapter (frozen
 * to its initial value) doesn't reproduce. The synchronous ref also means each
 * write composes on the latest value, avoiding the optimistic-cache-vs-prop
 * desync a hand-rolled `useState`-fed adapter hits under back-to-back writes.
 */
function MemoryAdapter({ children }: { children: React.ReactNode }) {
  return <NuqsTestingAdapter hasMemory>{children}</NuqsTestingAdapter>;
}

describe("drilldown ↔ parameter bar URL sync", () => {
  // One continuous lifecycle (drill → reflect → reset). Kept as a single test so
  // the nuqs `dparams` cache — module-level and keyed by name — can't leak from a
  // prior test's mount and make the next one non-deterministic.
  test("a drilldown write reflects in the bar, emits the bound value, and Reset clears it", async () => {
    const onChange = mock((_: ParameterValues) => {});

    render(<Harness onChange={onChange} />, { wrapper: MemoryAdapter });

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

    // Reset appears once an override is present; clicking it clears to defaults.
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    });
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("");
  });
});
