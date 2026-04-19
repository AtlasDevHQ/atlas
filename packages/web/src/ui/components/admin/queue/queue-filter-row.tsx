"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface QueueFilterOption<T extends string> {
  value: T;
  label: string;
}

interface QueueFilterRowProps<T extends string> {
  options: readonly QueueFilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Optional trailing content — e.g. a secondary filter select or bulk-action bar. */
  trailing?: ReactNode;
}

/**
 * Button-row filter chips for admin queue/moderation pages. The `trailing`
 * slot is deliberately generic so callers own their bulk-action UI — this
 * primitive does not prescribe bulk controls.
 */
export function QueueFilterRow<T extends string>({
  options,
  value,
  onChange,
  trailing,
}: QueueFilterRowProps<T>) {
  return (
    <div
      role="toolbar"
      aria-label="Queue filters"
      className="flex flex-wrap items-center gap-2"
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <Button
            key={opt.value}
            size="sm"
            variant={selected ? "secondary" : "ghost"}
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </Button>
        );
      })}
      {trailing && (
        <>
          <div aria-hidden className="mx-1 h-4 w-px bg-border" />
          {trailing}
        </>
      )}
    </div>
  );
}
