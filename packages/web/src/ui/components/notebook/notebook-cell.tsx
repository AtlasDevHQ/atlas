"use client";

import { forwardRef, useState } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SortableItemHandle } from "@/components/ui/sortable";
import { cn } from "@/lib/utils";
import type { ResolvedCell } from "./types";
import { NotebookCellToolbar } from "./notebook-cell-toolbar";
import { NotebookCellInput } from "./notebook-cell-input";
import { NotebookCellOutput } from "./notebook-cell-output";
import { DeleteCellDialog } from "./delete-cell-dialog";
import { extractTextContent } from "./use-notebook";
import { DashboardBridgeProvider, type DashboardCardEntry } from "./dashboard-bridge-context";

interface NotebookCellProps {
  cell: ResolvedCell;
  anyRunning: boolean;
  onRerun: (cellId: string, newQuestion: string) => void;
  onDelete: (cellId: string) => void;
  onToggleEdit: (cellId: string) => void;
  onToggleCollapse: (cellId: string) => void;
  onCopy: (cellId: string) => Promise<void>;
  onFork: (cellId: string) => Promise<void>;
  dashboardCards: Record<string, DashboardCardEntry>;
  onDashboardCardAdded: (cellId: string, entry: DashboardCardEntry) => void;
}

export const NotebookCell = forwardRef<HTMLElement, NotebookCellProps>(
  function NotebookCell(
    { cell, anyRunning, onRerun, onDelete, onToggleEdit, onToggleCollapse, onCopy, onFork, dashboardCards, onDashboardCardAdded },
    ref,
  ) {
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const question = extractTextContent(cell.userMessage);
    const isRunning = cell.status === "running";

    const bridgeValue = {
      cellId: cell.id,
      dashboardCards,
      onDashboardCardAdded,
    };

    return (
      <>
        <section
          ref={ref}
          role="region"
          aria-label={`Cell ${cell.number}`}
          tabIndex={0}
          className={cn(
            "group rounded-lg border border-zinc-200 bg-white transition-shadow focus:outline-none focus:ring-2 focus:ring-ring dark:border-zinc-800 dark:bg-zinc-950",
            isRunning && "ring-2 ring-primary/50",
          )}
        >
          <div className="flex items-start gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/50">
            <SortableItemHandle asChild>
              <button
                className="mt-0.5 flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                aria-label="Drag to reorder"
              >
                <GripVertical className="size-3.5" />
              </button>
            </SortableItemHandle>
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-zinc-100 font-mono text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {cell.number}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="sr-only">
                Cell {cell.number}: {question}
              </h3>
              <NotebookCellInput
                question={question}
                editing={cell.editing}
                onSubmit={(newQ) => onRerun(cell.id, newQ)}
                onCancel={() => onToggleEdit(cell.id)}
              />
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => onToggleCollapse(cell.id)}
                aria-label={cell.collapsed ? "Expand output" : "Collapse output"}
              >
                {cell.collapsed ? (
                  <ChevronRight className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </Button>
              <NotebookCellToolbar
                status={cell.status}
                editing={cell.editing}
                disabled={anyRunning && !isRunning}
                onEdit={() => onToggleEdit(cell.id)}
                onRun={() => onRerun(cell.id, question)}
                onCopy={() => onCopy(cell.id)}
                onFork={() => onFork(cell.id)}
                onDelete={() => setShowDeleteDialog(true)}
              />
            </div>
          </div>

          <div
            role="region"
            aria-label={`Cell ${cell.number} output`}
            className={cn("px-4 py-3", cell.editing && "opacity-50")}
          >
            <DashboardBridgeProvider value={bridgeValue}>
              <NotebookCellOutput
                assistantMessage={cell.assistantMessage}
                status={cell.status}
                collapsed={cell.collapsed}
                previousExecution={cell.previousExecution}
              />
            </DashboardBridgeProvider>
          </div>
        </section>

        <DeleteCellDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          cellNumber={cell.number}
          onConfirm={() => onDelete(cell.id)}
        />
      </>
    );
  },
);
