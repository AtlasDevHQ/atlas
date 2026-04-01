/**
 * Effect Layer DAG for Atlas server startup.
 *
 * Replaces a subset of the sequential startup steps in server.ts
 * (telemetry, migrations, semantic sync, settings, schedulers) with
 * composable Layers. Config and plugin wiring remain imperative in
 * server.ts because they produce the config object the DAG needs.
 *
 * Layer dependency graph (all independent — merged via Layer.mergeAll):
 *
 *   TelemetryLayer          (no deps)
 *   ConfigLayer             (no deps — receives pre-resolved config via Layer.succeed)
 *   MigrationLayer          (no deps)
 *   SemanticSyncLayer       (no deps)
 *   SettingsLayer           (no deps)
 *   SchedulerLayer          (no deps — receives config as function param)
 *
 *   AppLayer = mergeAll(Telemetry, Config, Migration, SemanticSync, Settings, Scheduler)
 *
 * Note: ConnectionLayer (P4) and PluginLayer (P5) live in services.ts
 * and are not yet part of AppLayer — they are wired imperatively in server.ts.
 *
 * Each layer wraps an imperative startup step with Effect.addFinalizer
 * for cleanup. On shutdown, Effect disposes scoped layers via their
 * finalizers. Order among independent layers is unspecified.
 */

import { Context, Effect, Layer } from "effect";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("effect:layers");

// ══════════════════════════════════════════════════════════════════════
// ██  Telemetry Layer
// ══════════════════════════════════════════════════════════════════════

export interface TelemetryShape {
  /** Flush pending spans. Returns a no-op promise when OTel is disabled. */
  shutdown(): Promise<void>;
}

export class Telemetry extends Context.Tag("Telemetry")<
  Telemetry,
  TelemetryShape
>() {}

/**
 * Initialize OpenTelemetry when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * No-op layer otherwise. Finalizer flushes pending spans on shutdown.
 */
export const TelemetryLive: Layer.Layer<Telemetry> = Layer.scoped(
  Telemetry,
  Effect.gen(function* () {
    let shutdownFn: (() => Promise<void>) | null = null;

    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const { shutdownTelemetry } = await import(
            "@atlas/api/lib/telemetry"
          );
          return shutdownTelemetry;
        },
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((errMsg) => {
          log.error(
            { err: new Error(errMsg) },
            "Failed to initialize OpenTelemetry — tracing disabled for this process",
          );
          return Effect.succeed(null);
        }),
      );
      shutdownFn = result;
    }

    yield* Effect.addFinalizer(() =>
      shutdownFn
        ? Effect.tryPromise({
            try: () => shutdownFn!(),
            catch: (err) => (err instanceof Error ? err.message : String(err)),
          }).pipe(
            Effect.catchAll((errMsg) => {
              log.error({ err: new Error(errMsg) }, "Failed to shut down OTel SDK");
              return Effect.void;
            }),
          )
        : Effect.void,
    );

    const service: TelemetryShape = {
      shutdown: () => (shutdownFn ? shutdownFn() : Promise.resolve()),
    };

    return service;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Config Layer
// ══════════════════════════════════════════════════════════════════════

export interface ConfigShape {
  /** The resolved atlas.config.ts (or env-var fallback). */
  readonly config: ResolvedConfig;
}

// Import the type — lazy-import the module in Layer construction to
// avoid circular dependency at module evaluation time.
type ResolvedConfig = import("@atlas/api/lib/config").ResolvedConfig;

export class Config extends Context.Tag("Config")<Config, ConfigShape>() {}

/**
 * Load atlas.config.ts, wire datasources. Fails the Layer (and therefore
 * the entire server startup) if config is invalid.
 */
