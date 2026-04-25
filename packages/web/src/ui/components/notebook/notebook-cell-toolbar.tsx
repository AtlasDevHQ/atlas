"use client";

import { Pencil, Play, Copy, Trash2, Loader2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CellStatus } from "./types";

interface CellToolbarProps {
  status: CellStatus;
  editing: boolean;
  disabled: boolean;
  onEdit: () => void;
  onRun: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

/**
 * Cell action toolbar.
 *
 * - At md+ viewports: 4 icon buttons (edit / run / copy / delete) revealed on
 *   hover or focus-within.
 * - Below md: a single overflow menu (kebab) so the cell question gets the
 *   full row width and isn't crowded by toolbar chrome.
 *
 * The "What if?" / fork action is promoted out of this toolbar and rendered
 * as a separate pill below the cell output (only when the cell has output) —
 * see {@link NotebookCell}.
 */
export function NotebookCellToolbar({
  status,
  editing,
  disabled,
  onEdit,
  onRun,
  onCopy,
  onDelete,
}: CellToolbarProps) {
  const isRunning = status === "running";

  return (
    <>
      {/* md+: revealed icon row */}
      <div
        role="toolbar"
        aria-label="Cell actions"
        className="hidden items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:flex"
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
          className="size-7 text-red-500 hover:text-red-600"
          onClick={onDelete}
          disabled={isRunning || disabled}
          aria-label="Delete cell"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* <md: kebab menu — keeps the question's row clean on small viewports */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 md:hidden"
            aria-label="Cell actions"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit} disabled={isRunning || disabled}>
            <Pencil className="mr-2 size-3.5" />
            {editing ? "Cancel edit" : "Edit cell"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRun} disabled={isRunning || disabled}>
            {isRunning ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Play className="mr-2 size-3.5" />
            )}
            Run cell
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopy}>
            <Copy className="mr-2 size-3.5" />
            Copy cell
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDelete}
            disabled={isRunning || disabled}
            className="text-red-600 focus:text-red-700"
          >
            <Trash2 className="mr-2 size-3.5" />
            Delete cell
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
