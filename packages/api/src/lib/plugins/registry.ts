/**
 * Runtime plugin registry for Atlas.
 *
 * Manages plugin lifecycle: registration → initialization → health checks → teardown.
 * Uses a structural `PluginLike` interface defined locally so `@atlas/api` does not
 * depend on `@useatlas/plugin-sdk`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";

const log = createLogger("plugins");

// ---------------------------------------------------------------------------
// Cached-liveness TTL for /health (#3201)
// ---------------------------------------------------------------------------

/**
 * Default TTL (ms) for the cached plugin-liveness snapshot served to `/health`.
 *
 * `/health` is public + unauthenticated and probes every credential-backed
 * plugin on each request (jira → /myself, salesforce connection probe, email
 * → Resend /domains, twenty → /rest/open-api/core). A monitor poll loop or a
 * request burst would otherwise amplify into N live upstream calls per request.
 * A short TTL collapses repeats onto a single probe while staying fresh enough
 * to surface a newly-unhealthy plugin within ~15s.
 */
const DEFAULT_PLUGIN_HEALTH_CACHE_TTL_MS = 15_000;

/** Upper bound — caps accidental over-staleness from a fat-fingered env value. */
const MAX_PLUGIN_HEALTH_CACHE_TTL_MS = 300_000;

let lastWarnedHealthTtl: string | undefined;

/**
 * Resolve the plugin-liveness cache TTL (ms) from
 * `ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS`. Falls back to the 15s default on an
 * absent / unparseable / out-of-range value. `0` is valid and disables
 * caching (every call re-probes upstream).
 */
export function getPluginHealthCacheTtlMs(): number {
  const raw = process.env.ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_PLUGIN_HEALTH_CACHE_TTL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PLUGIN_HEALTH_CACHE_TTL_MS) {
    if (raw !== lastWarnedHealthTtl) {
      log.warn(
        { value: raw },
        `Invalid ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS; using default ${DEFAULT_PLUGIN_HEALTH_CACHE_TTL_MS}ms`,
      );
      lastWarnedHealthTtl = raw;
    }
    return DEFAULT_PLUGIN_HEALTH_CACHE_TTL_MS;
  }
  return n;
}

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

/** Per-plugin liveness keyed by plugin id — the shape `healthCheckAll` returns. */
export type PluginHealthSnapshot = Map<
  string,
  PluginHealthResult & { status: PluginStatus }
>;

/**
 * Serializable config field description for admin UI form generation.
 * Structural mirror of ConfigSchemaField from `@useatlas/plugin-sdk`.
 */
export interface ConfigSchemaField {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  label?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  options?: string[];
  default?: unknown;
}

/**
 * Structural plugin context (mirrors AtlasPluginContext from the SDK).
 * Built at boot time from Atlas internals, passed to initialize().
 */
export interface PluginContextLike {
  db: { query(sql: string, params?: unknown[]): Promise<unknown>; execute(sql: string, params?: unknown[]): Promise<void> } | null;
  connections: { get(id: string): unknown; list(): string[]; tables(id: string): readonly string[] };
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
  /** Plugin type(s). A plugin can implement multiple types. */
  readonly types: readonly PluginType[];
  readonly version: string;
  readonly name?: string;
  readonly config?: unknown;
  initialize?(ctx: PluginContextLike): Promise<void>;
  healthCheck?(): Promise<PluginHealthResult>;
  teardown?(): Promise<void>;
  getConfigSchema?(): ConfigSchemaField[];
  // Additional properties from specific plugin types are accessed via
  // type-narrowing in wiring.ts using structural checks.
  readonly [key: string]: unknown;
}

interface PluginEntry {
  plugin: PluginLike;
  status: PluginStatus;
  enabled: boolean;
}

export interface PluginDescription {
  id: string;
  types: readonly PluginType[];
  version: string;
  name: string;
  status: PluginStatus;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private entries: PluginEntry[] = [];
  private idSet = new Set<string>();
  private initialized = false;

  // ── Cached plugin liveness for /health (#3201) ─────────────────────────
  // The public, unauthenticated `/health` route calls `healthCheckAllCached`
  // (not `healthCheckAll`) so a monitor poll loop / request burst collapses
  // onto a single upstream probe per TTL window instead of fanning out N
  // external calls per request. The route's cheap in-process checks (DB
  // SELECT 1, etc.) stay live — only the credential-backed plugin probes are
  // cached here.
  private healthSnapshot: { at: number; result: PluginHealthSnapshot } | null =
    null;
  private healthSnapshotInFlight: Promise<PluginHealthSnapshot> | null = null;

