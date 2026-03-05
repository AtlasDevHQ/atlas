"use client";

import { cn } from "@/lib/utils";

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";

const statusConfig: Record<HealthStatus, { dot: string; text: string; label: string }> = {
  healthy: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400", label: "Healthy" },
  degraded: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", label: "Degraded" },
  down: { dot: "bg-red-500", text: "text-red-700 dark:text-red-400", label: "Down" },
  unknown: { dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400", label: "Unknown" },
};

export function HealthBadge({
  status,
  label,
  className,
}: {
  status: HealthStatus;
  label?: string;
  className?: string;
}) {
  const config = statusConfig[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", config.text, className)}>
      <span className={cn("size-2 rounded-full", config.dot)} />
      {label ?? config.label}
    </span>
  );
}
