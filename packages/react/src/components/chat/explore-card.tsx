"use client";

import { useState } from "react";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";

export function ExploreCard({ part }: { part: unknown }) {
  const args = getToolArgs(part);
  const result = getToolResult(part);
  const done = isToolComplete(part);
  const [open, setOpen] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
      <button
        onClick={() => done && setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
      >
        <span className="font-mono text-green-400">$</span>
        <span className="flex-1 truncate font-mono text-zinc-700 dark:text-zinc-300">
          {String(args.command ?? "")}
        </span>
        {done ? (
          <span className="text-zinc-400 dark:text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
        ) : (
          <span className="animate-pulse text-zinc-500">running...</span>
        )}
      </button>
      {open && done && (
        <div className="border-t border-zinc-100 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            {result != null
              ? typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)
              : "(no output received)"}
          </pre>
        </div>
      )}
    </div>
  );
}
