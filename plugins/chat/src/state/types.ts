/**
 * Chat SDK state adapter types.
 *
 * Re-exports Chat SDK's StateAdapter and Lock interfaces. Derives PluginDB
 * from the plugin-sdk's AtlasPluginContext to maintain a compile-time link.
 * Re-exports StateConfig from ../config as the single canonical definition.
 */

import type { AtlasPluginContext } from "@useatlas/plugin-sdk";

export type { StateAdapter, Lock } from "chat";

/**
 * Internal DB access — derived from AtlasPluginContext["db"].
 * Plugins must not import from @atlas/api; they receive this via context.
 */
export type PluginDB = NonNullable<AtlasPluginContext["db"]>;

// Re-export StateConfig as the single canonical config type
export type { StateConfig } from "../config";
