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
 * Button-row filter chips used as the top-of-queue filter on admin
 * queue/moderation pages. Replaces the "4 StatCards in a grid" pattern —
 * same information, denser, keyboard-navigable, and leaves horizontal
 * room for a bulk-action bar on the right.
 *
 * The `trailing` slot is deliberately generic so callers can render their
 * own bulk-action UI inline (the `/admin/actions` and `/admin/approval`
 * flavour) without every caller needing identical bulk controls.
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
