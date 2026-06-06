/**
 * Drilldown ↔ parameter-bar URL sync (#3212).
 *
 * The whole feature rests on the page and the parameter bar sharing ONE nuqs
 * key: a drilldown click writes the override (page side), and the bar — reading
 * the same key — reflects it AND emits it via `onChange` (the trigger that
 * re-renders every card with the bound value). This drives the REAL bar + REAL
 * `withOverride` through a real nuqs adapter, so the linchpin can't silently
 * break.
 *
 * Each test seeds the prior state via the URL and drives exactly ONE live write,
 * then asserts — never two back-to-back writes in one mount. nuqs's update queue
 * can drop the second of two rapid synthetic writes before the first has flushed
 * (the compose step then sees only the first), so the original single-test
 * drill→Reset form flaked ~17% on slow CI for exactly that reason — and was NOT
 * locally reproducible. `withNuqsTestingAdapter`'s `resetUrlUpdateQueueOnMount`
 * (on by default) clears the shared queue per mount, so the separate seeded
 * mounts don't leak into each other. Mirrors the sibling cross-filter-sync
 * .test.tsx (de-flaked the same way in #3228).
 */
import { afterEach, describe, expect, test, mock } from "bun:test";
import { useQueryState } from "nuqs";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
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
 * Seeds the shared `dparams` key in the URL and drives a faithful round-trip via
 * NuqsTestingAdapter's `hasMemory` — writes land in nuqs's own synchronous store
 * and re-render every hook subscribed to the key (the Next.js round-trip a bare
 * initial-frozen adapter doesn't reproduce). `resetUrlUpdateQueueOnMount` (on by
 * default) clears the shared queue per mount, so separate seeded mounts stay
 * independent.
 */
const seeded = (overrides: Record<string, string> = {}) =>
  withNuqsTestingAdapter({
    searchParams: Object.keys(overrides).length
      ? `${DASHBOARD_PARAMS_KEY}=${encodeURIComponent(JSON.stringify(overrides))}`
      : "",
    hasMemory: true,
  });

describe("drilldown ↔ parameter bar URL sync (#3212)", () => {
  test("a drilldown write reflects in the bar and emits the bound override", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded() });

    // On mount the bar reports "no overrides" (use defaults).
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("");

    // Simulate the drilldown click → page-side write of the shared key (one write).
    fireEvent.click(screen.getByText("drill"));

    // The bar (same key) now reflects the drilldown value...
    await waitFor(() => {
      expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("us");
    });
    // ...and emitted the bound override — the signal the page turns into a
    // single batched re-render of every card.
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us" });
  });

  test("Reset clears the active override back to defaults", async () => {
    const onChange = mock((_: ParameterValues) => {});
    // Seed the prior override via the URL (a reloaded / drilled-in state) so the
    // single live write under test is the Reset itself — never two back-to-back.
    render(<Harness onChange={onChange} />, { wrapper: seeded({ region: "us" }) });

    // Mount reflects the seeded override on both the bar and the emitted map.
    await waitFor(() => {
      expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("us");
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us" });

    // Reset appears once an override is present; clicking it clears to defaults (one write).
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    });
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("");
  });
});
