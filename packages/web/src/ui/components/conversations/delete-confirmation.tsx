"use client";

import { Loader2 } from "lucide-react";

export function DeleteConfirmation({
  onConfirm,
  onCancel,
  deleting = false,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  deleting?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      <span className="text-zinc-500 dark:text-zinc-400">Delete?</span>
      <button
        onClick={onCancel}
        disabled={deleting}
        className="rounded px-2 py-0.5 text-zinc-500 transition-colors hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={deleting}
        className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-white transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-red-500/50 disabled:opacity-50"
      >
        {deleting && <Loader2 className="size-3 animate-spin" />}
        Delete
      </button>
    </div>
  );
}
