"use client";

import { Pencil, Play, Copy, GitFork, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CellStatus } from "./types";

interface CellToolbarProps {
  status: CellStatus;
  editing: boolean;
  disabled: boolean;
  onEdit: () => void;
  onRun: () => void;
  onCopy: () => void;
  onFork: () => void;
  onDelete: () => void;
}

export function NotebookCellToolbar({
  status,
  editing,
  disabled,
  onEdit,
  onRun,
  onCopy,
  onFork,
  onDelete,
}: CellToolbarProps) {
  const isRunning = status === "running";

  return (
    <div
      role="toolbar"
      aria-label="Cell actions"
      className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onEdit}
        disabled={isRunning || disabled}
        aria-label={editing ? "Cancel edit" : "Edit cell"}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onRun}
        disabled={isRunning || disabled}
        aria-label="Run cell"
      >
        {isRunning ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Play className="size-3.5" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onCopy}
        aria-label="Copy cell"
      >
        <Copy className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onFork}
        disabled={isRunning || disabled}
        aria-label="Fork from this cell"
      >
        <GitFork className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-red-500 hover:text-red-600"
        onClick={onDelete}
        disabled={isRunning || disabled}
        aria-label="Delete cell"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
