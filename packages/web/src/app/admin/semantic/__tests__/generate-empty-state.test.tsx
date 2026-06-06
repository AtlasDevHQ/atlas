/**
 * Door 2 (#3237): the /admin/semantic empty state offers an in-product
 * "Generate semantic layer" entry — replacing the old "Run `atlas init`"
 * terminal instruction — that launches the shared wizard flow. With exactly
 * one connection the CTA deep-links to that connection's table picker so the
 * generated entities land in its Connection group.
 *
 * Pins:
 *   1. empty + one connection → Generate CTA links to /wizard?connectionId=…&step=2
 *   2. empty + zero connections → Generate CTA links to the bare /wizard picker
 *   3. populated workspace → Generate CTA absent
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";

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
  useDevModeNoDrafts: () => false,
}));

mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => ({
    mutate: mock(async () => ({ ok: true as const, data: null })),
    saving: false,
    error: null,
    clearError: () => {},
    reset: () => {},
  }),
}));

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

function mockSemanticApi(opts: {
  entities: Array<{ name: string; columnCount?: number }>;
  connections: Array<{ id: string; dbType: string }>;
}) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/v1/admin/semantic/entities")) {
      return Promise.resolve(jsonResponse({ entities: opts.entities }));
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
    if (url.includes("/api/v1/admin/connections")) {
      return Promise.resolve(jsonResponse({ connections: opts.connections }));
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

function findGenerateCta(): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>('[data-testid="semantic-generate-cta"]');
}

describe("/admin/semantic — Generate empty state (#3237)", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("empty + one connection: CTA deep-links to that connection's table picker", async () => {
    mockSemanticApi({
      entities: [],
      connections: [{ id: "warehouse", dbType: "postgres" }],
    });

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    const cta = await waitFor(() => {
      const el = findGenerateCta();
      if (!el) throw new Error("Generate CTA not rendered");
      return el;
    });

    expect(cta.getAttribute("href")).toBe("/wizard?connectionId=warehouse&step=2");
    expect(cta.textContent).toContain("Generate semantic layer");
  });

  test("empty + zero connections: CTA routes to the bare wizard picker", async () => {
    mockSemanticApi({ entities: [], connections: [] });

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    const cta = await waitFor(() => {
      const el = findGenerateCta();
      if (!el) throw new Error("Generate CTA not rendered");
      return el;
    });

    expect(cta.getAttribute("href")).toBe("/wizard");
  });

  test("populated workspace: no Generate CTA, no 'atlas init' instruction", async () => {
    mockSemanticApi({
      entities: [{ name: "companies", columnCount: 3 }],
      connections: [{ id: "warehouse", dbType: "postgres" }],
    });

    await act(async () => {
      render(createElement(SemanticPage), { wrapper });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-testid="semantic-file-tree"]')).not.toBeNull();
    });

    expect(findGenerateCta()).toBeNull();
  });
});
