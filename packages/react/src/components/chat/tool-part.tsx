"use client";

import { Component, memo, type ReactNode, type ErrorInfo } from "react";
import { getToolName } from "ai";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";
import { isActionToolResult } from "../../lib/action-types";
import { ExploreCard } from "./explore-card";
import { SQLResultCard } from "./sql-result-card";
import { ActionApprovalCard } from "../actions/action-approval-card";
import { PythonResultCard } from "./python-result-card";
import type { ToolRenderers } from "../../lib/tool-renderer-types";

export interface ToolPartProps {
  part: unknown;
  toolRenderers?: ToolRenderers;
}

/** Error boundary that catches rendering failures in custom tool renderers. */
class ToolRendererErrorBoundary extends Component<
  { toolName: string; children: ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { toolName: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `Custom renderer for tool "${this.props.toolName}" failed:`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="my-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400">
          Custom renderer for &ldquo;{this.props.toolName}&rdquo; failed: {this.state.error?.message ?? "unknown error"}
        </div>
      );
    }
    return this.props.children;
  }
}

export const ToolPart = memo(function ToolPart({ part, toolRenderers }: ToolPartProps) {
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

  // Custom renderers take precedence over built-in defaults.
  // Note: this also overrides the ActionApprovalCard for action tools —
  // if you register a renderer for a tool that uses the action approval flow,
  // you are responsible for handling the approval UI yourself.
  const CustomRenderer = toolRenderers?.[name];
  if (CustomRenderer) {
    const args = getToolArgs(part);
    const result = getToolResult(part);
    const isLoading = !isToolComplete(part);
    return (
      <ToolRendererErrorBoundary toolName={name}>
        <CustomRenderer toolName={name} args={args} result={result} isLoading={isLoading} />
      </ToolRendererErrorBoundary>
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
  // Also check toolRenderers identity so swapping renderers at runtime triggers a re-render.
  if (isToolComplete(prev.part) && isToolComplete(next.part) && prev.toolRenderers === next.toolRenderers) return true;
  return false;
});
