"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface CellInputProps {
  question: string;
  editing: boolean;
  onSubmit: (newQuestion: string) => void;
  onCancel: () => void;
}

export function NotebookCellInput({ question, editing, onSubmit, onCancel }: CellInputProps) {
  const [draft, setDraft] = useState(question);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autoExpand() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  useEffect(() => {
    if (editing) {
      setDraft(question);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        autoExpand();
      });
    }
  }, [editing, question]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(draft);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value);
    autoExpand();
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
      <Textarea
        ref={textareaRef}
        value={draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="min-h-[60px] resize-y overflow-hidden"
        placeholder="Edit your question..."
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onSubmit(draft)}>
          Run
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-xs text-zinc-500">Enter to run, Shift+Enter for newline</span>
      </div>
    </div>
  );
}
