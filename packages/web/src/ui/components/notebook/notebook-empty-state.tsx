import { NotebookPen } from "lucide-react";

export function NotebookEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
        <NotebookPen className="size-8 text-zinc-400" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Start your analysis
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Ask a question below to create your first cell.
        </p>
      </div>
    </div>
  );
}
