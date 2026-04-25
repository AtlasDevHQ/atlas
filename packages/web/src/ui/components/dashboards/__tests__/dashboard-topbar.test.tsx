import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { DashboardTopBar } from "../dashboard-topbar";
import type { Density } from "../grid-constants";

const unexpected = (label: string) => () => {
  throw new Error(`unexpected ${label} call`);
};

const baseProps = {
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

describe("DashboardTopBar", () => {
  afterEach(cleanup);

  test("renders title, breadcrumb, and tile chip", () => {
    render(<DashboardTopBar {...baseProps} />);
    expect(screen.getByText("Revenue overview")).toBeTruthy();
    expect(screen.getByText("All dashboards")).toBeTruthy();
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
    );
    const editBtn = screen.getByRole("button", { name: /Edit/ });
    expect(editBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(editBtn);
    expect(captured).toBe(true);
  });

  test("Suggest button disabled when no cards", () => {
    render(<DashboardTopBar {...baseProps} cardCount={0} />);
    const suggestBtn = screen.getByRole("button", { name: /Suggest/ });
    expect((suggestBtn as HTMLButtonElement).disabled).toBe(true);
  });

  test("Add from chat only renders in edit mode", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} editing={false} />);
    expect(screen.queryByText("Add from chat")).toBeNull();
    rerender(<DashboardTopBar {...baseProps} editing={true} />);
    expect(screen.getByText("Add from chat")).toBeTruthy();
  });

  test("singular vs plural tile chip", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} cardCount={1} />);
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
    );

    fireEvent.click(screen.getByText("Revenue overview"));
    const input = screen.getByDisplayValue("Revenue overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(saved).toBe("New title");
  });

  test("Escape cancels the title edit without firing onTitleChange", () => {
    render(<DashboardTopBar {...baseProps} />);
    fireEvent.click(screen.getByText("Revenue overview"));
    const input = screen.getByDisplayValue("Revenue overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Different" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByDisplayValue("Different")).toBeNull();
    expect(screen.getByText("Revenue overview")).toBeTruthy();
  });

  test("Delete button calls onDelete on click", () => {
    let called = false;
    render(<DashboardTopBar {...baseProps} onDelete={() => { called = true; }} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(called).toBe(true);
  });

  test("editing banner with Esc-to-exit hint only renders in edit mode", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} editing={false} />);
    expect(screen.queryByText(/drag tiles to rearrange/)).toBeNull();
    rerender(<DashboardTopBar {...baseProps} editing={true} />);
    expect(screen.getByText(/drag tiles to rearrange/)).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();
  });

  test("tile count chip is hidden when there are zero tiles", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} cardCount={0} />);
    expect(screen.queryByText(/0 tiles?/)).toBeNull();
    rerender(<DashboardTopBar {...baseProps} cardCount={2} />);
    expect(screen.getByText(/2 tiles/)).toBeTruthy();
  });

  test("description renders with title attribute fallback so truncated text is reachable on hover", () => {
    const long = "Pipeline, revenue, win-rate, retention, NRR, magic-number, churn, and CAC payback across all 4 regions";
    render(<DashboardTopBar {...baseProps} description={long} />);
    const desc = screen.getByText(long);
    expect(desc.getAttribute("title")).toBe(long);
  });
});
