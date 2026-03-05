/**
 * Runtime plugin registry for Atlas.
 *
 * Manages plugin lifecycle: registration → initialization → health checks → teardown.
 * Uses a structural `PluginLike` interface defined locally so `@atlas/api` does not
 * depend on `@useatlas/plugin-sdk`.
 */

import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("plugins");

// ---------------------------------------------------------------------------
// Structural interfaces (no import from @useatlas/plugin-sdk)
// ---------------------------------------------------------------------------

export interface PluginHealthResult {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}

export type PluginType = "datasource" | "context" | "interaction" | "action" | "sandbox";
export type PluginStatus = "registered" | "initializing" | "healthy" | "unhealthy" | "teardown";

/**
 * Structural plugin context (mirrors AtlasPluginContext from the SDK).
 * Built at boot time from Atlas internals, passed to initialize().
 */
export interface PluginContextLike {
  db: { query(sql: string, params?: unknown[]): Promise<unknown>; execute(sql: string, params?: unknown[]): Promise<void> } | null;
  connections: { get(id: string): unknown; list(): string[] };
  tools: { register(tool: { name: string; description: string; tool: unknown }): void };
  logger: Record<string, unknown>;
  config: Record<string, unknown>;
}

/**
 * Structural interface matching AtlasPlugin from the SDK. The registry
 * accepts any object satisfying this shape — no hard dependency on the SDK.
 */
export interface PluginLike {
  readonly id: string;
  readonly type: PluginType;
  readonly version: string;
  readonly name?: string;
  initialize?(ctx: PluginContextLike): Promise<void>;
  healthCheck?(): Promise<PluginHealthResult>;
  teardown?(): Promise<void>;
  // Additional properties from specific plugin types are accessed via
  // type-narrowing in wiring.ts using structural checks.
  readonly [key: string]: unknown;
}

interface PluginEntry {
  plugin: PluginLike;
  status: PluginStatus;
}

export interface PluginDescription {
  id: string;
  type: PluginType;
  version: string;
  name: string;
  status: PluginStatus;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private entries: PluginEntry[] = [];
  private idSet = new Set<string>();
  private initialized = false;

  register(plugin: PluginLike): void {
    if (!plugin.id || !plugin.id.trim()) {
      throw new Error("Plugin id must not be empty");
    }
    if (this.idSet.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already registered`);
    }
    this.idSet.add(plugin.id);
    this.entries.push({ plugin, status: "registered" });
    log.info({ pluginId: plugin.id, type: plugin.type }, "Plugin registered");
  }

  /**
   * Initialize all registered plugins sequentially. Each plugin's
   * `initialize(ctx)` receives the Atlas context (db, connections, tools,
   * logger, config). Plugins without an `initialize` method are marked
   * healthy immediately. Failures set "unhealthy" + log — they don't crash.
   */
  async initializeAll(ctx: PluginContextLike): Promise<{ succeeded: string[]; failed: string[] }> {
    if (this.initialized) {
      throw new Error("Plugins already initialized — initializeAll() cannot be called twice");
    }
    this.initialized = true;

    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const entry of this.entries) {
      entry.status = "initializing";
      if (!entry.plugin.initialize) {
        entry.status = "healthy";
        succeeded.push(entry.plugin.id);
        continue;
      }
      try {
        const pluginCtx = {
          ...ctx,
          logger: typeof (ctx.logger as Record<string, unknown>)?.child === "function"
            ? (ctx.logger as { child(bindings: Record<string, unknown>): unknown }).child({ pluginId: entry.plugin.id })
            : ctx.logger,
        };
        await entry.plugin.initialize(pluginCtx as PluginContextLike);
        entry.status = "healthy";
        succeeded.push(entry.plugin.id);
        log.info({ pluginId: entry.plugin.id }, "Plugin initialized");
      } catch (err) {
        entry.status = "unhealthy";
        failed.push(entry.plugin.id);
        log.error(
          { pluginId: entry.plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
          "Plugin initialization failed",
        );
      }
    }

    return { succeeded, failed };
  }

  /**
   * Run health checks on all registered plugins. Returns a map of plugin id
   * to health result with current status. Catches exceptions from probes.
   */
  async healthCheckAll(): Promise<Map<string, PluginHealthResult & { status: PluginStatus }>> {
    const results = new Map<string, PluginHealthResult & { status: PluginStatus }>();

    for (const entry of this.entries) {
      if (!entry.plugin.healthCheck) {
        results.set(entry.plugin.id, { healthy: entry.status === "healthy", status: entry.status });
        continue;
      }
      try {
        const result = await entry.plugin.healthCheck();
        entry.status = result.healthy ? "healthy" : "unhealthy";
        results.set(entry.plugin.id, { ...result, status: entry.status });
      } catch (err) {
        entry.status = "unhealthy";
        results.set(entry.plugin.id, {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          status: entry.status,
        });
      }
    }

    return results;
  }

  /**
   * Tear down all plugins in reverse registration order (LIFO).
   * Catches and logs errors — teardown continues for remaining plugins.
   */
  async teardownAll(): Promise<void> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      entry.status = "teardown";
      if (!entry.plugin.teardown) continue;
      try {
        await entry.plugin.teardown();
        log.info({ pluginId: entry.plugin.id }, "Plugin torn down");
      } catch (err) {
        log.error(
          { pluginId: entry.plugin.id, err: err instanceof Error ? err : new Error(String(err)) },
          "Plugin teardown failed",
        );
      }
    }
  }

  get(id: string): PluginLike | undefined {
    return this.entries.find((e) => e.plugin.id === id)?.plugin;
  }

  getStatus(id: string): PluginStatus | undefined {
    return this.entries.find((e) => e.plugin.id === id)?.status;
  }

  /** Return plugins of the given type that are currently healthy. */
  getByType(type: PluginType): PluginLike[] {
    return this.entries
      .filter((e) => e.plugin.type === type && e.status === "healthy")
      .map((e) => e.plugin);
  }

  /** Return all healthy plugins regardless of type (for cross-cutting hooks). */
  getAllHealthy(): PluginLike[] {
    return this.entries
      .filter((e) => e.status === "healthy")
      .map((e) => e.plugin);
  }

  /** Return metadata for all registered plugins. */
  describe(): PluginDescription[] {
    return this.entries.map((e) => ({
      id: e.plugin.id,
      type: e.plugin.type,
      version: e.plugin.version,
      name: e.plugin.name ?? e.plugin.id,
      status: e.status,
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  /** Reset registry state. For testing only. */
  _reset(): void {
    this.entries = [];
    this.idSet.clear();
    this.initialized = false;
  }
}

/** Global singleton. */
export const plugins = new PluginRegistry();
