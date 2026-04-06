/**
 * Effect Layer DAG for Atlas server startup.
 *
 * Replaces a subset of the sequential startup steps in server.ts
 * (telemetry, migrations, semantic sync, settings, schedulers) with
 * composable Layers. Config and plugin wiring remain imperative in
 * server.ts because they produce the config object the DAG needs.
 *
 * Layer dependency graph:
 *
 *   InternalDBLayer         (no deps — creates pg.Pool via PgClient.layerFromPool)
 *   MigrationLayer          (depends on InternalDB — pool must be ready first)
 *   TelemetryLayer          (no deps)
 *   ConfigLayer             (no deps — receives pre-resolved config via Layer.succeed)
 *   SemanticSyncLayer       (no deps)
 *   SettingsLayer           (no deps)
 *   SchedulerLayer          (no deps — receives config as function param)
 *
 *   AppLayer = mergeAll(Telemetry, Config, InternalDB, Migration, SemanticSync, Settings, Scheduler)
 *
 * Note: ConnectionLayer (P4) and PluginLayer (P5) live in services.ts
 * and are not yet part of AppLayer — they are wired imperatively in server.ts.
 *
 * Each layer wraps an imperative startup step with Effect.addFinalizer
 * for cleanup. On shutdown, Effect disposes scoped layers via their
 * finalizers. Order among independent layers is unspecified (except
 * MigrationLayer which depends on InternalDB).
 *
 * SettingsLive and SchedulerLayer fork long-lived periodic fibers
 * (settings refresh, OAuth cleanup, rate-limit cleanup, email scheduler,
 * demo cleanup, abuse cleanup, dashboard/conversation rate sweeps,
 * share token cleanup) that are interrupted when their Layer scope closes.
 */

import { Context, Duration, Effect, Fiber, Layer, Schedule } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { InternalDB, makeInternalDBLive, hasInternalDB } from "@atlas/api/lib/db/internal";

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
 * Depends on InternalDB — ensures pool is ready before migrations run.
 * Non-fatal: logs errors but does not fail the Layer.
 */
export const MigrationLive: Layer.Layer<Migration, never, InternalDB> = Layer.effect(
  Migration,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    if (!db.available) {
      const reason = hasInternalDB()
        ? "Internal DB connection failed — skipping boot migrations (check DATABASE_URL connectivity)"
        : "No DATABASE_URL — skipping boot migrations";
      log.info(reason);
      return { migrated: false } satisfies MigrationShape;
    }

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

/** Default refresh interval: 30 seconds. */
const SETTINGS_REFRESH_DEFAULT_MS = 30_000;
/** Minimum allowed interval to prevent accidental tight loops. */
const SETTINGS_REFRESH_MIN_MS = 1_000;

/** Resolve the settings refresh interval from env or default. */
function resolveSettingsRefreshInterval(): number {
  const raw = process.env.ATLAS_SETTINGS_REFRESH_INTERVAL;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= SETTINGS_REFRESH_MIN_MS) return parsed;
    log.warn(
      { raw, parsed },
      `Invalid ATLAS_SETTINGS_REFRESH_INTERVAL — using default ${SETTINGS_REFRESH_DEFAULT_MS}ms (must be >= ${SETTINGS_REFRESH_MIN_MS})`,
    );
  }
  return SETTINGS_REFRESH_DEFAULT_MS;
}

