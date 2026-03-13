/**
 * @useatlas/sdk — TypeScript SDK for the Atlas API.
 *
 * @example
 * ```ts
 * import { createAtlasClient } from "@useatlas/sdk";
 *
 * const atlas = createAtlasClient({
 *   baseUrl: "https://api.example.com",
 *   apiKey: "my-key",
 * });
 *
 * const result = await atlas.query("How many users signed up last week?");
 * ```
 */
export {
  createAtlasClient,
  AtlasError,
  type AtlasErrorCode,
  type AtlasClient,
  type AtlasClientOptions,
  type QueryOptions,
  type QueryResponse,
  type Conversation,
  type Message,
  type ConversationWithMessages,
  type ListConversationsResponse,
  type ListConversationsOptions,
  type ChatMessage,
  type ChatOptions,
  type ShareConversationResponse,
  type StreamEvent,
  type StreamFinishReason,
  type StreamQueryOptions,
  type DeliveryChannel,
  type Recipient,
  type ScheduledTaskRecipient,
  type ScheduledTask,
  type ScheduledTaskWithRuns,
  type ScheduledTaskRun,
  type ListScheduledTasksResponse,
  type ListScheduledTasksOptions,
  type CreateScheduledTaskInput,
  type UpdateScheduledTaskInput,
  type DBType,
  type HealthStatus,
  type ConnectionHealth,
  type ConnectionInfo,
  type ConnectionDetail,
  type ConnectionHealthCheck,
  type PluginType,
  type PluginStatus,
  type AuthMode,
  type AdminOverview,
  type EntitySummary,
  type SemanticStats,
  type AuditLogEntry,
  type AuditLogResponse,
  type AuditLogOptions,
  type AuditStats,
  type PluginInfo,
  type PluginHealthCheckResponse,
  type RunStatus,
  type ActionApprovalMode,
} from "./client";
