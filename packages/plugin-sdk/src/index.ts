/**
 * @useatlas/plugin-sdk — Public API for authoring Atlas plugins.
 *
 * Optional peer dependency re-exports are available via sub-paths:
 * - `@useatlas/plugin-sdk/ai` — `tool`, `jsonSchema`, `ToolSet`, `Tool`
 * - `@useatlas/plugin-sdk/hono` — `Hono`, `Context`, `MiddlewareHandler`
 */

export type {
  PluginQueryResult,
  PluginDBConnection,
  QueryValidationResult,
  PluginDBType,
  ParserDialect,
  PluginType,
  PluginStatus,
  PluginHealthResult,
  PluginLogger,
  AtlasPluginContext,
  PluginHookEntry,
  QueryHookContext,
  QueryHookMutation,
  AfterQueryHookContext,
  ExploreHookContext,
  ExploreHookMutation,
  AfterExploreHookContext,
  ToolCallSessionContext,
  ToolCallHookContext,
  AfterToolCallHookContext,
  ToolCallArgsMutation,
  ToolCallResultMutation,
  RequestHookContext,
  ResponseHookContext,
  PluginHooks,
  PluginFieldDefinition,
  PluginTableDefinition,
  AtlasPluginBase,
  PluginEntity,
  EntityProvider,
  PluginObjectType,
  PluginSemanticType,
  PluginForeignKeySource,
  PluginForeignKey,
  PluginTableFlags,
  PluginPartitionStrategy,
  PluginPartitionInfo,
  PluginColumnProfile,
  PluginTableProfile,
  PluginDatabaseObject,
  PluginProfileError,
  PluginProfilingResult,
  PluginProfileLogger,
  PluginProfileProgress,
  PluginListObjectsOptions,
  PluginProfileOptions,
  AtlasDatasourcePlugin,
  AtlasContextPlugin,
  AtlasInteractionPlugin,
  PluginAction,
  AtlasActionPlugin,
  PluginExecResult,
  PluginExploreBackend,
  PluginSandboxNetworkPolicy,
  PluginPythonChart,
  PluginRechartsChart,
  PluginPythonData,
  PluginPythonResult,
  PluginPythonProgressEvent,
  PluginPythonOptions,
  PluginPythonBackend,
  AtlasSandboxPlugin,
  ActionApprovalMode,
  ConfigSchemaField,
  AtlasPlugin,
  $InferServerPlugin,
  AtlasMcpTool,
  McpToolAnnotations,
  McpToolContext,
  McpToolAuditEntry,
  PluginZodSchema,
} from "./types";

export {
  SANDBOX_DEFAULT_PRIORITY,
  PLUGIN_PYTHON_RESULT_FILE_ENV,
  PLUGIN_PYTHON_CHART_DIR_ENV,
  PLUGIN_PYTHON_CHART_PATTERN,
} from "./types";

export {
  definePlugin,
  createPlugin,
  createDatasourcePlugin,
  isDatasourcePlugin,
  isContextPlugin,
  isInteractionPlugin,
  isActionPlugin,
  isSandboxPlugin,
  collectSemanticFiles,
  measuredHealthCheck,
  runHealthCheckWithTimeout,
} from "./helpers";

export type {
  CreatePluginOptions,
  CreateDatasourcePluginOptions,
  DatasourcePluginFactory,
  DatasourcePluginRuntime,
  CollectedSemanticFile,
  SandboxHelperLogger,
  HealthCheckTimeoutOptions,
} from "./helpers";

export { gateOnSemanticWhitelist, warnIfStructuralOnly } from "./semantic-whitelist";
export type { SemanticWhitelistSubject, SemanticWhitelistGate } from "./semantic-whitelist";

// ---------------------------------------------------------------------------
// Peer dependency type re-exports (type-only — erased at runtime, safe even
// when the optional peer deps are not installed)
// ---------------------------------------------------------------------------

export type { ToolSet, Tool } from "./ai";
export type { Context, MiddlewareHandler } from "./hono";

export {
  createFileTransportPythonBackend,
  directoryEntryNames,
  enforcePythonEgress,
  installPythonPackages,
  isNotFoundSdkError,
  shellQuote,
} from "./python-backend";

export type {
  EnforceablePythonEgress,
  PythonBackendAdapter,
  PythonBackendLogger,
  PythonSandboxRunResult,
  PythonSandboxSession,
} from "./python-backend";
