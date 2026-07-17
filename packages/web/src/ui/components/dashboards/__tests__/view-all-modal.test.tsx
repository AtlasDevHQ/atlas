import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";
import type { ReactNode } from "react";

const navigateCalls: string[] = [];

void mock.module("next/navigation", () => ({
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

void mock.module("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ViewAllDashboardsModal } from "../view-all-modal";
import {
  dashboardsWrapper,
  stubDashboardsFetch,
  stubDashboardsFetchWithCreate,
} from "./_fixtures";

const originalFetch = globalThis.fetch;

describe("ViewAllDashboardsModal", () => {
  beforeEach(() => {
    navigateCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("renders nothing when closed", () => {
    stubDashboardsFetch([]);
    render(
      <ViewAllDashboardsModal open={false} onOpenChange={() => {}} currentId="d-1" />,
      { wrapper: dashboardsWrapper },
    );
    expect(screen.queryByRole("dialog", { name: /All dashboards/i })).toBeNull();
  });

  test("renders the grid sorted most-recent-first with the current one marked", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);
    render(
      <ViewAllDashboardsModal open onOpenChange={() => {}} currentId="d-1" />,
      { wrapper: dashboardsWrapper },
    );

    await screen.findByRole("button", { name: "Open Older" });
    const openNow = screen.getByRole("button", { name: "Open Now" });
    expect(openNow.getAttribute("aria-current")).toBe("page");
    // Current pill renders only on the active card.
    expect(screen.getByText("Current")).toBeTruthy();
  });

  test("clicking a non-current card navigates and closes", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);
    let openState = true;
    render(
      <ViewAllDashboardsModal open onOpenChange={(next) => { openState = next; }} currentId="d-1" />,
      { wrapper: dashboardsWrapper },
    );

    const older = await screen.findByRole("button", { name: "Open Older" });
    fireEvent.click(older);
    await waitFor(() => expect(navigateCalls).toContain("/dashboards/d-2"));
    expect(openState).toBe(false);
  });

  // #4563 — surface-native creation from the view-all modal follows the same
  // policy as the switcher / empty state: land on the new canvas with the
  // bound editor open.
  test("creating from the modal navigates to the new canvas with the bound editor open", async () => {
    stubDashboardsFetchWithCreate(
      [{ id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 }],
      { id: "d-new", title: "Fresh", updatedAt: "2026-04-25T11:00:00Z", cardCount: 0 },
    );
    render(
      <ViewAllDashboardsModal open onOpenChange={() => {}} currentId="d-1" />,
      { wrapper: dashboardsWrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    const input = await screen.findByPlaceholderText("Dashboard title");
    fireEvent.change(input, { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(navigateCalls).toContain("/dashboards/d-new?openChat=true"),
    );
  });

  test("search input only renders above the threshold", async () => {
    stubDashboardsFetch([
      { id: "d-1", title: "Now", updatedAt: "2026-04-25T10:00:00Z", cardCount: 0 },
      { id: "d-2", title: "Older", updatedAt: "2026-04-24T10:00:00Z", cardCount: 4 },
    ]);
    render(
      <ViewAllDashboardsModal open onOpenChange={() => {}} currentId="d-1" />,
      { wrapper: dashboardsWrapper },
    );
    await screen.findByRole("button", { name: "Open Older" });
    expect(screen.queryByLabelText(/Filter dashboards/)).toBeNull();
  });
});
