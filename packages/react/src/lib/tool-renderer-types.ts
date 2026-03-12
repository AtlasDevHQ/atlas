import type { ComponentType } from "react";

/** Props passed to custom tool renderers. */
export interface ToolRendererProps<T = unknown> {
  /** Name of the tool being rendered. */
  toolName: string;
  /** Input arguments passed to the tool invocation. */
  args: Record<string, unknown>;
  /** Tool output. `null` while the tool is still running. */
  result: T;
  /** Whether the tool invocation is still in progress. */
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Known tool result types                                            */
/* ------------------------------------------------------------------ */

/** Result shape from the executeSQL tool. */
export interface SQLToolResult {
  success: boolean;
  columns?: string[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  error?: string;
}

/** Result shape from the explore tool (shell command output). */
export type ExploreToolResult = string;

/** Result shape from the executePython tool. */
export interface PythonToolResult {
  success: boolean;
  output?: string;
  error?: string;
  table?: { columns: string[]; rows: unknown[][] };
  charts?: { base64: string; mimeType: "image/png" }[];
  rechartsCharts?: {
    type: string;
    data: Record<string, unknown>[];
    categoryKey: string;
    valueKeys: string[];
  }[];
}

/* ------------------------------------------------------------------ */
/*  Tool renderers map                                                 */
/* ------------------------------------------------------------------ */

/** Map of tool names to custom renderer components. */
export interface ToolRenderers {
  executeSQL?: ComponentType<ToolRendererProps<SQLToolResult | null>>;
  explore?: ComponentType<ToolRendererProps<ExploreToolResult | null>>;
  executePython?: ComponentType<ToolRendererProps<PythonToolResult | null>>;
  [toolName: string]: ComponentType<ToolRendererProps> | undefined;
}
