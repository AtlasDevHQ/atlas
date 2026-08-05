import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * `token-usage/tab.tsx` had no test of any kind, and #5068's review found that
 * every mutation to it survives the whole web suite: re-admitting 503 to its
 * gate set, deleting the gate outright, and reverting all three
 * `friendlyError` banners were each silently green.
 *
 * That matters because this file is one of the gate-set owners. It held the
 * last of five hand-written copies of the gated-status list, and the *reason*
 * for its narrowing — 503 stays per-section because it can fail one of three
 * parallel requests — is a decision nothing was pinning.
 *
 * The tab fires three requests and promotes the first gate error to
 * `AdminContentWrapper`, so each arm answers all three identically.
 */

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/usage",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// Recharts is `dynamic(..., { ssr: false })` and irrelevant to every arm here.
void mock.module("../token-chart", () => ({ default: () => null }));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const { TokenUsageTab } = await import("../tab");

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    NuqsAdapter,
    null,
    createElement(
      QueryClientProvider,
      { client: testQueryClient },
      createElement(AtlasProvider, {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
        children,
      }),
    ),
  );
}

const REQUEST_ID = "8f0c1e2a-4b6d-4f1a-9c3e-77d2b5a10e94";

const originalFetch = globalThis.fetch;

function failAll(status: number, body: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const renderTab = () => render(createElement(TokenUsageTab), { wrapper: Wrapper });

beforeEach(() => {
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testQueryClient.clear();
  cleanup();
});

describe("TokenUsageTab — the gate carries the server's words and the id (#5068)", () => {
  test("a 403 surfaces the server's role message, not the canned admin-role line", async () => {
    failAll(403, {
      error: "forbidden_role",
      message: "Platform admin role required.",
      requestId: REQUEST_ID,
    });
    const view = renderTab();

    await waitFor(() => expect(view.container.textContent ?? "").toContain("Access denied"));
    expect(view.container.textContent ?? "").toContain("Platform admin role required.");
    expect(view.container.textContent ?? "").not.toContain(
      "You need the admin role to access this page.",
    );
    const line = view.container.querySelector('[data-testid="feature-gate-request-id"]');
    if (!line) throw new Error("gate rendered no request-id line");
    expect(line.textContent).toContain(REQUEST_ID);
  });

  test("an EMPTY gated body keeps the canned copy — the arm that pins gateProps()", async () => {
    // Without this, forwarding `error.message` instead of `gateProps(error)`
    // passes the arm above and puts "HTTP 404" where the guidance belongs.
    failAll(404, {});
    const view = renderTab();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Token Usage not enabled"),
    );
    expect(view.container.textContent ?? "").toContain(
      "Enable this feature in your server configuration to use this page.",
    );
    expect(view.container.textContent ?? "").not.toContain("HTTP 404");
  });

  test("a 503 is NOT promoted to a page-level gate — it stays per-section", async () => {
    // The deliberate narrowing, and the only thing pinning it. A gate here
    // replaces the whole tab; a 503 can fail one of three parallel requests
    // (restarting replica, unhealthy proxy) and blanking the tab for that
    // would discard two sections that loaded fine.
    failAll(503, {
      error: "permissions_unavailable",
      message: "Authorization service is temporarily unavailable.",
      requestId: REQUEST_ID,
    });
    const view = renderTab();

    await waitFor(() =>
      expect(view.container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0),
    );
    // The gate's headline is the discriminator — the banner renders the server
    // sentence either way, so asserting on the copy proves nothing.
    expect(view.container.textContent ?? "").not.toContain("Token Usage is unavailable");
    expect(view.container.textContent ?? "").not.toContain("Access denied");
    // Per banner, not container-scoped: this tab has three independent
    // `friendlyError` call sites and a whole-container `toContain` is
    // satisfied by any one, so reverting two would stay green — the exact
    // weakness the sibling analytics-panel arm was rewritten to close.
    const alerts = Array.from(view.container.querySelectorAll('[role="alert"]'));
    expect(alerts.length).toBe(3);
    for (const alert of alerts) {
      expect(alert.textContent ?? "").toContain(REQUEST_ID);
    }
  });

  test("an empty-bodied 500 banner shows actionable copy, never the status echo", async () => {
    // 500 is not a gate, so this is the negative that keeps the whitelist
    // meaningful — and the one that pins the `friendlyError` swap on the
    // summary banner, which previously rendered the literal "HTTP 500".
    failAll(500, {});
    const view = renderTab();

    await waitFor(() =>
      expect(view.container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0),
    );
    expect(view.container.textContent ?? "").not.toContain("HTTP 500");
    expect(view.container.textContent ?? "").toContain("Retry in a moment");
    expect(view.container.textContent ?? "").not.toContain("Access denied");
    expect(view.container.textContent ?? "").not.toContain("Token Usage not enabled");
  });
});
