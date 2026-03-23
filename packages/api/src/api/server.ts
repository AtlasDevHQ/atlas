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
 */

// Initialize OpenTelemetry SDK before other imports that may create spans.
// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set — @opentelemetry/api
// returns no-op tracers (zero overhead).
// Buffers any init error and replays it through pino once the logger exists.
let _shutdownTelemetry: (() => Promise<void>) | null = null;
let _otelInitError: string | null = null;
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    const { shutdownTelemetry } = await import("@atlas/api/lib/telemetry");
    _shutdownTelemetry = shutdownTelemetry;
  } catch (err) {
    _otelInitError = err instanceof Error ? err.message : String(err);
  }
}

import { app } from "./index";
import { createLogger } from "@atlas/api/lib/logger";
import { initializeConfig } from "@atlas/api/lib/config";
import { migrateAuthTables } from "@atlas/api/lib/auth/migrate";
import { connections } from "@atlas/api/lib/db/connection";
import { closeInternalDB } from "@atlas/api/lib/db/internal";
import { plugins, type PluginContextLike } from "@atlas/api/lib/plugins/registry";
import { wireDatasourcePlugins, wireActionPlugins, wireInteractionPlugins, wireContextPlugins } from "@atlas/api/lib/plugins/wiring";
import { setPluginTools, setContextFragments, setDialectHints } from "@atlas/api/lib/plugins/tools";

const log = createLogger("server");

// Replay buffered OTel init error through the structured logger.
if (_otelInitError) {
  log.error({ err: new Error(_otelInitError) }, "Failed to initialize OpenTelemetry — tracing disabled for this process");
}

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

// Load atlas.config.ts (if present) and wire datasources/tools.
// Blocks startup so the server never serves requests with stale config.
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
    log.error("Aborting startup — one or more plugins failed to register. Fix your atlas.config.ts plugins array.");
    process.exit(1);
  }

  // Build plugin context — gives plugins typed access to Atlas internals
  // via dependency injection (db, connections, tools, logger, config).
  const { connections } = await import("@atlas/api/lib/db/connection");
  const { ToolRegistry } = await import("@atlas/api/lib/tools/registry");
  const { hasInternalDB, internalQuery, getInternalDB } = await import("@atlas/api/lib/db/internal");
  const { getLogger } = await import("@atlas/api/lib/logger");

  // Create an unfrozen registry for plugin tools
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
    connections: { get: (id: string) => connections.get(id), list: () => connections.list() },
    tools: { register: (tool) => pluginToolRegistry.register(tool as Parameters<typeof pluginToolRegistry.register>[0]) },
    logger: getLogger() as unknown as Record<string, unknown>,
    config: config as unknown as Record<string, unknown>,
  };

  // Run plugin schema migrations before initialize() so plugins can use
  // their tables in initialize(). Schema is declared at plugin creation
  // time, so it is readable before initialize() runs.
  const pluginsWithSchema = plugins.getAll().filter((p) => p.schema != null);
  if (pluginsWithSchema.length > 0) {
    if (hasInternalDB()) {
      try {
        const { runPluginMigrations } = await import("@atlas/api/lib/plugins/migrate");
        const migrationResult = await runPluginMigrations(getInternalDB(), plugins.getAll());
        if (migrationResult.applied.length > 0) {
          log.info({ applied: migrationResult.applied }, "Plugin schema migrations applied");
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
    log.error({ succeeded, failed }, `Plugin initialization completed with ${failed.length} failure(s)`);
  } else {
    log.info({ succeeded }, "All plugins initialized successfully");
  }

  const dsResult = await wireDatasourcePlugins(plugins);
  if (dsResult.failed.length > 0) {
    log.error({ failed: dsResult.failed }, "Some datasource plugins failed to wire");
  }
  if (dsResult.entityFailures.length > 0) {
    log.error({ entityFailures: dsResult.entityFailures }, "Some plugin entities failed to load");
  }
  if (dsResult.dialectHints.length > 0) {
    setDialectHints(dsResult.dialectHints);
  }

  const actionResult = await wireActionPlugins(plugins, pluginToolRegistry);
  if (actionResult.failed.length > 0) {
    log.error({ failed: actionResult.failed }, "Some action plugins failed to wire");
  }

  // Store plugin tools for chat route merging (if any tools were registered)
  if (pluginToolRegistry.size > 0) {
    pluginToolRegistry.freeze();
    setPluginTools(pluginToolRegistry);
  }

  const ctxResult = await wireContextPlugins(plugins);
  if (ctxResult.failed.length > 0) {
    log.error({ failed: ctxResult.failed }, "Some context plugins failed to load");
  }
  if (ctxResult.fragments.length > 0) {
    setContextFragments(ctxResult.fragments);
  }

  const intResult = await wireInteractionPlugins(plugins, app);
  if (intResult.failed.length > 0) {
    log.error({ failed: intResult.failed }, "Some interaction plugins failed to wire");
  }

  // Wire plugin cache backend if any plugin provides one
  for (const plugin of plugins.getAll()) {
    if (plugin.cacheBackend) {
      try {
        const { setCacheBackend } = await import("@atlas/api/lib/cache/index");
        setCacheBackend(plugin.cacheBackend as import("@atlas/api/lib/cache/index").CacheBackend);
        log.info({ pluginId: plugin.id }, "Plugin-provided cache backend registered");
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err), pluginId: plugin.id }, "Failed to wire plugin cache backend — falling back to in-memory LRU");
      }
      break;
    }
  }

  // Graceful shutdown: teardown plugins on SIGTERM
  process.on("SIGTERM", async () => {
    log.info("SIGTERM received — tearing down plugins");
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
    }
    process.exit(0);
  });
}

