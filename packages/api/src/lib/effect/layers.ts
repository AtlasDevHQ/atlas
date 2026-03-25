/**
 * Effect Layer DAG for Atlas server startup.
 *
 * Replaces the sequential await chain in server.ts with composable Layers
 * that express dependency ordering at the type level. Shutdown is automatic
 * via Scope cleanup — no manual SIGTERM handler ordering.
 *
 * Layer dependency graph:
 *
 *   TelemetryLayer (independent)
 *   ConfigLayer (independent)
 *     ├→ ConnectionLayer (depends on Config)        [P4 — services.ts]
 *     │    └→ PluginLayer (depends on Connections)  [P5 — services.ts]
 *     ├→ MigrationLayer (depends on Config)
 *     ├→ SemanticSyncLayer (depends on Config)
 *     ├→ SettingsLayer (depends on Config)
 *     └→ SchedulerLayer (depends on Config)
 *
 *   AppLayer = merge all of the above
 *
 * Each layer wraps an imperative startup step with Effect.addFinalizer
 * for cleanup. Layer construction runs eagerly — startup errors surface
 * at boot, not on first request.
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
              log.error({ err: errMsg }, "Failed to shut down OTel SDK");
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
        log.error({ err: errMsg }, "Semantic sync failed");
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
 */
export const SettingsLive: Layer.Layer<Settings> = Layer.effect(
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
        log.error({ err: errMsg }, "Settings load failed");
        return Effect.succeed(0);
      }),
    );

    return { loaded } satisfies SettingsShape;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Scheduler Layer
// ══════════════════════════════════════════════════════════════════════

export interface SchedulerShape {
  readonly backend: "bun" | "vercel" | "none";
}

export class SchedulerService extends Context.Tag("Scheduler")<
  SchedulerService,
  SchedulerShape
>() {}

/**
 * Create a Scheduler layer that reads the config to decide which backend
 * to start. Finalizer stops the scheduler and email/audit sub-schedulers.
 */
export function makeSchedulerLive(
  config: ResolvedConfig,
): Layer.Layer<SchedulerService> {
  return Layer.scoped(
    SchedulerService,
    Effect.gen(function* () {
      const backend = config.scheduler?.backend ?? "none";

      // Start main scheduler
      if (backend === "bun") {
        yield* Effect.tryPromise({
          try: async () => {
            const { getScheduler } = await import(
              "@atlas/api/lib/scheduler/engine"
            );
            getScheduler().start();
          },
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
          Effect.catchAll((errMsg) => {
            log.error({ err: errMsg }, "Failed to start scheduler");
            return Effect.void;
          }),
        );
      } else if (backend === "vercel") {
        log.info(
          "Scheduler backend is 'vercel' — tick endpoint active, no in-process loop",
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
        catch: (err) => (err instanceof Error ? err.message : String(err)),
      }).pipe(
        Effect.catchAll((errMsg) => {
          log.debug(
            { err: errMsg },
            "Onboarding email scheduler not started — feature may be disabled",
          );
          return Effect.void;
        }),
      );

      // Start audit purge scheduler (enterprise — no-op when ee module not available)
      yield* Effect.tryPromise({
        try: async () => {
          const { startAuditPurgeScheduler } = await import(
            "@atlas/ee/audit/purge-scheduler"
          );
          startAuditPurgeScheduler();
        },
        catch: () => "ee-not-available",
      }).pipe(
        Effect.catchAll(() => Effect.void), // intentionally ignored: ee module may not be installed
      );

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
                err instanceof Error ? err.message : String(err),
            }).pipe(
              Effect.catchAll((errMsg) => {
                log.error({ err: errMsg }, "Failed to stop scheduler");
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
            catch: () => "not-loaded",
          }).pipe(Effect.catchAll(() => Effect.void));

          log.info("Schedulers shut down via Effect scope");
        }),
      );

      return { backend: backend as "bun" | "vercel" | "none" } satisfies SchedulerShape;
    }),
  );
}

// ══════════════════════════════════════════════════════════════════════
// ██  AppLayer — compose the full startup DAG
// ══════════════════════════════════════════════════════════════════════

/**
 * Build the full application Layer DAG.
 *
 * The Layer graph encodes dependency ordering at the type level:
 * - Config loads first (everything depends on it)
 * - Connection warmup + plugin wiring depend on Config
 * - Migrations, semantic sync, settings, scheduler are independent
 *   of each other but all run after Config
 * - Telemetry is fully independent
 *
 * On shutdown, Effect tears down Layers in reverse dependency order:
 * Scheduler → Plugins → Connections → Telemetry (automatic, no manual ordering).
 */
export function buildAppLayer(config: ResolvedConfig): Layer.Layer<
  Telemetry | Config | Migration | SemanticSync | Settings | SchedulerService
> {
  const configLayer = Layer.succeed(Config, { config });

  // Independent layers (no deps beyond Config)
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
