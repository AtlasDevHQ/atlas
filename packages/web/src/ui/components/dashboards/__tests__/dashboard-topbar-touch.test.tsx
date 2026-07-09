/**
 * DashboardTopBar — viewing-first on touch (#4323).
 *
 * On a coarse (touch) pointer the layout-Edit affordance is HIDDEN with a
 * one-line "editing is desktop-only" explanation, rather than shown-and-inert
 * (the grid is a read-only stack on touch anyway). A fine pointer keeps the
 * View/Edit toggle. `useCoarsePointer` is mocked through a mutable flag so both
 * pointer classes are exercised.
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import type { ReactNode } from "react";

let coarse = false;
void mock.module("@/ui/hooks/use-coarse-pointer", () => ({
  useCoarsePointer: () => coarse,
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
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

import { render, cleanup, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { DashboardTopBar } from "../dashboard-topbar";
import type { Density } from "../grid-constants";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

const noop = () => {};

const baseProps = {
  dashboardId: "d-1",
  title: "Revenue overview",
  cardCount: 3,
  description: null,
  onTitleChange: noop as (next: string) => void,
  refreshing: false,
  refreshSchedule: null,
  onScheduleChange: noop as (v: string) => void,
  onRefreshAll: noop,
  onSuggest: noop,
  suggesting: false,
  onExport: noop as (format: "png" | "pdf") => void,
  exporting: false,
  onDelete: noop,
  shareSlot: <button type="button">Share</button>,
  editing: false,
  onEditingChange: noop as (next: boolean) => void,
  density: "comfortable" as Density,
  onDensityChange: noop as (next: Density) => void,
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

describe("DashboardTopBar — touch (#4323)", () => {
  afterEach(() => {
    cleanup();
    coarse = false;
  });

  test("a fine pointer shows the View/Edit mode toggle", () => {
    coarse = false;
    render(<DashboardTopBar {...baseProps} />, { wrapper });
    expect(screen.getByRole("group", { name: "Mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(screen.queryByTestId("edit-desktop-only-hint")).toBeNull();
  });

  test("a coarse (touch) pointer hides the toggle and explains editing is desktop-only", () => {
    coarse = true;
    render(<DashboardTopBar {...baseProps} />, { wrapper });
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    const hint = screen.getByTestId("edit-desktop-only-hint");
    expect(hint.textContent).toContain("Editing is desktop-only");
  });
});
