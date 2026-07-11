/**
 * Tests for the fetching `CoverageView` (#4521) — the piece that fulfills AC4's
 * promise that a `profiling` connection's loading state resolves on its own by
 * polling the backfill. The presentational rendering is pinned in
 * `coverage-view.test.tsx`; this file pins the fetch wiring + the poll lifecycle
 * (only a render can catch a never-cleared interval or a poll that never fires).
 *
 * `setInterval`/`clearInterval` are spied (not fake-timered) so the poll is
 * asserted deterministically without a 4s wall-clock wait.
 */

import { describe, expect, test, mock, afterEach, spyOn } from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { CoverageOverviewResponse } from "../coverage";

// Mutable fetch fixture so a test can feed a profiling / ready / empty overview.
let mockData: CoverageOverviewResponse | null = null;
let mockLoading = false;
const refetchSpy = mock(async () => ({}));

void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ data: mockData, loading: mockLoading, error: null, refetch: refetchSpy }),
}));
void mock.module("@/ui/components/admin/mutation-error-surface", () => ({
  MutationErrorSurface: () => null,
}));
void mock.module("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
void mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));

const { CoverageView } = await import("../coverage");

function readyConnection(): CoverageOverviewResponse {
  return {
    profiling: false,
    connections: [
      {
        installId: "conn_1",
        group: "grp_prod",
        dbType: "postgres",
        status: "ready",
        error: null,
        freshness: "profiled 2 days ago",
        coverage: {
          tables: [
            {
              table: "orders",
              rowCount: 10,
              entity: "orders",
              group: "grp_prod",
              state: "partial",
              coveredColumnCount: 1,
              coverableColumnCount: 2,
              columns: [
                { column: "status", type: "text", isPrimaryKey: false, covered: true, dimension: "status", described: true, sampled: false },
              ],
            },
          ],
          summary: { coveredTables: 0, partialTables: 1, uncoveredTables: 0, totalTables: 1 },
        },
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  mockData = null;
  mockLoading = false;
  refetchSpy.mockClear();
});

describe("CoverageView — fetch wiring", () => {
  test("renders the fetched connections", () => {
    mockData = readyConnection();
    const { getByText } = render(createElement(CoverageView, { onColumnAnchor: () => {}, disabled: false }));
    expect(getByText("grp_prod")).toBeDefined();
    expect(getByText("orders")).toBeDefined();
  });

  test("shows the empty state when there are no profilable connections", () => {
    mockData = { connections: [], profiling: false };
    const { getByText } = render(createElement(CoverageView, { onColumnAnchor: () => {}, disabled: false }));
    expect(getByText(/No profilable connections yet/i)).toBeDefined();
  });
});

describe("CoverageView — poll lifecycle (AC4)", () => {
  test("polls refetch on a 4s interval while any connection is profiling, and clears on unmount", () => {
    mockData = {
      profiling: true,
      connections: [
        { installId: "c1", group: "g", dbType: "postgres", status: "profiling", error: null, freshness: null, coverage: null },
      ],
    };
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    try {
      const { unmount } = render(createElement(CoverageView, { onColumnAnchor: () => {}, disabled: false }));

      // The poll effect registered a 4s interval.
      const pollCall = setIntervalSpy.mock.calls.find((c) => c[1] === 4000);
      expect(pollCall).toBeDefined();

      // Firing the interval callback re-fetches (drives the backfill to completion).
      const tick = pollCall?.[0] as () => void;
      act(() => tick());
      expect(refetchSpy).toHaveBeenCalled();

      // Unmounting clears the interval — no leak / runaway poll.
      unmount();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  test("does NOT poll when nothing is profiling", () => {
    mockData = readyConnection(); // profiling: false
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    try {
      render(createElement(CoverageView, { onColumnAnchor: () => {}, disabled: false }));
      expect(setIntervalSpy.mock.calls.find((c) => c[1] === 4000)).toBeUndefined();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
