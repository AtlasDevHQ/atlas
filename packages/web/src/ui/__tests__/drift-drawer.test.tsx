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

// #2462: drawer now fires `useAdminMutation` for reconcile actions. Mock it
// so the smoke tests don't need a live AtlasProvider for the API base URL —
// the contract under test is the diff-render path, not the network layer.
const mockReconcileMutate = mock(async () => ({ ok: true as const, data: undefined }));

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: mockReconcileMutate,
    saving: false,
    error: null,
    errorsByItemId: {},
    errorFor: () => undefined,
    clearError: () => {},
    clearErrorFor: () => {},
    reset: () => {},
    isMutating: () => false,
  }),
}));

mock.module("@/ui/components/admin/mutation-error-surface", () => ({
  MutationErrorSurface: () => null,
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
  mockReconcileMutate.mockClear();
  mockReconcileMutate.mockImplementation(async () => ({ ok: true as const, data: undefined }));
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
    expect(document.body.textContent).toContain("shipped_at");
    expect(document.body.textContent).toContain("total");
    expect(document.body.textContent).toContain("decimal");
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

  test("falls back to no-drift notice when the entity is not in the diff", () => {
    // Defensive: the page only opens the drawer for drifted entities, but
    // a manual open on a clean entity must not look broken. Drawer also
    // logs a console.warn for this case (drift/diff disagreement signal) —
    // capture and assert it fired so a future refactor can't silently drop
    // the warning.
    const originalWarn = console.warn;
    const warned: string[] = [];
    console.warn = (...args: unknown[]) => {
      warned.push(args.map((a) => String(a)).join(" "));
    };

    try {
      mockData = makeDiff({
        unchangedCount: 1,
        summary: { total: 1, new: 0, removed: 0, changed: 0, unchanged: 1 },
      });

      render(
        <DriftDrawer entityName="users" open={true} onOpenChange={() => {}} />,
        { wrapper },
      );

      expect(document.body.textContent).toContain("No drift detected for");
      expect(warned.some((m) => m.includes("drift-drawer") && m.includes("users"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
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

  test("clicking the sync action fires reconcile mutate, onReconciled, and closes", async () => {
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

    const opens: boolean[] = [];
    const reconciledCalls: number[] = [];

    render(
      <DriftDrawer
        entityName="orders"
        open={true}
        onOpenChange={(o) => opens.push(o)}
        onReconciled={() => reconciledCalls.push(1)}
      />,
      { wrapper },
    );

    const syncBtn = document.querySelector('[data-testid="drift-action-sync_yaml"]') as HTMLButtonElement | null;
    expect(syncBtn).not.toBeNull();
    fireEvent.click(syncBtn!);

    // Mutate is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockReconcileMutate).toHaveBeenCalledTimes(1);
    const callArg = (mockReconcileMutate.mock.calls[0] as unknown as [{ body: { action: string; connection: string } }])[0];
    expect(callArg.body.action).toBe("sync_yaml");
    expect(callArg.body.connection).toBe("default");
    expect(reconciledCalls).toHaveLength(1);
    expect(opens).toContain(false);
  });

  test("reconcileDisabled disables every action button and surfaces the reason via title", () => {
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
      <DriftDrawer
        entityName="orders"
        open={true}
        onOpenChange={() => {}}
        reconcileDisabled
        reconcileDisabledReason="Switch to developer mode"
      />,
      { wrapper },
    );

    const syncBtn = document.querySelector('[data-testid="drift-action-sync_yaml"]') as HTMLButtonElement | null;
    const removeBtn = document.querySelector('[data-testid="drift-action-remove"]') as HTMLButtonElement | null;
    expect(syncBtn?.disabled).toBe(true);
    expect(removeBtn?.disabled).toBe(true);
    expect(syncBtn?.getAttribute("title")).toBe("Switch to developer mode");
  });
});
