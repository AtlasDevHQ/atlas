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
  DBType,
  HealthStatus,
  ConnectionHealth,
  ConnectionInfo,
  ChatErrorCode,
  ChatErrorInfo,
  Dimension,
  Join,
  Measure,
  QueryPattern,
  SemanticEntitySummary,
  SemanticEntityDetail,
  EntityData,
} from "@useatlas/types";
export { authErrorMessage, parseChatError } from "@useatlas/types/errors";
