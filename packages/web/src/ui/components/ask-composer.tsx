"use client";

import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface AskComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder: string;
  multiline?: boolean;
  helperText?: string;
  inputAriaLabel?: string;
  className?: string;
}

export function AskComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder,
  multiline = false,
  helperText,
  inputAriaLabel = "Chat message",
  className,
}: AskComposerProps) {
  const canSubmit = !disabled && value.trim().length > 0;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter") return;
    if (multiline) {
      if (!e.shiftKey) {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }
      return;
    }
    // Single-line: cmd/ctrl-Enter alias for users coming from tools where
    // Enter inserts a newline. Plain Enter submits via the form.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      className={cn(
        "flex flex-none flex-col gap-1 border-t border-zinc-100 py-4 dark:border-zinc-800",
        className,
      )}
    >
      <div className="flex items-end gap-2">
        {multiline ? (
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            aria-label={inputAriaLabel}
            className="min-h-10 min-w-0 flex-1 resize-none"
          />
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={inputAriaLabel}
            className="min-w-0 flex-1 py-3 text-base sm:text-sm"
          />
        )}
        <Button
          type="submit"
          size="icon"
          disabled={!canSubmit}
          aria-label="Send"
          className="size-10 shrink-0"
        >
          <Send className="size-4" />
        </Button>
      </div>
      {helperText && (
        <span className="text-xs text-muted-foreground">{helperText}</span>
      )}
    </form>
  );
}
