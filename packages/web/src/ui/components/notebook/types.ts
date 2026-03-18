import type { UIMessage } from "@ai-sdk/react";

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
  version: 1;
}

/** A cell with its resolved user + assistant messages attached. */
export interface ResolvedCell extends NotebookCell {
  userMessage: UIMessage;
  assistantMessage: UIMessage | null;
}
