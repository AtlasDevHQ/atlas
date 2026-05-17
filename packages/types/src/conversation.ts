/** Conversation persistence types — wire format for conversations and messages. */

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type Surface = "web" | "api" | "mcp" | "slack" | "notebook";

/**
 * Three-state cross-environment routing picker for a conversation (#2518):
 *
 *   - `"auto"` — agent's `scope` decides per turn. Default for new
 *     conversations created via the picker's Auto mode.
 *   - `"pin"` — force single-env execution against the conversation's
 *     stored `connectionId`; the agent's `scope` override is ignored.
 *   - `"all"` — force fanout across every member of the active group;
 *     the agent's `scope` override is ignored.
 *
 * `null` on a persisted row is read as `"pin"` (back-compat — pre-#2518
 * rows carry a non-null `connectionId` and the safest interpretation
 * is "stay pinned to that member").
 */
export type ConversationRoutingMode = "auto" | "pin" | "all";

export interface Conversation {
  id: string;
  userId: string | null;
  title: string | null;
  surface: Surface;
  /**
   * Execution target — the specific connection (replica) SQL runs
   * against. May be overridden per-turn by the chat header without
   * persisting back to this column.
   */
  connectionId: string | null;
  /**
   * Content scope — the connection group whose semantic entities,
   * dashboards, and approvals resolve for this conversation. Independent
   * of `connectionId`: a multi-member "prod" group can resolve content
   * while `connectionId` points at a single member. Nullable for legacy
   * conversations created before the multi-environment slice (#2345);
   * runtime falls back to single-connection behavior in that case.
   */
  connectionGroupId: string | null;
  /**
   * Three-state Auto/Pin/All picker state (#2518). `null` on existing
   * rows is read as `"pin"` by the runtime — pre-#2518 conversations
   * carry a single `connectionId` and the safest interpretation is
   * "stay pinned to that member". New conversations created via the
   * Auto picker mode persist `"auto"`; explicit Pin / All selections
   * persist their literal values.
   *
   * Optional in the type so pre-#2518 test fixtures and external
   * SDK consumers can construct a `Conversation` without supplying
   * the field; the runtime treats missing the same as `null`.
   */
  routingMode?: ConversationRoutingMode | null;
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
  /** Legacy bridge — always equal to `toolCallId`. Some UI components read this field. */
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

/** Type predicate that narrows Message to user/assistant roles. */
function isRenderable(m: Message): m is Message & { role: "user" | "assistant" } {
  return m.role === "user" || m.role === "assistant";
}

/** Type guard for valid content part objects (filters out null, primitives, nested arrays). */
function isContentPart(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Converts persisted `Message[]` into a UI-ready array.
 *
 * Filters to user/assistant messages, maps content parts to text and
 * dynamic-tool parts. The return type is structurally compatible with
 * `UIMessage` from `@ai-sdk/react`.
 */
export function transformMessages(messages: Message[]): TransformedMessage[] {
  return messages.filter(isRenderable).map((m) => {
    const parts: TransformedPart[] = Array.isArray(m.content)
      ? (m.content as unknown[])
          .filter(isContentPart)
          .filter((p) => p.type === "text" || p.type === "tool-invocation")
          .map((p, idx) => {
            if (p.type === "tool-invocation") {
              const toolCallId =
                typeof p.toolCallId === "string" && p.toolCallId
                  ? (p.toolCallId as string)
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
      : typeof m.content === "string"
        ? [{ type: "text" as const, text: m.content }]
        : [{ type: "text" as const, text: "" }];

    return { id: m.id, role: m.role, parts };
  });
}
