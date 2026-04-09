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
import { closeInternalDB } from "@atlas/api/lib/db/internal";
import {
  plugins,
  type PluginContextLike,
} from "@atlas/api/lib/plugins/registry";
import {
  wireDatasourcePlugins,
  wireActionPlugins,
  wireInteractionPlugins,
  wireContextPlugins,
} from "@atlas/api/lib/plugins/wiring";
import {
  setPluginTools,
  setContextFragments,
  setDialectHints,
} from "@atlas/api/lib/plugins/tools";
import { buildAppLayer } from "@atlas/api/lib/effect/layers";

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

// Register, initialize, and wire plugins (only when config contains plugins).
if (config.plugins?.length) {
  let registrationFailed = false;
  for (const raw of config.plugins) {
    try {
      plugins.register(raw as Parameters<typeof plugins.register>[0]);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Plugin registration failed",
      );
      registrationFailed = true;
    }
  }

  if (registrationFailed) {
    log.error(
      "Aborting startup — one or more plugins failed to register. Fix your atlas.config.ts plugins array.",
    );
    process.exit(1);
  }

  // Build plugin context — gives plugins typed access to Atlas internals
  const { connections } = await import("@atlas/api/lib/db/connection");
  const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");
  const { hasInternalDB, internalQuery, getInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );
  const { getLogger } = await import("@atlas/api/lib/logger");

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
      get: (id: string) => connections.get(id),
      list: () => connections.list(),
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

  // Run plugin schema migrations before initialize()
  const pluginsWithSchema = plugins.getAll().filter((p) => p.schema != null);
  if (pluginsWithSchema.length > 0) {
    if (hasInternalDB()) {
      try {
        const { runPluginMigrations } = await import(
          "@atlas/api/lib/plugins/migrate"
        );
        const migrationResult = await runPluginMigrations(
          getInternalDB(),
          plugins.getAll(),
        );
        if (migrationResult.applied.length > 0) {
          log.info(
            { applied: migrationResult.applied },
            "Plugin schema migrations applied",
          );
        }
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Plugin schema migration failed — aborting startup",
        );
        process.exit(1);
      }
    } else {
      log.error(
        { plugins: pluginsWithSchema.map((p) => p.id) },
        "Plugins declare schema but DATABASE_URL is not set — plugin tables will not be created",
      );
    }
  }

  const { succeeded, failed } = await plugins.initializeAll(pluginContext);
  if (failed.length > 0) {
    log.error(
      { succeeded, failed },
      `Plugin initialization completed with ${failed.length} failure(s)`,
    );
  } else {
    log.info({ succeeded }, "All plugins initialized successfully");
  }

  const dsResult = await wireDatasourcePlugins(plugins);
  if (dsResult.failed.length > 0) {
    log.error(
      { failed: dsResult.failed },
      "Some datasource plugins failed to wire",
    );
  }
  if (dsResult.entityFailures.length > 0) {
    log.error(
      { entityFailures: dsResult.entityFailures },
      "Some plugin entities failed to load",
    );
  }
  if (dsResult.dialectHints.length > 0) {
    setDialectHints(dsResult.dialectHints);
  }

  const actionResult = await wireActionPlugins(plugins, pluginToolRegistry);
  if (actionResult.failed.length > 0) {
    log.error(
      { failed: actionResult.failed },
      "Some action plugins failed to wire",
    );
  }

  if (pluginToolRegistry.size > 0) {
    pluginToolRegistry.freeze();
    setPluginTools(pluginToolRegistry);
  }

  const ctxResult = await wireContextPlugins(plugins);
  if (ctxResult.failed.length > 0) {
    log.error(
      { failed: ctxResult.failed },
      "Some context plugins failed to load",
    );
  }
  if (ctxResult.fragments.length > 0) {
    setContextFragments(ctxResult.fragments);
  }

  const intResult = await wireInteractionPlugins(plugins, app);
  if (intResult.failed.length > 0) {
    log.error(
      { failed: intResult.failed },
      "Some interaction plugins failed to wire",
    );
  }

  // Wire plugin cache backend if any plugin provides one
  for (const plugin of plugins.getAll()) {
    if (plugin.cacheBackend) {
      try {
        const { setCacheBackend } = await import(
          "@atlas/api/lib/cache/index"
        );
        setCacheBackend(
          plugin.cacheBackend as import("@atlas/api/lib/cache/index").CacheBackend,
        );
        log.info(
          { pluginId: plugin.id },
          "Plugin-provided cache backend registered",
        );
      } catch (err) {
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            pluginId: plugin.id,
          },
          "Failed to wire plugin cache backend — falling back to in-memory LRU",
        );
      }
      break;
    }
  }
}

// Pre-warm connection pools after all datasources (config + plugins) are registered.
await connections.warmup().catch((err) => {
  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "Pool warmup failed — datasource may be unreachable",
  );
});

// ── Effect Layer DAG (P6) ───────────────────────────────────────────
// Remaining startup steps (telemetry, migrations, semantic sync, settings,
// schedulers) run as an Effect Layer DAG. Shutdown is automatic via Scope.

const appLayer = buildAppLayer(config);
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

  // Dispose the Effect runtime — tears down schedulers, telemetry via finalizers
  try {
    await runtime.dispose();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Effect runtime disposal failed",
    );
  }

  // Teardown plugin lifecycle (still imperative pending full P5 wiring integration)
  if (config.plugins?.length) {
    const timeout = setTimeout(() => {
      log.error("Plugin teardown timed out after 10s — forcing exit");
      process.exit(1);
    }, 10_000);
    timeout.unref();
    try {
      await plugins.teardownAll();
      log.info("Plugin teardown complete");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Unexpected error during plugin teardown",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // Imperative singleton cleanup
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
