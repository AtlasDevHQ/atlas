/**
 * Plugin system — public API from @atlas/api.
 */

export { plugins, PluginRegistry } from "./registry";
export type { PluginLike, PluginContextLike, PluginHealthResult, PluginType, PluginStatus, PluginDescription, ConfigSchemaField } from "./registry";
export { wireDatasourcePlugins, wireActionPlugins, wireInteractionPlugins, wireContextPlugins, wireSandboxPlugins } from "./wiring";
export type { SandboxExecBackend } from "./wiring";
export { wireMcpToolPlugins, pluginMcpToolRegistry, PluginMcpToolRegistry, registerPluginMcpTools } from "./mcp-tools";
export type {
  AtlasMcpToolLike,
  RegisteredPluginMcpTool,
  McpToolContextShape,
  McpToolAuditEntry,
  ZodSchemaLike,
  WireMcpToolsResult,
  McpServerLike,
  McpCallToolResult,
  RegisterPluginMcpToolsOptions,
} from "./mcp-tools";
export { bootPluginsForMcp } from "./mcp-boot";
export { generateMigrationSQL, generateColumnMigrations, applyMigrations, runPluginMigrations, ensureMigrationsTable, getAppliedMigrations, diffSchema, prefixTableName } from "./migrate";
export type { MigrateDB, MigrationStatement, SchemaDiff } from "./migrate";
export { dispatchHook } from "./hooks";
export { getPluginTools, setPluginTools, getContextFragments, setContextFragments } from "./tools";
export { loadPluginSettings, savePluginEnabled, savePluginConfig, getPluginConfig, getAllPluginSettings } from "./settings";
export type { PluginSettings } from "./settings";
export { MASKED_PLACEHOLDER, maskSecretFields, restoreMaskedSecrets, parseConfigSchema } from "./secrets";
export type { ConfigSchema } from "./secrets";
