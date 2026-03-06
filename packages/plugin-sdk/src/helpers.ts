/**
 * Plugin SDK helpers — factory function, createPlugin, and type guards.
 */

import type {
  AtlasPlugin,
  AtlasPluginBase,
  AtlasDatasourcePlugin,
  AtlasContextPlugin,
  AtlasInteractionPlugin,
  AtlasActionPlugin,
  AtlasSandboxPlugin,
} from "./types";

const VALID_TYPES: Set<string> = new Set(["datasource", "context", "interaction", "action", "sandbox"]);

/**
 * Validate a plugin object's required fields and variant-specific structure.
 * Used by both definePlugin and createPlugin.
 *
 * @throws {Error} When required fields are missing or variant-specific structure is invalid.
 */
function validatePluginShape(plugin: AtlasPlugin): void {
  if (!plugin.id || !plugin.id.trim()) {
    throw new Error("Plugin id must not be empty");
  }
  if (!plugin.version || !plugin.version.trim()) {
    throw new Error("Plugin version must not be empty");
  }
  if (!VALID_TYPES.has(plugin.type)) {
    throw new Error(`Invalid plugin type "${plugin.type}" — must be one of: datasource, context, interaction, action, sandbox`);
  }

  // Variant-specific structural checks
  if (plugin.type === "datasource") {
    const ds = plugin as AtlasDatasourcePlugin;
    if (!ds.connection || typeof ds.connection !== "object") {
      throw new Error('Datasource plugin must have a "connection" property');
    }
    if (typeof ds.connection.create !== "function") {
      throw new Error('Datasource plugin connection must have a "create()" factory function');
    }
    if (ds.entities !== undefined && !Array.isArray(ds.entities) && typeof ds.entities !== "function") {
      throw new Error('Datasource plugin "entities" must be an array or a function');
    }
    if (Array.isArray(ds.entities)) {
      for (const e of ds.entities) {
        if (!e || typeof e !== "object" || typeof (e as Record<string, unknown>).name !== "string" || typeof (e as Record<string, unknown>).yaml !== "string") {
          throw new Error('Each entity in "entities" must have string "name" and "yaml" fields');
        }
      }
    }
    if (ds.connection.validate !== undefined && typeof ds.connection.validate !== "function") {
      throw new Error('Datasource plugin connection "validate" must be a function');
    }
    if (ds.connection.parserDialect !== undefined && (typeof ds.connection.parserDialect !== "string" || !ds.connection.parserDialect.trim())) {
      throw new Error('Datasource plugin connection "parserDialect" must be a non-empty string');
    }
    if (ds.connection.forbiddenPatterns !== undefined) {
      if (!Array.isArray(ds.connection.forbiddenPatterns)) {
        throw new Error('Datasource plugin connection "forbiddenPatterns" must be an array of RegExp');
      }
      for (const p of ds.connection.forbiddenPatterns) {
        if (!(p instanceof RegExp)) {
          throw new Error('Each entry in "forbiddenPatterns" must be a RegExp');
        }
      }
    }
    if (ds.dialect !== undefined && (typeof ds.dialect !== "string" || !ds.dialect.trim())) {
      throw new Error('Datasource plugin "dialect" must be a non-empty string');
    }
  }
  if (plugin.type === "context") {
    const ctx = plugin as AtlasContextPlugin;
    if (!ctx.contextProvider || typeof ctx.contextProvider !== "object") {
      throw new Error('Context plugin must have a "contextProvider" property');
    }
  }
  if (plugin.type === "interaction") {
    const int = plugin as AtlasInteractionPlugin;
    if (int.routes !== undefined && typeof int.routes !== "function") {
      throw new Error('Interaction plugin "routes" must be a function when provided');
    }
  }
  if (plugin.type === "action") {
    const act = plugin as AtlasActionPlugin;
    if (!Array.isArray(act.actions)) {
      throw new Error('Action plugin must have an "actions" array');
    }
  }
  if (plugin.type === "sandbox") {
    const sb = plugin as AtlasSandboxPlugin;
    if (!sb.sandbox || typeof sb.sandbox !== "object") {
      throw new Error('Sandbox plugin must have a "sandbox" property');
    }
    if (typeof sb.sandbox.create !== "function") {
      throw new Error('Sandbox plugin sandbox must have a "create()" factory function');
    }
    if (sb.sandbox.priority !== undefined && (typeof sb.sandbox.priority !== "number" || isNaN(sb.sandbox.priority))) {
      throw new Error('Sandbox plugin "priority" must be a number');
    }
  }
}

