"use client";

import { forwardRef, useState, useRef, useEffect } from "react";
import { GripVertical, Pencil, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SortableItemHandle } from "@/components/ui/sortable";
import { cn } from "@/lib/utils";
import { Markdown } from "@/ui/components/chat/markdown";
import type { ResolvedCell } from "./types";

interface NotebookTextCellProps {
  cell: ResolvedCell;
  onUpdateContent: (cellId: string, content: string) => void;
  onDelete: (cellId: string) => void;
  onToggleEdit: (cellId: string) => void;
}

export const NotebookTextCell = forwardRef<HTMLElement, NotebookTextCellProps>(
  function NotebookTextCell({ cell, onUpdateContent, onDelete, onToggleEdit }, ref) {
    const [draft, setDraft] = useState(cell.content ?? "");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Sync draft when cell content changes externally
    useEffect(() => {
      if (!cell.editing) {
        setDraft(cell.content ?? "");
      }
    }, [cell.content, cell.editing]);

    // Focus and auto-expand textarea when entering edit mode
    useEffect(() => {
      if (cell.editing) {
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }
        });
      }
    }, [cell.editing]);

    function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const value = e.target.value;
      setDraft(value);
      onUpdateContent(cell.id, value);

      // Auto-expand
      const el = textareaRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }
    }

    function handleDone() {
      onUpdateContent(cell.id, draft);
      onToggleEdit(cell.id);
    }

    function handleKeyDown(e: React.KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleDone();
      }
    }

    const hasContent = (cell.content ?? "").trim().length > 0;

    // Editing wears the dashed border + tinted background as the focused-edit signal.
    // Rendered text reads as inline documentation; the chrome would otherwise feel
    // like a "this cell is unfinished" placeholder.
    return (
      <section
        ref={ref}
        role="region"
        aria-label={`Text cell ${cell.number}`}
        tabIndex={0}
        className={cn(
          "group rounded-lg transition-shadow focus:outline-none focus:ring-2 focus:ring-ring",
          cell.editing
            ? "border border-dashed border-zinc-300 bg-zinc-50/50 dark:border-zinc-700 dark:bg-zinc-900/30"
            : "",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 px-4 py-1.5",
            cell.editing && "border-b border-dashed border-zinc-200 dark:border-zinc-800/50",
          )}
        >
          <SortableItemHandle asChild>
            <button
              className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-zinc-300 transition-colors hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-300"
              aria-label="Drag to reorder"
            >
              <GripVertical className="size-3.5" />
            </button>
          </SortableItemHandle>
          <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Text
          </span>
          <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => (cell.editing ? handleDone() : onToggleEdit(cell.id))}
              aria-label={cell.editing ? "Done editing" : "Edit text cell"}
            >
              {cell.editing ? (
                <Check className="size-3.5" />
              ) : (
                <Pencil className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-red-500 hover:text-red-600"
              onClick={() => onDelete(cell.id)}
              aria-label="Delete text cell"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="px-4 py-3">
          {cell.editing ? (
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              className="min-h-[80px] resize-y overflow-hidden border-none bg-transparent p-0 shadow-none focus-visible:ring-0"
              placeholder="Write markdown text..."
            />
          ) : hasContent ? (
            <div
              className="cursor-pointer text-sm"
              onDoubleClick={() => onToggleEdit(cell.id)}
            >
              <Markdown content={cell.content ?? ""} />
            </div>
          ) : (
            <p
              className="cursor-pointer text-xs italic text-zinc-400 dark:text-zinc-500"
              onDoubleClick={() => onToggleEdit(cell.id)}
            >
              Double-click to edit
            </p>
          )}
        </div>
      </section>
    );
  },
);
