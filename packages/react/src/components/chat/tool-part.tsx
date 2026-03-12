"use client";

import { memo } from "react";
import { getToolName } from "ai";
import { getToolResult, isToolComplete } from "../../lib/helpers";
import { isActionToolResult } from "../../lib/action-types";
import { ExploreCard } from "./explore-card";
import { SQLResultCard } from "./sql-result-card";
import { ActionApprovalCard } from "../actions/action-approval-card";
import { PythonResultCard } from "./python-result-card";

export const ToolPart = memo(function ToolPart({ part }: { part: unknown }) {
  let name: string;
  try {
    name = getToolName(part as Parameters<typeof getToolName>[0]);
  } catch (err) {
    console.warn("Failed to determine tool name:", err);
    return (
      <div className="my-2 rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-400">
        Tool result (unknown type)
      </div>
    );
  }

  switch (name) {
    case "explore":
      return <ExploreCard part={part} />;
    case "executeSQL":
      return <SQLResultCard part={part} />;
    case "executePython":
      return <PythonResultCard part={part} />;
    default: {
      const result = getToolResult(part);
      if (isActionToolResult(result)) {
        return <ActionApprovalCard part={part} />;
      }
      return (
        <div className="my-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
          Tool: {name}
        </div>
      );
    }
  }
}, (prev, next) => {
  // Once a tool part is complete, its output won't change — skip re-renders.
  // This prevents the Recharts render tree from contributing to React's update depth limit.
  if (isToolComplete(prev.part) && isToolComplete(next.part)) return true;
  return false;
});
