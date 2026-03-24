/**
 * Plugin wiring — bridges plugins into existing Atlas registries.
 *
 * Each function accepts DI params for testability. When registries are
 * omitted, the global singletons are used.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { PluginRegistry, PluginLike } from "./registry";
import type { ConnectionRegistry } from "@atlas/api/lib/db/connection";
import type { ToolRegistry, AtlasTool } from "@atlas/api/lib/tools/registry";

const log = createLogger("plugins:wiring");

// ---------------------------------------------------------------------------
// Structural checks for plugin subtypes (avoids SDK dependency)
// ---------------------------------------------------------------------------

interface ContextShape {
  contextProvider: {
    load(): Promise<string>;
    refresh?(): Promise<void>;
  };
}

interface DatasourceShape {
  connection: {
    create(): Promise<{ query(sql: string, timeoutMs?: number): Promise<unknown>; close(): Promise<void> }> | { query(sql: string, timeoutMs?: number): Promise<unknown>; close(): Promise<void> };
    dbType: string;
    validate?(query: string): { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;
    parserDialect?: string;
    forbiddenPatterns?: RegExp[];
  };
  entities?: unknown[] | (() => Promise<unknown[]> | unknown[]);
  dialect?: string;
}

interface ActionShape {
  actions: ReadonlyArray<{
    name: string;
    description: string;
    tool: unknown;
    actionType: string;
    reversible: boolean;
    defaultApproval: string;
    requiredCredentials: string[];
  }>;
}

interface InteractionShape {
  routes: (app: unknown) => void;
}

function hasContextProvider(p: PluginLike): p is PluginLike & ContextShape {
  return (
    p.types.includes("context") &&
    typeof (p as Record<string, unknown>).contextProvider === "object" &&
    (p as Record<string, unknown>).contextProvider !== null &&
    typeof ((p as Record<string, unknown>).contextProvider as Record<string, unknown>)?.load === "function"
  );
}

function hasDatasource(p: PluginLike): p is PluginLike & DatasourceShape {
  return (
    p.types.includes("datasource") &&
    typeof (p as Record<string, unknown>).connection === "object" &&
    (p as Record<string, unknown>).connection !== null
  );
}

function hasActions(p: PluginLike): p is PluginLike & ActionShape {
  return p.types.includes("action") && Array.isArray((p as Record<string, unknown>).actions);
}

function hasRoutes(p: PluginLike): p is PluginLike & InteractionShape {
  return p.types.includes("interaction") && typeof (p as Record<string, unknown>).routes === "function";
}

// ---------------------------------------------------------------------------
// Wiring functions
// ---------------------------------------------------------------------------

export interface DialectHint {
  readonly pluginId: string;
  readonly dialect: string;
}

/**
 * For each healthy datasource plugin, call `connection.create()` and register
 * the resulting DBConnection in the ConnectionRegistry. Also resolves
 * plugin-provided entities and collects dialect hints.
 */
