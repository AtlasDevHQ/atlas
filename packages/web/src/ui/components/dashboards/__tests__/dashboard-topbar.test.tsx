/**
 * DashboardTopBar.
 *
 * Merged 2026-09-04; formerly also dashboard-topbar-touch.test.tsx (#4323).
 *
 * Viewing-first on touch (#4323): on a coarse (touch) pointer the layout-Edit
 * affordance is HIDDEN with a one-line "editing is desktop-only" explanation,
 * rather than shown-and-inert (the grid is a read-only stack on touch anyway).
 * A fine pointer keeps the View/Edit toggle. `useCoarsePointer` is mocked
 * through a mutable flag so both pointer classes are exercised; it defaults to
 * `false`, which is what the real hook returns in jsdom (no `matchMedia`), so
 * the non-touch tests below are unaffected.
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

import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { DashboardTopBar } from "../dashboard-topbar";
import type { Density } from "../grid-constants";

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

const unexpected = (label: string) => () => {
  throw new Error(`unexpected ${label} call`);
};

const baseProps = {
  dashboardId: "d-1",
  title: "Revenue overview",
  cardCount: 3,
  description: null,
  onTitleChange: unexpected("onTitleChange") as (next: string) => void,
  refreshing: false,
  refreshSchedule: null,
  onScheduleChange: unexpected("onScheduleChange") as (v: string) => void,
  onRefreshAll: unexpected("onRefreshAll"),
  onSuggest: unexpected("onSuggest"),
  suggesting: false,
  onExport: unexpected("onExport") as (format: "png" | "pdf") => void,
  exporting: false,
  onDelete: unexpected("onDelete"),
  shareSlot: <button type="button">Share</button>,
  editing: false,
  onEditingChange: unexpected("onEditingChange") as (next: boolean) => void,
  density: "comfortable" as Density,
  onDensityChange: unexpected("onDensityChange") as (next: Density) => void,
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

describe("DashboardTopBar", () => {
  afterEach(cleanup);

  test("renders title, switcher trigger, and tile chip", () => {
    render(<DashboardTopBar {...baseProps} />, { wrapper });
    expect(screen.getByText("Revenue overview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch dashboard" })).toBeTruthy();
    expect(screen.getByText(/3 tiles/)).toBeTruthy();
  });

  test("View/Edit toggle reflects current mode and fires onEditingChange", () => {
    let captured: boolean | null = null;
    render(
      <DashboardTopBar
        {...baseProps}
        editing={false}
        onEditingChange={(v) => { captured = v; }}
      />,
      { wrapper },
    );
    const editBtn = screen.getByRole("button", { name: /Edit/ });
    expect(editBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(editBtn);
    expect<boolean | null>(captured).toBe(true);
  });

  test("Suggest button disabled when no cards", () => {
    render(<DashboardTopBar {...baseProps} cardCount={0} />, { wrapper });
    const suggestBtn = screen.getByRole("button", { name: /Suggest/ });
    expect((suggestBtn as HTMLButtonElement).disabled).toBe(true);
  });

  test("Add from chat only renders in edit mode", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} editing={false} />, { wrapper });
    expect(screen.queryByText("Add from chat")).toBeNull();
    rerender(<DashboardTopBar {...baseProps} editing={true} />);
    expect(screen.getByText("Add from chat")).toBeTruthy();
  });

  test("singular vs plural tile chip", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} cardCount={1} />, { wrapper });
    expect(screen.getByText("1 tile")).toBeTruthy();
    rerender(<DashboardTopBar {...baseProps} cardCount={5} />);
    expect(screen.getByText("5 tiles")).toBeTruthy();
  });

  test("title is internally editable — committing fires onTitleChange with the trimmed draft", () => {
    let saved: string | null = null;
    render(
      <DashboardTopBar
        {...baseProps}
        onTitleChange={(next) => { saved = next; }}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByText("Revenue overview"));
    const input = screen.getByDisplayValue("Revenue overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect<string | null>(saved).toBe("New title");
  });

  test("Escape cancels the title edit without firing onTitleChange", () => {
    render(<DashboardTopBar {...baseProps} />, { wrapper });
    fireEvent.click(screen.getByText("Revenue overview"));
    const input = screen.getByDisplayValue("Revenue overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Different" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByDisplayValue("Different")).toBeNull();
    expect(screen.getByText("Revenue overview")).toBeTruthy();
  });

  test("Export trigger renders and is disabled when there are no tiles", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} cardCount={0} />, { wrapper });
    const exportBtn = screen.getByRole("button", { name: "Export dashboard" });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true);
    rerender(<DashboardTopBar {...baseProps} cardCount={3} />);
    expect((screen.getByRole("button", { name: "Export dashboard" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("Export trigger is disabled while an export is in flight", () => {
    render(<DashboardTopBar {...baseProps} exporting={true} />, { wrapper });
    const exportBtn = screen.getByRole("button", { name: "Export dashboard" });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Exporting/)).toBeTruthy();
  });

  test("Delete button calls onDelete on click", () => {
    let called = false;
    render(<DashboardTopBar {...baseProps} onDelete={() => { called = true; }} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(called).toBe(true);
  });

  test("editing banner with Esc-to-exit hint only renders in edit mode", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} editing={false} />, { wrapper });
    expect(screen.queryByText(/drag tiles to rearrange/)).toBeNull();
    rerender(<DashboardTopBar {...baseProps} editing={true} />);
    expect(screen.getByText(/drag tiles to rearrange/)).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();
  });

  test("tile count chip is hidden when there are zero tiles", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} cardCount={0} />, { wrapper });
    expect(screen.queryByText(/0 tiles?/)).toBeNull();
    rerender(<DashboardTopBar {...baseProps} cardCount={2} />);
    expect(screen.getByText(/2 tiles/)).toBeTruthy();
  });

  test("description renders with title attribute fallback so truncated text is reachable on hover", () => {
    const long = "Pipeline, revenue, win-rate, retention, NRR, magic-number, churn, and CAC payback across all 4 regions";
    render(<DashboardTopBar {...baseProps} description={long} />, { wrapper });
    const desc = screen.getByText(long);
    expect(desc.getAttribute("title")).toBe(long);
  });

  test("title editing hides the switcher trigger so the input has room", () => {
    render(<DashboardTopBar {...baseProps} />, { wrapper });
    expect(screen.getByRole("button", { name: "Switch dashboard" })).toBeTruthy();
    fireEvent.click(screen.getByText("Revenue overview"));
    expect(screen.queryByRole("button", { name: "Switch dashboard" })).toBeNull();
  });
});

const touchNoop = () => {};

const touchBaseProps = {
  dashboardId: "d-1",
  title: "Revenue overview",
  cardCount: 3,
  description: null,
  onTitleChange: touchNoop as (next: string) => void,
  refreshing: false,
  refreshSchedule: null,
  onScheduleChange: touchNoop as (v: string) => void,
  onRefreshAll: touchNoop,
  onSuggest: touchNoop,
  suggesting: false,
  onExport: touchNoop as (format: "png" | "pdf") => void,
  exporting: false,
  onDelete: touchNoop,
  shareSlot: <button type="button">Share</button>,
  editing: false,
  onEditingChange: touchNoop as (next: boolean) => void,
  density: "comfortable" as Density,
  onDensityChange: touchNoop as (next: Density) => void,
};

function touchWrapper({ children }: { children: ReactNode }) {
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
    render(<DashboardTopBar {...touchBaseProps} />, { wrapper: touchWrapper });
    expect(screen.getByRole("group", { name: "Mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(screen.queryByTestId("edit-desktop-only-hint")).toBeNull();
  });

  test("a coarse (touch) pointer hides the toggle and explains editing is desktop-only", () => {
    coarse = true;
    render(<DashboardTopBar {...touchBaseProps} />, { wrapper: touchWrapper });
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    const hint = screen.getByTestId("edit-desktop-only-hint");
    expect(hint.textContent).toContain("Editing is desktop-only");
  });
});

describe("DashboardTopBar — stacked (narrow) grid (#4689)", () => {
  afterEach(() => {
    cleanup();
    coarse = false;
  });

  test("a fine-pointer narrow window (grid stacked) hides the toggle and reads 'widen the window', NOT 'desktop-only'", () => {
    coarse = false;
    render(<DashboardTopBar {...touchBaseProps} stacked={true} />, { wrapper: touchWrapper });
    // The drag/resize toggle is gone — the stacked grid can't honor a drag.
    expect(screen.queryByRole("group", { name: "Mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    // Reason tracks the signal: a resized DESKTOP browser is not "desktop-only".
    expect(screen.queryByTestId("edit-desktop-only-hint")).toBeNull();
    const hint = screen.getByTestId("edit-too-narrow-hint");
    expect(hint.textContent).toContain("Widen the window to edit");
  });

  test("stacked suppresses the 'drag tiles' help even when editing is still true (held from a prior wide session)", () => {
    coarse = false;
    render(<DashboardTopBar {...touchBaseProps} stacked={true} editing={true} />, { wrapper: touchWrapper });
    expect(screen.queryByText(/drag tiles to rearrange/)).toBeNull();
    expect(screen.queryByText("Add from chat")).toBeNull();
  });

  test("a coarse pointer wins the hint copy even when also stacked", () => {
    coarse = true;
    render(<DashboardTopBar {...touchBaseProps} stacked={true} />, { wrapper: touchWrapper });
    const hint = screen.getByTestId("edit-desktop-only-hint");
    expect(hint.textContent).toContain("Editing is desktop-only");
    expect(screen.queryByTestId("edit-too-narrow-hint")).toBeNull();
  });

  test("a fine pointer with a wide (non-stacked) grid keeps the View/Edit toggle", () => {
    coarse = false;
    render(<DashboardTopBar {...touchBaseProps} stacked={false} />, { wrapper: touchWrapper });
    expect(screen.getByRole("group", { name: "Mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(screen.queryByTestId("edit-too-narrow-hint")).toBeNull();
  });
});
