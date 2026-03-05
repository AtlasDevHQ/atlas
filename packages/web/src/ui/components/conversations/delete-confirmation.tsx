"use client";

export function DeleteConfirmation({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      <span className="text-zinc-500 dark:text-zinc-400">Delete?</span>
      <button
        onClick={onCancel}
        className="rounded px-2 py-0.5 text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        className="rounded bg-red-600 px-2 py-0.5 text-white transition-colors hover:bg-red-500"
      >
        Delete
      </button>
    </div>
  );
}