export async function wireDatasourcePlugins(
  pluginRegistry: PluginRegistry,
  connectionRegistry?: ConnectionRegistry,
): Promise<{ wired: string[]; failed: Array<{ pluginId: string; error: string }>; dialectHints: DialectHint[]; entityFailures: Array<{ pluginId: string; error: string }> }> {
  const connRegistry = connectionRegistry ?? (await import("@atlas/api/lib/db/connection")).connections;
  const datasources = pluginRegistry.getByType("datasource");
  const wired: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];
  const dialectHints: DialectHint[] = [];
  const entityFailures: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of datasources) {
    if (!hasDatasource(plugin)) {
      log.warn({ pluginId: plugin.id }, "Datasource plugin missing connection property — skipped");
      continue;
    }
    try {
      const conn = await plugin.connection.create();
      const meta = (plugin.connection.parserDialect || plugin.connection.forbiddenPatterns)
        ? { parserDialect: plugin.connection.parserDialect, forbiddenPatterns: plugin.connection.forbiddenPatterns }
        : undefined;
      await connRegistry.registerDirect(
        plugin.id,
        conn as Parameters<ConnectionRegistry["registerDirect"]>[1],
        plugin.connection.dbType as Parameters<ConnectionRegistry["registerDirect"]>[2],
        plugin.name ?? plugin.id,
        plugin.connection.validate,
        meta,
      );
      wired.push(plugin.id);
      log.info({ pluginId: plugin.id, dbType: plugin.connection.dbType }, "Datasource plugin wired");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to wire datasource plugin",
      );
      continue;
    }

    // Resolve plugin-provided entities (in-memory, no disk writes)
    if (plugin.entities !== undefined) {
      try {
        const resolved = typeof plugin.entities === "function"
          ? await plugin.entities()
          : plugin.entities;
        if (resolved != null && !Array.isArray(resolved)) {
          const msg = `entities factory returned non-array (${typeof resolved})`;
          log.error({ pluginId: plugin.id, type: typeof resolved }, msg);
          entityFailures.push({ pluginId: plugin.id, error: msg });
        } else if (Array.isArray(resolved) && resolved.length === 0) {
          log.warn({ pluginId: plugin.id }, "Plugin entities factory returned empty array");
        } else if (Array.isArray(resolved) && resolved.length > 0) {
          // Validate per-element shape: must have string name and yaml
          const valid: Array<{ name: string; yaml: string }> = [];
          for (const el of resolved) {
            if (
              el != null &&
              typeof el === "object" &&
              typeof (el as Record<string, unknown>).name === "string" &&
              typeof (el as Record<string, unknown>).yaml === "string"
            ) {
              valid.push(el as { name: string; yaml: string });
            } else {
              log.error(
                { pluginId: plugin.id, element: el },
                "Invalid entity element — expected { name: string; yaml: string }, skipping",
              );
            }
          }
          if (valid.length > 0) {
            const { registerPluginEntities } = await import("@atlas/api/lib/semantic");
            registerPluginEntities(plugin.id, valid);
            log.info({ pluginId: plugin.id, entityCount: valid.length }, "Plugin entities registered");
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        entityFailures.push({ pluginId: plugin.id, error: msg });
        log.error(
          { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to resolve plugin entities — connection still wired",
        );
      }
    }

    // Collect dialect hints
    if (typeof plugin.dialect === "string" && plugin.dialect.trim()) {
      dialectHints.push({ pluginId: plugin.id, dialect: plugin.dialect });
    }
  }

  return { wired, failed, dialectHints, entityFailures };
}

/**
 * For each healthy action plugin, register each PluginAction as an AtlasTool
 * in the ToolRegistry.
 */
export async function wireActionPlugins(
  pluginRegistry: PluginRegistry,
  toolRegistry?: ToolRegistry,
): Promise<{ wired: string[]; failed: Array<{ pluginId: string; error: string }> }> {
  const registry = toolRegistry ?? (await import("@atlas/api/lib/tools/registry")).defaultRegistry;
  const actionPlugins = pluginRegistry.getByType("action");
  const wired: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of actionPlugins) {
    if (!hasActions(plugin)) {
      log.warn({ pluginId: plugin.id }, "Action plugin missing actions array — skipped");
      continue;
    }
    for (const action of plugin.actions) {
      try {
        registry.register(action as unknown as AtlasTool);
        wired.push(action.name);
        log.info({ pluginId: plugin.id, action: action.name }, "Action plugin tool wired");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ pluginId: plugin.id, error: msg });
        log.error(
          { pluginId: plugin.id, action: action.name, err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to wire action plugin tool",
        );
      }
    }
  }

  return { wired, failed };
}

/**
 * For each healthy interaction plugin, call `routes(app)` to mount Hono routes.
 */
export async function wireInteractionPlugins(
  pluginRegistry: PluginRegistry,
  app: unknown,
): Promise<{ wired: string[]; failed: Array<{ pluginId: string; error: string }> }> {
  const interactionPlugins = pluginRegistry.getByType("interaction");
  const wired: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of interactionPlugins) {
    if (!hasRoutes(plugin)) {
      log.debug({ pluginId: plugin.id }, "Interaction plugin has no routes — skipping route wiring");
      continue;
    }
    try {
      // Scope plugin routes under /api/plugins/:pluginId to prevent auth bypass
      const { Hono } = await import("hono");
      const subApp = new Hono();
      plugin.routes(subApp);
      (app as { route(path: string, app: unknown): void }).route(`/api/plugins/${plugin.id}`, subApp);
      wired.push(plugin.id);
      log.info({ pluginId: plugin.id, prefix: `/api/plugins/${plugin.id}` }, "Interaction plugin routes mounted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to wire interaction plugin routes",
      );
    }
  }

  return { wired, failed };
}

// ---------------------------------------------------------------------------
// Sandbox plugins
// ---------------------------------------------------------------------------

/**
 * Duplicated from @useatlas/plugin-sdk/types to avoid runtime SDK dependency.
 * Keep in sync — explore-sdk-compat.test.ts verifies structural equivalence.
 */
