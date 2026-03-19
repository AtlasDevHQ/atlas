import { useCallback, useRef, useEffect } from "react";

export interface UseKeyboardNavOptions {
  cellCount: number;
  onEnterEdit: (index: number) => void;
  onExitEdit: () => void;
  onDelete: (index: number) => void;
  onInsertTextCell?: (index: number) => void;
  editing: boolean;
}

/**
 * Keyboard navigation for notebook cells.
 *
 * Bindings (when focus is on a cell, not in an input/textarea):
 *   ArrowUp/Down         — navigate between cells
 *   Enter                — enter edit mode for focused cell
 *   Escape               — exit edit mode, return focus to cell
 *   Ctrl+Shift+Backspace — delete focused cell (shows confirmation dialog)
 *   Ctrl+Shift+T         — insert text cell after focused cell
 *
 * When inside an INPUT/TEXTAREA, only Escape is handled (exits edit mode).
 * In-editor key handling (Enter to submit, Shift+Enter for newline) is
 * managed by NotebookCellInput, not this hook.
 */
export function useKeyboardNav({
  cellCount,
  onEnterEdit,
  onExitEdit,
  onDelete,
  onInsertTextCell,
  editing,
}: UseKeyboardNavOptions) {
  const focusedIndex = useRef(0);
  const cellRefs = useRef<(HTMLElement | null)[]>([]);

  const setRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      cellRefs.current[index] = el;
    },
    [],
  );

  const focusCell = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, cellRefs.current.length - 1));
    focusedIndex.current = clamped;
    cellRefs.current[clamped]?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "Escape") {
          e.preventDefault();
          onExitEdit();
          focusCell(focusedIndex.current);
        }
        return;
      }

      switch (e.key) {
        case "ArrowUp":
          if (cellCount > 0) {
            e.preventDefault();
            focusCell(focusedIndex.current - 1);
          }
          break;
        case "ArrowDown":
          if (cellCount > 0) {
            e.preventDefault();
            focusCell(focusedIndex.current + 1);
          }
          break;
        case "Enter":
          if (!editing && cellCount > 0) {
            e.preventDefault();
            onEnterEdit(focusedIndex.current);
          }
          break;
        case "Escape":
          if (editing) {
            e.preventDefault();
            onExitEdit();
            focusCell(focusedIndex.current);
          }
          break;
        case "Backspace":
          if (e.ctrlKey && e.shiftKey && cellCount > 0) {
            e.preventDefault();
            onDelete(focusedIndex.current);
          }
          break;
        case "t":
        case "T":
          if (e.ctrlKey && e.shiftKey && onInsertTextCell) {
            e.preventDefault();
            onInsertTextCell(focusedIndex.current);
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [cellCount, editing, focusCell, onEnterEdit, onExitEdit, onDelete, onInsertTextCell]);

  return { setRef, focusCell, focusedIndex };
}
