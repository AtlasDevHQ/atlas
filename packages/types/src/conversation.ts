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
  /** Per-cell persisted properties (only collapsed; editing/status are transient). */
  cellProps?: Record<string, { collapsed?: boolean }>;
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

// ---------------------------------------------------------------------------
// transformMessages — converts persisted Message[] to UI-ready format
// ---------------------------------------------------------------------------

/** A text part in a transformed message. */
export interface TransformedTextPart {
  readonly type: "text";
  readonly text: string;
}

/** A tool invocation part in a transformed message. */
export interface TransformedToolPart {
  readonly type: "dynamic-tool";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInvocationId: string;
  readonly state: "output-available";
  readonly input: unknown;
  readonly output: unknown;
}

export type TransformedPart = TransformedTextPart | TransformedToolPart;

/** A UI-ready message produced by `transformMessages`. Structurally compatible with `UIMessage`. */
export interface TransformedMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly parts: TransformedPart[];
}

/**
 * Converts persisted `Message[]` into a UI-ready array.
 *
 * Filters to user/assistant messages, maps content parts to text and
 * dynamic-tool parts. The return type is structurally compatible with
 * `UIMessage` from `@ai-sdk/react`.
 */
export function transformMessages(messages: Message[]): TransformedMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const parts: TransformedPart[] = Array.isArray(m.content)
        ? (m.content as Record<string, unknown>[])
            .filter((p) => p.type === "text" || p.type === "tool-invocation")
            .map((p, idx) => {
              if (p.type === "tool-invocation") {
                const toolCallId =
                  typeof p.toolCallId === "string" && p.toolCallId
                    ? p.toolCallId
                    : `unknown-${idx}`;
                return {
                  type: "dynamic-tool" as const,
                  toolName:
                    typeof p.toolName === "string" ? p.toolName : "unknown",
                  toolCallId,
                  toolInvocationId: toolCallId,
                  state: "output-available" as const,
                  input: p.args,
                  output: p.result,
                };
              }
              return { type: "text" as const, text: String(p.text ?? "") };
            })
        : [{ type: "text" as const, text: String(m.content) }];

      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        parts,
      };
    });
}
