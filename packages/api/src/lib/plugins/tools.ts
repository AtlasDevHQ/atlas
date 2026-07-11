/**
 * Plugin bridge — stores plugin tool registry and context fragments for
 * use by the chat route and agent loop respectively.
 *
 * server.ts writes these at boot; chat.ts and agent.ts read them at runtime.
 */

import type { ToolRegistry } from "@atlas/api/lib/tools/registry";

let pluginToolRegistry: ToolRegistry | undefined;
let contextFragments: string[] = [];

export function setPluginTools(registry: ToolRegistry): void {
  pluginToolRegistry = registry;
}

export function getPluginTools(): ToolRegistry | undefined {
  return pluginToolRegistry;
}

export function setContextFragments(fragments: string[]): void {
  contextFragments = fragments;
}

export function getContextFragments(): string[] {
  return contextFragments;
}

import type { DialectHint } from "./wiring";
import type { PluginDialectModule } from "@atlas/api/lib/dialect-specialist";

let dialectHints: readonly DialectHint[] = [];

export function setDialectHints(hints: readonly DialectHint[]): void {
  dialectHints = hints;
}

export function getDialectHints(): readonly DialectHint[] {
  return dialectHints;
}

/**
 * Project the wired plugin dialect hints into the dbType-keyed
 * {@link PluginDialectModule} shape the dialect-specialist registry (#4515)
 * resolves against. One module per plugin hint — the registry's precedence
 * (plugin > core) and blank-body filtering apply at resolution time.
 */
export function pluginDialectModules(): readonly PluginDialectModule[] {
  return dialectHints.map((h) => ({ dbType: h.dbType, module: h.dialect }));
}
