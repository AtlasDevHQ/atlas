/**
 * Plugin system — public API from @atlas/api.
 */

export { plugins, PluginRegistry } from "./registry";
export type { PluginLike, PluginContextLike, PluginHealthResult, PluginType, PluginStatus, PluginDescription } from "./registry";
export { wireDatasourcePlugins, wireActionPlugins, wireInteractionPlugins, wireContextPlugins } from "./wiring";
export { dispatchHook } from "./hooks";
export { getPluginTools, setPluginTools, getContextFragments, setContextFragments } from "./tools";
