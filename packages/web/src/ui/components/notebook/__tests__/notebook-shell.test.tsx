import { describe, expect, test, afterEach, mock } from "bun:test";
import React from "react";
import type { UIMessage } from "@ai-sdk/react";
import type { ResolvedCell } from "../types";
import type { ForkBranchWire } from "@/ui/lib/types";
import type { UseNotebookReturn } from "../use-notebook";

// Stub heavy children — we're testing the shell's conditional rendering matrix,
// not the inner components.
mock.module("../notebook-cell", () => ({
  NotebookCell: () => React.createElement("div", { "data-testid": "notebook-cell-stub" }),
}));
mock.module("../notebook-text-cell", () => ({
  NotebookTextCell: () => React.createElement("div", { "data-testid": "notebook-text-cell-stub" }),
}));
mock.module("../notebook-empty-state", () => ({
  NotebookEmptyState: () =>
    React.createElement("div", { "data-testid": "notebook-empty-state-stub" }, "Empty"),
}));
mock.module("../notebook-input-bar", () => ({
  NotebookInputBar: () => React.createElement("div", { "data-testid": "notebook-input-bar-stub" }),
}));
mock.module("../fork-branch-selector", () => ({
  ForkBranchSelector: () =>
    React.createElement("div", { "data-testid": "fork-branch-selector-stub" }, "Branches"),
}));
// Sortable wraps the cell list; stub it so we don't need DnD context.
mock.module("@/components/ui/sortable", () => ({
  Sortable: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SortableContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SortableItem: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SortableOverlay: () => React.createElement("div"),
}));

import { render, cleanup } from "@testing-library/react";
import { NotebookShell } from "../notebook-shell";

function makeMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function makeCell(id: string, n: number): ResolvedCell {
  return {
    id,
    messageId: `u${n}`,
    number: n,
    collapsed: false,
    editing: false,
    status: "idle",
    userMessage: makeMessage(`u${n}`, "user", `q${n}`),
    assistantMessage: makeMessage(`a${n}`, "assistant", `a${n}`),
  };
}

function makeBranch(id: string, label: string): ForkBranchWire {
  return {
    conversationId: id,
    forkPointCellId: "msg-1",
    label,
    createdAt: new Date().toISOString(),
  };
}

function makeNotebook(overrides: Partial<UseNotebookReturn> = {}): UseNotebookReturn {
  return {
    cells: [],
    status: "ready",
    error: null,
    warning: null,
    clearWarning: () => {},
    appendCell: () => {},
    rerunCell: () => {},
    deleteCell: () => {},
    toggleEdit: () => {},
    toggleCollapse: () => {},
    copyCell: async () => {},
    reorderCells: () => {},
    forkCell: async () => {},
    switchBranch: () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    forkInfo: null,
    input: "",
    setInput: () => {},
    insertTextCell: () => {},
    updateTextCell: () => {},
    dashboardCards: {},
    addDashboardCard: () => {},
    ...overrides,
  };
}

const STARTER_PROMPTS = {
  apiUrl: "",
  isCrossOrigin: false,
  getHeaders: () => ({}),
  enabled: false,
};

describe("NotebookShell — toolbar + branch-selector matrix", () => {
  afterEach(() => {
    cleanup();
  });

  test("cells=0, branches=0 → empty state, no toolbar band, no branch selector, no Text Cell", () => {
    const { queryByTestId, queryByText } = render(
      <NotebookShell notebook={makeNotebook()} starterPrompts={STARTER_PROMPTS} />,
    );
    expect(queryByTestId("notebook-empty-state-stub")).not.toBeNull();
    expect(queryByTestId("fork-branch-selector-stub")).toBeNull();
    expect(queryByText("Text Cell")).toBeNull();
    expect(queryByText("Export")).toBeNull();
  });

  test("cells=0, branches>0 → branch selector renders, Text Cell + Share/Export do NOT", () => {
    const { queryByTestId, queryByText } = render(
      <NotebookShell
        notebook={makeNotebook({
          forkInfo: { rootId: "root", currentId: "branch-1", branches: [makeBranch("branch-1", "What if?")] },
        })}
        starterPrompts={STARTER_PROMPTS}
      />,
    );
    expect(queryByTestId("fork-branch-selector-stub")).not.toBeNull();
    // Empty state still renders since cells.length === 0.
    expect(queryByTestId("notebook-empty-state-stub")).not.toBeNull();
    // Cell-dependent actions stay hidden — nothing to add a text cell to / export / share.
    expect(queryByText("Text Cell")).toBeNull();
    expect(queryByText("Export")).toBeNull();
  });

  test("cells>0, branches=0 → Text Cell + Export render, no branch selector", () => {
    const { queryByTestId, queryByText } = render(
      <NotebookShell
        notebook={makeNotebook({ cells: [makeCell("c1", 1)] })}
        starterPrompts={STARTER_PROMPTS}
      />,
    );
    expect(queryByTestId("fork-branch-selector-stub")).toBeNull();
    expect(queryByText("Text Cell")).not.toBeNull();
    expect(queryByText("Export")).not.toBeNull();
    expect(queryByTestId("notebook-empty-state-stub")).toBeNull();
  });

  test("cells>0, branches>0 → branch selector + Text Cell + Export all render", () => {
    const { queryByTestId, queryByText } = render(
      <NotebookShell
        notebook={makeNotebook({
          cells: [makeCell("c1", 1)],
          forkInfo: { rootId: "root", currentId: "branch-1", branches: [makeBranch("branch-1", "What if?")] },
        })}
        starterPrompts={STARTER_PROMPTS}
      />,
    );
    expect(queryByTestId("fork-branch-selector-stub")).not.toBeNull();
    expect(queryByText("Text Cell")).not.toBeNull();
    expect(queryByText("Export")).not.toBeNull();
  });

  test("Share as Report renders only when onShareAsReport is provided", () => {
    const { queryByText } = render(
      <NotebookShell
        notebook={makeNotebook({ cells: [makeCell("c1", 1)] })}
        starterPrompts={STARTER_PROMPTS}
      />,
    );
    expect(queryByText("Share as Report")).toBeNull();
    cleanup();

    const { queryByText: queryByText2 } = render(
      <NotebookShell
        notebook={makeNotebook({ cells: [makeCell("c1", 1)] })}
        starterPrompts={STARTER_PROMPTS}
        onShareAsReport={async () => "tok-1"}
      />,
    );
    expect(queryByText2("Share as Report")).not.toBeNull();
  });
});
