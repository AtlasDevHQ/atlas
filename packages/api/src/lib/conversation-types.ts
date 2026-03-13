/**
 * Conversation persistence types for Atlas.
 */

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type Surface = "web" | "api" | "mcp" | "slack";
export type ShareMode = "public" | "org";

/** Valid share expiry duration keys sent by clients. */
export type ShareExpiry = "1h" | "24h" | "7d" | "30d" | "never";

/** Map expiry keys to milliseconds (null = never). */
export const SHARE_EXPIRY_MS: Record<ShareExpiry, number | null> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  never: null,
};

export interface Conversation {
  id: string;
  userId: string | null;
  title: string | null;
  surface: Surface;
  connectionId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
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
