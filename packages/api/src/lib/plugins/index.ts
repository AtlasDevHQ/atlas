/**
 * Plugin system — public API from @atlas/api.
 */

export { plugins, PluginRegistry } from "./registry";
export type { PluginLike, PluginContextLike, PluginHealthResult, PluginType, PluginStatus, PluginDescription } from "./registry";
export { wireDatasourcePlugins, wireActionPlugins, wireInteractionPlugins, wireContextPlugins, wireSandboxPlugins } from "./wiring";
export type { SandboxExecBackend } from "./wiring";
export { generateMigrationSQL, generateColumnMigrations, applyMigrations, runPluginMigrations, ensureMigrationsTable, getAppliedMigrations, diffSchema, prefixTableName } from "./migrate";
export type { MigrateDB, MigrationStatement, SchemaDiff } from "./migrate";
export { dispatchHook } from "./hooks";
export { getPluginTools, setPluginTools, getContextFragments, setContextFragments } from "./tools";
