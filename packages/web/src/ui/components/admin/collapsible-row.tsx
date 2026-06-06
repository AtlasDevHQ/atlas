"use client";

import { useId, useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusDot, type StatusKind, STATUS_LABEL } from "./compact";

/* ────────────────────────────────────────────────────────────────────────
 *  CollapsibleRow — a dense, one-line connection/datasource row that expands
 *  in place to reveal its detail sheet + actions.
 *
 *  Built for the connections surface, where a workspace can hold many
 *  databases and REST APIs at once. The collapsed row carries everything an
 *  admin scans for (identity, kind, health, a single headline metric); the
 *  expanded panel carries the full DetailList + Test/Edit/Delete footer that
 *  the old always-open {@link Shell} card showed unconditionally.
 *
 *  Shares the StatusKind vocabulary + status tinting with {@link Shell} so a
 *  collapsed row and an expanded panel read as the same object. The whole
 *  summary line is the toggle; actions live only in the expanded footer, so
 *  the toggle never swallows an action click.
 * ──────────────────────────────────────────────────────────────────────── */

export function CollapsibleRow({
  icon: Icon,
  title,
  titleText,
  titleBadge,
  meta,
  status,
  statusLabel,
  summary,
  defaultExpanded = false,
  children,
  actions,
  dataTestId,
}: {
  icon: ComponentType<{ className?: string }>;
  /** Rendered title (often `<span className="font-mono">{id}</span>`). */
  title: ReactNode;
  /** Plain-text title for the aria-label when `title` is JSX. */
  titleText?: string;
  titleBadge?: ReactNode;
  /** Secondary identity line shown muted after the title (e.g. "Postgres · prod"
   *  or a REST host). Truncates. */
  meta?: ReactNode;
  status: StatusKind;
  /** Override the default Live / Unhealthy / Connected pill text. */
  statusLabel?: string;
  /** Right-aligned headline metric shown while COLLAPSED (e.g. "12ms", "42 ops").
   *  Hidden once expanded — the detail sheet carries the precise values. */
  summary?: ReactNode;
  defaultExpanded?: boolean;
  /** Expanded detail body (typically a DetailList). */
  children?: ReactNode;
  /** Expanded footer actions (Test / Edit / Delete …). */
  actions?: ReactNode;
  dataTestId?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();
  const ariaTitle = titleText ?? (typeof title === "string" ? title : "item");

  const pill =
    status === "connected" ? (
      <span className="hidden items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary sm:flex">
        <StatusDot kind="connected" />
        {statusLabel ?? "Live"}
      </span>
    ) : status === "unhealthy" ? (
      <span className="hidden items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-destructive sm:flex">
        <StatusDot kind="unhealthy" />
        {statusLabel ?? "Unhealthy"}
      </span>
    ) : status === "transitioning" ? (
      <span className="hidden items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-amber-600 dark:text-amber-400 sm:flex">
        <StatusDot kind="transitioning" />
        {statusLabel ?? STATUS_LABEL[status]}
      </span>
    ) : (
      // On a narrow screen the labelled pill collapses to just the dot so the
      // row never wraps; the sr-only label keeps it announced.
      <span className="flex items-center">
        <StatusDot kind={status} />
        <span className="sr-only">{statusLabel ?? STATUS_LABEL[status]}</span>
      </span>
    );

  return (
    <section
      data-testid={dataTestId}
      className={cn(
        "overflow-hidden rounded-xl border bg-card/40 transition-colors",
        expanded ? "bg-card/60" : "hover:bg-card/70 hover:border-border/80",
        status === "connected" && expanded && "border-primary/20",
        status === "unhealthy" && "border-destructive/25",
        status === "transitioning" && "border-amber-500/25",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={`${ariaTitle}: ${statusLabel ?? STATUS_LABEL[status]}`}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
      >
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status === "unhealthy" && "border-destructive/30 text-destructive",
            status === "transitioning" &&
              "border-amber-500/30 text-amber-600 dark:text-amber-400",
            (status === "disconnected" ||
              status === "unavailable" ||
              status === "ready") &&
              "text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>

        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-semibold leading-tight tracking-tight">
            {title}
          </span>
          {titleBadge}
          {meta != null && (
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
              {meta}
            </span>
          )}
        </span>

        {summary != null && !expanded && (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {summary}
          </span>
        )}
        {pill}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div id={panelId} className="border-t border-border/50">
          {children != null && (
            <div className="space-y-3 px-4 pb-3 pt-3 text-sm">{children}</div>
          )}
          {actions && (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
              {actions}
            </footer>
          )}
        </div>
      )}
    </section>
  );
}
