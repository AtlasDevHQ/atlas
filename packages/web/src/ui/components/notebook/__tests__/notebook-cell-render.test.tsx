import { describe, expect, test, afterEach, mock } from "bun:test";
import React from "react";

// Sortable handle requires SortableContext + SortableItemContext from `@dnd-kit/sortable`.
// Stub it to a passthrough so we can render <NotebookCell> outside a Sortable parent.
mock.module("@/components/ui/sortable", () => ({
  SortableItemHandle: ({ children }: { children: React.ReactNode; asChild?: boolean }) =>
    React.createElement(React.Fragment, null, children),
}));

// The output region pulls in Markdown / TypingIndicator / ToolPart, which transitively load
// the AI SDK. Stub it to a marker so pill-gating tests don't need that surface.
mock.module("../notebook-cell-output", () => ({
  NotebookCellOutput: () => React.createElement("div", { "data-testid": "cell-output-stub" }),
}));

import { render, cleanup, fireEvent } from "@testing-library/react";
import { NotebookCell } from "../notebook-cell";
import type { ResolvedCell } from "../types";
import type { UIMessage } from "@ai-sdk/react";

function makeMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  };
}

function makeCell(overrides: Partial<ResolvedCell> = {}): ResolvedCell {
  return {
    id: "cell-1",
    messageId: "u1",
    number: 1,
    collapsed: false,
    editing: false,
    status: "idle",
    userMessage: makeMessage("u1", "user", "Test question"),
    assistantMessage: makeMessage("a1", "assistant", "Test answer"),
    ...overrides,
  };
}

function makeProps(cellOverrides: Partial<ResolvedCell> = {}, anyRunning = false) {
  return {
    cell: makeCell(cellOverrides),
    anyRunning,
    cellBranches: [],
    onRerun: mock(() => {}),
    onDelete: mock(() => {}),
    onToggleEdit: mock(() => {}),
    onToggleCollapse: mock(() => {}),
    onCopy: mock(async () => {}),
    onFork: mock(async () => {}),
    dashboardCards: {},
    onDashboardCardAdded: mock(() => {}),
  };
}

describe("NotebookCell — \"What if?\" pill gating", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the pill when assistantMessage exists and cell is neither collapsed nor editing", () => {
    const { queryByLabelText } = render(<NotebookCell {...makeProps()} />);
    expect(
      queryByLabelText("Branch from this cell to explore an alternative direction"),
    ).not.toBeNull();
  });

  test("hides the pill when assistantMessage is null (no output yet)", () => {
    const { queryByLabelText } = render(
      <NotebookCell {...makeProps({ assistantMessage: null })} />,
    );
    expect(
      queryByLabelText("Branch from this cell to explore an alternative direction"),
    ).toBeNull();
  });

  test("hides the pill when the cell is collapsed", () => {
    const { queryByLabelText } = render(
      <NotebookCell {...makeProps({ collapsed: true })} />,
    );
    expect(
      queryByLabelText("Branch from this cell to explore an alternative direction"),
    ).toBeNull();
  });

  test("hides the pill when the cell is being edited", () => {
    const { queryByLabelText } = render(
      <NotebookCell {...makeProps({ editing: true })} />,
    );
    expect(
      queryByLabelText("Branch from this cell to explore an alternative direction"),
    ).toBeNull();
  });

  test("clicking the pill calls onFork(cellId) once", () => {
    const props = makeProps();
    const { getByLabelText } = render(<NotebookCell {...props} />);
    fireEvent.click(getByLabelText("Branch from this cell to explore an alternative direction"));
    expect(props.onFork).toHaveBeenCalledTimes(1);
    expect(props.onFork).toHaveBeenCalledWith("cell-1");
  });

  test("pill is disabled when this cell is running", () => {
    const { getByLabelText } = render(<NotebookCell {...makeProps({ status: "running" })} />);
    const pill = getByLabelText(
      "Branch from this cell to explore an alternative direction",
    ) as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
  });

  test("pill is disabled when a sibling cell is running", () => {
    const { getByLabelText } = render(<NotebookCell {...makeProps({}, /* anyRunning */ true)} />);
    const pill = getByLabelText(
      "Branch from this cell to explore an alternative direction",
    ) as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
  });
});
