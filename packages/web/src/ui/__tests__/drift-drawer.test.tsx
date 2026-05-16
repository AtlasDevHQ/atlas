/**
 * Smoke tests for the drift drawer (#2461). Verifies that a fixture diff
 * payload renders through the shared `<DiffCard>` and that the open/close
 * contract surfaces back to the caller. Mocks `useAdminFetch` directly so
 * we don't touch the network layer — the contract under test is "given
 * data X for entity Y, the drawer renders the right card".
 *
 * Mirrors the mocking shape from `backup-method-banner.test.tsx`.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SemanticDiffResponse } from "@useatlas/types";

type DiffResponse = SemanticDiffResponse;

let mockData: DiffResponse | null = null;
let mockLoading = false;
let mockError: { message: string; status?: number } | null = null;

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({
    data: mockError ? null : mockData,
    loading: mockLoading,
    error: mockError,
    setError: () => {},
    refetch: () => Promise.resolve(),
  }),
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
}));

mock.module("@/ui/lib/fetch-error", () => ({
  friendlyError: (err: { message?: string }) => err?.message ?? "error",
  friendlyErrorOrNull: (err: { message?: string } | null | undefined) =>
    err?.message ?? null,
  buildFetchError: (init: { message: string }) => ({ message: init.message }),
  extractFetchError: async (r: Response) => ({ message: `HTTP ${r.status}` }),
}));

const { DriftDrawer } = await import("../components/admin/drift-drawer");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function makeDiff(overrides: Partial<DiffResponse> = {}): DiffResponse {
  return {
    connection: "default",
    newTables: [],
    removedTables: [],
    tableDiffs: [],
    unchangedCount: 0,
    summary: { total: 0, new: 0, removed: 0, changed: 0, unchanged: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  mockData = null;
  mockLoading = false;
  mockError = null;
});

afterEach(() => {
  cleanup();
});

describe("DriftDrawer (#2461)", () => {
  test("renders the per-table diff card for a drifted entity", () => {
    mockData = makeDiff({
      tableDiffs: [
        {
          table: "orders",
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
          removedColumns: [],
          typeChanges: [{ name: "total", yamlType: "number", dbType: "decimal" }],
        },
      ],
      summary: { total: 1, new: 0, removed: 0, changed: 1, unchanged: 0 },
    });

    render(
      <DriftDrawer entityName="orders" open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    // Drawer renders to a portal — query document.body, not container.
    expect(document.body.textContent).toContain("orders");
    // Added column surfaced from the fixture.
    expect(document.body.textContent).toContain("shipped_at");
    // Type-change row uses the YAML → DB transition.
    expect(document.body.textContent).toContain("total");
    expect(document.body.textContent).toContain("decimal");
    // Header sentence is the static drawer description.
    expect(document.body.textContent).toContain("Schema drift between database and YAML");
  });

  test("renders the removed-table notice when the entity is in removedTables", () => {
    mockData = makeDiff({
      removedTables: ["legacy_table"],
      summary: { total: 1, new: 0, removed: 1, changed: 0, unchanged: 0 },
    });

    render(
      <DriftDrawer entityName="legacy_table" open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    expect(document.body.textContent).toContain("legacy_table");
    expect(document.body.textContent).toContain("no longer exists in the database");
  });

  test("falls back to in-sync notice when the entity is not in the diff", () => {
    // Defensive: the page only opens the drawer for drifted entities, but
    // a manual open on a clean entity must not look broken.
    mockData = makeDiff({
      unchangedCount: 1,
      summary: { total: 1, new: 0, removed: 0, changed: 0, unchanged: 1 },
    });

    render(
      <DriftDrawer entityName="users" open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    expect(document.body.textContent).toContain("is in sync with the database");
  });

  test("does not fetch or render body when closed", () => {
    mockData = makeDiff({
      tableDiffs: [
        {
          table: "orders",
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
          removedColumns: [],
          typeChanges: [],
        },
      ],
      summary: { total: 1, new: 0, removed: 0, changed: 1, unchanged: 0 },
    });

    render(
      <DriftDrawer entityName="orders" open={false} onOpenChange={() => {}} />,
      { wrapper },
    );

    // Sheet is closed → Radix unmounts portal content. The drawer-specific
    // copy must not be on the page.
    expect(document.body.textContent).not.toContain("Schema drift between database and YAML");
    expect(document.body.textContent).not.toContain("shipped_at");
  });

  test("invokes onOpenChange(false) when the user closes the sheet", () => {
    mockData = makeDiff({
      tableDiffs: [
        {
          table: "orders",
          addedColumns: [{ name: "shipped_at", type: "timestamp" }],
          removedColumns: [],
          typeChanges: [],
        },
      ],
      summary: { total: 1, new: 0, removed: 0, changed: 1, unchanged: 0 },
    });

    const calls: boolean[] = [];

    const { rerender } = render(
      <DriftDrawer
        entityName="orders"
        open={true}
        onOpenChange={(open) => calls.push(open)}
      />,
      { wrapper },
    );

    // Radix Dialog (which Sheet wraps) closes on Escape and routes that
    // through `onOpenChange(false)`. This is the contract we care about —
    // we don't need to drive the close button manually to verify it.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(calls).toContain(false);

    // Re-render with `open={false}` to mimic the parent state update —
    // body content should disappear.
    rerender(
      <DriftDrawer
        entityName="orders"
        open={false}
        onOpenChange={(open) => calls.push(open)}
      />,
    );
    expect(document.body.textContent).not.toContain("shipped_at");
  });

  test("renders error banner when the diff request fails", () => {
    mockError = { message: "Boom", status: 500 };

    render(
      <DriftDrawer entityName="orders" open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    expect(document.body.textContent).toContain("Boom");
  });

  test("renders loading state while the diff request is in flight", () => {
    mockLoading = true;

    render(
      <DriftDrawer entityName="orders" open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    expect(document.body.textContent).toContain("Loading drift");
  });
});
