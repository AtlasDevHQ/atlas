/**
 * Effect.ts foundation for Atlas.
 *
 * Re-exports tagged error types, the Hono bridge, and Effect services
 * so consumers can import from a single entry point:
 *
 * ```ts
 * import { runEffect, EmptyQueryError, ConnectionRegistry } from "@atlas/api/lib/effect";
 * ```
 */

export {
  // SQL validation
  EmptyQueryError,
  ForbiddenPatternError,
  ParseError,
  WhitelistError,
  // Connection
  ConnectionNotFoundError,
  PoolExhaustedError,
  NoDatasourceError,
  // Query execution
  QueryTimeoutError,
  QueryExecutionError,
  // Rate limiting
  RateLimitExceededError,
  ConcurrencyLimitError,
  // RLS
  RLSError,
  // Enterprise
  EnterpriseGateError,
  ApprovalRequiredError,
  // Plugin
  PluginRejectedError,
  CustomValidatorError,
  // Action
  ActionTimeoutError,
  // Scheduler
  SchedulerTaskTimeoutError,
  SchedulerExecutionError,
  DeliveryError,
  // Union type
  type AtlasError,
  type AtlasErrorTag,
} from "./errors";

export { runEffect, runHandler, mapTaggedError, type DomainErrorMapping, type RunEffectOptions } from "./hono";

// ── Effect Services (P4+) ───────────────────────────────────────────

export {
  ConnectionRegistry,
  ConnectionRegistryLive,
  makeConnectionRegistryLive,
  createTestLayer,
  type ConnectionRegistryShape,
  // Plugin Registry (P5)
  PluginRegistry,
  PluginRegistryLive,
  makePluginRegistryLive,
  makeWiredPluginRegistryLive,
  createPluginTestLayer,
  type PluginRegistryShape,
  type PluginWiringConfig,
  // Request + Auth Context (P8)
  RequestContext,
  makeRequestContextLayer,
  createRequestContextTestLayer,
  AuthContext,
  makeAuthContextLayer,
  createAuthContextTestLayer,
  type RequestContextShape,
  type AuthContextShape,
} from "./services";

// ── Startup Layers (P6) ─────────────────────────────────────────────

export {
  Telemetry,
  TelemetryLive,
  Config,
  ConfigLive,
  Migration,
  MigrationLive,
  SemanticSync,
  SemanticSyncLive,
  Settings,
  SettingsLive,
  Scheduler as SchedulerService,
  Scheduler,
  makeSchedulerLive,
  buildAppLayer,
  type TelemetryShape,
  type ConfigShape,
  type MigrationShape,
  type SemanticSyncShape,
  type SettingsShape,
  type SchedulerShape,
} from "./layers";

// ── AI Model Service (P10a) ─────────────────────────────────────────

export {
  AtlasAiModel,
  AtlasAiModelLive,
  makeWorkspaceAiModelLayer,
  createAiModelTestLayer,
  type AtlasAiModelShape,
} from "./ai";
