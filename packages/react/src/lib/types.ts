/**
 * Shared types for Atlas UI.
 *
 * All types are canonical from @useatlas/types — no local duplication.
 */

export { AUTH_MODES, DB_TYPES, CHAT_ERROR_CODES, CLIENT_ERROR_CODES } from "@useatlas/types";
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
  ClientErrorCode,
  Dimension,
  Join,
  Measure,
  QueryPattern,
  SemanticEntitySummary,
  SemanticEntityDetail,
  EntityData,
} from "@useatlas/types";
export { authErrorMessage, parseChatError, classifyClientError } from "@useatlas/types/errors";
