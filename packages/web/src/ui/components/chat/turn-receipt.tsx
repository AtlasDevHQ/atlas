"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { isToolUIPart } from "ai";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { ToolPart } from "./tool-part";
import { parseSuggestions } from "../../lib/helpers";
import { summarizeActivity, type IndexedTurnPart } from "./turn-partitioner";
import type { PythonProgressData } from "./python-result-card";

/**
 * The collapsed receipt a finished turn's activity settles into (#4298):
 * one muted summary line ("Explored schema · 2 queries") that expands on
 * click to the full activity — tool cards with today's affordances (Show
 * SQL, result views) plus the agent's narration at sub-answer weight.
 *
 * Renders nothing for empty activity (a zero-tool turn has no receipt).
 * `defaultOpen` lets the caller keep the work visible when the activity is
 * the turn's only content (interrupted stream, approval-parked action).
 */
export function TurnReceipt({
  activity,
  pythonProgress,
  defaultOpen = false,
}: {
  activity: IndexedTurnPart[];
  pythonProgress?: Map<string, PythonProgressData[]>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (activity.length === 0) return null;

  return (
    <div className="max-w-[95%]" data-testid="turn-receipt">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100/60 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-300"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span>{summarizeActivity(activity)}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
          {activity.map(({ part, index }) => {
            if (part.type === "text") {
              const displayText = parseSuggestions(part.text).text;
              if (!displayText.trim()) return null;
              return (
                <div
                  key={index}
                  className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
                >
                  <Markdown content={displayText} />
                </div>
              );
            }
            if (isToolUIPart(part)) {
              return <ToolPart key={index} part={part} pythonProgress={pythonProgress} />;
            }
            // The partitioner only emits text + tool parts; this is a type-narrowing dead end.
            return null;
          })}
        </div>
      )}
    </div>
  );
}
