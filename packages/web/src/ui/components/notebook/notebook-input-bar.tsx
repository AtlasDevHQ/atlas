"use client";

import { useRef } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}

export function NotebookInputBar({ value, onChange, onSubmit, disabled }: InputBarProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) onSubmit();
    }
  }

  return (
    <div className="sticky bottom-0 border-t border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-5xl items-end gap-2">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question to add a new cell..."
          disabled={disabled}
          rows={1}
          className="min-h-[40px] flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-400"
        />
        <Button
          size="icon"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          aria-label="Send"
          className="size-10 shrink-0"
        >
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}
