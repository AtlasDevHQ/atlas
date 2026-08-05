import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";

/**
 * The third `FeatureGate` call site (#5068), which had no test of any kind.
 *
 * `AdminContentWrapper` and `MutationErrorSurface` are the other two, and both
 * are covered — so deleting `message` / `requestId` from *this* file was the
 * one revert of the fix that left the whole web suite green. That is the gap
 * this file closes: the exact regression #5068 fixes could be reintroduced on
 * the audit-analytics page silently.
 *
 * The panel fires five parallel requests and gates on the first failure among
 * them, so each arm answers every request with the same envelope.
 */

void mock.module("next/navigation", () => ({
  usePathname: () => "/admin/audit",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// Recharts is `dynamic(..., { ssr: false })` here and irrelevant to the gate —
// every arm below returns before a chart renders. Stubbing keeps the failure
// mode legible if one ever does.
void mock.module("../volume-chart", () => ({ default: () => null }));
void mock.module("../error-chart", () => ({ default: () => null }));

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const { AnalyticsPanel } = await import("../analytics-panel");

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

/** Answer every one of the panel's five requests with the same failure. */
function failAll(status: number, body: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function renderPanel() {
  return render(createElement(AnalyticsPanel, { from: "", to: "" }), { wrapper: Wrapper });
}

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

describe("AnalyticsPanel — the gate carries the server's words and the id (#5068)", () => {
  test("a 403 surfaces the server's role message, not the canned admin-role line", async () => {
    failAll(403, {
      error: "forbidden_role",
      message: "Platform admin role required.",
      requestId: REQUEST_ID,
    });
    const view = renderPanel();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Access denied"),
    );
    expect(view.container.textContent ?? "").toContain("Platform admin role required.");
    // The role the server did NOT ask for — the canned line this displaces.
    expect(view.container.textContent ?? "").not.toContain(
      "You need the admin role to access this page.",
    );
    const line = view.container.querySelector('[data-testid="feature-gate-request-id"]');
    if (!line) throw new Error("gate rendered no request-id line");
    expect(line.textContent).toContain(REQUEST_ID);
  });

  test("a 404 surfaces the server's message", async () => {
    failAll(404, {
      error: "not_available",
      message: "No internal database configured.",
      requestId: REQUEST_ID,
    });
    const view = renderPanel();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Query Analytics not enabled"),
    );
    expect(view.container.textContent ?? "").toContain("No internal database configured.");
    expect(view.container.textContent ?? "").not.toContain(
      "Enable this feature in your server configuration",
    );
  });

  test("an EMPTY gated body keeps the canned copy — the arm that pins serverMessage()", async () => {
    // Without this, forwarding `error.message` instead of `serverMessage(error)`
    // passes both arms above, and puts "HTTP 404" where the guidance belongs.
    failAll(404, {});
    const view = renderPanel();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Query Analytics not enabled"),
    );
    expect(view.container.textContent ?? "").toContain(
      "Enable this feature in your server configuration to use this page.",
    );
    expect(view.container.textContent ?? "").not.toContain("HTTP 404");
    expect(
      view.container.querySelector('[data-testid="feature-gate-request-id"]'),
    ).toBeNull();
  });

  test("a 404 without a body message still shows the id when one is present", async () => {
    failAll(404, { error: "not_available", requestId: REQUEST_ID });
    const view = renderPanel();

    await waitFor(() =>
      expect(view.container.textContent ?? "").toContain("Query Analytics not enabled"),
    );
    const line = view.container.querySelector('[data-testid="feature-gate-request-id"]');
    if (!line) throw new Error("gate rendered no request-id line");
    expect(line.textContent).toContain(REQUEST_ID);
  });

  test("a 503 is NOT promoted to a page-level gate — it stays per-chart", async () => {
    // 503 is deliberately excluded from this page's gate set. 401/403/404 are
    // shared verdicts (whatever denies one of the five requests denies all
    // five), but a 503 can fail one — a restarting replica, an unhealthy
    // proxy — and gating on the first would discard four charts that rendered
    // fine. An earlier pass added 503 here and this is the arm that says why
    // it came back out.
    failAll(503, {
      error: "permissions_unavailable",
      message: "Authorization service is temporarily unavailable.",
      requestId: REQUEST_ID,
    });
    const view = renderPanel();

    await waitFor(() =>
      expect(view.container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0),
    );
    // The gate's own headline is the discriminator — the banners render the
    // server sentence either way, so asserting on the copy proves nothing.
    expect(view.container.textContent ?? "").not.toContain("Query Analytics is unavailable");
    // The banners go through `friendlyError`, so they carry the correlation id
    // that raw `.message` was dropping.
    expect(view.container.textContent ?? "").toContain(REQUEST_ID);
  });

  test("a 500 is a fault, not a gate — the whitelist still means something", async () => {
    // The negative the gate arms need: without it, widening `findGateError` to
    // return ANY errored request passes every positive above. 500 is the
    // canonical "known status that must NOT gate".
    failAll(500, {
      error: "internal_error",
      message: "Failed to load analytics.",
      requestId: REQUEST_ID,
    });
    const view = renderPanel();

    await waitFor(() =>
      expect(view.container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0),
    );
    expect(view.container.textContent ?? "").not.toContain("Query Analytics not enabled");
    expect(view.container.textContent ?? "").not.toContain("Query Analytics is unavailable");
    expect(view.container.textContent ?? "").not.toContain("Access denied");
  });
});
