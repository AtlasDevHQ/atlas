import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";

const replaceCalls: string[] = [];

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: (url: string) => replaceCalls.push(url),
    back: () => {},
  }),
  usePathname: () => "/dashboards",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import DashboardsPage from "../page";
import { dashboardsWrapper, stubDashboardsFetch } from "../../../../ui/components/dashboards/__tests__/_fixtures";

const originalFetch = globalThis.fetch;

/** Stub the dashboards list endpoint with an arbitrary status / body. */
function stubDashboardsStatus(status: number, body: unknown = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.endsWith("/api/v1/dashboards")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("DashboardsPage (redirect index)", () => {
  beforeEach(() => {
    replaceCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("redirects to the most-recently-updated dashboard", async () => {
    stubDashboardsFetch([
      { id: "d-old", title: "Old", updatedAt: "2026-04-24T10:00:00Z", cardCount: 1 },
      { id: "d-new", title: "New", updatedAt: "2026-04-25T10:00:00Z", cardCount: 2 },
    ]);

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/dashboards/d-new"),
    );
    // AC#1: a logged-in user with dashboards is NEVER bounced to /login.
    expect(replaceCalls).not.toContain("/login?redirect=/dashboards");
  });

  test("renders the empty state when there are no dashboards", async () => {
    stubDashboardsFetch([]);

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await screen.findByText("No dashboards yet");
    // The genuine empty state is NOT a redirect — no navigation should fire.
    expect(replaceCalls).toHaveLength(0);
  });

  test("bounces an unauthenticated visitor (401) to /login", async () => {
    stubDashboardsStatus(401, { error: "auth_required", message: "Not authenticated" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/login?redirect=/dashboards"),
    );
  });

  test("bounces a forbidden visitor (403) to /login", async () => {
    stubDashboardsStatus(403, { error: "forbidden", message: "Access denied" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await waitFor(() =>
      expect(replaceCalls).toContain("/login?redirect=/dashboards"),
    );
  });

  test("shows an error card (not a /login bounce) on a server error", async () => {
    stubDashboardsStatus(500, { message: "Internal error" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });

    await screen.findByText("Couldn’t load your dashboards");
    // The server-authored body message reaches the card via friendlyError() —
    // the page renders the real error, not a canned "HTTP 500" fallback.
    await screen.findByText("Internal error");
    expect(replaceCalls).toHaveLength(0);
  });

  test("the error card's Try again button refetches and then redirects", async () => {
    stubDashboardsStatus(500, { message: "Internal error" });

    render(<DashboardsPage />, { wrapper: dashboardsWrapper });
    await screen.findByText("Couldn’t load your dashboards");

    // Recover the endpoint, then click retry — refetch() must re-run the query
    // and the now-successful list redirects to the most-recent dashboard.
    stubDashboardsFetch([
      { id: "d-1", title: "Recovered", updatedAt: "2026-04-25T10:00:00Z", cardCount: 1 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(replaceCalls).toContain("/dashboards/d-1"));
  });
});
