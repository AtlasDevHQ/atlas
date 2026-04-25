import { describe, expect, test, afterEach, mock } from "bun:test";
import type { ReactNode } from "react";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
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

import { render, cleanup, fireEvent, screen } from "@testing-library/react";
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
    expect(captured).toBe(true);
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

    expect(saved).toBe("New title");
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