/**
 * Load settings overrides from internal DB into in-process cache.
 * Non-fatal: loadSettings() handles errors internally.
 *
 * In SaaS mode, forks a periodic refresh fiber so that settings changes
 * from other API replicas propagate within ~30s. The fiber is interrupted
 * on shutdown via the Layer's scope finalizer.
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

    // In SaaS mode, fork a periodic refresh fiber for multi-instance consistency
    const isSaas = yield* Effect.try({
      try: () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getConfig } = require("@atlas/api/lib/config") as { getConfig: () => { deployMode?: string } | null };
        return getConfig()?.deployMode === "saas";
      },
      catch: (err) => {
        log.debug({ err: err instanceof Error ? err.message : String(err) }, "Config not available for SaaS detection — defaulting to self-hosted");
        return false;
      },
    }).pipe(Effect.catchAll(() => Effect.succeed(false)));

    if (isSaas) {
      const intervalMs = resolveSettingsRefreshInterval();
      const tick = Effect.tryPromise({
        try: async () => {
          const { refreshSettingsTick } = await import("@atlas/api/lib/settings");
          await refreshSettingsTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Periodic settings refresh failed — will retry next interval",
            );
          }),
        ),
      );

      const fiber = yield* Effect.fork(
        tick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(intervalMs)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));

      log.info({ intervalMs }, "Started periodic settings refresh fiber");
    }

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
 * to start. Periodic cleanup fibers (OAuth state, rate-limit, email, demo
 * cleanup, abuse detection, dashboard rate-limit, conversation rate sweep,
 * share token cleanup) are forked and automatically interrupted when the
 * Layer scope closes.
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

      // ── Periodic fiber: onboarding email scheduler (#1276) ──────────
      const emailEnabled = yield* Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { isEmailSchedulerEnabled } = require("@atlas/api/lib/email/scheduler") as {
            isEmailSchedulerEnabled: () => boolean;
          };
          return isEmailSchedulerEnabled();
        },
        catch: (err) => {
          log.debug({ err: err instanceof Error ? err.message : String(err) }, "Email scheduler module not available — skipping");
          return false;
        },
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (emailEnabled) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS } = require("@atlas/api/lib/email/scheduler") as {
          DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS: number;
        };
        const emailTick = Effect.tryPromise({
          try: async () => {
            const { runTick } = await import("@atlas/api/lib/email/scheduler");
            await runTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log.warn({ err: err instanceof Error ? err.message : String(err) }, "Onboarding email tick failed");
            }),
          ),
        );
        const emailFiber = yield* Effect.fork(
          emailTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS)))),
        );
        yield* Effect.addFinalizer(() => Fiber.interrupt(emailFiber));
      } else {
        log.debug("Onboarding email scheduler not started — feature disabled");
      }

      // ── Periodic fiber: semantic expert scheduler (#1269) ──────────
      const expertEnabled = yield* Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { isExpertSchedulerEnabled } = require("@atlas/api/lib/semantic/expert/scheduler") as {
            isExpertSchedulerEnabled: () => boolean;
          };
          return isExpertSchedulerEnabled();
        },
        catch: (err) => {
          log.debug({ err: err instanceof Error ? err.message : String(err) }, "Expert scheduler module not available — skipping");
          return false;
        },
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (expertEnabled) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getExpertSchedulerIntervalMs } = require("@atlas/api/lib/semantic/expert/scheduler") as {
          getExpertSchedulerIntervalMs: () => number;
        };
        const expertTick = Effect.tryPromise({
          try: async () => {
            const { runExpertSchedulerTick } = await import("@atlas/api/lib/semantic/expert/scheduler");
            await runExpertSchedulerTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log.warn({ err: err instanceof Error ? err.message : String(err) }, "Expert scheduler tick failed");
            }),
          ),
        );
        const expertFiber = yield* Effect.fork(
          expertTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(getExpertSchedulerIntervalMs())))),
        );
        yield* Effect.addFinalizer(() => Fiber.interrupt(expertFiber));
        log.info({ intervalMs: getExpertSchedulerIntervalMs() }, "Semantic expert scheduler started");
      } else {
        log.debug("Semantic expert scheduler not started — feature disabled");
      }

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

      // ── Periodic fiber: OAuth state cleanup (#1273) — every 10 min ──
      const oauthTick = Effect.tryPromise({
        try: async () => {
          const { cleanExpiredOAuthState } = await import(
            "@atlas/api/lib/auth/oauth-state"
          );
          await cleanExpiredOAuthState();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "OAuth state cleanup tick failed",
            );
          }),
        ),
      );
      const oauthFiber = yield* Effect.fork(
        oauthTick.pipe(Effect.repeat(Schedule.spaced(Duration.minutes(10)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(oauthFiber));

      // ── Periodic fiber: rate-limit cleanup (#1274) — every 60s ──────
      // Interval matches WINDOW_MS in middleware.ts (sliding-window duration).
      const rateLimitTick = Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { rateLimitCleanupTick } = require("@atlas/api/lib/auth/middleware") as {
            rateLimitCleanupTick: () => void;
          };
          rateLimitCleanupTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Rate limit cleanup tick failed",
            );
          }),
        ),
      );
      const rateLimitFiber = yield* Effect.fork(
        rateLimitTick.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(60)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(rateLimitFiber));

      // ── Periodic fiber: demo rate-limit cleanup — interval from DEMO_CLEANUP_INTERVAL_MS ──
      const demoTick = Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { demoCleanupTick } = require("@atlas/api/lib/demo") as {
            demoCleanupTick: () => void;
          };
          demoCleanupTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.error(
              { err: err instanceof Error ? err.message : String(err) },
              "Demo rate-limit cleanup tick failed",
            );
          }),
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DEMO_CLEANUP_INTERVAL_MS } = require("@atlas/api/lib/demo") as {
        DEMO_CLEANUP_INTERVAL_MS: number;
      };
      const demoFiber = yield* Effect.fork(
        demoTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(DEMO_CLEANUP_INTERVAL_MS)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(demoFiber));

      // ── Periodic fiber: abuse detection cleanup — every 5 min ──────
      const abuseTick = Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { abuseCleanupTick } = require("@atlas/api/lib/security/abuse") as {
            abuseCleanupTick: () => void;
          };
          abuseCleanupTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Abuse cleanup tick failed",
            );
          }),
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ABUSE_CLEANUP_INTERVAL_MS } = require("@atlas/api/lib/security/abuse") as {
        ABUSE_CLEANUP_INTERVAL_MS: number;
      };
      const abuseFiber = yield* Effect.fork(
        abuseTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(ABUSE_CLEANUP_INTERVAL_MS)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(abuseFiber));

      // ── Periodic fiber: dashboard public rate-limit cleanup — every 60s ─
      const dashboardTick = Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { dashboardRateLimitCleanupTick } = require("@atlas/api/api/routes/dashboards") as {
            dashboardRateLimitCleanupTick: () => void;
          };
          dashboardRateLimitCleanupTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Dashboard rate-limit cleanup tick failed",
            );
          }),
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DASHBOARD_RATE_CLEANUP_INTERVAL_MS } = require("@atlas/api/api/routes/dashboards") as {
        DASHBOARD_RATE_CLEANUP_INTERVAL_MS: number;
      };
      const dashboardFiber = yield* Effect.fork(
        dashboardTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(DASHBOARD_RATE_CLEANUP_INTERVAL_MS)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(dashboardFiber));

      // ── Periodic fiber: conversation public rate sweep — every 60s ──
      const convSweepTick = Effect.try({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { conversationRateSweepTick } = require("@atlas/api/api/routes/conversations") as {
            conversationRateSweepTick: () => void;
          };
          conversationRateSweepTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Conversation rate sweep tick failed",
            );
          }),
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CONVERSATION_RATE_SWEEP_INTERVAL_MS, SHARE_CLEANUP_INTERVAL_MS } = require("@atlas/api/api/routes/conversations") as {
        CONVERSATION_RATE_SWEEP_INTERVAL_MS: number;
        SHARE_CLEANUP_INTERVAL_MS: number;
      };
      const convSweepFiber = yield* Effect.fork(
        convSweepTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(CONVERSATION_RATE_SWEEP_INTERVAL_MS)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(convSweepFiber));

      // ── Periodic fiber: share token cleanup — every 60 min ─────────
      const shareCleanupEffect = Effect.tryPromise({
        try: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { shareCleanupTick: tick } = require("@atlas/api/api/routes/conversations") as {
            shareCleanupTick: () => Promise<void>;
          };
          return tick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.error(
              { err: err instanceof Error ? err.message : String(err) },
              "Unexpected error in share cleanup tick",
            );
          }),
        ),
      );
      const shareCleanupFiber = yield* Effect.fork(
        shareCleanupEffect.pipe(Effect.repeat(Schedule.spaced(Duration.millis(SHARE_CLEANUP_INTERVAL_MS)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(shareCleanupFiber));

      // --- Finalizer: stop main scheduler ---
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
 * Layer dependency graph:
 *   InternalDB          (no deps — creates pg.Pool via PgClient.layerFromPool)
 *   MigrationLayer      (depends on InternalDB — pool must be ready first)
 *   All other layers    (independent peers)
 *
 * On shutdown, Effect disposes scoped layers via their finalizers.
 * InternalDB scope finalizer closes the pg.Pool automatically.
 * Connection and plugin shutdown is handled imperatively in server.ts.
 */
export function buildAppLayer(config: ResolvedConfig): Layer.Layer<
  Telemetry | Config | InternalDB | Migration | SemanticSync | Settings | Scheduler
> {
  const configLayer = Layer.succeed(Config, { config });
  const internalDBLayer = makeInternalDBLive();

  // MigrationLive depends on InternalDB — provide it
  const migrationLayer = MigrationLive.pipe(Layer.provide(internalDBLayer));

  // Independent layers (no Effect-level deps)
  const semanticSyncLayer = SemanticSyncLive;
  const settingsLayer = SettingsLive;
  const schedulerLayer = makeSchedulerLive(config);

  // Merge all layers. InternalDB is included both directly and as a
  // dependency of migrationLayer — Effect memoizes same-reference Layers.
  return Layer.mergeAll(
    TelemetryLive,
    configLayer,
    internalDBLayer,
    migrationLayer,
    semanticSyncLayer,
    settingsLayer,
    schedulerLayer,
  );
}
