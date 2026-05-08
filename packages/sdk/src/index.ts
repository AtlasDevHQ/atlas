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
  type ValidateSQLResponse,
  type ValidationLayer,
  type ActionStatus,
  type RollbackActionResponse,
  type ListTablesResponse,
  type TableInfo,
  type TableColumn,
  type StarterPrompt,
  type StarterPromptProvenance,
  type StarterPromptsResponse,
  type GetStarterPromptsOptions,
} from "./client";

export {
  fetchStarterPrompts,
  type FetchStarterPromptsConfig,
  type FetchStarterPromptsCredentials,
} from "./fetch-starter-prompts";

// ── MCP onboarding (#2079) ────────────────────────────────────────────
//
// Standalone helpers, also bound to `client.mcp.*` for the call shape
// `atlas.mcp.beginConnect(...)`. Importing only `createAtlasClient` does
// not pull these in unless the caller actually accesses `client.mcp`,
// since the client.ts re-export is a static import — bundlers tree-shake
// the unused functions away through the named-export graph.
export {
  AtlasMcpError,
  beginConnect,
  buildConfig,
  completeConnect,
  connectMachineToMachine,
  type AtlasMcpErrorCode,
  type BeginConnectOptions,
  type BeginConnectResult,
  type BuildConfigOptions,
  type CompleteConnectOptions,
  type CompleteConnectResult,
  type ConnectMachineToMachineOptions,
  type ConnectMachineToMachineResult,
  type ListAgentsResponse,
  type McpBareConfig,
  type McpClientConfig,
  type McpClientId,
  type McpHttpServer,
  type McpWrappedConfig,
  type RevokeAgentResponse,
} from "./mcp";
