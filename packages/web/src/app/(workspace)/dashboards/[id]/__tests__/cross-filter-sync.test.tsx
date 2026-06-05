/**
 * Cross-filter ↔ parameter-bar ↔ chips URL sync (#3213).
 *
 * Cross-filtering rests on every surface sharing ONE nuqs key (`dparams`): a
 * drilldown click writes an override (toggle), the parameter bar — reading the
 * same key — reflects it AND emits it via `onChange` (the SINGLE signal the page
 * turns into one batched re-render of EVERY card, so the filter applies across
 * cards), and the chips bar shows the active overrides with per-chip remove +
 * clear-all. This drives the REAL bar + REAL chips + REAL toggle/withOverride
 * through a real nuqs adapter, so the cross-card linchpin can't silently break.
 *
 * The actual fan-out (one bound override → a render per card, batched via
 * `Promise.all`) is `renderDashboardCards`, covered in dashboard-card-render
 * .test.ts; which cards bind the param is covered in cross-filter.test.ts. Here
 * we pin the URL-state contract those two build on.
 */
import { afterEach, describe, expect, test, mock } from "bun:test";
import { useQueryState } from "nuqs";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { DashboardParameterBar, type ParameterValues } from "@/ui/components/dashboards/dashboard-parameter-bar";
import { DashboardFilterChips } from "@/ui/components/dashboards/dashboard-filter-chips";
import {
  DASHBOARD_PARAMS_KEY,
  dashboardParamsParser,
  parseOverrides,
  withOverride,
  toggleOverride,
} from "../search-params";
import { activeFilters } from "../cross-filter";
import type { DashboardParameter } from "@/ui/lib/types";

afterEach(cleanup);

const REGION: DashboardParameter = { key: "region", type: "text", default: null, label: "Region" };
const STAGE: DashboardParameter = { key: "stage", type: "text", default: null, label: "Stage" };
const PARAMS = [REGION, STAGE];

/**
 * Mirrors the page wiring: a page-side `useQueryState` on the shared key (the
 * drilldown writer, applied through the same `toggleOverride` the page uses),
 * the parameter bar (render trigger), and the chips bar (active-filter summary +
 * remove/clear-all) — all bound to the one key. The drill buttons stand in for
 * a chart/table click resolved to `onDrilldown(param, value)`.
 */
function Harness({ onChange }: { onChange: (o: ParameterValues) => void }) {
  const [raw, setRaw] = useQueryState(DASHBOARD_PARAMS_KEY, dashboardParamsParser);
  const filters = activeFilters(parseOverrides(raw), PARAMS);
  return (
    <>
      <button type="button" onClick={() => void setRaw(toggleOverride(raw, "region", "us"))}>
        drill-region
      </button>
      <button type="button" onClick={() => void setRaw(toggleOverride(raw, "stage", "Discovery"))}>
        drill-stage
      </button>
      <DashboardParameterBar parameters={PARAMS} onChange={onChange} />
      <DashboardFilterChips
        filters={filters}
        onRemove={(key) => void setRaw(withOverride(raw, key, null))}
        onClearAll={() => void setRaw(null)}
      />
    </>
  );
}

/**
 * A wrapper that seeds the shared `dparams` key in the URL and drives a faithful
 * round-trip via NuqsTestingAdapter's `hasMemory` — writes land in nuqs's own
 * synchronous store and re-render every hook subscribed to the key, the Next.js
 * round-trip a bare (initial-frozen) testing adapter doesn't reproduce.
 *
 * Each test seeds the *prior* filter state and drives exactly ONE live write —
 * one drill / chip-remove / clear-all — then asserts. One write per mount,
 * never two back-to-back, is what keeps this deterministic: nuqs's update queue
 * can drop the second of two rapid synthetic writes before the first has flushed
 * (the compose step composes on the first, so a dropped/lagging first write
 * silently breaks it). The single-write sibling `drilldown-sync` is stable for
 * the same reason. `resetUrlUpdateQueueOnMount` (on by default) clears the
 * shared queue per mount, so separate seeded mounts don't leak into each other.
 */
const seeded = (overrides: Record<string, string> = {}) =>
  withNuqsTestingAdapter({
    searchParams: Object.keys(overrides).length
      ? `${DASHBOARD_PARAMS_KEY}=${encodeURIComponent(JSON.stringify(overrides))}`
      : "",
    hasMemory: true,
  });

describe("cross-filter ↔ bar ↔ chips URL sync (#3213)", () => {
  test("drilling a card applies the filter across cards and shows a chip", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded() });

    // Mount: no overrides (use defaults), no chips.
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    expect(screen.queryByTestId("dashboard-filter-chips")).toBeNull();

    // Drill on "region" → filter applies to every card (the bound map the page
    // hands the batched render) and a chip appears.
    fireEvent.click(screen.getByText("drill-region"));
    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-region").textContent).toContain("us");
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us" });
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("us");
  });

  test("a second drill composes (AND) with the existing filter", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded({ region: "us" }) });

    // Mount reflects the seeded region filter on every surface.
    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-region").textContent).toContain("us");
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us" });
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("us");

    // Drill a second param → the two compose (AND) in one override map.
    fireEvent.click(screen.getByText("drill-stage"));
    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-stage").textContent).toContain("Discovery");
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us", stage: "Discovery" });
  });

  test("removing a chip drops only that filter", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded({ region: "us", stage: "Discovery" }) });

    // Mount reflects both seeded filters.
    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-stage").textContent).toContain("Discovery");
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us", stage: "Discovery" });

    // Remove the region chip → only the stage filter remains.
    fireEvent.click(screen.getByRole("button", { name: "Remove Region filter" }));
    await waitFor(() => {
      expect(screen.queryByTestId("filter-chip-region")).toBeNull();
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ stage: "Discovery" });
  });

  test("re-drilling the same value toggles that filter off", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded({ stage: "Discovery" }) });

    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-stage").textContent).toContain("Discovery");
    });

    // Re-click the same stage element → toggle deselect clears it; no chips left.
    fireEvent.click(screen.getByText("drill-stage"));
    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    });
    expect(screen.queryByTestId("dashboard-filter-chips")).toBeNull();
  });

  test("Clear all removes every active cross-filter in one action", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded({ region: "us", stage: "Discovery" }) });

    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "us", stage: "Discovery" });
    });

    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    await waitFor(() => {
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({});
    });
    expect(screen.queryByTestId("dashboard-filter-chips")).toBeNull();
  });

  test("reload of a shared link reflects the URL filters on mount", async () => {
    const onChange = mock((_: ParameterValues) => {});
    render(<Harness onChange={onChange} />, { wrapper: seeded({ region: "eu" }) });

    // The chip + bar reflect the persisted state with no interaction, and the bar
    // emits the bound map so the page renders the shared view's filtered cards.
    await waitFor(() => {
      expect(screen.getByTestId("filter-chip-region").textContent).toContain("eu");
    });
    expect((screen.getByLabelText("Region") as HTMLInputElement).value).toBe("eu");
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ region: "eu" });
  });
});
