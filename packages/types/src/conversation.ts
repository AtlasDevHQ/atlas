/** Conversation persistence types — wire format for conversations and messages. */

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type Surface = "web" | "api" | "mcp" | "slack" | "notebook";

export interface Conversation {
  id: string;
  userId: string | null;
  title: string | null;
  surface: Surface;
  connectionId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
  notebookState?: NotebookStateWire | null;
}

/** Server-persisted notebook state stored as JSONB on the conversation. */
export interface NotebookStateWire {
  version: number;
  /** Custom display order of cell IDs (empty = natural message order). */
  cellOrder?: string[];
  /** Per-cell persisted properties (collapsed + transient rerun comparison). */
  cellProps?: Record<string, {
    collapsed?: boolean;
    previousExecution?: { executionMs?: number; rowCount?: number };
  }>;
  /** Fork branches originating from this conversation (stored on root only). */
  branches?: ForkBranchWire[];
  /** If this conversation is a fork, the root conversation ID. */
  forkRootId?: string;
  /** If this conversation is a fork, the cell ID at the fork point. */
  forkPointCellId?: string;
  /** Text cell content keyed by cell ID (text cells are not message-backed). */
  textCells?: Record<string, { content: string }>;
  /** Tracks which notebook cells have been added to dashboards. */
  dashboardCards?: Record<string, { dashboardId: string; cardId: string }>;
}

/** A fork branch — metadata for a forked conversation. */
export interface ForkBranchWire {
  conversationId: string;
  forkPointCellId: string;
  label: string;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: unknown;
  createdAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}
