/**
 * Shared types for Atlas UI.
 *
 * All types are canonical from @useatlas/types — no local duplication.
 */

import type { ShareMode } from "@useatlas/types";

export { AUTH_MODES, DB_TYPES, CHAT_ERROR_CODES, CLIENT_ERROR_CODES } from "@useatlas/types";
export type {
  AuthMode,
  MessageRole,
  Surface,
  Conversation,
  Message,
  ConversationWithMessages,
  ShareLink,
  ShareMode,
  ShareExpiryKey,
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
  ClientErrorCode,
  Dimension,
  Join,
  Measure,
  QueryPattern,
  SemanticEntitySummary,
  SemanticEntityDetail,
  EntityData,
  ActionApprovalMode,
  ActionLogEntry,
  ActionStatus,
  RollbackInfo,
} from "@useatlas/types";
export { SHARE_MODES, SHARE_EXPIRY_OPTIONS } from "@useatlas/types";
export { authErrorMessage, parseChatError, classifyClientError } from "@useatlas/types/errors";

// --- Web-only types (not in @useatlas/types) ---

export type ShareStatus =
  | { shared: false }
  | { shared: true; token: string; url: string; expiresAt: string | null; shareMode: ShareMode };
