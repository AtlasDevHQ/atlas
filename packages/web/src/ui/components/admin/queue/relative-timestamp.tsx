"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function absoluteTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
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
 */
export function RelativeTimestamp({
  iso,
  label,
}: {
  iso: string;
  label?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          {label ? `${label}: ` : ""}
          {relativeTime(iso)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <time dateTime={iso}>{absoluteTimestamp(iso)}</time>
      </TooltipContent>
    </Tooltip>
  );
}
