"use client";

import { useState } from "react";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";

export function ExploreCard({ part }: { part: unknown }) {
  const args = getToolArgs(part);
  const result = getToolResult(part);
  const done = isToolComplete(part);
  const [open, setOpen] = useState(false);

  return (
    <div className="group/explore overflow-hidden rounded-md">
      <button
        onClick={() => done && setOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-zinc-600 transition-colors hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:bg-zinc-800/40"
      >
        <span className="font-mono text-zinc-400 dark:text-zinc-600">$</span>
        <span className="min-w-0 flex-1 truncate font-mono">
          {String(args.command ?? "")}
        </span>
        {done ? (
          <span className="text-zinc-400 opacity-0 transition-opacity group-hover/explore:opacity-100 dark:text-zinc-600">{open ? "▾" : "▸"}</span>
        ) : (
          <span className="animate-pulse text-zinc-400">running…</span>
        )}
      </button>
      {open && done && (
        <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          <span className="text-zinc-400 dark:text-zinc-600">$ </span>
          <span className="text-zinc-700 dark:text-zinc-300">{String(args.command ?? "")}</span>
          {"\n\n"}
          {result != null
            ? typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)
            : "(no output received)"}
        </pre>
      )}
    </div>
  );
}
