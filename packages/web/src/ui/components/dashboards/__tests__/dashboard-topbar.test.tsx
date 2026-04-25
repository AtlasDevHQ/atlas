import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { DashboardTopBar } from "../dashboard-topbar";

const baseProps = {
  title: "Revenue overview",
  cardCount: 3,
  description: null,
  editingTitle: false,
  titleDraft: "",
  onTitleClick: () => {},
  onTitleDraftChange: () => {},
  onTitleSave: () => {},
  onTitleCancel: () => {},
  refreshing: false,
  refreshSchedule: null,
  onScheduleChange: () => {},
  onRefreshAll: () => {},
  onSuggest: () => {},
  suggesting: false,
  onDelete: () => {},
  shareSlot: <button type="button">Share</button>,
  editing: false,
  onEditingChange: (_next: boolean) => {},
  density: "comfortable" as const,
  onDensityChange: (_next: "compact" | "comfortable" | "spacious") => {},
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

  test("Delete button is rendered", () => {
    render(<DashboardTopBar {...baseProps} />);
    expect(screen.getByRole("button", { name: /Delete/ })).toBeTruthy();
  });

  test("Suggest button disabled when no cards", () => {
    render(<DashboardTopBar {...baseProps} cardCount={0} />);
    const suggestBtn = screen.getByRole("button", { name: /Suggest/ });
    expect((suggestBtn as HTMLButtonElement).disabled).toBe(true);
  });

  test("Add tile only renders in edit mode", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} editing={false} />);
    expect(screen.queryByText("Add tile")).toBeNull();
    rerender(<DashboardTopBar {...baseProps} editing={true} />);
    expect(screen.getByText("Add tile")).toBeTruthy();
  });

  test("singular vs plural tile chip", () => {
    const { rerender } = render(<DashboardTopBar {...baseProps} cardCount={1} />);
    expect(screen.getByText("1 tile")).toBeTruthy();
    rerender(<DashboardTopBar {...baseProps} cardCount={5} />);
    expect(screen.getByText("5 tiles")).toBeTruthy();
  });
});
