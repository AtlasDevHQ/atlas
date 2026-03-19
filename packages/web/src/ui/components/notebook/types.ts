import type { UIMessage } from "@ai-sdk/react";
import type { ForkBranchWire } from "@/ui/lib/types";

export type CellStatus = "idle" | "running" | "error";

export interface NotebookCell {
  id: string;
  messageId: string;
  number: number;
  collapsed: boolean;
  editing: boolean;
  status: CellStatus;
}

export interface NotebookState {
  conversationId: string;
  cells: NotebookCell[];
  version: 1 | 2 | 3;
  cellOrder?: string[];
}

/** A cell with its resolved user + assistant messages attached. */
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