/**
 * Identity-style factory for type inference and runtime validation when
 * authoring plugins. Validates required fields and variant-specific properties.
 *
 * For plugins that need typed configuration, use {@link createPlugin} instead.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "@useatlas/plugin-sdk";
 *
 * export default definePlugin({
 *   id: "my-datasource",
 *   type: "datasource",
 *   version: "1.0.0",
 *   connection: {
 *     create: () => myDBConnection,
 *     dbType: "postgres",
 *   },
 * });
 * ```
 */
export function definePlugin<T extends AtlasPlugin>(plugin: T): T {
  validatePluginShape(plugin);
  return plugin;
}

// ---------------------------------------------------------------------------
// createPlugin — typed config factory (Better Auth pattern)
// ---------------------------------------------------------------------------

/**
 * Options for {@link createPlugin}. The `create` function receives the
 * validated config and returns the plugin object.
 */
export interface CreatePluginOptions<TConfig, TPlugin extends AtlasPluginBase<TConfig>> {
  /**
   * Any object with a `parse(input)` method (e.g. a Zod schema) for validating
   * plugin configuration. Must throw on invalid input. Called at factory
   * invocation time so invalid config fails fast during `bun run dev` startup.
   */
  configSchema: { parse(input: unknown): TConfig };
  /** Build the plugin from validated config. */
  create(config: TConfig): TPlugin;
}

/**
 * Factory pattern for plugins that need typed configuration. Follows
 * Better Auth's `plugins: [myPlugin({ key: "value" })]` convention.
 *
 * The returned function validates config via the provided schema at call
 * time, then delegates to `create()` to build the plugin object.
 *
 * @throws The returned factory throws when config fails schema validation
 *   or when the created plugin fails structural validation (missing id,
 *   version, or variant-specific properties).
 *
 * @example
 * ```typescript
 * // bigquery-plugin.ts
 * import { createPlugin } from "@useatlas/plugin-sdk";
 * import { z } from "zod";
 *
 * export const bigqueryPlugin = createPlugin({
 *   configSchema: z.object({
 *     projectId: z.string(),
 *     dataset: z.string(),
 *   }),
 *   create: (config) => ({
 *     id: "bigquery",
 *     type: "datasource" as const,
 *     version: "1.0.0",
 *     config,
 *     connection: {
 *       create: () => makeBQConnection(config.projectId, config.dataset),
 *       dbType: "bigquery",
 *     },
 *   }),
 * });
 *
 * // atlas.config.ts
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { bigqueryPlugin } from "./bigquery-plugin";
 *
 * export default defineConfig({
 *   plugins: [bigqueryPlugin({ projectId: "my-proj", dataset: "analytics" })],
 * });
 * ```
 */
export function createPlugin<TConfig, TPlugin extends AtlasPluginBase<TConfig>>(
  options: CreatePluginOptions<TConfig, TPlugin>,
): (config: TConfig) => TPlugin {
  return (rawConfig: TConfig) => {
    let config: TConfig;
    try {
      config = options.configSchema.parse(rawConfig);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin config validation failed: ${detail}`, { cause: err });
    }

    let plugin: TPlugin;
    try {
      plugin = options.create(config);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin create() failed: ${detail}`, { cause: err });
    }

    validatePluginShape(plugin as unknown as AtlasPlugin);
    return plugin;
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isDatasourcePlugin(
  plugin: AtlasPlugin,
): plugin is AtlasDatasourcePlugin {
  return plugin.type === "datasource";
}

export function isContextPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasContextPlugin {
  return plugin.type === "context";
}

export function isInteractionPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasInteractionPlugin {
  return plugin.type === "interaction";
}

export function isActionPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasActionPlugin {
  return plugin.type === "action";
}

export function isSandboxPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasSandboxPlugin {
  return plugin.type === "sandbox";
}
