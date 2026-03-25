"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ResultCardBaseProps {
  /** Badge text shown in the header (e.g. "SQL", "Python") */
  badge: string;
  /** Color classes for the badge */
  badgeClassName: string;
  /** Title/explanation text shown next to the badge */
  title: string;
  /** Extra content in the header before the collapse arrow (e.g. row count) */
  headerExtra?: ReactNode;
  /** Main content rendered inside the collapsible body */
  children: ReactNode;
  /** Additional className for the content wrapper div */
  contentClassName?: string;
  /** Whether the card starts expanded (default: true) */
  defaultOpen?: boolean;
}

export function ResultCardBase({
  badge,
  badgeClassName,
  title,
  headerExtra,
  children,
  contentClassName,
  defaultOpen = true,
}: ResultCardBaseProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
      >
        <span className={cn("rounded px-1.5 py-0.5 font-medium", badgeClassName)}>
          {badge}
        </span>
        <span className="flex-1 truncate text-zinc-500 dark:text-zinc-400">
          {title}
        </span>
        {headerExtra}
        <span className="text-zinc-400 dark:text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
      </button>
      {open && (
        <div className={cn("border-t border-zinc-100 dark:border-zinc-800", contentClassName)}>
          {children}
        </div>
      )}
    </div>
  );
}
