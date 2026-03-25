"use client";

import { Component, useState, type ReactNode, type ErrorInfo } from "react";
import { cn } from "@/lib/utils";

export interface ResultCardBaseProps {
  /** Badge text shown in the header (e.g. "SQL", "Python") */
  badge: string;
  /** Color classes for the badge — expects bg + text + dark variants, e.g. "bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400" */
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
        aria-expanded={open}
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

/* ------------------------------------------------------------------ */
/*  Shared error boundary for result cards                             */
/* ------------------------------------------------------------------ */

interface ResultCardErrorBoundaryProps {
  /** Label for the error message, e.g. "SQL" or "Python" */
  label: string;
  children: ReactNode;
}

interface ResultCardErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ResultCardErrorBoundary extends Component<
  ResultCardErrorBoundaryProps,
  ResultCardErrorBoundaryState
> {
  constructor(props: ResultCardErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ResultCardErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} result card rendering failed:`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="my-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
          {this.props.label} result could not be rendered: {this.state.error?.message || "unknown error"}
        </div>
      );
    }
    return this.props.children;
  }
}