  // `register` is intentionally not span-wrapped: synchronous, sub-millisecond
  // array push. A span here would dwarf its own measurement and clutter every
  // plugin boot trace. `init` / `teardown` / `healthCheckAll` are wrapped
  // because they may run async work (DB pools, external services) where slow
  // paths are worth observing.
  register(plugin: PluginLike): void {
    if (!plugin.id || !plugin.id.trim()) {
      throw new Error("Plugin id must not be empty");
    }
    if (this.idSet.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already registered`);
    }
    this.idSet.add(plugin.id);
    this.entries.push({ plugin, status: "registered", enabled: true });
    log.info({ pluginId: plugin.id, types: plugin.types }, "Plugin registered");
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
        await withSpan(
          "atlas.plugin.init",
          { "atlas.plugin_id": entry.plugin.id },
          () => entry.plugin.initialize!(pluginCtx as PluginContextLike),
        );
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
   *
   * Always probes live — every credential-backed plugin's upstream is hit.
   * The unauthenticated `/health` route must call `healthCheckAllCached`
   * instead so repeated polls don't amplify into N external calls per request.
   */
  async healthCheckAll(): Promise<PluginHealthSnapshot> {
    return withSpan(
      "atlas.plugin.healthCheckAll",
      { "atlas.plugin_count": this.entries.length },
      async () => {
        const results: PluginHealthSnapshot = new Map();

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
      },
    );
  }

  /**
   * Like {@link healthCheckAll}, but serves a cached snapshot while the
   * previous probe is younger than `ttlMs` (default
   * `ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS`, 15s). Built for the public,
   * unauthenticated `/health` route: it bounds upstream fan-out so a monitor
   * poll loop or request burst triggers each credential-backed plugin probe
   * at most once per TTL window.
   *
   * - Concurrent callers during an in-flight probe share that probe rather
   *   than each spawning their own (request coalescing).
   * - Unhealthy results are cached verbatim — caching never converts a failing
   *   probe into a healthy one, so an unhealthy plugin still surfaces.
   * - A probe that rejects is NOT cached: the rejection propagates (so the
   *   caller can surface `degraded`) and the next call re-probes. Any prior
   *   snapshot is left untouched rather than being clobbered by the failure.
   * - `ttlMs === 0` disables caching (every call re-probes).
   */
  async healthCheckAllCached(
    ttlMs: number = getPluginHealthCacheTtlMs(),
  ): Promise<PluginHealthSnapshot> {
    const snapshot = this.healthSnapshot;
    if (snapshot && Date.now() - snapshot.at < ttlMs) {
      return snapshot.result;
    }
    if (this.healthSnapshotInFlight) {
      return this.healthSnapshotInFlight;
    }

    const inFlight = this.healthCheckAll()
      .then((result) => {
        this.healthSnapshot = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.healthSnapshotInFlight = null;
      });
    this.healthSnapshotInFlight = inFlight;
    return inFlight;
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
        await withSpan(
          "atlas.plugin.teardown",
          { "atlas.plugin_id": entry.plugin.id },
          () => entry.plugin.teardown!(),
        );
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

  /** Return plugins whose types array includes the given type, are enabled, and are currently healthy. */
  getByType(type: PluginType): PluginLike[] {
    return this.entries
      .filter((e) => e.enabled && e.plugin.types.includes(type) && e.status === "healthy")
      .map((e) => e.plugin);
  }

  /** Return all registered plugins regardless of status or enabled state (for schema migrations at boot). */
  getAll(): PluginLike[] {
    return this.entries.map((e) => e.plugin);
  }

  /** Return all healthy and enabled plugins regardless of type (for cross-cutting hooks). */
  getAllHealthy(): PluginLike[] {
    return this.entries
      .filter((e) => e.enabled && e.status === "healthy")
      .map((e) => e.plugin);
  }

  /** Return metadata for all registered plugins. */
  describe(): PluginDescription[] {
    return this.entries.map((e) => ({
      id: e.plugin.id,
      types: e.plugin.types,
      version: e.plugin.version,
      name: e.plugin.name ?? e.plugin.id,
      status: e.status,
      enabled: e.enabled,
    }));
  }

  /** Enable a plugin so it participates in agent execution. */
  enable(id: string): boolean {
    const entry = this.entries.find((e) => e.plugin.id === id);
    if (!entry) return false;
    if (entry.status === "teardown") {
      log.warn({ pluginId: id }, "Cannot enable plugin in teardown state");
      return false;
    }
    entry.enabled = true;
    log.info({ pluginId: id }, "Plugin enabled");
    return true;
  }

  /** Disable a plugin so it is skipped during agent execution. */
  disable(id: string): boolean {
    const entry = this.entries.find((e) => e.plugin.id === id);
    if (!entry) return false;
    if (entry.status === "teardown") {
      log.warn({ pluginId: id }, "Cannot disable plugin in teardown state");
      return false;
    }
    entry.enabled = false;
    log.info({ pluginId: id }, "Plugin disabled");
    return true;
  }

  /** Check whether a plugin is currently enabled. */
  isEnabled(id: string): boolean {
    const entry = this.entries.find((e) => e.plugin.id === id);
    return entry?.enabled ?? false;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * True once `initializeAll` has run. Boot paths that may run twice in
   * the same process (Hono server + in-process MCP server) check this
   * to skip re-init rather than throw.
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Reset registry state. For testing only. */
  _reset(): void {
    this.entries = [];
    this.idSet.clear();
    this.initialized = false;
    this.healthSnapshot = null;
    this.healthSnapshotInFlight = null;
  }
}

/** Global singleton. */
export const plugins = new PluginRegistry();
