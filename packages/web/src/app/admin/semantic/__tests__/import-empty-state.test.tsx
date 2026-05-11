/**
 * The Import-from-disk affordance must only render when the workspace has
 * zero entities. Otherwise it sits next to a fully populated tree and reads
 * as "data is missing — recover here", which confuses users on a clean Demo.
 *
 * Pins three invariants:
 *   1. populated → toolbar button AND empty-state both gone
 *   2. empty + non-dev → toolbar button AND empty-state both present,
 *      and the empty-state link drives the same mutation as the toolbar
 *   3. empty + dev-mode-no-drafts → DeveloperEmptyState wins (routes the
 *      admin to /admin/connections), the new SaaS empty-state must NOT render
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";

// Controls `useDevModeNoDrafts` per test. The dev-mode branch in page.tsx
// must take precedence over the new SaaS empty state — flipped here so the
// precedence test can exercise the dev-mode branch without rewriting mocks.
let devNoDraftsValue = false;

// Shared spy used by `useAdminMutation` — every consumer (`mutateSave`,
// `mutateDelete`, `mutateImport`) sees the same `mutate` fn, so a click on
// the Sync link is verifiable via call count without entangling other paths
// that aren't clicked in this suite.
const mockMutate = mock(async () => ({
  ok: true as const,
  data: { imported: 0, skipped: 0, total: 0 },
}));

mock.module("next/navigation", () => ({
  usePathname: () => "/admin/semantic",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/ui/context", () => ({
  useAtlasConfig: () => ({
    apiUrl: "http://localhost",
    isCrossOrigin: false,
    authClient: { useSession: () => ({ data: null }) },
  }),
}));

mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({ deployMode: "saas", loading: false, error: null }),
}));

mock.module("@/ui/hooks/use-demo-readonly", () => ({
  useDemoReadonly: () => ({ readOnly: false, demoIndustry: null }),
  demoIndustryLabel: () => null,
}));

mock.module("@/ui/hooks/use-dev-mode-no-drafts", () => ({
  useDevModeNoDrafts: () => devNoDraftsValue,
}));

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: mockMutate,
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

// Minimal stand-ins for nested admin surfaces — the page mounts them
// regardless of branch, but they're not under test here.
mock.module("@/ui/components/admin/semantic-health-widget", () => ({
  SemanticHealthWidget: () => null,
}));
mock.module("@/ui/components/admin/semantic-file-tree", () => ({
  SemanticFileTree: () => createElement("div", { "data-testid": "semantic-file-tree" }),
}));
mock.module("@/ui/components/admin/entity-version-history", () => ({
  EntityVersionHistory: () => null,
}));
mock.module("@/ui/components/admin/entity-editor-dialog", () => ({
  EntityEditorDialog: () => null,
  formValuesToEntityBody: () => ({}),
}));

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockSemanticApi(entities: Array<{ name: string; description?: string; columnCount?: number }>) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/admin/semantic/org/entities")) {
      return Promise.resolve(jsonResponse({ entities }));
    }
    if (url.includes("/api/v1/admin/semantic/entities")) {
      return Promise.resolve(jsonResponse({ entities }));
    }
    if (url.includes("/api/v1/admin/semantic/glossary")) {
      return Promise.resolve(jsonResponse({ glossary: [] }));
    }
    if (url.includes("/api/v1/admin/semantic/metrics")) {
      return Promise.resolve(jsonResponse({ metrics: [] }));
    }
    if (url.includes("/api/v1/admin/semantic/catalog")) {
      return Promise.resolve(jsonResponse({ catalog: null }));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
}

const SemanticPage = (await import("../page")).default;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(
    NuqsAdapter,
    null,
    createElement(QueryClientProvider, { client }, children),
  );
}

function findButtonByText(text: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  );
}

describe("/admin/semantic — Import-from-disk gating", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    devNoDraftsValue = false;
    mockMutate.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("populated workspace hides both Import surfaces", async () => {
    mockSemanticApi([
      { name: "companies", description: "", columnCount: 3 },
      { name: "users", description: "", columnCount: 5 },
    ]);

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="semantic-file-tree"]')).not.toBeNull();
    });

    expect(findButtonByText("Import from disk")).toBeNull();
    expect(
      document.querySelector('[data-testid="semantic-empty-state"]'),
    ).toBeNull();
  });

  test("empty workspace surfaces toolbar button + empty-state link", async () => {
    mockSemanticApi([]);

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="semantic-empty-state"]'),
      ).not.toBeNull();
    });

    expect(findButtonByText("Import from disk")).not.toBeNull();
    expect(findButtonByText("Sync from disk")).not.toBeNull();
  });

  test("empty-state Sync link drives the same import mutation as the toolbar", async () => {
    mockSemanticApi([]);

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    const syncBtn = await waitFor(() => {
      const b = findButtonByText("Sync from disk");
      if (!b) throw new Error("Sync from disk button not rendered");
      return b;
    });

    const callsBefore = mockMutate.mock.calls.length;
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // A real spy call — not just a non-null `onclick`, which React doesn't
    // populate on the DOM node under synthetic event delegation. A regression
    // that wires the link to a no-op handler would leave the count flat.
    expect(mockMutate.mock.calls.length).toBe(callsBefore + 1);
  });

  test("dev-mode-no-drafts empty state takes precedence over the SaaS empty state", async () => {
    // Both `showDevNoDrafts && entities.length === 0` and `isSaas && entities.length === 0`
    // can be true at once. The dev-mode branch sits first in the ternary because
    // an admin with no drafts AND no published entities needs a connection first —
    // a disk sync against an empty org dir is wasted motion. If the conditional
    // ladder gets reordered, this case exposes the swap.
    devNoDraftsValue = true;
    mockSemanticApi([]);

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="developer-empty-state"]'),
      ).not.toBeNull();
    });

    expect(
      document.querySelector('[data-testid="semantic-empty-state"]'),
    ).toBeNull();
    // `DeveloperEmptyState` renders its CTA as `<Button asChild><Link/></Button>`,
    // so the anchor — not a `<button>` — carries the label.
    const goLink = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Go to connections"),
    );
    expect(goLink).toBeDefined();
  });
});
