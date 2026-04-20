"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function absoluteTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(ms: number): string {
  const diffMs = ms - Date.now();
  const absSec = Math.abs(Math.round(diffMs / 1000));
  if (absSec < 60) return RTF.format(Math.round(diffMs / 1000), "second");
  const absMin = Math.abs(Math.round(diffMs / 60000));
  if (absMin < 60) return RTF.format(Math.round(diffMs / 60000), "minute");
  const absHr = Math.abs(Math.round(diffMs / 3600000));
  if (absHr < 24) return RTF.format(Math.round(diffMs / 3600000), "hour");
  return RTF.format(Math.round(diffMs / 86400000), "day");
}

/**
 * Short relative timestamp with the absolute datetime on hover.
 * Caller must wrap the tree in `<TooltipProvider>` — this component
 * reuses the existing shadcn Tooltip primitives and does not create
 * its own provider.
 *
 * Invalid ISO strings render a dash rather than `"NaN days ago"` /
 * `"Invalid Date"`. Servers should emit valid ISO; the guard is a
 * belt-and-braces floor so a single bad row never degrades the table.
 */
export function RelativeTimestamp({
  iso,
  label,
}: {
  iso: string;
  label?: string;
}) {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return <span className="text-muted-foreground">—</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          {label ? `${label}: ` : ""}
          {relativeTime(ms)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <time dateTime={iso}>{absoluteTimestamp(ms)}</time>
      </TooltipContent>
    </Tooltip>
  );
}