// Pre-warm connection pools after all datasources (config + plugins) are registered.
await connections.warmup().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Pool warmup failed — datasource may be unreachable");
});

// Run migrations once at boot — blocks until complete, but does not prevent startup on failure.
await migrateAuthTables().catch((err) => {
  log.error({ err: err instanceof Error ? err : new Error(String(err)) }, "Boot migration failed");
});

// Reconcile org semantic layer directories from DB.
// Ensures persistent org dirs exist on disk for the explore tool after
// restart, disk loss, or new deployment. Non-blocking — errors logged internally.
import { reconcileAllOrgs } from "@atlas/api/lib/semantic-sync";
await reconcileAllOrgs();

// Load settings overrides from internal DB into in-process cache.
// loadSettings() handles errors internally (logs + falls back to env vars).
import { loadSettings } from "@atlas/api/lib/settings";
await loadSettings();

// Start scheduler if configured with "bun" backend
if (config.scheduler?.backend === "bun") {
  const { getScheduler } = await import("@atlas/api/lib/scheduler/engine");
  getScheduler().start();
} else if (config.scheduler?.backend === "vercel") {
  log.info("Scheduler backend is 'vercel' — tick endpoint active, no in-process loop");
}

// Start onboarding email fallback scheduler (sends time-based nudge emails)
try {
  const { startOnboardingEmailScheduler } = await import("@atlas/api/lib/email/scheduler");
  startOnboardingEmailScheduler();
} catch (err) {
  log.debug({ err: err instanceof Error ? err.message : String(err) }, "Onboarding email scheduler not started — feature may be disabled");
}

// Start audit log purge scheduler (enterprise feature — no-op when disabled)
try {
  const { startAuditPurgeScheduler } = await import("@atlas/ee/audit/purge-scheduler");
  startAuditPurgeScheduler();
} catch {
  // intentionally ignored: ee module not installed — audit purge scheduler unavailable
}

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

async function shutdown(signal: string) {
  log.info({ signal }, "Graceful shutdown initiated");

  try {
    server.stop();
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to stop HTTP server");
  }

  // Stop scheduler if running
  if (config.scheduler?.backend === "bun") {
    try {
      const { getScheduler } = await import("@atlas/api/lib/scheduler/engine");
      getScheduler().stop();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to stop scheduler");
    }
  }

  // Stop onboarding email scheduler
  try {
    const { stopOnboardingEmailScheduler } = await import("@atlas/api/lib/email/scheduler");
    stopOnboardingEmailScheduler();
  } catch {
    // intentionally ignored: module may not be loaded
  }

  try {
    await connections.shutdown();
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to shut down connections");
  }

  try {
    await closeInternalDB();
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to close internal DB");
  }

  // Flush pending OTel spans before exit so final traces are not lost.
  if (_shutdownTelemetry) {
    try {
      await _shutdownTelemetry();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Failed to shut down OTel SDK");
    }
  }

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM").catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Shutdown handler failed");
  process.exit(1);
}));
process.on("SIGINT", () => shutdown("SIGINT").catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Shutdown handler failed");
  process.exit(1);
}));

log.info({ port }, "Atlas API server starting");

export default server;
