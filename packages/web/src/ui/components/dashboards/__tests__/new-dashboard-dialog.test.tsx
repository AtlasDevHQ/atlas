import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test";

const pushCalls: string[] = [];

void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (url: string) => pushCalls.push(url),
    replace: () => {},
    back: () => {},
  }),
  usePathname: () => "/dashboards",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  NewDashboardDialog,
  defaultOnDashboardCreated,
} from "../new-dashboard-dialog";
import {
  dashboardsWrapper,
  buildDashboardWireRow,
  stubDashboardsFetchWithCreate,
} from "./_fixtures";
import type { Dashboard } from "@/ui/lib/types";

const originalFetch = globalThis.fetch;

describe("NewDashboardDialog", () => {
  beforeEach(() => {
    pushCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  // #4563 — surface-native creation: every surface origin (switcher, list
  // empty state, view-all modal) lands on the new board's canvas with the
  // bound editor OPEN, via the same `?openChat=true` entry the main-chat
  // `createDashboard` handoff uses.
  test("defaultOnDashboardCreated navigates to the canvas with the bound editor open", () => {
    const push: string[] = [];
    const navigate = defaultOnDashboardCreated({ push: (u: string) => push.push(u) });

    navigate(
      buildDashboardWireRow({
        id: "d-9",
        title: "Revenue",
        updatedAt: "2026-07-16T10:00:00Z",
        cardCount: 0,
      }),
    );

    expect(push).toEqual(["/dashboards/d-9?openChat=true"]);
  });

  test("creating via the dialog POSTs the title and hands the created dashboard to onCreated", async () => {
    const bodies = stubDashboardsFetchWithCreate([], {
      id: "d-9",
      title: "Revenue",
      updatedAt: "2026-07-16T10:00:00Z",
      cardCount: 0,
    });
    const created: Dashboard[] = [];

    render(
      <NewDashboardDialog
        open
        onOpenChange={() => {}}
        onCreated={(d) => created.push(d)}
      />,
      { wrapper: dashboardsWrapper },
    );

    fireEvent.change(screen.getByPlaceholderText("Dashboard title"), {
      target: { value: "Revenue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(created).toHaveLength(1));
    // The manual title-only path is exactly this payload — nothing else rides
    // along; the editor-open intent lives in the navigation, not the create.
    expect(bodies).toEqual([{ title: "Revenue" }]);
    expect(created[0].id).toBe("d-9");
  });

  test("a failed create surfaces the error, keeps the dialog open, and never navigates", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const created: Dashboard[] = [];
    const openChanges: boolean[] = [];

    render(
      <NewDashboardDialog
        open
        onOpenChange={(next) => openChanges.push(next)}
        onCreated={(d) => created.push(d)}
      />,
      { wrapper: dashboardsWrapper },
    );

    fireEvent.change(screen.getByPlaceholderText("Dashboard title"), {
      target: { value: "Revenue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // The server-authored message surfaces inline; the dialog stays open and
    // onCreated never fires — a failed create must not navigate to (or set a
    // creation handoff for) a board that doesn't exist.
    await screen.findByText(/Internal error/);
    expect(created).toHaveLength(0);
    expect(openChanges).not.toContain(false);
  });

  test("Create stays disabled until a non-blank title is entered", () => {
    render(
      <NewDashboardDialog open onOpenChange={() => {}} onCreated={() => {}} />,
      { wrapper: dashboardsWrapper },
    );

    const create = screen.getByRole("button", { name: "Create" });
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Dashboard title"), {
      target: { value: "   " },
    });
    expect(create.hasAttribute("disabled")).toBe(true);
  });
});
