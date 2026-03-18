"use client";

import { forwardRef, useState } from "react";
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
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ResolvedCell } from "./types";
import { NotebookCellToolbar } from "./notebook-cell-toolbar";
import { NotebookCellInput } from "./notebook-cell-input";
import { NotebookCellOutput } from "./notebook-cell-output";
import { extractTextContent } from "./use-notebook";

interface NotebookCellProps {
  cell: ResolvedCell;
  anyRunning: boolean;
  onRerun: (cellId: string, newQuestion: string) => void;
  onDelete: (cellId: string) => void;
  onToggleEdit: (cellId: string) => void;
  onToggleCollapse: (cellId: string) => void;
  onCopy: (cellId: string) => Promise<void>;
}

export const NotebookCell = forwardRef<HTMLElement, NotebookCellProps>(
  function NotebookCell(
    { cell, anyRunning, onRerun, onDelete, onToggleEdit, onToggleCollapse, onCopy },
    ref,
  ) {
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const question = extractTextContent(cell.userMessage);
    const isRunning = cell.status === "running";

    return (
      <>
        <section
          ref={ref}
          role="region"
          aria-label={`Cell ${cell.number}`}
          tabIndex={0}
          className={cn(
            "group rounded-lg border border-zinc-200 bg-white transition-shadow focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-950",
            isRunning && "ring-2 ring-blue-400/50",
          )}
        >
          <div className="flex items-start gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800/50">
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
                onDelete={() => setShowDeleteDialog(true)}
              />
            </div>
          </div>

          <div
            role="region"
            aria-label={`Cell ${cell.number} output`}
            className={cn("px-4 py-3", cell.editing && "opacity-50")}
          >
            <NotebookCellOutput
              assistantMessage={cell.assistantMessage}
              status={cell.status}
              collapsed={cell.collapsed}
            />
          </div>
        </section>

        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Cell {cell.number}?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove this cell and all cells after it. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onDelete(cell.id)}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  },
);
