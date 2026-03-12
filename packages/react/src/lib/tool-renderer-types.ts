import type { ComponentType } from "react";

/** Props passed to custom tool renderers. */
export interface ToolRendererProps<T = unknown> {
  /** Name of the tool being rendered. */
  toolName: string;
  /** Input arguments passed to the tool invocation. */
  args: Record<string, unknown>;
  /** Tool output. For built-in tools, `null` while the tool is still running. */
  result: T;
  /** Whether the tool invocation is still in progress. */
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Known tool result types                                            */
/* ------------------------------------------------------------------ */

/** Result shape from the executeSQL tool. Subset covering fields most useful for rendering. */
export type SQLToolResult =
  | {
      success: true;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated?: boolean;
      explanation?: string;
      row_count?: number;
    }
  | {
      success: false;
      error: string;
    };

/** Result shape from the explore tool (semantic layer exploration output). */
export type ExploreToolResult = string;

/** Result shape from the executePython tool. */
export type PythonToolResult =
  | {
      success: true;
      output?: string;
      explanation?: string;
      table?: { columns: string[]; rows: unknown[][] };
      charts?: { base64: string; mimeType: "image/png" }[];
      rechartsCharts?: {
        type: "line" | "bar" | "pie";
        data: Record<string, unknown>[];
        categoryKey: string;
        valueKeys: string[];
      }[];
    }
  | {
      success: false;
      error: string;
      output?: string;
    };

/* ------------------------------------------------------------------ */
/*  Tool renderers map                                                 */
/* ------------------------------------------------------------------ */

/**
 * Map of tool names to custom renderer components.
 *
 * Known tool names (executeSQL, explore, executePython) get typed result generics.
 * Arbitrary tool names are also supported via the index signature with `unknown` result type.
 *
 * Custom renderers take precedence over built-in defaults, including the action approval UI.
 */
export type ToolRenderers = {
  executeSQL?: ComponentType<ToolRendererProps<SQLToolResult | null>>;
  explore?: ComponentType<ToolRendererProps<ExploreToolResult | null>>;
  executePython?: ComponentType<ToolRendererProps<PythonToolResult | null>>;
} & {
  [toolName: string]: ComponentType<ToolRendererProps> | undefined;
};
