"use client";

import type { UIMessage } from "@ai-sdk/react";
import { isToolUIPart } from "ai";
import type { CellStatus, PreviousExecution } from "./types";
import { AssistantTurn } from "@/ui/components/chat/assistant-turn";
import { FinishedTurn } from "@/ui/components/chat/finished-turn";
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

  // #4301 — finished cells render through the same partitioner + turn
  // components as the chat transcript (receipt → answer → promoted artifact),
  // so the two surfaces cannot drift in formatting. Only the actively-running
  // cell keeps the live part-by-part renderer below, mirroring the chat's
  // streaming-turn carve-out (#4298).
  if (status !== "running") {
    return (
      <AssistantTurn className="space-y-2 text-sm">
        <FinishedTurn parts={assistantMessage.parts} previousExecution={previousExecution} />
      </AssistantTurn>
    );
  }

  // Live path: while the agent retries the same SQL verbatim, fold identical
  // failures instead of stacking red blocks. Finished cells don't need this —
  // failures settle into the receipt, whose summary counts them. (An
  // all-failure turn starts with the receipt expanded, so the retries do
  // stack there — accepted: the "N failed" count labels the repetition, and
  // matching the chat surface exactly is the point of #4301.)
  const { failureRuns, skipFailureIndex } = computeSqlFailureDedup(assistantMessage.parts);

  return (
    <AssistantTurn className="space-y-2 text-sm">
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
    </AssistantTurn>
  );
}
