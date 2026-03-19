"use client";

import { useRef, useEffect, useState } from "react";
import type { UseNotebookReturn } from "./use-notebook";
import { useKeyboardNav } from "./use-keyboard-nav";
import { NotebookCell } from "./notebook-cell";
import { NotebookEmptyState } from "./notebook-empty-state";
import { NotebookInputBar } from "./notebook-input-bar";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface NotebookShellProps {
  notebook: UseNotebookReturn;
  focusCellId?: string;
}

export function NotebookShell({ notebook, focusCellId }: NotebookShellProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const anyRunning = notebook.cells.some((c) => c.status === "running");
  const editingCellId = notebook.cells.find((c) => c.editing)?.id ?? null;
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);

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
      setPendingDeleteIndex(index);
    },
    editing: editingCellId !== null,
  });

  // Focus the deep-linked cell on mount (browser will scroll it into view)
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
          {notebook.error && (
            <div className="mx-auto max-w-5xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <p className="font-medium">Request failed</p>
              <p>{notebook.error.message}</p>
              <p className="mt-1 text-xs text-red-500 dark:text-red-400">Try re-running the last cell or refreshing the page.</p>
            </div>
          )}
          {notebook.cells.length === 0 ? (
            <NotebookEmptyState />
          ) : (
            notebook.cells.map((cell, i) => (
              <ErrorBoundary
                key={cell.id}
                fallbackRender={(error, reset) => (
                  <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
                    <p className="font-medium">Cell {cell.number} failed to render</p>
                    <p className="mt-1 text-xs">This cell encountered a rendering error. Other cells should be unaffected.</p>
                    <p className="mt-1 text-xs opacity-60">{error.message}</p>
                    <Button variant="outline" size="sm" onClick={reset} className="mt-2 text-xs">
                      Retry
                    </Button>
                  </div>
                )}
              >
                <NotebookCell
                  ref={setRef(i)}
                  cell={cell}
                  anyRunning={anyRunning}
                  onRerun={notebook.rerunCell}
                  onDelete={notebook.deleteCell}
                  onToggleEdit={notebook.toggleEdit}
                  onToggleCollapse={notebook.toggleCollapse}
                  onCopy={notebook.copyCell}
                />
              </ErrorBoundary>
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

      <AlertDialog
        open={pendingDeleteIndex !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteIndex(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete Cell {pendingDeleteIndex !== null ? notebook.cells[pendingDeleteIndex]?.number : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will remove this cell and all cells after it. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDeleteIndex !== null) {
                  const cell = notebook.cells[pendingDeleteIndex];
                  if (cell) notebook.deleteCell(cell.id);
                }
                setPendingDeleteIndex(null);
              }}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
