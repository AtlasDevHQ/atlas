/**
 * Runtime plugin registry for Atlas.
 *
 * Manages plugin lifecycle: registration → initialization → health checks → teardown.
 * Uses a structural `PluginLike` interface defined locally so `@atlas/api` does not
 * depend on `@useatlas/plugin-sdk`.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
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
  // Platform-scoped settings registry (#3705): DB override > env > default.
  const raw = getSettingAuto("ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS");
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
  /**
   * Per-workspace uninstall hook (#3188). Structural mirror of the SDK's
   * `AtlasPluginBase.onUninstall`. Invoked by both uninstall paths (the
   * marketplace DELETE route and `WorkspaceInstaller.uninstall`) BEFORE
   * the install row + credential stores are removed, via
   * `lib/plugins/uninstall-hook.ts`. Best-effort: a throw is logged and
   * never aborts the uninstall.
   */
  onUninstall?(workspaceId: string): Promise<void> | void;
  getConfigSchema?(): ConfigSchemaField[];
  // Additional properties from specific plugin types are accessed via
  // type-narrowing in wiring.ts using structural checks.
  readonly [key: string]: unknown;
}

interface PluginEntry {
  plugin: PluginLike;
  status: PluginStatus;
  enabled: boolean;
  // #3681 — set by `markUnhealthy` when a boot-time schema migration failed.
  // Sticky: the periodic `healthCheckAll` loop must NOT re-probe such a plugin
  // and promote it back to "healthy". Its tables were never created, so a
  // `healthCheck()` that only validates an external upstream would otherwise
  // flip it healthy on the next tick, re-surface it via `getByType`, and let
  // it dispatch against missing relations — the exact failure this guards.
  migrationFailed?: boolean;
  migrationFailureReason?: string;
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
  // Captured at `initializeAll` so a single plugin can be torn down and
  // re-initialized at runtime (`refresh`) with the same Atlas context —
  // the operator-credential rebuild seam (#3704). Null until init has run.
  private lastInitContext: PluginContextLike | null = null;

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
    this.lastInitContext = ctx;

    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const entry of this.entries) {
      // #3681 — a plugin whose boot-time schema migration failed is marked
      // unhealthy before init. Skip it: its tables were never created, so
      // initializing (and later dispatching against) it would only surface
      // confusing "relation does not exist" errors. It stays unhealthy.
      if (entry.status === "unhealthy") {
        failed.push(entry.plugin.id);
        log.warn(
          { pluginId: entry.plugin.id },
          "Plugin already marked unhealthy (e.g. failed schema migration) — skipping initialization",
        );
        continue;
      }
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
          // #3681 — a plugin disabled by a failed boot-time schema migration
          // stays unhealthy permanently. Never re-probe it: a `healthCheck()`
          // that only validates an external upstream (not its own missing
          // tables) would otherwise flip it back to "healthy", re-surfacing it
          // for dispatch against relations that were never created.
          if (entry.migrationFailed) {
            results.set(entry.plugin.id, {
              healthy: false,
              ...(entry.migrationFailureReason ? { message: entry.migrationFailureReason } : {}),
              status: "unhealthy",
            });
            continue;
          }
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

  /**
   * Tear down and re-initialize a SINGLE plugin in place, reusing the Atlas
   * context captured at `initializeAll` (#3704 — the operator-credential
   * rebuild seam). This is the runtime "pick up rotated credentials with no
   * process restart" path: a plugin whose `initialize()` re-reads its
   * credential source (e.g. the chat plugin's `resolveAdapterEnv`) rebuilds
   * against the new values.
   *
   * Safe for the chat plugin specifically: its `teardown()` shuts down the
   * bridge + state adapter and resets its `initialized` flag, and its
   * `initialize()` rebuilds the bridge, the Chat SDK instance, and the webhook
   * handlers (the once-mounted routes read the live `bridge` closure), then
   * re-registers the proactive listener via the rebuilt bridge. The old Chat
   * SDK instance is shut down in `teardown()` before the rebuild.
   *
   * Returns a discriminated `{ ok }` result: `{ ok: true }` on success, or
   * `{ ok: false; reason }` on failure (so a caller narrowing on `ok` always
   * has a `reason`). A teardown error is logged but does not abort the re-init
   * (best-effort, mirrors `teardownAll`); an initialize error leaves the plugin
   * marked `unhealthy` and is surfaced. Never throws — callers (the Admin
   * route) map the result to an HTTP body.
   */
  async refresh(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const entry = this.entries.find((e) => e.plugin.id === id);
    if (!entry) {
      return { ok: false, reason: `Plugin "${id}" is not registered` };
    }
    if (!this.lastInitContext) {
      return { ok: false, reason: "Plugins have not been initialized yet — cannot refresh" };
    }
    const ctx = this.lastInitContext;

    return withSpan(
      "atlas.plugin.refresh",
      { "atlas.plugin_id": id },
      async () => {
        // Best-effort teardown — a failure here is logged, not fatal, so a
        // partially-broken old instance can't wedge the re-init.
        if (entry.plugin.teardown) {
          try {
            await entry.plugin.teardown();
          } catch (err) {
            log.error(
              { pluginId: id, err: err instanceof Error ? err : new Error(String(err)) },
              "Plugin teardown failed during refresh — continuing to re-initialize",
            );
          }
        }

        if (!entry.plugin.initialize) {
          entry.status = "healthy";
          return { ok: true };
        }

        entry.status = "initializing";
        try {
          const pluginCtx = {
            ...ctx,
            logger:
              typeof (ctx.logger as Record<string, unknown>)?.child === "function"
                ? (ctx.logger as { child(bindings: Record<string, unknown>): unknown }).child({
                    pluginId: id,
                  })
                : ctx.logger,
          };
          await entry.plugin.initialize(pluginCtx as PluginContextLike);
          entry.status = "healthy";
          // A successful re-init invalidates the cached /health snapshot so
          // the next probe reflects the rebuilt plugin rather than a stale
          // pre-refresh result.
          this.healthSnapshot = null;
          log.info({ pluginId: id }, "Plugin refreshed (teardown + re-initialize)");
          return { ok: true };
        } catch (err) {
          entry.status = "unhealthy";
          // Invalidate the cached /health snapshot on failure too: a
          // re-init that threw (e.g. a decrypt/corruption failure on a
          // rotated credential) leaves the plugin dead, and a stale
          // pre-refresh snapshot could otherwise keep reporting it healthy
          // to the public `/health` route for up to the TTL window.
          this.healthSnapshot = null;
          const reason = err instanceof Error ? err.message : String(err);
          log.error(
            { pluginId: id, err: err instanceof Error ? err : new Error(String(err)) },
            "Plugin re-initialization failed during refresh",
          );
          return { ok: false, reason };
        }
      },
    );
  }

  get(id: string): PluginLike | undefined {
    return this.entries.find((e) => e.plugin.id === id)?.plugin;
  }

  getStatus(id: string): PluginStatus | undefined {
    return this.entries.find((e) => e.plugin.id === id)?.status;
  }

  /**
   * Force a registered plugin into the "unhealthy" state. Used at boot when a
   * plugin's schema migration fails (#3681): the migration is isolated per
   * plugin so one bad DDL doesn't `exit(1)` the replica, but the plugin's
   * tables don't exist, so it must not be initialized or dispatched against.
   * `initializeAll` skips plugins already marked unhealthy. Returns false when
   * the id is unknown.
   */
  markUnhealthy(id: string, reason?: string): boolean {
    const entry = this.entries.find((e) => e.plugin.id === id);
    if (!entry) return false;
    entry.status = "unhealthy";
    // Sticky — see PluginEntry.migrationFailed. Keeps the health loop from
    // ever promoting a migration-failed plugin back to "healthy".
    entry.migrationFailed = true;
    if (reason) entry.migrationFailureReason = reason;
    log.warn({ pluginId: id, ...(reason ? { reason } : {}) }, "Plugin marked unhealthy");
    return true;
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
    this.lastInitContext = null;
    this.healthSnapshot = null;
    this.healthSnapshotInFlight = null;
  }
}

/** Global singleton. */
export const plugins = new PluginRegistry();
