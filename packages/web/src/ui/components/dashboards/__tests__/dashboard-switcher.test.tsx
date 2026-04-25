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
import { DashboardSwitcher } from "../dashboard-switcher";
import { dashboardsWrapper, stubDashboardsFetch } from "./_fixtures";

const originalFetch = globalThis.fetch;

/**
 * Radix DropdownMenu opens on a real PointerEvent — JSDOM swallows
 * fireEvent.click here. Activate via keyboard (Enter on the focused trigger),
 * which is also the more accessibility-honest interaction to assert against.
 */
function openSwitcher() {
  const trigger = screen.getByRole("button", { name: "Switch dashboard" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("DashboardSwitcher", () => {
  beforeEach(() => {
    navigateCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("opens to a list of dashboards sorted most-recent-first with the current one marked", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);

    render(<DashboardSwitcher currentId="d-1" />, { wrapper: dashboardsWrapper });

    openSwitcher();

    await screen.findByRole("menuitem", { name: /Older/ });
    const items = screen.getAllByRole("menuitem");
    // First two items are the dashboards in order; remaining are footer actions.
    expect(items[0].textContent).toContain("Now");
    expect(items[1].textContent).toContain("Older");
    expect(items[0].getAttribute("aria-current")).toBe("page");
    expect(items[1].getAttribute("aria-current")).toBeNull();
  });

  test("clicking a non-current dashboard navigates to its detail page", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);

    render(<DashboardSwitcher currentId="d-1" />, { wrapper: dashboardsWrapper });
    openSwitcher();
    const older = await screen.findByRole("menuitem", { name: /Older/ });
    fireEvent.click(older);

    await waitFor(() => expect(navigateCalls).toContain("/dashboards/d-2"));
  });

  test("New dashboard footer item opens the create dialog", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
    ]);

    render(<DashboardSwitcher currentId="d-1" />, { wrapper: dashboardsWrapper });
    openSwitcher();
    const newItem = await screen.findByRole("menuitem", { name: /New dashboard/ });
    fireEvent.click(newItem);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /New dashboard/i })).toBeTruthy();
    });
  });

  test("renders an error + retry when the list fetch fails", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    render(<DashboardSwitcher currentId="d-1" />, { wrapper: dashboardsWrapper });
    openSwitcher();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/HTTP 500|server|error/i);
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(screen.queryByText(/No other dashboards yet/)).toBeNull();
  });

  test("View all footer item opens the view-all modal", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
    ]);

    render(<DashboardSwitcher currentId="d-1" />, { wrapper: dashboardsWrapper });
    openSwitcher();
    const viewAll = await screen.findByRole("menuitem", { name: /View all/ });
    fireEvent.click(viewAll);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /All dashboards/i })).toBeTruthy();
    });
  });
});
