/**
 * @useatlas/plugin-sdk — Public API for authoring Atlas plugins.
 *
 * Peer dependency re-exports are available via sub-paths:
 * - `@useatlas/plugin-sdk/ai` — `tool`, `jsonSchema`, `CoreTool`, `ToolSet`, `Tool`
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
  AtlasDatasourcePlugin,
  AtlasContextPlugin,
  AtlasInteractionPlugin,
  PluginAction,
  AtlasActionPlugin,
  PluginExecResult,
  PluginExploreBackend,
  AtlasSandboxPlugin,
  ActionApprovalMode,
  ConfigSchemaField,
  AtlasPlugin,
  $InferServerPlugin,
} from "./types";

export { SANDBOX_DEFAULT_PRIORITY } from "./types";

export {
  definePlugin,
  createPlugin,
  isDatasourcePlugin,
  isContextPlugin,
  isInteractionPlugin,
  isActionPlugin,
  isSandboxPlugin,
} from "./helpers";

export type { CreatePluginOptions } from "./helpers";

// ---------------------------------------------------------------------------
// Peer dependency re-exports (convenience — also available via sub-paths)
// ---------------------------------------------------------------------------

export { tool, jsonSchema } from "./ai";
export type { ToolSet, Tool } from "./ai";

export { Hono } from "./hono";
export type { Context, MiddlewareHandler } from "./hono";
