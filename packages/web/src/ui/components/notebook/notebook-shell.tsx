"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { Plus, Download, FileText, Check } from "lucide-react";
import type { UseNotebookReturn } from "./use-notebook";
import { useKeyboardNav } from "./use-keyboard-nav";
import { NotebookCell } from "./notebook-cell";
import { NotebookTextCell } from "./notebook-text-cell";
import { NotebookEmptyState } from "./notebook-empty-state";
import { NotebookInputBar } from "./notebook-input-bar";
import { DeleteCellDialog } from "./delete-cell-dialog";
import { ForkBranchSelector } from "./fork-branch-selector";
import { exportToMarkdown, exportToHTML, downloadFile } from "./notebook-export";
import type { ForkBranchWire } from "@/ui/lib/types";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableOverlay,
} from "@/components/ui/sortable";

interface NotebookShellProps {
  notebook: UseNotebookReturn;
  focusCellId?: string;
  /** When provided, enables the "Share as Report" button. Returns the share token. */
  onShareAsReport?: () => Promise<string>;
}

export function NotebookShell({ notebook, focusCellId, onShareAsReport }: NotebookShellProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const anyRunning = notebook.cells.some((c) => c.status === "running");
  const editingCellId = notebook.cells.find((c) => c.editing)?.id ?? null;
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);
  const [dismissedError, setDismissedError] = useState<Error | null>(null);
  const [shareState, setShareState] = useState<"idle" | "sharing" | "copied" | "error">("idle");

  // Build a map from forkPointCellId (message ID) → branches for gutter indicators.
  // Correctness: useMemo is needed here for a stable reference identity across renders.
  const branchesByMessageId = useMemo(() => {
    const map = new Map<string, ForkBranchWire[]>();
    if (!notebook.forkInfo?.branches) return map;
    for (const branch of notebook.forkInfo.branches) {
      const existing = map.get(branch.forkPointCellId);
      if (existing) {
        existing.push(branch);
      } else {
        map.set(branch.forkPointCellId, [branch]);
      }
    }
    return map;
  }, [notebook.forkInfo?.branches]);

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
    onInsertTextCell: (index) => {
      const cell = notebook.cells[index];
      notebook.insertTextCell(cell?.id);
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

  const pendingDeleteCell = pendingDeleteIndex !== null ? notebook.cells[pendingDeleteIndex] : null;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-5xl space-y-4">
          {notebook.error && notebook.error !== dismissedError && (
            <div className="flex items-start justify-between rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <div>
                <p className="font-medium">Request failed</p>
                <p>{notebook.error.message}</p>
                <p className="mt-1 text-xs text-red-500 dark:text-red-400">Try re-running the last cell or refreshing the page.</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setDismissedError(notebook.error)} className="shrink-0 text-red-600 dark:text-red-400">
                Dismiss
              </Button>
            </div>
          )}
          {notebook.warning && !notebook.error && (
            <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <p>{notebook.warning}</p>
              <Button variant="ghost" size="sm" onClick={notebook.clearWarning} className="shrink-0 text-amber-600 dark:text-amber-400">
                Dismiss
              </Button>
            </div>
          )}

          {notebook.forkInfo && notebook.forkInfo.branches.length > 0 && (
            <ForkBranchSelector
              forkInfo={notebook.forkInfo}
              onSwitchBranch={notebook.switchBranch}
              onDeleteBranch={notebook.deleteBranch}
              onRenameBranch={notebook.renameBranch}
            />
          )}

          {/* Notebook toolbar */}
          {notebook.cells.length > 0 && (
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => notebook.insertTextCell()}
              >
                <Plus className="size-3" />
                Text Cell
              </Button>

              <div className="flex items-center gap-1.5">
                {onShareAsReport && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={shareState === "sharing"}
                    onClick={async () => {
                      setShareState("sharing");
                      let token: string;
                      try {
                        token = await onShareAsReport();
                      } catch (err: unknown) {
                        console.error(
                          "Share as Report API failed:",
                          err instanceof Error ? err.message : String(err),
                        );
                        setShareState("error");
                        setTimeout(() => setShareState("idle"), 3000);
                        return;
                      }
                      const url = `${window.location.origin}/report/${token}`;
                      try {
                        await navigator.clipboard.writeText(url);
                        setShareState("copied");
                        setTimeout(() => setShareState("idle"), 2500);
                      } catch (clipErr: unknown) {
                        console.warn(
                          "Clipboard write failed, share was created:",
                          clipErr instanceof Error ? clipErr.message : String(clipErr),
                        );
                        window.prompt("Report link (copy manually):", url);
                        setShareState("copied");
                        setTimeout(() => setShareState("idle"), 2500);
                      }
                    }}
                  >
                    {shareState === "copied" ? (
                      <Check className="size-3" />
                    ) : (
                      <FileText className="size-3" />
                    )}
                    {shareState === "sharing"
                      ? "Sharing..."
                      : shareState === "copied"
                        ? "Link Copied!"
                        : shareState === "error"
                          ? "Share Failed"
                          : "Share as Report"}
                  </Button>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                    >
                      <Download className="size-3" />
                      Export
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        try {
                          downloadFile(
                            exportToMarkdown(notebook.cells),
                            "notebook.md",
                            "text/markdown",
                          );
                        } catch (err: unknown) {
                          console.error(
                            "Export to Markdown failed:",
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      }}
                    >
                      Markdown (.md)
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        try {
                          downloadFile(
                            exportToHTML(notebook.cells),
                            "notebook.html",
                            "text/html",
                          );
                        } catch (err: unknown) {
                          console.error(
                            "Export to HTML failed:",
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      }}
                    >
                      HTML (.html)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}

          {notebook.cells.length === 0 ? (
            <NotebookEmptyState />
          ) : (
            <Sortable
              value={notebook.cells}
              onValueChange={(newCells) =>
                notebook.reorderCells(newCells.map((c) => c.id))
              }
              getItemValue={(cell) => cell.id}
              orientation="vertical"
            >
              <SortableContent className="space-y-4">
                {notebook.cells.map((cell, i) => (
                  <SortableItem key={cell.id} value={cell.id}>
                    <ErrorBoundary
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
                      {cell.type === "text" ? (
                        <NotebookTextCell
                          ref={setRef(i)}
                          cell={cell}
                          onUpdateContent={notebook.updateTextCell}
                          onDelete={notebook.deleteCell}
                          onToggleEdit={notebook.toggleEdit}
                        />
                      ) : (
                        <NotebookCell
                          ref={setRef(i)}
                          cell={cell}
                          anyRunning={anyRunning}
                          cellBranches={branchesByMessageId.get(cell.messageId) ?? []}
                          onRerun={notebook.rerunCell}
                          onDelete={notebook.deleteCell}
                          onToggleEdit={notebook.toggleEdit}
                          onToggleCollapse={notebook.toggleCollapse}
                          onCopy={notebook.copyCell}
                          onFork={notebook.forkCell}
                          dashboardCards={notebook.dashboardCards}
                          onDashboardCardAdded={notebook.addDashboardCard}
                        />
                      )}
                    </ErrorBoundary>
                  </SortableItem>
                ))}
              </SortableContent>
              <SortableOverlay />
            </Sortable>
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

      <DeleteCellDialog
        open={pendingDeleteIndex !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteIndex(null); }}
        cellNumber={pendingDeleteCell?.number ?? 0}
        isTextCell={pendingDeleteCell?.type === "text"}
        onConfirm={() => {
          if (pendingDeleteIndex !== null) {
            const cell = notebook.cells[pendingDeleteIndex];
            if (cell) {
              notebook.deleteCell(cell.id);
            } else {
              console.warn(
                `Delete failed: cell at index ${pendingDeleteIndex} no longer exists (cells length: ${notebook.cells.length})`,
              );
            }
          }
          setPendingDeleteIndex(null);
        }}
      />
    </div>
  );
}
