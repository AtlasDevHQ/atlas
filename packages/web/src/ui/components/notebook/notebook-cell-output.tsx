"use client";

import type { UIMessage } from "@ai-sdk/react";
import { isToolUIPart } from "ai";
import type { CellStatus, PreviousExecution } from "./types";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { Markdown } from "@/ui/components/chat/markdown";
import { TypingIndicator } from "@/ui/components/chat/typing-indicator";
import { parseSuggestions } from "@/ui/lib/helpers";
import { computeSqlFailureDedup } from "@/ui/lib/sql-failure-dedup";

interface CellOutputProps {
  assistantMessage: UIMessage | null;
  status: CellStatus;
  collapsed: boolean;
  previousExecution?: PreviousExecution;
}

export function NotebookCellOutput({ assistantMessage, status, collapsed, previousExecution }: CellOutputProps) {
  if (status === "running" && !assistantMessage) {
    return <TypingIndicator />;
  }

  if (!assistantMessage) {
    return (
      <p className="text-xs italic text-zinc-400 dark:text-zinc-500">
        No output yet
      </p>
    );
  }

  if (collapsed) {
    const preview = assistantMessage.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => parseSuggestions(p.text).text)
      .join(" ")
      .slice(0, 120);

    return (
      <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
        {preview || "Tool output"}
        {preview.length >= 120 && "..."}
      </p>
    );
  }

  const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(assistantMessage.parts);

  return (
    <div className="space-y-2 border-l-2 border-primary/40 pl-4 text-sm">
      {assistantMessage.parts.map((part, i) => {
        if (skipFailureIndex.has(i)) return null;
        if (part.type === "text") {
          const displayText = parseSuggestions(part.text).text;
          return <Markdown key={i} content={displayText} />;
        }
        if (isToolUIPart(part)) {
          return (
            <ToolPart
              key={i}
              part={part}
              previousExecution={previousExecution}
              repeatedCount={failureRuns.get(i)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
