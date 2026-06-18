/**
 * Standalone Hono server entry point.
 *
 * Run with: bun run dev:api (from repo root)
 *
 * This enables headless API deployment without Next.js — useful for
 * Slack bots, CLI tools, SDK consumers, or any non-browser client.
 *
 * On startup, loads `atlas.config.ts` (if present) and wires datasources
 * into the ConnectionRegistry. When no config file exists, the existing
 * env-var behavior is preserved.
 *
 * Effect migration (P6):
 * Server boot expressed as an Effect Layer DAG. Startup validation runs
 * eagerly during Layer construction. Shutdown is automatic via Scope
 * cleanup — no manual SIGTERM handler ordering.
 */

import { Effect, ManagedRuntime } from "effect";
import { app } from "./index";
import { createLogger } from "@atlas/api/lib/logger";
import { initializeConfig } from "@atlas/api/lib/config";
import { connections } from "@atlas/api/lib/db/connection";
import { getWhitelistedTablesStrict } from "@atlas/api/lib/semantic";
import { closeInternalDB } from "@atlas/api/lib/db/internal";
import { type PluginContextLike } from "@atlas/api/lib/plugins/registry";
import { buildAppLayer } from "@atlas/api/lib/effect/layers";
import type { PluginWiringConfig } from "@atlas/api/lib/effect/services";

const log = createLogger("server");

const port = Number(process.env.PORT ?? 3001);

if (!Number.isFinite(port) || port < 0 || port > 65535) {
  log.error({ raw: process.env.PORT }, "Invalid PORT — must be 0–65535");
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "Unhandled rejection");
});

process.on("uncaughtException", (err) => {
  log.error({ err }, "Uncaught exception");
});

// ── Config + Plugin wiring (imperative, pre-Layer) ──────────────────
// Config and plugin wiring stay imperative because they produce the
// config object that the Layer DAG needs as input.

const config = await initializeConfig().catch((err) => {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Config initialization failed — check your atlas.config.ts",
  );
  process.exit(1);
});

// Build the plugin-wiring INPUTS the Layer DAG needs (only when config contains
// plugins). #3743 — registration / plugin-schema-migration / initialize / wiring
// (datasources, actions + tool-shadow check, MCP tools, context, interactions,
// cache backend) and the post-wiring `loadPluginSettings`/bootstrap + pool warmup
// now ALL run INSIDE the DAG via `makeWiredPluginRegistryLive` + `AuthBootstrapLive`
// + `PoolWarmupLive`. The wired layer depends on `Migration` (and `ConnectionRegistry`)
// at the TYPE LEVEL, so a plugin `initialize()` can never run before core migrations
// — the #3741 race is now unrepresentable, not just avoided by call placement.
// This block only constructs the context object + tool registry the DAG consumes.
let pluginWiring: PluginWiringConfig | undefined;
if (config.plugins?.length) {
  const { connections } = await import("@atlas/api/lib/db/connection");
  const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");
  const { hasInternalDB, internalQuery, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );
  const { getLogger } = await import("@atlas/api/lib/logger");

  // The plugin tool registry is shared between `context.tools.register` (plugins
  // register tools during `initialize`) and the wired layer's action wiring +
  // tool-shadow check — pass the SAME instance to both via `pluginWiring`.
  const pluginToolRegistry = new ToolRegistry();

  const pluginContext: PluginContextLike = {
    db: hasInternalDB()
      ? {
          async query(sql: string, params?: unknown[]) {
            const rows = await internalQuery(sql, params);
            return { rows };
          },
          async execute(sql: string, params?: unknown[]) {
            const pool = getInternalDB();
            await pool.query(sql, params);
          },
        }
      : null,
    connections: {
      // Plugins operate on the bare registry by their own connection id — there
      // is no querying-workspace context here to scope by, so this stays a bare
      // `get` (unlike the per-(workspace, install_id) read paths in the agent
      // tools — #3109). Plugin-managed pools register on the bare map anyway.
      get: (id: string) => connections.get(id),
      list: () => connections.list(),
      // Semantic-layer object names for a connection — the per-object
      // membership whitelist for plugin query tools (SOQL / ES Query DSL).
      // Self-host / static datasource mode: filesystem-backed, the same source
      // `executeSQL` validates against, so a plugin's bespoke tool honors the
      // identical boundary as the SQL path (#3307).
      //
      // Uses the STRICT accessor: it THROWS `SemanticLayerScanError` when the
      // whitelist is empty because a semantic-layer directory scan FAILED
      // (#3243), so a plugin tool fails CLOSED instead of dropping to
      // structural-only (which would silently widen access on a scan failure).
      // A legitimately-unconfigured layer still returns `[]` → structural-only
      // (#3313). The bespoke tools catch the throw and return a clean refusal.
      tables: (id: string) => Array.from(getWhitelistedTablesStrict(id)),
    },
    tools: {
      register: (tool) =>
        pluginToolRegistry.register(
          tool as Parameters<typeof pluginToolRegistry.register>[0],
        ),
    },
    logger: getLogger() as unknown as Record<string, unknown>,
    config: config as unknown as Record<string, unknown>,
  };

  pluginWiring = {
    plugins: config.plugins as unknown as PluginWiringConfig["plugins"],
    context: pluginContext,
    app: app as unknown as PluginWiringConfig["app"],
    toolRegistry: pluginToolRegistry,
    // Plugin schema migrations — run by the wired layer BEFORE initialize() so
    // plugins can use their tables. #3681 — migrations are isolated per plugin:
    // a single plugin's bad DDL no longer fails the Layer / `exit(1)`s the
    // replica. The failed plugin is marked unhealthy (so `initializeAll` skips
    // it and it never dispatches against tables that were never created) and
    // boot continues with the healthy plugins.
    runMigrations: async (allPlugins) => {
      const pluginsWithSchema = allPlugins.filter((p) => p.schema != null);
      if (pluginsWithSchema.length === 0) return;
      if (!hasInternalDB()) {
        log.error(
          { plugins: pluginsWithSchema.map((p) => p.id) },
          "Plugins declare schema but DATABASE_URL is not set — plugin tables will not be created",
        );
        return;
      }
      const { runPluginMigrations } = await import(
        "@atlas/api/lib/plugins/migrate"
      );
      const { plugins } = await import("@atlas/api/lib/plugins/registry");
      // Spread to a mutable array — `runPluginMigrations` takes `PluginLike[]`
      // and the wired layer hands us a `ReadonlyArray`.
      const migrationResult = await runPluginMigrations(getInternalDB(), [...allPlugins]);
      if (migrationResult.applied.length > 0) {
        log.info(
          { applied: migrationResult.applied },
          "Plugin schema migrations applied",
        );
      }
      if (migrationResult.failed.length > 0) {
        for (const { pluginId, error } of migrationResult.failed) {
          if (!plugins.markUnhealthy(pluginId, `schema migration failed: ${error}`)) {
            // The migration reported a plugin id the registry never registered
            // — markUnhealthy no-op'd, so initializeAll will NOT skip it and the
            // plugin could initialize/dispatch against tables that were never
            // created (the exact #3681 regression). Surface the contradiction
            // loudly rather than letting it pass silently.
            log.error(
              { pluginId },
              "Migration reported a failed plugin id not present in the registry — it may still initialize against missing tables",
            );
          }
        }
        log.error(
          { failed: migrationResult.failed },
          "Some plugin schema migrations failed — those plugins are marked unhealthy and skipped; boot continues with the rest",
        );
      }
    },
  };
}

