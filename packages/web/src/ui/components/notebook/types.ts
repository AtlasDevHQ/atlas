import type { UIMessage } from "@ai-sdk/react";
import type { ForkBranchWire } from "@/ui/lib/types";

export type CellStatus = "idle" | "running" | "error";
export type CellType = "query" | "text";

export interface NotebookCell {
  id: string;
  /** Message ID for query cells; empty string for text cells. */
  messageId: string;
  number: number;
  collapsed: boolean;
  editing: boolean;
  status: CellStatus;
  /** Cell type — undefined treated as "query" for backwards compatibility. */
  type?: CellType;
  /** Markdown content for text cells. */
  content?: string;
}

export interface NotebookState {
  conversationId: string;
  cells: NotebookCell[];
  version: 1 | 2 | 3;
  cellOrder?: string[];
}

/** A cell with its resolved messages attached. For query cells, these are real conversation messages; for text cells, userMessage is synthetic and assistantMessage is always null. */
export interface ResolvedCell extends NotebookCell {
  userMessage: UIMessage;
  assistantMessage: UIMessage | null;
}

/** Fork info passed to UI for branch display. */
export interface ForkInfo {
  rootId: string;
  currentId: string;
  branches: ForkBranchWire[];
}
