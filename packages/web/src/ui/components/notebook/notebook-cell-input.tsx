"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";

interface CellInputProps {
  question: string;
  editing: boolean;
  onSubmit: (newQuestion: string) => void;
  onCancel: () => void;
}

export function NotebookCellInput({ question, editing, onSubmit, onCancel }: CellInputProps) {
  const [draft, setDraft] = useState(question);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(question);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [editing, question]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      onSubmit(draft);
    }
  }

  if (!editing) {
    return (
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        {question}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        className="min-h-[60px] w-full resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        placeholder="Edit your question..."
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onSubmit(draft)}>
          Run
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-xs text-zinc-500">Shift+Enter to run</span>
      </div>
    </div>
  );
}