const SANDBOX_DEFAULT_PRIORITY = 60;

/**
 * Sandbox execution backend interface.
 * Canonical definition lives in backends/types.ts. Re-exported here for
 * backward compatibility with plugins that reference SandboxExecBackend.
 */
import type { ExploreBackend } from "@atlas/api/lib/tools/backends/types";
export type SandboxExecBackend = ExploreBackend;

interface SandboxShape {
  sandbox: {
    create(root: string): Promise<SandboxExecBackend> | SandboxExecBackend;
    priority?: number;
  };
}

function hasSandbox(p: PluginLike): p is PluginLike & SandboxShape {
  return (
    p.types.includes("sandbox") &&
    typeof (p as Record<string, unknown>).sandbox === "object" &&
    (p as Record<string, unknown>).sandbox !== null &&
    typeof ((p as Record<string, unknown>).sandbox as Record<string, unknown>)?.create === "function"
  );
}

/**
 * Discover sandbox plugins, sort by priority (highest first), and try to
 * create a backend from each until one succeeds.
 *
 * Unlike other wire functions, sandbox plugins are not registered into a
 * global registry — the caller receives a single backend instance directly.
 *
 * NOTE: In practice, called lazily from getExploreBackend() on the first
 * explore command (not at startup), because the explore backend is cached
 * as a singleton and depends on runtime environment detection.
 */
export async function wireSandboxPlugins(
  pluginRegistry: PluginRegistry,
  semanticRoot: string,
): Promise<{
  backend: SandboxExecBackend | null;
  pluginId: string | null;
  failed: Array<{ pluginId: string; error: string }>;
}> {
  const sandboxPlugins = pluginRegistry.getByType("sandbox");
  const failed: Array<{ pluginId: string; error: string }> = [];

  if (sandboxPlugins.length === 0) {
    return { backend: null, pluginId: null, failed };
  }

  // Filter to valid sandbox plugins, sort by priority descending
  const valid = sandboxPlugins.filter(hasSandbox);
  if (valid.length === 0) {
    for (const sp of sandboxPlugins) {
      log.warn({ pluginId: sp.id }, "Sandbox plugin missing sandbox.create() — skipped");
    }
    return { backend: null, pluginId: null, failed };
  }

  const sorted = [...valid].sort((a, b) => {
    const pa = a.sandbox.priority ?? SANDBOX_DEFAULT_PRIORITY;
    const pb = b.sandbox.priority ?? SANDBOX_DEFAULT_PRIORITY;
    return pb - pa;
  });

  for (const sp of sorted) {
    try {
      const backend = await sp.sandbox.create(semanticRoot);
      if (!backend || typeof backend.exec !== "function") {
        const msg = "create() returned invalid backend (missing exec method)";
        failed.push({ pluginId: sp.id, error: msg });
        log.error({ pluginId: sp.id }, msg);
        continue;
      }
      log.info({ pluginId: sp.id }, "Using sandbox plugin for explore backend");
      return { backend, pluginId: sp.id, failed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: sp.id, error: msg });
      log.error(
        { pluginId: sp.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Sandbox plugin create() failed, trying next",
      );
    }
  }

  log.error({ count: sorted.length }, "All sandbox plugins failed to create a backend");
  return { backend: null, pluginId: null, failed };
}

/**
 * For each healthy context plugin, call `contextProvider.load()` and collect
 * the returned text fragments. Fragments are injected into the agent system
 * prompt to provide additional context from plugins.
 */
export async function wireContextPlugins(
  pluginRegistry: PluginRegistry,
): Promise<{ fragments: string[]; failed: Array<{ pluginId: string; error: string }> }> {
  const contextPlugins = pluginRegistry.getByType("context");
  const fragments: string[] = [];
  const failed: Array<{ pluginId: string; error: string }> = [];

  for (const plugin of contextPlugins) {
    if (!hasContextProvider(plugin)) {
      log.warn({ pluginId: plugin.id }, "Context plugin missing contextProvider — skipped");
      continue;
    }
    try {
      const fragment = await plugin.contextProvider.load();
      if (fragment.trim()) {
        fragments.push(fragment);
      }
      log.info({ pluginId: plugin.id, fragmentLength: fragment.length }, "Context plugin loaded");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ pluginId: plugin.id, error: msg });
      log.error(
        { pluginId: plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to load context plugin",
      );
    }
  }

  return { fragments, failed };
}