export const ConfigLive: Layer.Layer<Config, Error> = Layer.effect(
  Config,
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise({
      try: async () => {
        const { initializeConfig } = await import("@atlas/api/lib/config");
        return initializeConfig();
      },
      catch: (err) =>
        new Error(
          `Config initialization failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });

    return { config } satisfies ConfigShape;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Migration Layer
// ══════════════════════════════════════════════════════════════════════

export interface MigrationShape {
  /** Whether migrations ran successfully. */
  readonly migrated: boolean;
}

export class Migration extends Context.Tag("Migration")<
  Migration,
  MigrationShape
>() {}

/**
 * Run auth + internal DB migrations at boot.
 * Non-fatal: logs errors but does not fail the Layer.
 */
export const MigrationLive: Layer.Layer<Migration> = Layer.effect(
  Migration,
  Effect.gen(function* () {
    const migrated = yield* Effect.tryPromise({
      try: async () => {
        const { migrateAuthTables } = await import(
          "@atlas/api/lib/auth/migrate"
        );
        await migrateAuthTables();
        return true;
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.error(
          { err: new Error(errMsg) },
          "Boot migration failed",
        );
        return Effect.succeed(false);
      }),
    );

    return { migrated } satisfies MigrationShape;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Semantic Sync Layer
// ══════════════════════════════════════════════════════════════════════

export interface SemanticSyncShape {
  readonly reconciled: boolean;
}

export class SemanticSync extends Context.Tag("SemanticSync")<
  SemanticSync,
  SemanticSyncShape
>() {}

/**
 * Reconcile org semantic layer directories from DB.
 * Non-fatal: errors logged internally by reconcileAllOrgs().
 */
export const SemanticSyncLive: Layer.Layer<SemanticSync> = Layer.effect(
  SemanticSync,
  Effect.gen(function* () {
    const reconciled = yield* Effect.tryPromise({
      try: async () => {
        const { reconcileAllOrgs } = await import(
          "@atlas/api/lib/semantic/sync"
        );
        await reconcileAllOrgs();
        return true;
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.error({ err: new Error(errMsg) }, "Semantic sync failed");
        return Effect.succeed(false);
      }),
    );

    return { reconciled } satisfies SemanticSyncShape;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Settings Layer
// ══════════════════════════════════════════════════════════════════════

export interface SettingsShape {
  readonly loaded: number;
}

export class Settings extends Context.Tag("Settings")<
  Settings,
  SettingsShape
>() {}

/**
 * Load settings overrides from internal DB into in-process cache.
 * Non-fatal: loadSettings() handles errors internally.
 *
 * In SaaS mode, starts a periodic refresh timer so that settings changes
 * from other API replicas propagate within ~30s. The timer is cleaned up
 * via Effect finalizer on shutdown.
 */
export const SettingsLive: Layer.Layer<Settings> = Layer.scoped(
  Settings,
  Effect.gen(function* () {
    const loaded = yield* Effect.tryPromise({
      try: async () => {
        const { loadSettings } = await import("@atlas/api/lib/settings");
        return loadSettings();
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.error({ err: new Error(errMsg) }, "Settings load failed");
        return Effect.succeed(0);
      }),
    );

    // In SaaS mode, start periodic refresh for multi-instance consistency
    const timerCleanup = yield* Effect.tryPromise({
      try: async () => {
        const { getConfig } = await import("@atlas/api/lib/config");
        if (getConfig()?.deployMode === "saas") {
          const { startSettingsRefreshTimer } = await import("@atlas/api/lib/settings");
          return startSettingsRefreshTimer();
        }
        return null;
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.warn(
          { err: new Error(errMsg) },
          "Settings refresh timer failed to start — multi-instance settings sync disabled",
        );
        return Effect.succeed(null);
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (timerCleanup) timerCleanup();
      }),
    );

    return { loaded } satisfies SettingsShape;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Scheduler Layer
// ══════════════════════════════════════════════════════════════════════

export interface SchedulerShape {
  /** "webhook" relies on external cron; "none" means no scheduler configured. */
  readonly backend: "bun" | "webhook" | "vercel" | "none";
}

export class Scheduler extends Context.Tag("Scheduler")<
  Scheduler,
  SchedulerShape
>() {}

/**
 * Create a Scheduler layer that reads the config to decide which backend
 * to start. Finalizer stops the scheduler and email sub-scheduler.
 */
export function makeSchedulerLive(
  config: ResolvedConfig,
): Layer.Layer<Scheduler> {
  return Layer.scoped(
    Scheduler,
    Effect.gen(function* () {
      const raw = config.scheduler?.backend ?? "none";
      const VALID_BACKENDS = new Set<SchedulerShape["backend"]>(["bun", "webhook", "vercel", "none"]);
      if (!VALID_BACKENDS.has(raw as SchedulerShape["backend"])) {
        log.error({ backend: raw }, `Unknown scheduler backend "${raw}" — falling back to "none"`);
      }
      const backend: SchedulerShape["backend"] = VALID_BACKENDS.has(raw as SchedulerShape["backend"])
        ? (raw as SchedulerShape["backend"])
        : "none";

      // Start main scheduler
      if (backend === "bun") {
        yield* Effect.tryPromise({
          try: async () => {
            const { getScheduler } = await import(
              "@atlas/api/lib/scheduler/engine"
            );
            getScheduler().start();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.catchAll((err) => {
            log.error({ err }, "Failed to start scheduler");
            return Effect.void;
          }),
        );
      } else if (backend === "vercel") {
        log.info(
          "Scheduler backend is 'vercel' — tick endpoint active, no in-process loop",
        );
      } else if (backend === "webhook") {
        log.info(
          "Scheduler backend is 'webhook' — external cron expected, no in-process loop",
        );
      }

      // Start onboarding email scheduler
      yield* Effect.tryPromise({
        try: async () => {
          const { startOnboardingEmailScheduler } = await import(
            "@atlas/api/lib/email/scheduler"
          );
          startOnboardingEmailScheduler();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.debug(
            { err },
            "Onboarding email scheduler not started — feature may be disabled",
          );
          return Effect.void;
        }),
      );

      // Start audit purge scheduler (enterprise — no-op when ee module not installed)
      yield* Effect.tryPromise({
        try: async () => {
          const { startAuditPurgeScheduler } = await import(
            "@atlas/ee/audit/purge-scheduler"
          );
          startAuditPurgeScheduler();
        },
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((errMsg) => {
          if (errMsg.includes("Cannot find module") || errMsg.includes("Cannot find package")) {
            // intentionally ignored: ee module not installed — audit purge scheduler unavailable
          } else {
            log.error({ err: new Error(errMsg) }, "Audit purge scheduler failed to start");
          }
          return Effect.void;
        }),
      );

      // Clean expired OAuth state every 10 minutes (DB rows + in-memory fallback)
      const oauthCleanupTimer = setInterval(async () => {
        let cleanExpiredOAuthState: () => Promise<void>;
        try {
          ({ cleanExpiredOAuthState } = await import(
            "@atlas/api/lib/auth/oauth-state"
          ));
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "OAuth state module failed to load — cleanup disabled",
          );
          clearInterval(oauthCleanupTimer);
          return;
        }
        try {
          await cleanExpiredOAuthState();
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "OAuth state cleanup query failed",
          );
        }
      }, 600_000);
      oauthCleanupTimer.unref();

      // --- Finalizer: stop all schedulers ---
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (backend === "bun") {
            yield* Effect.tryPromise({
              try: async () => {
                const { getScheduler } = await import(
                  "@atlas/api/lib/scheduler/engine"
                );
                getScheduler().stop();
              },
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            }).pipe(
              Effect.catchAll((err) => {
                log.error({ err }, "Failed to stop scheduler");
                return Effect.void;
              }),
            );
          }

          yield* Effect.tryPromise({
            try: async () => {
              const { stopOnboardingEmailScheduler } = await import(
                "@atlas/api/lib/email/scheduler"
              );
              stopOnboardingEmailScheduler();
            },
            catch: (err) =>
              err instanceof Error ? err : new Error(String(err)),
          }).pipe(
            Effect.catchAll((err) => {
              log.error({ err }, "Failed to stop onboarding email scheduler");
              return Effect.void;
            }),
          );

          clearInterval(oauthCleanupTimer);

          log.info("Schedulers shut down via Effect scope");
        }),
      );

      return { backend } satisfies SchedulerShape;
    }),
  );
}

// ══════════════════════════════════════════════════════════════════════
// ██  AppLayer — compose the full startup DAG
// ══════════════════════════════════════════════════════════════════════

/**
 * Build the full application Layer DAG.
 *
 * All layers are independent peers (no Effect-level dependencies between
 * them). Config is provided as a pre-resolved value via `Layer.succeed`.
 * The remaining layers use dynamic imports to reach their modules and do
 * not consume Config from the Effect context.
 *
 * On shutdown, Effect disposes scoped layers (Telemetry, Settings, Scheduler) via
 * their finalizers. Order among independent layers is unspecified.
 * Connection and plugin shutdown is handled imperatively in server.ts.
 */
export function buildAppLayer(config: ResolvedConfig): Layer.Layer<
  Telemetry | Config | Migration | SemanticSync | Settings | Scheduler
> {
  const configLayer = Layer.succeed(Config, { config });

  // Independent layers (no Effect-level deps)
  const migrationLayer = MigrationLive;
  const semanticSyncLayer = SemanticSyncLive;
  const settingsLayer = SettingsLive;
  const schedulerLayer = makeSchedulerLive(config);

  // Merge all independent layers
  return Layer.mergeAll(
    TelemetryLive,
    configLayer,
    migrationLayer,
    semanticSyncLayer,
    settingsLayer,
    schedulerLayer,
  );
}
