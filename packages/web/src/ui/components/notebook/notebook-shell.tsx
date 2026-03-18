"use client";

import { useRef, useEffect } from "react";
import type { UseNotebookReturn } from "./use-notebook";
import { useKeyboardNav } from "./use-keyboard-nav";
import { NotebookCell } from "./notebook-cell";
import { NotebookEmptyState } from "./notebook-empty-state";
import { NotebookInputBar } from "./notebook-input-bar";

interface NotebookShellProps {
  notebook: UseNotebookReturn;
  focusCellId?: string;
}

export function NotebookShell({ notebook, focusCellId }: NotebookShellProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const anyRunning = notebook.cells.some((c) => c.status === "running");
  const editingCellId = notebook.cells.find((c) => c.editing)?.id ?? null;

  const { setRef, focusCell } = useKeyboardNav({
    cellCount: notebook.cells.length,
    onEnterEdit: (index) => {
      const cell = notebook.cells[index];
      if (cell && !cell.editing) notebook.toggleEdit(cell.id);
    },
    onExitEdit: () => {
      if (editingCellId) notebook.toggleEdit(editingCellId);
    },
    onDelete: (index) => {
      const cell = notebook.cells[index];
      if (cell) notebook.deleteCell(cell.id);
    },
    editing: editingCellId !== null,
  });

  // Scroll to deep-linked cell on mount
  useEffect(() => {
    if (!focusCellId) return;
    const idx = notebook.cells.findIndex((c) => c.id === focusCellId);
    if (idx !== -1) focusCell(idx);
  }, [focusCellId]); // Only scroll on mount/deep-link change

  // Scroll to bottom when a new cell is appended
  const prevCellCount = useRef(notebook.cells.length);
  useEffect(() => {
    if (notebook.cells.length > prevCellCount.current) {
      const lastEl = scrollAreaRef.current?.querySelector("[role='region']:last-of-type");
      lastEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    prevCellCount.current = notebook.cells.length;
  }, [notebook.cells.length]);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-5xl space-y-4">
          {notebook.cells.length === 0 ? (
            <NotebookEmptyState />
          ) : (
            notebook.cells.map((cell, i) => (
              <NotebookCell
                key={cell.id}
                ref={setRef(i)}
                cell={cell}
                anyRunning={anyRunning}
                onRerun={notebook.rerunCell}
                onDelete={notebook.deleteCell}
                onToggleEdit={notebook.toggleEdit}
                onToggleCollapse={notebook.toggleCollapse}
                onCopy={notebook.copyCell}
              />
            ))
          )}
        </div>
      </div>

      <NotebookInputBar
        value={notebook.input}
        onChange={notebook.setInput}
        onSubmit={() => {
          if (notebook.input.trim()) {
            notebook.appendCell(notebook.input.trim());
          }
        }}
        disabled={anyRunning}
      />
    </div>
  );
}
