/**
 * Regression guard for #2419: single-group workspaces must auto-bind the
 * sole `connection_groups` row to the card on create. The pre-fix dialog
 * hid the picker when `groups.length <= 1` AND dropped `connectionGroupId`
 * from the POST payload, silently falling through to `resolveCardConnectionId`'s
 * workspace-default path (packages/api/src/lib/dashboards.ts:238). That
 * violates PRD #2342's "card-create form scopes by group" criterion —
 * the single-env case must materialize the binding even though there's
 * no UI choice to make.
 *
 * Pins all three cardinality regimes (one / zero / multi) plus the
 * single-env readout copy so a future refactor can't re-introduce the
 * silent fallthrough.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import React, { type ReactNode } from "react";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface ConnectionGroup {
  id: string;
  name: string;
  memberCount: number;
  primaryConnectionId: string | null;
  resolvedConnectionId: string | null;
}

interface CapturedCall {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
}

let dashboardsData: { dashboards: Array<{ id: string; title: string; cardCount: number }>; total: number } = {
  dashboards: [],
  total: 0,
};
let groupsData: { groups: ConnectionGroup[] } | null = { groups: [] };
let mutateCalls: CapturedCall[] = [];

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: (path: string) => {
    if (path === "/api/v1/dashboards") {
      return { data: dashboardsData, loading: false, error: null, refetch: () => {} };
    }
    if (path === "/api/v1/admin/connection-groups") {
      return { data: groupsData, loading: false, error: null, refetch: () => {} };
    }
    return { data: null, loading: false, error: null, refetch: () => {} };
  },
}));

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: async (opts: { path: string; method?: string; body?: Record<string, unknown> }) => {
      mutateCalls.push({ path: opts.path, method: opts.method, body: opts.body });
      if (opts.path.endsWith("/cards")) {
        return { ok: true, data: { id: "card-1" } };
      }
      // createDashboard mutation
      return {
        ok: true,
        data: { id: "dashboard-1", title: opts.body?.title ?? "Dash", cardCount: 0 },
      };
    },
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

const { AddToDashboardDialog } = await import("../components/chat/add-to-dashboard-dialog");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

const noChartResult = { chartable: false as const, recommendations: [] };

const baseProps = {
  open: true,
  onOpenChange: () => {},
  sql: "SELECT 1",
  columns: ["x"],
  rows: [{ x: 1 }],
  chartResult: noChartResult,
};

beforeEach(() => {
  mutateCalls = [];
  dashboardsData = { dashboards: [], total: 0 };
  groupsData = { groups: [] };
});

afterEach(() => {
  cleanup();
});

async function submitDialog(): Promise<void> {
  // dashboards = [] forces effectiveMode → "new", which renders an
  // Input instead of a Select for the dashboard target.
  const titleInput = screen.getByPlaceholderText("Dashboard title");
  fireEvent.change(titleInput, { target: { value: "My Dashboard" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Add to Dashboard/ }));
  });
}

describe("AddToDashboardDialog — connection group binding (#2419)", () => {
  test("one-group workspace: auto-binds the sole group in the POST payload", async () => {
    groupsData = {
      groups: [
        {
          id: "g_prod",
          name: "prod",
          memberCount: 1,
          primaryConnectionId: "c_prod",
          resolvedConnectionId: "c_prod",
        },
      ],
    };
    render(React.createElement(AddToDashboardDialog, baseProps), { wrapper: Wrapper });

    await submitDialog();

    await waitFor(() => {
      const cardCall = mutateCalls.find((c) => c.path.endsWith("/cards"));
      expect(cardCall).toBeDefined();
      expect(cardCall?.body?.connectionGroupId).toBe("g_prod");
    });
  });

  test("zero-group workspace: POST payload omits connectionGroupId (pre-1.4.4 fallthrough)", async () => {
    groupsData = { groups: [] };
    render(React.createElement(AddToDashboardDialog, baseProps), { wrapper: Wrapper });

    await submitDialog();

    await waitFor(() => {
      const cardCall = mutateCalls.find((c) => c.path.endsWith("/cards"));
      expect(cardCall).toBeDefined();
    });
    const cardCall = mutateCalls.find((c) => c.path.endsWith("/cards"));
    expect(cardCall?.body).toBeDefined();
    expect("connectionGroupId" in (cardCall!.body as object)).toBe(false);
  });

  test("multi-group workspace: env picker renders, no auto-binding", () => {
    groupsData = {
      groups: [
        {
          id: "g_prod",
          name: "prod",
          memberCount: 1,
          primaryConnectionId: "c_prod",
          resolvedConnectionId: "c_prod",
        },
        {
          id: "g_staging",
          name: "staging",
          memberCount: 1,
          primaryConnectionId: "c_staging",
          resolvedConnectionId: "c_staging",
        },
      ],
    };
    render(React.createElement(AddToDashboardDialog, baseProps), { wrapper: Wrapper });

    // The "Environment" label is the picker's anchor — its presence
    // proves the picker rendered. Single-env readout copy must NOT
    // appear in the multi-group case.
    expect(screen.queryByText("Environment")).not.toBeNull();
    expect(screen.queryByText(/Card runs against/)).toBeNull();
  });

  test("one-group with primary: readout copy surfaces the binding (picker stays hidden)", () => {
    groupsData = {
      groups: [
        {
          id: "g_prod",
          name: "prod",
          memberCount: 1,
          primaryConnectionId: "c_prod",
          resolvedConnectionId: "c_prod",
        },
      ],
    };
    render(React.createElement(AddToDashboardDialog, baseProps), { wrapper: Wrapper });

    // Picker is hidden, readout is visible. The wording must name the
    // group so single-env users can confirm the binding at a glance.
    expect(screen.queryByText("Environment")).toBeNull();
    expect(screen.getByText(/Card runs against the primary member of/i).textContent)
      .toContain("prod");
  });

  test("one-group with no primary: readout falls back to 'first member' language", () => {
    groupsData = {
      groups: [
        {
          id: "g_only",
          name: "warehouse",
          memberCount: 2,
          primaryConnectionId: null,
          resolvedConnectionId: "c_first",
        },
      ],
    };
    render(React.createElement(AddToDashboardDialog, baseProps), { wrapper: Wrapper });

    expect(screen.getByText(/first member \(no primary pinned\)/i)).toBeTruthy();
  });

  test("one-group with zero members: readout warns instead of silently binding to an empty group", () => {
    // Auto-bind still materializes connectionGroupId so the API's
    // NoGroupMembersError fires cleanly at refresh time — but the
    // operator must see the warning at create time, not after the
    // first failed refresh.
    groupsData = {
      groups: [
        {
          id: "g_empty",
          name: "ghost",
          memberCount: 0,
          primaryConnectionId: null,
          resolvedConnectionId: null,
        },
      ],
    };
    render(React.createElement(AddToDashboardDialog, baseProps), { wrapper: Wrapper });

    expect(screen.getByText(/has no connections/i)).toBeTruthy();
  });
});
