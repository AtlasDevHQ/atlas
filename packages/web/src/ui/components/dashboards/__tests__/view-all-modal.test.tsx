import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import type { ReactNode } from "react";

const navigateCalls: string[] = [];

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (url: string) => navigateCalls.push(url),
    replace: () => {},
    back: () => {},
  }),
  usePathname: () => "/dashboards/d-1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "d-1" }),
  redirect: () => {},
  notFound: () => {},
}));

mock.module("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { ViewAllDashboardsModal } from "../view-all-modal";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <AtlasProvider
        config={{
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        }}
      >
        {children}
      </AtlasProvider>
    </QueryClientProvider>
  );
}

const originalFetch = globalThis.fetch;

function stubDashboards(rows: { id: string; title: string; updatedAt: string; cardCount: number }[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.endsWith("/api/v1/dashboards")) {
      return new Response(
        JSON.stringify({
          dashboards: rows.map((r) => ({
            id: r.id,
            title: r.title,
            description: null,
            shareToken: null,
            shareExpiresAt: null,
            shareMode: "private",
            refreshSchedule: null,
            lastRefreshAt: null,
            nextRefreshAt: null,
            cardCount: r.cardCount,
            createdAt: r.updatedAt,
            updatedAt: r.updatedAt,
            orgId: null,
            ownerId: "u",
          })),
          total: rows.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("ViewAllDashboardsModal", () => {
  beforeEach(() => {
    navigateCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("renders nothing when closed", () => {
    stubDashboards([]);
    render(
      <ViewAllDashboardsModal open={false} onOpenChange={() => {}} currentId="d-1" />,
      { wrapper },
    );
    expect(screen.queryByRole("dialog", { name: /All dashboards/i })).toBeNull();
  });

  test("renders the grid sorted most-recent-first with the current one marked", async () => {
    stubDashboards([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);
    render(
      <ViewAllDashboardsModal open onOpenChange={() => {}} currentId="d-1" />,
      { wrapper },
    );

    await screen.findByRole("button", { name: "Open Older" });
    const openNow = screen.getByRole("button", { name: "Open Now" });
    expect(openNow.getAttribute("aria-current")).toBe("page");
    // Current pill renders only on the active card.
    expect(screen.getByText("Current")).toBeTruthy();
  });

  test("clicking a non-current card navigates and closes", async () => {
    stubDashboards([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);
    let openState = true;
    render(
      <ViewAllDashboardsModal open onOpenChange={(next) => { openState = next; }} currentId="d-1" />,
      { wrapper },
    );

    const older = await screen.findByRole("button", { name: "Open Older" });
    fireEvent.click(older);
    await waitFor(() => expect(navigateCalls).toContain("/dashboards/d-2"));
    expect(openState).toBe(false);
  });

  test("search input only renders above the threshold", async () => {
    stubDashboards([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);
    render(
      <ViewAllDashboardsModal open onOpenChange={() => {}} currentId="d-1" />,
      { wrapper },
    );
    await screen.findByRole("button", { name: "Open Older" });
    expect(screen.queryByLabelText(/Filter dashboards/)).toBeNull();
  });
});
