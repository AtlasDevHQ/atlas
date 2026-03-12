"use client";

import type { ActionStatus } from "../../lib/action-types";

const STATUS_CONFIG: Record<ActionStatus, { label: string; classes: string }> = {
  pending_approval: {
    label: "Pending Approval",
    classes: "bg-yellow-100 text-yellow-700 dark:bg-yellow-600/20 dark:text-yellow-400",
  },
  approved: {
    label: "Approved",
    classes: "bg-green-100 text-green-700 dark:bg-green-600/20 dark:text-green-400",
  },
  executed: {
    label: "Executed",
    classes: "bg-green-100 text-green-700 dark:bg-green-600/20 dark:text-green-400",
  },
  auto_approved: {
    label: "Auto-approved",
    classes: "bg-green-100 text-green-700 dark:bg-green-600/20 dark:text-green-400",
  },
  denied: {
    label: "Denied",
    classes: "bg-red-100 text-red-700 dark:bg-red-600/20 dark:text-red-400",
  },
  failed: {
    label: "Failed",
    classes: "bg-red-100 text-red-700 dark:bg-red-600/20 dark:text-red-400",
  },
  rolled_back: {
    label: "Rolled Back",
    classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-600/20 dark:text-zinc-400",
  },
  timed_out: {
    label: "Timed Out",
    classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-600/20 dark:text-zinc-400",
  },
};

export function ActionStatusBadge({ status }: { status: ActionStatus }) {
  const config = STATUS_CONFIG[status] ?? {
    label: status.replace(/_/g, " "),
    classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-600/20 dark:text-zinc-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${config.classes}`}>
      {config.label}
    </span>
  );
}