// ── Effect Layer DAG (P6) ───────────────────────────────────────────
// All startup steps — telemetry, CORE migrations, plugin register/init/wire,
// connections hydrate, post-migration bootstrap, pool warmup, semantic sync,
// settings, schedulers, boot guards — run as an Effect Layer DAG. The type-level
// dependency edges enforce ordering (notably Migration → plugin init). Shutdown
// is automatic via Scope finalizers (plugin teardown included).

const appLayer = buildAppLayer(config, pluginWiring);
const runtime = ManagedRuntime.make(appLayer);

// Eagerly boot the Layer DAG — startup errors surface here, not on first request.
await Effect.runPromise(runtime.runtimeEffect).catch((err) => {
  log.error(
    { err: err instanceof Error ? err : new Error(String(err)) },
    "Server startup failed — Layer DAG could not initialize",
  );
  process.exit(1);
});

// ── HTTP Server ─────────────────────────────────────────────────────

const server = Bun.serve({
  port,
  fetch: app.fetch,
  // Bun's default idleTimeout is 10s — too short for SSE/streaming responses.
  // Agent runs can take 60-90s with gaps >10s between stream writes (LLM thinking,
  // tool execution). Setting to 0 disables the idle timeout entirely.
  idleTimeout: 0,
});

// ── Graceful shutdown ───────────────────────────────────────────────
// Effect runtime disposal tears down scoped Layers via their finalizers.
// We also clean up the imperative singletons (connections, internal DB).

async function shutdown(signal: string) {
  log.info({ signal }, "Graceful shutdown initiated");

  try {
    server.stop();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to stop HTTP server",
    );
  }

  // Dispose the Effect runtime — tears down schedulers, telemetry AND plugin
  // lifecycle via finalizers. #3743 — plugin `teardownAll()` is now the wired
  // PluginRegistry layer's scope finalizer (no longer an imperative call here).
  // The 10s timeout that previously guarded the imperative plugin teardown now
  // guards the whole disposal so a hung plugin teardown can't wedge shutdown.
  const disposeTimeout = setTimeout(() => {
    log.error(
      "Runtime disposal (incl. plugin teardown) timed out after 10s — forcing exit",
    );
    process.exit(1);
  }, 10_000);
  disposeTimeout.unref();
  try {
    await runtime.dispose();
    log.info("Effect runtime disposed (schedulers, plugins, telemetry torn down)");
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Effect runtime disposal failed",
    );
  } finally {
    clearTimeout(disposeTimeout);
  }

  // Imperative singleton cleanup. The global `connections` registry is
  // lifecycle-unmanaged by the DAG (#3743 — `manageLifecycle: false`), so its
  // shutdown stays here.
  try {
    await connections.shutdown();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to shut down connections",
    );
  }

  try {
    await closeInternalDB();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to close internal DB",
    );
  }

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () =>
  shutdown("SIGTERM").catch((err) => {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Shutdown handler failed",
    );
    process.exit(1);
  }),
);
process.on("SIGINT", () =>
  shutdown("SIGINT").catch((err) => {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Shutdown handler failed",
    );
    process.exit(1);
  }),
);

log.info({ port }, "Atlas API server starting");

export default server;
