/**
 * Shared types for Atlas UI.
 *
 * All types are canonical from @useatlas/types — no local duplication.
 */

export { AUTH_MODES, DB_TYPES, CHAT_ERROR_CODES } from "@useatlas/types";
export type {
  AuthMode,
  MessageRole,
  Surface,
  Conversation,
  Message,
  ConversationWithMessages,
  ShareLink,
  DeliveryChannel,
  DeliveryStatus,
  Recipient,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskWithRuns,
  ScheduledTaskRunWithTaskName,
  DBType,
  HealthStatus,
  ConnectionHealth,
  ConnectionInfo,
  ConnectionDetail,
  ChatErrorCode,
  ChatErrorInfo,
  Dimension,
  Join,
  Measure,
  QueryPattern,
  SemanticEntitySummary,
  SemanticEntityDetail,
  EntityData,
  ActionApprovalMode,
} from "@useatlas/types";
export { authErrorMessage, parseChatError } from "@useatlas/types/errors";

// --- Web-only types (not in @useatlas/types) ---

export type ShareStatus =
  | { shared: false }
  | { shared: true; token: string; url: string; expiresAt: string | null };
