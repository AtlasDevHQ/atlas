/**
 * Effect Layer DAG for Atlas server startup.
 *
 * Expresses the startup steps as composable Layers. Only the plugin-wiring
 * INPUTS (the plugin context object + tool registry) are built imperatively in
 * server.ts and passed in as `pluginWiring` — registration / init / wiring
 * themselves now run INSIDE the DAG (#3743).
 *
 * Layer dependency graph (key ordering edges):
 *
 *   InternalDBLayer         (no deps — creates pg.Pool via PgClient.layerFromPool)
 *   MigrationLayer          (← InternalDB — pool ready first; SCHEMA migrations only)
 *   ConnectionRegistryLayer (no deps — binds the GLOBAL `connections` Tag,
 *                            lifecycle-unmanaged: `manageLifecycle: false`)
 *   PluginRegistryLayer     (← ConnectionRegistry + Migration — the #3741
 *                            structural fix: plugin initialize() can't run before
 *                            core migrations. Wired variant when plugins exist;
 *                            empty PluginRegistryLive as an ordering barrier otherwise)
 *   ConnectionsHydrateLayer (← InternalDB + Migration + PluginRegistry — DB-stored
 *                            datasource plugins must be registered before hydrate)
 *   AuthBootstrapLayer      (← Migration + PluginRegistry — post-schema bootstrap
 *                            AFTER wiring, preserving loadPluginSettings order)
 *   PoolWarmupLayer         (← PluginRegistry + ConnectionsHydrate)
 *   TelemetryLayer / ConfigLayer / SemanticSyncLayer / SettingsLayer / SchedulerLayer
 *                            (independent peers)
 *
 *   AppLayer = mergeAll(... all of the above + the SaaS boot guards ...)
 *
 * Each layer wraps a startup step with Effect.addFinalizer for cleanup. On
 * shutdown, Effect disposes scoped layers via their finalizers (the wired
 * PluginRegistry layer's finalizer runs `plugins.teardownAll()`). Order among
 * independent layers is unspecified; the edges above are the only guarantees.
 *
 * SettingsLive and SchedulerLayer fork long-lived periodic fibers
 * (settings refresh, OAuth cleanup, rate-limit cleanup, email scheduler,
 * demo cleanup, abuse cleanup, dashboard/conversation rate sweeps,
 * share token cleanup) that are interrupted when their Layer scope closes.
 */

import { Context, Duration, Effect, Layer, Schedule, type Scope } from "effect";
import type { Attributes } from "@opentelemetry/api";
import { createLogger } from "@atlas/api/lib/logger";
import { withEffectSpan } from "@atlas/api/lib/tracing";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { normalizeError } from "@atlas/api/lib/effect/errors";
import { InternalDB, makeInternalDBLive, hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getApiRegion } from "@atlas/api/lib/residency/misrouting";
import {
  StagingSeed,
  StagingSeedError,
  ensureStagingSeed,
  type StagingSeedResult,
} from "@atlas/api/lib/staging/seed";
import { assertSaasPlatformEmailIsResend } from "@atlas/api/lib/email/dpa-guard";
import {
  EnterpriseGuardLive,
  EncryptionKeyGuardLive,
  InternalDbGuardLive,
  RateLimitGuardLive,
  TurnstileGuardLive,
  SandboxCredsGuardLive,
  ProviderKeyGuardLive,
  ProactiveProviderKeyGuardLive,
  RegionGuardLive,
  PluginConfigGuardLive,
  ChatAdapterEnvGuardLive,
  BillingConfigGuardLive,
  McpSpineGuardLive,
  MigrationsRequiredError,
} from "./saas-guards";
import { readSaasEnv } from "./saas-env";
import { EnterpriseLayer, type EnterpriseSubsystem } from "./enterprise-layer";
import {
  AuditPurgeScheduler,
  BackupsManager,
  SaasCrm,
  AbuseResponse,
  Migration,
  type MigrationShape,
  ConnectionRegistry,
  PluginRegistry,
  PluginRegistryLive,
  makeConnectionRegistryLive,
  makeWiredPluginRegistryLive,
  type PluginWiringConfig,
  DurableSession,
  DurableState,
} from "./services";
import { durableSessionLayer } from "./durable-session";
import { durableStateLayer } from "./durable-state";
// Static import (not the require-in-thunk pattern): cadence.ts is a pure,
// dependency-free core leaf with no import-time env reads, and a typo'd
// symbol should be a compile error, not an undefined interval at runtime.
import {
  SCHEDULED_BACKUP_CHECK_INTERVAL_MS,
  isScheduledBackupEnvDisabled,
} from "@atlas/api/lib/backups/cadence";
import { getRetentionDays, getMaxParkMinutes } from "@atlas/api/lib/durable-session";
import {
  recoverInFlight as recoverOutboxInFlight,
  drainOutbox as drainOutboxQueue,
  getBackstopSweepIntervalMs as getOutboxBackstopSweepIntervalMs,
  getWarnThreshold as getOutboxWarnThreshold,
  isFlusherEnabled as isOutboxFlusherEnabled,
  OutboxWarnRateLimiter,
  FlusherSignal as OutboxFlusherSignal,
  setActiveFlusherSignal as setActiveOutboxFlusherSignal,
  FLUSH_BATCH_LIMIT as OUTBOX_FLUSH_BATCH_LIMIT,
  STARTUP_RECOVERY_STALE_MS as OUTBOX_STARTUP_STALE_MS,
  SHUTDOWN_RECOVERY_STALE_MS as OUTBOX_SHUTDOWN_STALE_MS,
  type OutboxDB,
  type RecoveryResult as OutboxRecoveryResult,
} from "@atlas/api/lib/lead-outbox";
import {
  recoverInFlight as recoverEmailOutboxInFlight,
  runEmailOutboxTick,
  makeEmailDispatcher,
  getTickIntervalMs as getEmailOutboxTickIntervalMs,
  getWarnThreshold as getEmailOutboxWarnThreshold,
  isFlusherEnabled as isEmailOutboxFlusherEnabled,
  OutboxWarnRateLimiter as EmailOutboxWarnRateLimiter,
  FLUSH_BATCH_LIMIT as EMAIL_OUTBOX_FLUSH_BATCH_LIMIT,
  STARTUP_RECOVERY_STALE_MS as EMAIL_OUTBOX_STARTUP_STALE_MS,
  SHUTDOWN_RECOVERY_STALE_MS as EMAIL_OUTBOX_SHUTDOWN_STALE_MS,
  type EmailOutboxDB,
  type RecoveryResult as EmailOutboxRecoveryResult,
} from "@atlas/api/lib/email-outbox";
import { sendEmail, assertStagingMailRegion } from "@atlas/api/lib/email/delivery";
import {
  crmOutboxPendingCount,
  crmOutboxDeadCount,
  crmOutboxFlusherWakes,
  emailOutboxPendingCount,
  emailOutboxDeadCount,
} from "@atlas/api/lib/metrics";

const log = createLogger("effect:layers");

// ── Defect-canary wrapper for forked periodic fibers (#2864) ──────────
// Inner `Effect.catchAll(...)` blocks at each tick body normalize
// expected Promise rejections into typed `Cause.Fail` so the
// `Effect.repeat(Schedule.spaced(...))` loop survives them. But a
// genuine defect — a synchronous throw inside the `Effect.sync` log
// handler, an Effect runtime fault, or any non-`tryPromise` path — lands
// in `Cause.Die`, escapes the inner `catchAll`, exits `repeat`, and
// kills the fiber **silently** (the original #2864 failure mode, just
// reached via a different door). Wrap each `tick.pipe(Effect.repeat(...))`
// with this outer catch so a defect-induced fiber death emits a single
// `periodic_fiber.died` error log entry before the fiber unwinds.
function withFiberDeathLog<A, E, R>(
  fiber: string,
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> {
  return eff.pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        log.error(
          { err: cause.toString(), event: "periodic_fiber.died", fiber },
          `Periodic fiber "${fiber}" died — defect escaped tick body`,
        );
      }),
    ),
    Effect.asVoid,
  );
}

// ── Per-tick observability spans for periodic scheduler fibers (#2945, #2944, #2987) ──
// `withFiberDeathLog` (above) only fires when a defect kills the fiber.
// A healthy tick emits nothing, so "wedged silently" and "ran fine,
// nothing to do" are indistinguishable in traces, and a hung-but-not-
// crashed fiber never trips the death log. Wrap each of these periodic
// tick bodies in `withEffectSpan` so every repeat iteration emits one
// span — a wedged fiber then shows up as an absence of spans against its
// expected cadence.
//
// OK-on-failure trade-off: each tick's loop-liveness recovery sits INSIDE
// the span, so a failed-but-recovered tick still records span status OK (the
// error itself goes to `log.warn`). These spans answer "is the fiber still
// ticking?" via presence/absence + cadence, NOT "did this tick error?". The
// exceptions are the `spanResultAttributes` fibers — `orphan_task_reconcile`
// (#2944), `unclaimed_grace_reap` (#3796), `region_migration_stale_reap`
// (#4459), `region_migration_source_cleanup` (#4458), the three #4195
// DB/refresh jobs
// (`byot_catalog_refresh`, `openapi_spec_refresh`, `openapi_install_rediscover`),
// and `scheduled_backup` (#4457)
// — which deliberately invert the ordering (raw tick spanned, recovery applied
// OUTSIDE) to keep their result attributes truthful; see `registerPeriodicFiber`
// below.
//
// Membership splits into two single-source records, by fiber kind:
//
//   • SCHEDULER_CLEANUP_SPAN_NAMES — 14 cleanup/sweep fibers (they evict
//     expired in-memory or DB state). Eight were retrofitted with a span by
//     #2945 (the TTL/ratelimit/state sweeps below); the ninth,
//     `orphan_task_reconcile` (#2944), shipped with its span from day one and
//     additionally attaches the orphan count as a result attribute (one of
//     three `spanResultAttributes` fibers in THIS record, with
//     `region_migration_stale_reap` and `region_migration_source_cleanup` —
//     the work record adds
//     `unclaimed_grace_reap`, the three #4195 DB/refresh jobs, and
//     `scheduled_backup` (#4457); the
//     scheduler engine uses that 4th arg elsewhere, inside its own module).
//     The tenth,
//     `trial_rate_limit_cleanup` (#3654), sweeps the unauthenticated
//     `start_trial` per-IP/email attempt-limiter maps. The eleventh,
//     `agent_runs_retention_sweep` (#3745, ADR-0020), deletes terminal
//     durable-session runs past the retention window. The twelfth,
//     `region_probe_rate_sweep` (#3973, ADR-0024 §3), evicts expired per-IP
//     buckets from the login front-door's hashed-email existence-probe limiter.
//     The thirteenth, `region_migration_stale_reap` (#4459, ADR-0024), fails
//     region migrations stuck `in_progress` past the stale threshold so a
//     crashed migration releases its workspace write-lock without waiting for
//     an admin to request another migration (it attaches the stale-found and
//     reaped counts as result attributes, like `orphan_task_reconcile`).
//     The fourteenth, `region_migration_source_cleanup` (#4458, ADR-0024),
//     deletes a migrated workspace's source-region data once the 7-day grace
//     period elapses — the destructive half of migration Phase 4, scoped by
//     the bundle-scope registry (attaches due/cleaned/skipped counts as
//     result attributes).
//
//   • SCHEDULER_WORK_SPAN_NAMES — background-work fibers (they perform
//     recurring side-effecting work rather than evicting state):
//     `sub_processor_publisher`, `settings_refresh`, `onboarding_email`,
//     `expert_scheduler`, `promote_decay`, `billing_reconcile`,
//     `stripe_teardown_sweep`, `unclaimed_grace_reap`, `overage_report`,
//     the three #4195 DB/refresh jobs `byot_catalog_refresh`,
//     `openapi_spec_refresh`, `openapi_install_rediscover`, and
//     `scheduled_backup` (#4457 — the internal-DB backup cycle). Spanned by
//     #2987 (+#3423 for billing_reconcile, #3992 for overage_report, #4195
//     for the DB/refresh trio) — identical rationale and wrap shape.
//     `unclaimed_grace_reap` (#3796), the three #4195 jobs, and
//     `scheduled_backup` attach result attributes (cycle counts / outcome);
//     the rest carry none.
//
// Two records, not one: "cleanup sweep" vs "background work" is a real
// distinction (it drives the log wording and the operator's mental model),
// so each record stays the single source of truth for its own kind. Both are
// pinned by the same parameterized guard in `layers.test.ts`.
//
// Deliberately NOT spanned: the CRM + transactional-email outbox flushers and
// their stall-watchdog fibers (`lead_outbox_*`, `email_outbox_*`). They
// already carry a STRONGER liveness signal than a presence/absence span — a
// periodic heartbeat log when the queue is idle PLUS a separate watchdog
// fiber that raises an error log when no tick is observed in > 2× the
// interval. A per-tick span would be redundant with that, so #2987 leaves
// them on heartbeat + watchdog. The scheduler engine's own `tick`/`task.run`
// spans are self-defined inside `scheduler/engine.ts` and so never appear in
// either record here. (The BYOT/OpenAPI refresh trio USED to be self-spanning
// too, but #4195 folded them onto `registerPeriodicFiber` and moved their
// spans into `SCHEDULER_WORK_SPAN_NAMES` above.)
//
// Span names follow the existing `atlas.<area>.<op>` dotted convention
// (cf. `atlas.sql.execute`, `atlas.scheduler.task.run`, and the
// already-landed `atlas.scheduler.byot_catalog_refresh` from #2949).
// The snake_case op segment matches the fiber's `withFiberDeathLog`
// label; the LOW finding in #2945 is about NOT dropping the dotted
// `atlas.scheduler.` prefix, not about the underscores within the op.
//
// Each record is the single source of truth for its span names:
// `registerPeriodicFiber` (below) derives every fiber's span from the merged
// `SCHEDULER_SPAN_NAMES[spec.name]` lookup. `layers.test.ts` asserts, for
// each record, both the exact name set AND (via a structural source-scan
// guard) that every key has exactly one matching `name: "<key>"`
// registration site — so renaming an entry OR deleting a registration is a
// test failure rather than a silent regression.
export const SCHEDULER_CLEANUP_SPAN_NAMES = {
  oauth_state_cleanup: "atlas.scheduler.oauth_state_cleanup",
  rate_limit_cleanup: "atlas.scheduler.rate_limit_cleanup",
  demo_rate_limit_cleanup: "atlas.scheduler.demo_rate_limit_cleanup",
  contact_rate_limit_cleanup: "atlas.scheduler.contact_rate_limit_cleanup",
  trial_rate_limit_cleanup: "atlas.scheduler.trial_rate_limit_cleanup",
  abuse_cleanup: "atlas.scheduler.abuse_cleanup",
  dashboard_rate_limit_cleanup: "atlas.scheduler.dashboard_rate_limit_cleanup",
  conversation_rate_sweep: "atlas.scheduler.conversation_rate_sweep",
  region_probe_rate_sweep: "atlas.scheduler.region_probe_rate_sweep",
  share_token_cleanup: "atlas.scheduler.share_token_cleanup",
  orphan_task_reconcile: "atlas.scheduler.orphan_task_reconcile",
  agent_runs_retention_sweep: "atlas.scheduler.agent_runs_retention_sweep",
  region_migration_stale_reap: "atlas.scheduler.region_migration_stale_reap",
  region_migration_source_cleanup: "atlas.scheduler.region_migration_source_cleanup",
} as const satisfies Record<string, `atlas.scheduler.${string}`>;

// Per-tick spans for the background-work fibers (#2987). Same wrap shape and
// rationale as the cleanup record above; see the block comment for why these
// are a separate record and why the outbox flushers are excluded.
export const SCHEDULER_WORK_SPAN_NAMES = {
  sub_processor_publisher: "atlas.scheduler.sub_processor_publisher",
  settings_refresh: "atlas.scheduler.settings_refresh",
  onboarding_email: "atlas.scheduler.onboarding_email",
  expert_scheduler: "atlas.scheduler.expert_scheduler",
  promote_decay: "atlas.scheduler.promote_decay",
  billing_reconcile: "atlas.scheduler.billing_reconcile",
  stripe_teardown_sweep: "atlas.scheduler.stripe_teardown_sweep",
  unclaimed_grace_reap: "atlas.scheduler.unclaimed_grace_reap",
  overage_report: "atlas.scheduler.overage_report",
  // #4195 — the three DB/refresh jobs folded off their bespoke `setInterval`
  // lifecycle onto `registerPeriodicFiber`. Each now carries its per-tick span
  // here (previously self-spanned inside its own module) with the cycle result
  // attached via `spanResultAttributes`.
  byot_catalog_refresh: "atlas.scheduler.byot_catalog_refresh",
  openapi_spec_refresh: "atlas.scheduler.openapi_spec_refresh",
  openapi_install_rediscover: "atlas.scheduler.openapi_install_rediscover",
  // #4457 — internal-DB scheduled backups. The tick claims the current
  // cadence window atomically (partial UNIQUE index on
  // `backups.scheduled_window`), then create→verify→purge through the
  // `BackupsManager` Tag (EE-implemented; the gate skips the fiber when the
  // noop is bound).
  scheduled_backup: "atlas.scheduler.scheduled_backup",
} as const satisfies Record<string, `atlas.scheduler.${string}`>;

// ── registerPeriodicFiber — the periodic-fiber choreography, once (#4130) ──
// Every periodic scheduler fiber repeats the same five moves: evaluate an
// enablement gate, resolve an interval, wrap the tick in its per-tick span +
// `withFiberDeathLog`, `forkScoped` it, and log on start (or debug-log the
// skip). This helper owns that choreography once; each registration site
// declares only what is fiber-specific — the gate predicate, the interval
// source, the tick body, and the log copy. The span name is derived from
// `name` via the merged record below, so the "span op segment matches the
// `withFiberDeathLog` label" convention pinned by `layers.test.ts` holds by
// construction — a registered fiber cannot mismatch its label and span.
//
// The CRM/email outbox flusher fibers (`lead_outbox_*`, `email_outbox_*`)
// are NOT registered through this helper on purpose: they carry heartbeat +
// stall-watchdog liveness instead of a per-tick span (see the record block
// comment above) plus startup/shutdown recovery sequencing that doesn't fit
// the five-move shape.
const SCHEDULER_SPAN_NAMES = {
  ...SCHEDULER_CLEANUP_SPAN_NAMES,
  ...SCHEDULER_WORK_SPAN_NAMES,
} as const;

/** Names of the periodic fibers registered via {@link registerPeriodicFiber}. */
type PeriodicFiberName = keyof typeof SCHEDULER_SPAN_NAMES;

interface PeriodicFiberSpec<A, E> {
  /** Fiber label — also selects the per-tick span from the records above. */
  readonly name: PeriodicFiberName;
  /**
   * Interval between tick completions (`Schedule.spaced`). A thunk is
   * resolved once, after the gate passes — so a module that only makes
   * sense to `require` when its feature is enabled can supply the value,
   * and a settings-registry-backed knob is read after `loadSettings()`.
   * The thunk must not throw: a throw here is a layer-build defect (boot
   * failure). Self-guard if the source module may be absent, as the
   * `dashboard_rate_limit_cleanup` thunk does.
   */
  readonly intervalMs: number | (() => number);
  /** Raw per-tick body. Recovery is applied by the helper per `onTickFailure`. */
  readonly tick: Effect.Effect<A, E>;
  /**
   * Per-tick recovery keeping the repeat loop alive. `viaCause` recovers
   * defects too (`catchAllCause` — the agent_runs sweep); everything else
   * recovers typed failures only, so a genuine defect still reaches
   * `withFiberDeathLog`. Applied INSIDE the span — a failed-but-recovered
   * tick records span status OK, the OK-on-failure trade-off documented
   * above — unless `spanResultAttributes` is set, which inverts the order.
   */
  readonly onTickFailure: {
    readonly level: "warn" | "error";
    readonly message: string;
    readonly viaCause?: boolean;
  };
  /**
   * Attach result attributes to the per-tick span (orphan_task_reconcile /
   * unclaimed_grace_reap). The span then wraps the RAW tick and recovery is
   * applied OUTSIDE it, so a failed tick records ERROR + the exception
   * rather than a status-OK span carrying fabricated attributes. Do not
   * combine with `viaCause` — recovering defects outside the span is a
   * semantics no fiber wants.
   */
  readonly spanResultAttributes?: (result: A) => Attributes;
  /**
   * Enablement gate, evaluated once at registration. `check` may throw
   * (module-availability probes): a throw debug-logs `failLog` and then
   * proceeds as a `false` return, so both `failLog` and `skipLog` fire on
   * a throw (each when provided).
   */
  readonly gate?: {
    readonly check: () => boolean;
    readonly failLog?: string;
    readonly skipLog?: string;
  };
  /** info-level log once the fiber is forked, with the resolved interval. */
  readonly startLog?: string;
}

// Exported for the behavioral contract tests in layers.test.ts — every
// record-listed periodic fiber flows through this one seam (the outbox
// flushers stay outside, see above), so a helper-level bug is an every-record-listed-fiber
// blast radius the structural source scans alone cannot see.
export function registerPeriodicFiber<A, E>(
  spec: PeriodicFiberSpec<A, E>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { gate, onTickFailure } = spec;
    if (gate) {
      // Normalize to Error per the Effect.try/tryPromise rule; the catchAll
      // below logs it and degrades to "fiber not started".
      const enabled = yield* Effect.try({
        try: gate.check,
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.debug(
              { err: errorMessage(err) },
              gate.failLog ?? `${spec.name} gate check failed — skipping`,
            );
            return false;
          }),
        ),
      );
      if (!enabled) {
        if (gate.skipLog) log.debug(gate.skipLog);
        return;
      }
    }

    const intervalMs =
      typeof spec.intervalMs === "function" ? spec.intervalMs() : spec.intervalMs;

    const recover = (eff: Effect.Effect<A, E>): Effect.Effect<void> =>
      onTickFailure.viaCause
        ? eff.pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                log[onTickFailure.level](
                  { err: cause.toString() },
                  onTickFailure.message,
                );
              }),
            ),
            Effect.asVoid,
          )
        : eff.pipe(
            Effect.catchAll((err) =>
              Effect.sync(() => {
                log[onTickFailure.level](
                  { err: errorMessage(err) },
                  onTickFailure.message,
                );
              }),
            ),
            Effect.asVoid,
          );

    const span = SCHEDULER_SPAN_NAMES[spec.name];
    const iteration = spec.spanResultAttributes
      ? recover(withEffectSpan(span, {}, spec.tick, spec.spanResultAttributes))
      : withEffectSpan(span, {}, recover(spec.tick));

    // `forkScoped`, not `fork` — the bare `fork` API links the child fiber
    // to the *parent fiber's* lifetime, and the parent here is the Layer's
    // build gen function, which completes as soon as the Layer builds. With
    // `Effect.fork` the first scheduled iteration of
    // `Effect.repeat(Schedule.spaced)` never runs because the child is
    // interrupted at gen completion (verified by repro; diagnosed in #2864).
    // `forkScoped` binds to the Scope provided by `Layer.scoped`, so the
    // fiber lives until layer shutdown. No companion
    // `addFinalizer(Fiber.interrupt)` needed — scope handles it.
    yield* Effect.forkScoped(
      withFiberDeathLog(
        spec.name,
        iteration.pipe(Effect.repeat(Schedule.spaced(Duration.millis(intervalMs)))),
      ),
    );

    if (spec.startLog) log.info({ intervalMs }, spec.startLog);
  });
}

// ══════════════════════════════════════════════════════════════════════
// ██  Enterprise gate (#2563 slice 1/11 of #2017; #2564 slice 2/11)
// ══════════════════════════════════════════════════════════════════════
//
// `EnterpriseLayer` and the `EnterpriseSubsystem` union live in
// `./enterprise-layer` so the hono bridge can import them without
// pulling in the full startup DAG (the `InternalDB` chain, the
// SaaS guard family, the scheduler fibers). Re-exported here so
// existing consumers that grab them from `@atlas/api/lib/effect/layers`
// keep working unchanged.

export { EnterpriseLayer, type EnterpriseSubsystem };

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
          const { initTelemetry } = await import("@atlas/api/lib/telemetry");
          // Defaults service.name to "atlas-api" (or OTEL_SERVICE_NAME).
          return await initTelemetry();
        },
        catch: normalizeError,
      }).pipe(
        Effect.catchAll((err) => {
          log.error(
            { err },
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
            catch: normalizeError,
          }).pipe(
            Effect.catchAll((err) => {
              log.error({ err }, "Failed to shut down OTel SDK");
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

// The `Migration` Tag + `MigrationShape` moved to `./services` (#3743) so the
// wired plugin layer there can depend on Migration without importing this
// heavyweight boot module. Re-exported here so existing importers of `./layers`
// (and `effect/index.ts`) keep working unchanged.
export { Migration, type MigrationShape };

/**
 * Run CORE SCHEMA migrations at boot (Better Auth → Atlas internal, #1472
 * order). Depends on InternalDB — ensures pool is ready before migrations run.
 * Non-fatal: logs errors but does not fail the Layer.
 *
 * #3743 — runs `runBootMigrations()` (schema only), NOT the full
 * `migrateAuthTables()`. The post-schema bootstrap (loadPluginSettings, abuse
 * restore, admin/seed) moved to `AuthBootstrapLive`, which depends on the wired
 * plugin layer so `loadPluginSettings`'s `registry.disable()` still runs AFTER
 * plugin wiring (preserving the established order — wiring's `getByType` filters
 * on `enabled`). The `Migration` Tag here means "schema migrated", which is
 * exactly what every downstream consumer (seeds, hydrate, guards, the wired
 * plugin layer) actually gates on.
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

    const result = yield* Effect.tryPromise({
      try: async () => {
        const { runBootMigrations } = await import(
          "@atlas/api/lib/auth/migrate"
        );
        await runBootMigrations();
        return { migrated: true } satisfies MigrationShape;
      },
      catch: normalizeError,
    }).pipe(
      Effect.catchAll((err) => {
        log.error(
          { err },
          "Boot migration failed",
        );
        // Carry the underlying error message through the Migration Tag
        // so `MigrationGuardLive` can surface it on the boot-failure
        // log line in SaaS — review-flagged "MigrationsRequiredError
        // shouldn't punt to 'see prior log'" (#1988 PR review).
        return Effect.succeed({ migrated: false, error: err.message } satisfies MigrationShape);
      }),
    );

    return result;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  SaaS Trial Backfill Layer
// ══════════════════════════════════════════════════════════════════════

export interface BackfillSaasTrialShape {
  /** Number of organization rows promoted from 'free' to 'trial' this boot. */
  readonly updatedCount: number;
}

export class BackfillSaasTrial extends Context.Tag("BackfillSaasTrial")<
  BackfillSaasTrial,
  BackfillSaasTrialShape
>() {}

/**
 * One-time idempotent backfill that promotes existing SaaS workspaces
 * stuck on `plan_tier='free'` onto `'trial'` with `trial_ends_at = NOW()
 * + 14d`. Pairs with the signup-time `assignSaasTrial` hook (#2465)
 * which handles new orgs; this layer retires the legacy rows.
 *
 * Self-hosted is a no-op — the underlying function gates on
 * `deployMode === 'saas'`. Idempotent: the `trial_ends_at IS NULL`
 * clause makes subsequent boots find zero candidates.
 *
 * Depends on Migration so the `organization` table is guaranteed to
 * exist before the UPDATE; depends on InternalDB to keep the pool
 * ready. Non-fatal: errors logged but never fail the Layer.
 */
export const BackfillSaasTrialLive: Layer.Layer<
  BackfillSaasTrial,
  never,
  InternalDB | Migration
> = Layer.effect(
  BackfillSaasTrial,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    const migration = yield* Migration;
    if (!db.available || !migration.migrated) {
      // Match MigrationLive's "logged-reason" pattern so an operator
      // debugging "why didn't my SaaS region backfill?" can correlate
      // without grepping for absences.
      log.info(
        { available: db.available, migrated: migration.migrated },
        "SaaS trial backfill skipped — upstream gate (InternalDB or Migration) not satisfied",
      );
      return { updatedCount: 0 } satisfies BackfillSaasTrialShape;
    }

    const result = yield* Effect.tryPromise({
      try: async () => {
        const { backfillSaasTrial } = await import(
          "@atlas/api/lib/billing/backfill-saas-trial"
        );
        return await backfillSaasTrial();
      },
      // Preserve the original Error (stack trace included) so pino's
      // `err` serializer reports the throw site, not this catch site.
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        // Only reachable if the dynamic import itself rejects (e.g.
        // bundle artefact missing) — `backfillSaasTrial` catches its
        // own errors and never throws.
        log.error({ err }, "SaaS trial backfill threw");
        return Effect.succeed({ updatedCount: 0 } satisfies BackfillSaasTrialShape);
      }),
    );

    return { updatedCount: result.updatedCount } satisfies BackfillSaasTrialShape;
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Catalog Seed Layer (#2650 — 1.5.2 slice 2)
// ══════════════════════════════════════════════════════════════════════

/**
 * Discriminated outcome of the boot-time catalog seed. Mirrors
 * {@link ConnectionsHydrateOutcome} below so a future `/health` or
 * admin banner consumer can surface an unhealthy state without
 * re-grepping logs.
 *
 * - `skipped-gate`  — InternalDB or Migration upstream not satisfied
 * - `seeded`        — seed ran (may have applied 0 writes if config matched DB)
 * - `error`         — the boot wrapper or its dynamic import threw;
 *                     `plugin_catalog` reflects the pre-boot state
 */
export type CatalogSeedOutcome = "skipped-gate" | "seeded" | "error";

export interface CatalogSeedShape {
  /** Newly inserted plugin_catalog rows this boot. */
  readonly insertedCount: number;
  /** Rows whose mutable columns were updated to match config this boot. */
  readonly updatedCount: number;
  /**
   * Rows preserved at `enabled = false` because ops had manually
   * disabled them. Surfaced so admin observability tooling can flag the
   * config-vs-DB drift.
   */
  readonly preservedCount: number;
  /** Slugs in DB without a matching declaration. Logged at warn, never deleted. */
  readonly orphanSlugs: ReadonlyArray<string>;
  /** Discriminates intentional skip / normal seed / failure. */
  readonly outcome: CatalogSeedOutcome;
  /** Scrubbed error message when `outcome === "error"`. */
  readonly error?: string;
}

export class CatalogSeed extends Context.Tag("CatalogSeed")<
  CatalogSeed,
  CatalogSeedShape
>() {}

/**
 * Idempotent seed of `plugin_catalog` from `atlas.config.ts:catalog`.
 * Implements ADR-0002 S3 (config-driven, idempotently seeded).
 *
 * Depends on `Migration` so the new install_model + saas_eligible
 * columns (migration 0087) are guaranteed before the upsert; depends
 * on `InternalDB` for the pool. Non-fatal: the seeder swallows
 * errors internally and logs at error so a failed seed leaves
 * pre-existing rows authoritative for the boot rather than crashing
 * the API. The failure is observable via `CatalogSeedShape.outcome ===
 * "error"` so health surfaces can degrade instead of guessing.
 *
 * Self-hosted with an empty `catalog: []` (or omitted) is a quick
 * no-op: the seeder skips the upsert loop entirely and only emits the
 * orphan warn if any catalog rows linger.
 */
export const CatalogSeedLive: Layer.Layer<
  CatalogSeed,
  never,
  InternalDB | Migration
> = Layer.effect(
  CatalogSeed,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    const migration = yield* Migration;
    const zeroCounts = {
      insertedCount: 0,
      updatedCount: 0,
      preservedCount: 0,
      orphanSlugs: [] as ReadonlyArray<string>,
    };

    if (!db.available || !migration.migrated) {
      log.info(
        { available: db.available, migrated: migration.migrated },
        "Catalog seed skipped — upstream gate (InternalDB or Migration) not satisfied",
      );
      return { ...zeroCounts, outcome: "skipped-gate" } satisfies CatalogSeedShape;
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const { runCatalogSeedBoot } = await import(
          "@atlas/api/lib/integrations/catalog-seeder"
        );
        const result = await runCatalogSeedBoot();
        return {
          insertedCount: result.insertedCount,
          updatedCount: result.updatedCount,
          preservedCount: result.preservedCount,
          orphanSlugs: result.orphanSlugs,
          outcome: "seeded",
        } satisfies CatalogSeedShape;
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        // Reachable when the dynamic import itself rejects (bundle
        // artefact missing, runtime ESM resolution issue) — the
        // `runCatalogSeedBoot` wrapper catches its own SQL/DB errors.
        // We still surface the failure via `outcome: "error"` so
        // healthCheck consumers can degrade.
        log.error({ err }, "Catalog seed boot wrapper threw");
        return Effect.succeed({
          ...zeroCounts,
          outcome: "error",
          error: errorMessage(err),
        } satisfies CatalogSeedShape);
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Built-in Datasource Catalog Seed Layer (#2743 — 1.5.3 slice 5)
// ══════════════════════════════════════════════════════════════════════

/**
 * Discriminated outcome of the boot-time built-in Datasource catalog
 * seed. Distinct from {@link CatalogSeedOutcome} because the built-in
 * seed is code-driven (eight fixed rows) while the atlas.config.ts
 * seed is operator-driven. Per ADR-0007, the built-in seed runs in
 * addition to the atlas.config.ts seed, not instead of it.
 *
 * - `skipped-gate`  — InternalDB or Migration upstream not satisfied
 * - `seeded`        — seed ran (preservedSlugs may include all eight on re-boot)
 * - `error`         — the boot wrapper or its dynamic import threw;
 *                     pre-existing rows answer admin-UI reads
 */
export type BuiltinDatasourceCatalogSeedOutcome =
  | "skipped-gate"
  | "seeded"
  | "error";

export interface BuiltinDatasourceCatalogSeedShape {
  /** Slugs whose row was newly inserted this boot. */
  readonly insertedSlugs: ReadonlyArray<string>;
  /**
   * Slugs whose row already existed and was preserved (ON CONFLICT DO
   * NOTHING). Re-boots on a healthy DB land every built-in slug here.
   */
  readonly preservedSlugs: ReadonlyArray<string>;
  readonly outcome: BuiltinDatasourceCatalogSeedOutcome;
  /** Scrubbed error message when `outcome === "error"`. */
  readonly error?: string;
}

export class BuiltinDatasourceCatalogSeed extends Context.Tag(
  "BuiltinDatasourceCatalogSeed",
)<BuiltinDatasourceCatalogSeed, BuiltinDatasourceCatalogSeedShape>() {}

/**
 * Idempotent boot-time seed of the eight built-in Datasource catalog
 * rows. Per ADR-0007 these are code-seeded (not declared in
 * `atlas.config.ts`) and re-asserted on every boot via
 * `ON CONFLICT (slug) DO NOTHING`.
 *
 * Depends on `Migration` so the `pillar` / `implementation_status` /
 * `auto_install` columns added by migration 0092 exist before the
 * INSERT; depends on `InternalDB` for the pool.
 *
 * **Inert in slice 5 (#2743)** — `ConnectionRegistry` still reads from
 * the `connections` table; nothing consumes these rows yet. Slice 6
 * (#2744) pivots `ConnectionRegistry` to read from
 * `workspace_plugins WHERE pillar = 'datasource'`, at which point the
 * eight rows seeded here become live install targets.
 *
 * Non-fatal: the boot wrapper swallows errors and logs at error so a
 * failed seed leaves pre-existing rows authoritative.
 */
export const BuiltinDatasourceCatalogSeedLive: Layer.Layer<
  BuiltinDatasourceCatalogSeed,
  never,
  InternalDB | Migration
> = Layer.effect(
  BuiltinDatasourceCatalogSeed,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    const migration = yield* Migration;
    const zeroCounts = {
      insertedSlugs: [] as ReadonlyArray<string>,
      preservedSlugs: [] as ReadonlyArray<string>,
    };

    if (!db.available || !migration.migrated) {
      log.info(
        { available: db.available, migrated: migration.migrated },
        "Built-in Datasource catalog seed skipped — upstream gate not satisfied",
      );
      return {
        ...zeroCounts,
        outcome: "skipped-gate",
      } satisfies BuiltinDatasourceCatalogSeedShape;
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const { runBuiltinDatasourceCatalogSeedBoot } = await import(
          "@atlas/api/lib/db/seed-builtin-datasource-catalog"
        );
        const result = await runBuiltinDatasourceCatalogSeedBoot();
        switch (result.kind) {
          case "skipped":
            return {
              ...zeroCounts,
              outcome: "skipped-gate",
            } satisfies BuiltinDatasourceCatalogSeedShape;
          case "seeded":
            return {
              insertedSlugs: result.insertedSlugs,
              preservedSlugs: result.preservedSlugs,
              outcome: "seeded",
            } satisfies BuiltinDatasourceCatalogSeedShape;
          case "error":
            // `runBuiltinDatasourceCatalogSeedBoot` already logged at
            // error; surface the message to health consumers via the
            // documented `outcome: "error"` contract.
            return {
              ...zeroCounts,
              outcome: "error",
              error: result.message,
            } satisfies BuiltinDatasourceCatalogSeedShape;
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        // Reachable when the dynamic import itself rejects — the
        // `runBuiltinDatasourceCatalogSeedBoot` wrapper catches its own
        // SQL/DB errors. We still surface the failure via
        // `outcome: "error"` so healthCheck consumers can degrade.
        log.error({ err }, "Built-in Datasource catalog seed boot wrapper threw");
        return Effect.succeed({
          ...zeroCounts,
          outcome: "error",
          error: errorMessage(err),
        } satisfies BuiltinDatasourceCatalogSeedShape);
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Built-in Knowledge Base Catalog Seed Layer (#4206 — ADR-0028)
// ══════════════════════════════════════════════════════════════════════

/**
 * Discriminated outcome of the boot-time built-in Knowledge Base catalog
 * seed (the `okf-upload` #4206 and `bundle-sync` #4211 rows, ADR-0028 §5).
 * Mirrors {@link BuiltinDatasourceCatalogSeedOutcome}.
 *
 * - `skipped-gate`  — InternalDB or Migration upstream not satisfied
 * - `seeded`        — seed ran (`inserted` false on re-boot with both rows present)
 * - `error`         — the boot wrapper or its dynamic import threw;
 *                     pre-existing rows answer admin-UI reads
 */
export type BuiltinKnowledgeCatalogSeedOutcome =
  | "skipped-gate"
  | "seeded"
  | "error";

export interface BuiltinKnowledgeCatalogSeedShape {
  /**
   * True when ANY built-in knowledge catalog row (`okf-upload`,
   * `bundle-sync`) was newly inserted this boot.
   */
  readonly inserted: boolean;
  readonly outcome: BuiltinKnowledgeCatalogSeedOutcome;
  /** Scrubbed error message when `outcome === "error"`. */
  readonly error?: string;
}

export class BuiltinKnowledgeCatalogSeed extends Context.Tag(
  "BuiltinKnowledgeCatalogSeed",
)<BuiltinKnowledgeCatalogSeed, BuiltinKnowledgeCatalogSeedShape>() {}

/**
 * Idempotent boot-time seed of the built-in Knowledge Base catalog rows —
 * `okf-upload` (#4206) and `bundle-sync` (#4211), ADR-0028. Code-seeded
 * through the operator-curated seam and re-asserted on every boot via
 * `ON CONFLICT DO NOTHING`.
 *
 * Depends on `Migration` so migration 0161's widened pillar CHECK (which
 * admits `pillar = 'knowledge'`) is guaranteed before the INSERTs; depends on
 * `InternalDB` for the pool. Non-fatal: the boot wrapper swallows errors and
 * logs at error so a failed seed leaves the pre-existing rows authoritative.
 */
export const BuiltinKnowledgeCatalogSeedLive: Layer.Layer<
  BuiltinKnowledgeCatalogSeed,
  never,
  InternalDB | Migration
> = Layer.effect(
  BuiltinKnowledgeCatalogSeed,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    const migration = yield* Migration;

    if (!db.available || !migration.migrated) {
      log.info(
        { available: db.available, migrated: migration.migrated },
        "Built-in Knowledge Base catalog seed skipped — upstream gate not satisfied",
      );
      return {
        inserted: false,
        outcome: "skipped-gate",
      } satisfies BuiltinKnowledgeCatalogSeedShape;
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const { runBuiltinKnowledgeCatalogSeedBoot } = await import(
          "@atlas/api/lib/db/seed-builtin-knowledge-catalog"
        );
        const result = await runBuiltinKnowledgeCatalogSeedBoot();
        switch (result.kind) {
          case "skipped":
            return {
              inserted: false,
              outcome: "skipped-gate",
            } satisfies BuiltinKnowledgeCatalogSeedShape;
          case "seeded":
            return {
              inserted: result.inserted,
              outcome: "seeded",
            } satisfies BuiltinKnowledgeCatalogSeedShape;
          case "error":
            return {
              inserted: false,
              outcome: "error",
              error: result.message,
            } satisfies BuiltinKnowledgeCatalogSeedShape;
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        log.error({ err }, "Built-in Knowledge Base catalog seed boot wrapper threw");
        return Effect.succeed({
          inserted: false,
          outcome: "error",
          error: errorMessage(err),
        } satisfies BuiltinKnowledgeCatalogSeedShape);
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  OpenAPI Generic Datasource Catalog Seed (#2926 — v0.0.2 slice 2)
// ══════════════════════════════════════════════════════════════════════

export type OpenApiDatasourceCatalogSeedOutcome =
  | "skipped-gate"
  | "seeded"
  | "error";

export interface OpenApiDatasourceCatalogSeedShape {
  /** `true` when the boot re-assert inserted the row (was missing). */
  readonly inserted: boolean;
  readonly outcome: OpenApiDatasourceCatalogSeedOutcome;
  /** Scrubbed error message when `outcome === "error"`. */
  readonly error?: string;
}

export class OpenApiDatasourceCatalogSeed extends Context.Tag(
  "OpenApiDatasourceCatalogSeed",
)<OpenApiDatasourceCatalogSeed, OpenApiDatasourceCatalogSeedShape>() {}

/**
 * Idempotent boot-time seed of the built-in `openapi-generic` Datasource
 * catalog row (PRD #2868 slice 2, #2926). Code-seeded per ADR-0007, re-asserted
 * every boot via a bare `ON CONFLICT DO NOTHING`. Parallel peer of
 * `BuiltinDatasourceCatalogSeedLive` — the two touch disjoint slugs, and this
 * one is kept SEPARATE so the REST datasource never enters the SQL slug
 * allowlist / pool resolver (see `lib/openapi/catalog-seed.ts` header).
 *
 * Non-fatal: the boot wrapper swallows errors and logs at error so a failed
 * seed leaves the migration-0108 row authoritative.
 */
export const OpenApiDatasourceCatalogSeedLive: Layer.Layer<
  OpenApiDatasourceCatalogSeed,
  never,
  InternalDB | Migration
> = Layer.effect(
  OpenApiDatasourceCatalogSeed,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    const migration = yield* Migration;

    if (!db.available || !migration.migrated) {
      log.info(
        { available: db.available, migrated: migration.migrated },
        "openapi-generic catalog seed skipped — upstream gate not satisfied",
      );
      return {
        inserted: false,
        outcome: "skipped-gate",
      } satisfies OpenApiDatasourceCatalogSeedShape;
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const { runOpenApiDatasourceCatalogSeedBoot } = await import(
          "@atlas/api/lib/openapi/catalog-seed"
        );
        const result = await runOpenApiDatasourceCatalogSeedBoot();
        switch (result.kind) {
          case "skipped":
            return {
              inserted: false,
              outcome: "skipped-gate",
            } satisfies OpenApiDatasourceCatalogSeedShape;
          case "seeded":
            return {
              inserted: result.inserted,
              outcome: "seeded",
            } satisfies OpenApiDatasourceCatalogSeedShape;
          case "error":
            return {
              inserted: false,
              outcome: "error",
              error: result.message,
            } satisfies OpenApiDatasourceCatalogSeedShape;
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        log.error({ err }, "openapi-generic catalog seed boot wrapper threw");
        return Effect.succeed({
          inserted: false,
          outcome: "error",
          error: errorMessage(err),
        } satisfies OpenApiDatasourceCatalogSeedShape);
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Implementation-Status Override Layer (#2747 — 1.5.3 slice 9)
// ══════════════════════════════════════════════════════════════════════

/**
 * Discriminated outcome of the boot-time
 * `overrideImplementationStatus` consumer. Mirrors the two seed
 * Layers' shapes so a future `/health` consumer can treat the three
 * post-seed outcomes (skipped, applied, error) uniformly.
 */
export type ImplementationStatusOverrideOutcome =
  | "skipped-gate"
  | "skipped-empty"
  | "applied"
  | "error";

export interface ImplementationStatusOverrideShape {
  /** UPDATEs issued this boot. */
  readonly updatedCount: number;
  /** Slugs in the override that didn't match a catalog row. */
  readonly unmatchedSlugs: ReadonlyArray<string>;
  readonly outcome: ImplementationStatusOverrideOutcome;
  /** Scrubbed error message when `outcome === "error"`. */
  readonly error?: string;
}

export class ImplementationStatusOverride extends Context.Tag(
  "ImplementationStatusOverride",
)<ImplementationStatusOverride, ImplementationStatusOverrideShape>() {}

/**
 * Apply `atlas.config.ts:overrideImplementationStatus` against
 * `plugin_catalog`. Runs after BOTH seed Layers complete so the
 * override is the final word for `implementation_status` on the
 * boot — a re-asserting `EXCLUDED.implementation_status` from the
 * catalog seeder cannot land afterward. The Tag dependencies on
 * `CatalogSeed` + `BuiltinDatasourceCatalogSeed` encode the
 * ordering at the type level.
 *
 * Non-fatal: the boot wrapper swallows errors and logs at error so
 * a failed override leaves the seed output authoritative. The
 * failure is observable via `outcome: "error"` for health surfaces.
 *
 * **SaaS:** every catalog row's `implementation_status` is declared
 * directly in `deploy/api/atlas.config.ts:catalog`; the override
 * field stays empty and this Layer logs `skipped-empty`. Slice 9's
 * primary user is the self-host operator who shipped their own
 * handler for a Platform Atlas marks `coming_soon`.
 */
export const ImplementationStatusOverrideLive: Layer.Layer<
  ImplementationStatusOverride,
  never,
  InternalDB | Migration | CatalogSeed | BuiltinDatasourceCatalogSeed
> = Layer.effect(
  ImplementationStatusOverride,
  Effect.gen(function* () {
    const db = yield* InternalDB;
    const migration = yield* Migration;
    // Yielding the two seed Tags is the load-bearing line — Effect
    // memoizes the same-Tag layers, so adding them here doesn't
    // re-run the seeds. The dependency *ordering* is what we need.
    yield* CatalogSeed;
    yield* BuiltinDatasourceCatalogSeed;

    const zeroCounts = {
      updatedCount: 0,
      unmatchedSlugs: [] as ReadonlyArray<string>,
    };

    if (!db.available || !migration.migrated) {
      log.info(
        { available: db.available, migrated: migration.migrated },
        "Implementation-status override skipped — upstream gate not satisfied",
      );
      return {
        ...zeroCounts,
        outcome: "skipped-gate",
      } satisfies ImplementationStatusOverrideShape;
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const { runImplementationStatusOverrideBoot } = await import(
          "@atlas/api/lib/integrations/implementation-status-override"
        );
        const result = await runImplementationStatusOverrideBoot();
        switch (result.kind) {
          case "skipped":
            // Three skip reasons, two outcomes:
            //   - `no-internal-db` should be unreachable here (the Layer's
            //     `!db.available` gate above already caught it), but if a
            //     future refactor decouples the gate from the wrapper this
            //     surfaces as `skipped-gate` instead of mislabelling.
            //   - `no-config` mid-boot is genuinely unexpected — the Config
            //     Tag should have loaded by the time the override Layer
            //     runs — so surface as `error` for health visibility.
            //   - `empty-override` is the SaaS-norm path and the explicit
            //     "operator declared nothing" path on self-host.
            switch (result.reason) {
              case "no-internal-db":
                return {
                  ...zeroCounts,
                  outcome: "skipped-gate",
                } satisfies ImplementationStatusOverrideShape;
              case "no-config":
                return {
                  ...zeroCounts,
                  outcome: "error",
                  error: "Implementation-status override: no resolved config at post-seed boot phase",
                } satisfies ImplementationStatusOverrideShape;
              case "empty-override":
                return {
                  ...zeroCounts,
                  outcome: "skipped-empty",
                } satisfies ImplementationStatusOverrideShape;
            }
            break;
          case "applied":
            return {
              updatedCount: result.updatedCount,
              unmatchedSlugs: result.unmatchedSlugs,
              outcome: "applied",
            } satisfies ImplementationStatusOverrideShape;
          case "error":
            return {
              ...zeroCounts,
              outcome: "error",
              // Scrub the wrapper's message at the Layer boundary —
              // a pg connection-string echo in the underlying error
              // shouldn't survive into the Tag value the health
              // surface reads.
              error: errorMessage(new Error(result.message)),
            } satisfies ImplementationStatusOverrideShape;
        }
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.catchAll((err) => {
        log.error({ err }, "Implementation-status override boot wrapper threw");
        return Effect.succeed({
          ...zeroCounts,
          outcome: "error",
          error: errorMessage(err),
        } satisfies ImplementationStatusOverrideShape);
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Connections Hydrate Layer
// ══════════════════════════════════════════════════════════════════════

/**
 * Discriminated outcome of the boot-time hydrate. Distinguishes
 * "registry intentionally left empty" (skipped or no rows) from
 * "hydrate threw and registry is empty when it shouldn't be" so a
 * future `/health` or admin banner consumer can surface the latter
 * without re-grepping logs.
 */
export type ConnectionsHydrateOutcome =
  | "skipped-gate"
  | "empty"
  | "registered"
  | "error";

export interface ConnectionsHydrateShape {
  /** Number of connections registered into the runtime registry. */
  readonly count: number;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
  /** Discriminates intentional zero (skip / empty) from a failure that produced zero. */
  readonly outcome: ConnectionsHydrateOutcome;
  /** Scrubbed error message when `outcome === "error"`. */
  readonly error?: string;
}

export class ConnectionsHydrate extends Context.Tag("ConnectionsHydrate")<
  ConnectionsHydrate,
  ConnectionsHydrateShape
>() {}

/**
 * Production loader. The Layer body is testable by passing a stub via
 * `makeConnectionsHydrateLive(load)`; the default loader does the real
 * dynamic import + DB read.
 */
const defaultLoadSavedConnections = async (): Promise<number> => {
  const { loadSavedConnections } = await import(
    "@atlas/api/lib/db/internal"
  );
  return loadSavedConnections();
};

/**
 * Rebuild the runtime `ConnectionRegistry` from the internal `connections`
 * table at boot. Reads every non-archived row, decrypts the URL via
 * `decryptSecret`, and calls `connections.register(id, ...)` so that
 * immediately after a deploy the in-memory registry matches the DB
 * without any user PUT/onboarding round-trip.
 *
 * Depends on `Migration` (so the `connections` table is guaranteed to
 * exist) and `InternalDB` (for the pool). Non-fatal: per-row decryption
 * failures (key rotation, corrupted ciphertext) log a warning and skip
 * the row — they never crash boot. The query also includes a
 * `status != 'archived'` filter so the per-org tombstone rows from the
 * delete-as-hide flow in `admin-connections.ts` don't feed their
 * empty-string `url` marker to `decryptSecret`.
 *
 * Exposed as a factory so tests can inject a stub `load` to exercise
 * the `Effect.catchAll` branch without module-level mocking. The
 * exported `ConnectionsHydrateLive` binds the production loader.
 */
export function makeConnectionsHydrateLive(
  load: () => Promise<number> = defaultLoadSavedConnections,
): Layer.Layer<ConnectionsHydrate, never, InternalDB | Migration | PluginRegistry> {
  return Layer.effect(
    ConnectionsHydrate,
    Effect.gen(function* () {
      const start = performance.now();
      const db = yield* InternalDB;
      const migration = yield* Migration;
      // #3743 — ordering barrier: `loadSavedConnections` builds DB-stored plugin
      // datasource connections via `findDatasourcePluginConnection`, which reads
      // the GLOBAL plugin registry (`plugins.getAll()`). So datasource plugins
      // must be REGISTERED + wired before hydrate runs. In the imperative boot
      // this held because wiring ran before `buildAppLayer`; now the wired plugin
      // layer is part of the DAG, so this edge makes the dependency explicit. The
      // value is unused — the dependency ordering is the point.
      yield* PluginRegistry;
      if (!db.available || !migration.migrated) {
        const durationMs = Math.round(performance.now() - start);
        log.info(
          { available: db.available, migrated: migration.migrated, durationMs },
          "Connections hydrate skipped — upstream gate (InternalDB or Migration) not satisfied",
        );
        return {
          count: 0,
          durationMs,
          outcome: "skipped-gate",
        } satisfies ConnectionsHydrateShape;
      }

      const result = yield* Effect.tryPromise({
        try: load,
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((count) => ({ ok: true as const, count })),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            const message = errorMessage(err);
            log.error({ err: message }, "Connections hydrate threw — runtime registry left empty");
            return { ok: false as const, error: message };
          }),
        ),
      );
      const durationMs = Math.round(performance.now() - start);

      if (!result.ok) {
        return {
          count: 0,
          durationMs,
          outcome: "error",
          error: result.error,
        } satisfies ConnectionsHydrateShape;
      }

      if (result.count > 0) {
        log.info(
          { count: result.count, durationMs },
          "Hydrated runtime ConnectionRegistry from internal DB",
        );
        return {
          count: result.count,
          durationMs,
          outcome: "registered",
        } satisfies ConnectionsHydrateShape;
      }

      log.debug({ durationMs }, "Connections hydrate complete — no rows registered");
      return { count: 0, durationMs, outcome: "empty" } satisfies ConnectionsHydrateShape;
    }),
  );
}

/** Production binding — uses the real `loadSavedConnections()` from `db/internal.ts`. */
export const ConnectionsHydrateLive: Layer.Layer<
  ConnectionsHydrate,
  never,
  InternalDB | Migration | PluginRegistry
> = makeConnectionsHydrateLive();

// ══════════════════════════════════════════════════════════════════════
// ██  Auth Bootstrap Layer (#3743)
// ══════════════════════════════════════════════════════════════════════

/**
 * Post-schema boot bootstrap: plugin settings, abuse-state restore, admin
 * bootstrap + dev seed (via `runPostMigrationBootstrap`).
 *
 * Split out of `MigrationLive` (#3743). Depends on:
 *   - `Migration` — schema must exist before bootstrap reads/writes it.
 *   - `PluginRegistry` (the wired plugin layer) — `loadPluginSettings` calls
 *     `registry.disable()`, and wiring's `getByType` filters on `enabled`, so
 *     this step MUST run AFTER plugin wiring to preserve the established order
 *     (a DB-disabled datasource plugin stays wired-then-disabled, exactly as in
 *     the pre-#3743 imperative boot — NOT excluded from wiring).
 *
 * Non-fatal: `runPostMigrationBootstrap` self-gates on `hasInternalDB()` /
 * `detectAuthMode()` and each phase catches its own errors. A dynamic-import
 * failure here is logged, never crashes boot.
 */
export const AuthBootstrapLive: Layer.Layer<
  never,
  never,
  Migration | PluginRegistry | AbuseResponse
> = Layer.effectDiscard(
  Effect.gen(function* () {
    // Ordering barriers — values unused; the dependency edges are the point.
    yield* Migration;
    yield* PluginRegistry;
    // #4000 (WS5): `runPostMigrationBootstrap` calls `restoreAbuseState`,
    // which delegates to the sync `AbuseResponsePolicy` holder. On an
    // enterprise deploy that holder is only populated as a side effect of
    // building `AbuseResponseLive` (`setAbuseResponsePolicy` in its
    // `Layer.sync` factory). Without this barrier, `AuthBootstrapLive` and
    // `AbuseResponse` are independent siblings in the top-level mergeAll with
    // no build-order guarantee, so the restore could run against the inert
    // no-op policy — silently dropping rehydration of suspended tenants
    // across restarts. Yielding the Tag forces the EE layer (and its
    // registration) to build first, restoring the pre-split invariant that
    // `restoreAbuseState` always rehydrates when an internal DB is present.
    yield* AbuseResponse;

    yield* Effect.tryPromise({
      try: async () => {
        const { runPostMigrationBootstrap } = await import(
          "@atlas/api/lib/auth/migrate"
        );
        await runPostMigrationBootstrap();
      },
      catch: normalizeError,
    }).pipe(
      Effect.catchAll((err) => {
        log.error({ err }, "Post-migration bootstrap failed");
        return Effect.void;
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Pool Warmup Layer (#3743)
// ══════════════════════════════════════════════════════════════════════

/**
 * Pre-warm connection pools after all datasources are registered. Replaces the
 * imperative `connections.warmup()` that ran in server.ts before the DAG.
 *
 * Depends on:
 *   - `PluginRegistry` (wired plugin layer) — config-declared plugin datasources
 *     registered.
 *   - `ConnectionsHydrate` — DB-stored connections registered.
 *
 * Because it now runs after BOTH, warmup covers DB-hydrated connections too
 * (the pre-#3743 imperative call ran before hydrate and warmed only config /
 * already-registered pools) — strictly more complete. Non-fatal.
 */
export const PoolWarmupLive: Layer.Layer<
  never,
  never,
  PluginRegistry | ConnectionsHydrate
> = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* PluginRegistry;
    yield* ConnectionsHydrate;

    yield* Effect.tryPromise({
      try: async () => {
        const { connections } = await import("@atlas/api/lib/db/connection");
        await connections.warmup();
      },
      catch: normalizeError,
    }).pipe(
      Effect.catchAll((err) => {
        log.error(
          { err },
          "Pool warmup failed — datasource may be unreachable",
        );
        return Effect.void;
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  Staging Seed Layer (#2914 — staging slice 7)
// ══════════════════════════════════════════════════════════════════════

/**
 * Boot wiring for {@link ensureStagingSeed}. Runs after migrations + the
 * catalog seeders, before the HTTP server binds (`server.ts` awaits
 * `runtime.runtimeEffect` before `Bun.serve`).
 *
 * Unlike the non-fatal seeders above, a genuine seed failure is NOT
 * swallowed: the `StagingSeedError` propagates so `buildAppLayer`'s DAG
 * fails and `server.ts` exits non-zero. A misconfigured staging boot is
 * loud (#2914 acceptance: "Boot failure surfaces ... not swallowed").
 *
 * Dependencies:
 *   - `InternalDB` / `Migration` — the readiness gate (mirrors the other
 *     boot layers; a not-ready DB yields `skipped-gate` rather than a crash).
 *   - `BuiltinDatasourceCatalogSeed` — an ordering barrier so the
 *     `demo-postgres` catalog row exists before the staging org installs it.
 *     Effect memoizes the same-Tag layer, so this does not re-run the seed.
 *
 * The region gate is the FIRST statement: on `us`/`eu`/`apac` (or region
 * unset) this returns immediately, touching no DB and emitting no log line
 * (#2914 acceptance: "seed code does not execute").
 */
export const StagingSeedLive: Layer.Layer<
  StagingSeed,
  StagingSeedError,
  InternalDB | Migration | BuiltinDatasourceCatalogSeed
> = Layer.effect(
  StagingSeed,
  Effect.gen(function* () {
    // Boot assert (#2985): a staging-shaped deploy (ATLAS_DEPLOY_ENV=staging)
    // MUST stamp ATLAS_API_REGION=staging, else the outbound mail clamp
    // (lib/email/delivery.ts) can't recognize the box as staging and would
    // email real recipients. Runs BEFORE the region gate below so the
    // dangerous "env=staging, region=us" misconfig is caught — the gate would
    // otherwise early-return `skipped-region` and let the box serve real mail.
    // A throw here becomes a boot-DAG defect → server.ts exits non-zero: a
    // misconfigured staging boot is loud, never a silent skip (#2914 precedent).
    assertStagingMailRegion();

    // Region gate first — non-staging boots are provably inert.
    if (getApiRegion() !== "staging") {
      return { outcome: "skipped-region" } satisfies StagingSeedResult;
    }

    const db = yield* InternalDB;
    const migration = yield* Migration;
    // Ordering barrier — see the dependency note above.
    yield* BuiltinDatasourceCatalogSeed;

    if (!db.available || !migration.migrated) {
      log.info(
        { available: db.available, migrated: migration.migrated },
        "Staging seed skipped — upstream gate (InternalDB or Migration) not satisfied",
      );
      return { outcome: "skipped-gate" } satisfies StagingSeedResult;
    }

    // Let StagingSeedError propagate — boot fails loudly, never silently.
    return yield* ensureStagingSeed();
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
      catch: normalizeError,
    }).pipe(
      Effect.catchAll((err) => {
        log.error({ err }, "Semantic sync failed");
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
      catch: normalizeError,
    }).pipe(
      Effect.catchAll((err) => {
        log.error({ err }, "Settings load failed");
        return Effect.succeed(0);
      }),
    );

    // In SaaS mode, fork a periodic refresh fiber for multi-instance
    // consistency. Registered via `registerPeriodicFiber`, which owns the
    // gate/span/forkScoped choreography (#4130) — see the helper for the
    // forkScoped-vs-fork rationale (#2864).
    yield* registerPeriodicFiber({
      name: "settings_refresh",
      intervalMs: resolveSettingsRefreshInterval,
      gate: {
        check: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { getConfig } = require("@atlas/api/lib/config") as { getConfig: () => { deployMode?: string } | null };
          return getConfig()?.deployMode === "saas";
        },
        failLog: "Config not available for SaaS detection — defaulting to self-hosted",
      },
      tick: Effect.tryPromise({
        try: async () => {
          const { refreshSettingsTick } = await import("@atlas/api/lib/settings");
          await refreshSettingsTick();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }),
      onTickFailure: {
        level: "warn",
        message: "Periodic settings refresh failed — will retry next interval",
      },
      startLog: "Started periodic settings refresh fiber",
    });

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
): Layer.Layer<
  Scheduler,
  never,
  AuditPurgeScheduler | BackupsManager | SaasCrm | Migration | DurableSession | DurableState
> {
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

      // Start main scheduler.
      //
      // PER-REGION SCHEDULER (#4623, supersedes the #3687 "single global US"
      // framing). The engine starts wherever `config.scheduler.backend === "bun"`.
      // On the 3-region deploy the shared file config (deploy/api/atlas.config.ts)
      // sets that for EVERY region, and each region runs its OWN internal DB
      // (us/eu/apac-int-postgres, via each service's own DATABASE_URL) — so each
      // region's fiber processes its own tenants' `scheduled_tasks` in-region.
      // There is NO shared internal DB and no cross-region execution (the earlier
      // "US fiber executes every workspace's tasks" note assumed a shared DB that
      // does not exist here). `config.scheduler` is the single source of truth,
      // shared with the `/health` reporter and the task-creation route gate, so
      // all three agree per region.
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
      yield* registerPeriodicFiber({
        name: "onboarding_email",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS } = require("@atlas/api/lib/email/scheduler") as {
            DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS: number;
          };
          return DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS;
        },
        gate: {
          check: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { isEmailSchedulerEnabled } = require("@atlas/api/lib/email/scheduler") as {
              isEmailSchedulerEnabled: () => boolean;
            };
            return isEmailSchedulerEnabled();
          },
          failLog: "Email scheduler module not available — skipping",
          skipLog: "Onboarding email scheduler not started — feature disabled",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { runTick } = await import("@atlas/api/lib/email/scheduler");
            await runTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Onboarding email tick failed" },
      });

      // ── Periodic fiber: autonomous-improvement scheduler (#1269, #4516) ──
      // SaaS-first: the gate is the PLATFORM master switch (does the fiber run
      // on this deployment at all). The per-workspace opt-in + billing gate +
      // org-stamping live INSIDE the tick (runExpertSchedulerTick), so the
      // deploy-mode force-disable boot-guard (#4487) is retired — the fiber
      // runs on SaaS, gated per-workspace.
      yield* registerPeriodicFiber({
        name: "expert_scheduler",
        // Settings-registry-backed (platform DB override > env > default);
        // boot-consumed, so retuning needs a restart (#3392/#3399).
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { getExpertSchedulerIntervalMs } = require("@atlas/api/lib/semantic/expert/scheduler") as {
            getExpertSchedulerIntervalMs: () => number;
          };
          return getExpertSchedulerIntervalMs();
        },
        gate: {
          check: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { isExpertSchedulerEnabled } = require("@atlas/api/lib/semantic/expert/scheduler") as {
              isExpertSchedulerEnabled: () => boolean;
            };
            return isExpertSchedulerEnabled();
          },
          failLog: "Expert scheduler module not available — skipping",
          skipLog: "Semantic expert scheduler not started — feature disabled",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { runExpertSchedulerTick } = await import("@atlas/api/lib/semantic/expert/scheduler");
            await runExpertSchedulerTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Expert scheduler tick failed" },
        startLog: "Semantic expert scheduler started",
      });

      // ── Periodic fiber: learned-pattern auto-promote/decay (#3636, #4582) ──
      // SaaS-first: NO platform enable gate. The retired master switch was
      // boot-consumed, so it could never hot-reload a workspace opting in; the
      // fiber now always runs and resolves the opted-in workspaces per tick (the
      // workspace-scoped ATLAS_LEARN_PROMOTE_DECAY_ENABLED trust dial, off by
      // default), so the dial takes effect on the next tick with no restart. The
      // tick no-ops cheaply when no workspace opted in or there's no internal DB.
      yield* registerPeriodicFiber({
        name: "promote_decay",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { getPromoteDecaySchedulerIntervalMs } = require("@atlas/api/lib/learn/promote-decay-scheduler") as {
            getPromoteDecaySchedulerIntervalMs: () => number;
          };
          return getPromoteDecaySchedulerIntervalMs();
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { runPromoteDecayTick } = await import("@atlas/api/lib/learn/promote-decay-scheduler");
            await runPromoteDecayTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Promote/decay tick failed" },
        startLog: "Learned-pattern auto-promote/decay scheduler started",
      });

      // ── Periodic fiber: plan-tier reconciliation sweep (#3423) ──────
      // Safety net under the Stripe webhook path: heals plan_tier drift
      // from the plugin's subscription table and prunes the webhook
      // event ledger. Only meaningful when Stripe billing is wired AND
      // an internal DB holds the org/subscription tables.
      //
      // #3446 — migration barrier: `Effect.repeat` runs the reconcile
      // tick eagerly on boot, and on a fresh deploy that first tick can
      // otherwise race migration 0128 (`stripe_webhook_events` not yet
      // created), fail one warn, and back off 6 hours instead of healing
      // on boot. The `Migration` dependency edge sequences Scheduler
      // construction after `MigrationLive` completes (same
      // ordering-barrier shape as `connectionsHydrateLayer` /
      // `stagingSeedLayer`); this yield pins the requirement in the
      // Layer's R so `buildAppLayer` can't drop the `migrationLayer`
      // provide without a compile error. The value is deliberately
      // unused — `migrated: false` (no DATABASE_URL, self-hosted) still
      // proceeds to the `hasInternalDB()` gate, which short-circuits
      // exactly as before.
      yield* Migration;
      yield* registerPeriodicFiber({
        name: "billing_reconcile",
        // Default 6h: drift heals well inside Stripe's ~3-week retry horizon
        // without adding meaningful load (one org-table scan per pass).
        // Settings-registry-backed (#4130): platform DB override > env >
        // default; boot-consumed, so retuning needs a restart (not a
        // redeploy) — same shape as expert_scheduler (#3399). `Effect.repeat`
        // runs the tick once at boot, then on the spacing — so a deploy also
        // doubles as an immediate reconcile.
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { getBillingReconcileIntervalMs } = require("@atlas/api/lib/billing/reconcile-plan-tiers") as {
            getBillingReconcileIntervalMs: () => number;
          };
          return getBillingReconcileIntervalMs();
        },
        gate: {
          check: () => {
            if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
              return false;
            }
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          failLog: "Billing reconcile gate check failed — skipping",
          skipLog:
            "Plan-tier reconciliation sweep not started — Stripe billing or internal DB not configured",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { reconcilePlanTiers } = await import(
              "@atlas/api/lib/billing/reconcile-plan-tiers"
            );
            await reconcilePlanTiers();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: {
          level: "warn",
          message: "Plan-tier reconciliation tick failed — will retry next interval",
        },
        startLog: "Plan-tier reconciliation sweep started",
      });

      // ── Periodic fiber: Stripe teardown outbox sweep (#3679) ────────
      // Symmetric counterpart to the plan-tier reconcile above: drains the
      // `stripe_teardown_pending` outbox, retrying the subscription-cancel /
      // customer-delete ops a Stripe outage stranded during workspace
      // delete/purge until success or `resource_missing`. Unlike the
      // plan-tier sweep it does NOT need the webhook secret — only
      // `STRIPE_SECRET_KEY` (to act on Stripe) + an internal DB (to hold the
      // outbox). The `yield* Migration` barrier above already sequences this
      // after `MigrationLive`, so the eager boot tick can't race migration
      // 0141 creating the table.
      yield* registerPeriodicFiber({
        name: "stripe_teardown_sweep",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the interval constant synchronously at build time (same pattern as orphan_task_reconcile)
          const { STRIPE_TEARDOWN_SWEEP_INTERVAL_MS } = require("@atlas/api/lib/billing/reconcile-stripe-teardown") as {
            STRIPE_TEARDOWN_SWEEP_INTERVAL_MS: number;
          };
          return STRIPE_TEARDOWN_SWEEP_INTERVAL_MS;
        },
        gate: {
          check: () => {
            if (!process.env.STRIPE_SECRET_KEY) return false;
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          failLog: "Stripe teardown sweep gate check failed — skipping",
          skipLog: "Stripe teardown outbox sweep not started — Stripe or internal DB not configured",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { sweepStripeTeardownPending } = await import(
              "@atlas/api/lib/billing/reconcile-stripe-teardown"
            );
            await sweepStripeTeardownPending();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: {
          level: "warn",
          message: "Stripe teardown sweep tick failed — will retry next interval",
        },
        startLog: "Stripe teardown outbox sweep started",
      });

      // ── Periodic fiber: at-cost overage meter reporter (#3992; #4039) ────
      // Flushes each paid workspace's current-period at-cost usage overage (in
      // cents) to Stripe Billing Meters (`meter_events`), idempotently
      // (ledger-backed: same delta reported twice bills once). Like the teardown
      // sweep it needs only `STRIPE_SECRET_KEY` (to call Stripe) + an internal DB
      // (to hold the ledger + read usage) — NOT the webhook secret. The sweep
      // query excludes BYOT and non-paid tiers (free/trial/locked); a zero-credit
      // workspace is skipped by the per-workspace credit check.
      // The `yield* Migration` barrier above already sequences this after
      // `MigrationLive`, so the eager boot tick can't race migration 0154/0156
      // on `overage_meter_reports`.
      yield* registerPeriodicFiber({
        name: "overage_report",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the interval constant synchronously at build time (same pattern as stripe_teardown_sweep)
          const { OVERAGE_REPORT_INTERVAL_MS } = require("@atlas/api/lib/billing/overage-meter") as {
            OVERAGE_REPORT_INTERVAL_MS: number;
          };
          return OVERAGE_REPORT_INTERVAL_MS;
        },
        gate: {
          check: () => {
            if (!process.env.STRIPE_SECRET_KEY) return false;
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          failLog: "Overage reporter gate check failed — skipping",
          skipLog: "At-cost overage meter reporter not started — Stripe or internal DB not configured",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { reportPeriodOverages } = await import(
              "@atlas/api/lib/billing/overage-meter"
            );
            await reportPeriodOverages();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: {
          level: "warn",
          message: "Overage-meter reporting tick failed — will retry next interval",
        },
        startLog: "At-cost overage meter reporter started",
      });

      // ── Periodic fiber: unclaimed-grace reaper (#3652, ADR-0018) ────────
      // Bounds the free pre-claim window of self-serve trial Workspaces
      // provisioned over MCP: an UNCLAIMED Workspace (owner `emailVerified =
      // false`) whose short grace window has lapsed is demoted to the
      // `'locked'` churn tier, so Gate 0 then blocks it on every surface incl.
      // MCP. Claimed trials are never touched (the reaper's EXISTS arm only
      // matches an unverified owner) — those run the full 14-day clock under
      // normal trial-expiry. SaaS-only: the fork is gated on
      // `config.deployMode === 'saas'` here AND the sweep itself no-ops
      // off-SaaS / without an internal DB. The `yield* Migration` barrier above
      // already sequences this after `MigrationLive`, so the eager boot tick
      // can't race the `organization`/`member`/`user` tables into existence.
      yield* registerPeriodicFiber({
        name: "unclaimed_grace_reap",
        // Default 1h: the grace window is measured in hours
        // (TRIAL_GRACE_HOURS), so an hourly sweep keeps the abandoned-signup
        // horizon tight without adding meaningful load (one guarded UPDATE
        // per pass). Settings-registry-backed (#4130): platform DB override
        // > env > default; boot-consumed, so retuning needs a restart (not a
        // redeploy) — same shape as expert_scheduler (#3399). `Effect.repeat`
        // runs the tick once at boot, then on the spacing.
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { getUnclaimedGraceReapIntervalMs } = require("@atlas/api/lib/billing/reap-unclaimed-grace") as {
            getUnclaimedGraceReapIntervalMs: () => number;
          };
          return getUnclaimedGraceReapIntervalMs();
        },
        gate: {
          check: () => config.deployMode === "saas",
          skipLog: "Unclaimed-grace reaper not started — not a SaaS deployment",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { reapUnclaimedGraceWorkspaces } = await import(
              "@atlas/api/lib/billing/reap-unclaimed-grace"
            );
            return reapUnclaimedGraceWorkspaces();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        // #3796 — attach the reaped count as a span result attribute (the
        // orphan_task_reconcile pattern): the span wraps the raw tick so the
        // attribute is truthful, and the loop-liveness catchAll is applied
        // OUTSIDE the span so a failed tick records ERROR (not OK-with-a-
        // fabricated-zero) while the (default-hourly) fiber survives a DB blip.
        spanResultAttributes: (result) => ({
          "atlas.unclaimed_grace.reaped_count": result.reapedCount,
        }),
        onTickFailure: {
          level: "warn",
          message: "Unclaimed-grace reaper tick failed — will retry next interval",
        },
        startLog: "Unclaimed-grace reaper started",
      });

      // Start audit purge scheduler via the `AuditPurgeScheduler` Tag
      // (#2587 — split out of `AuditRetention` so the cron lifecycle is
      // testable in isolation). Self-hosted: noop layer fails with
      // `EnterpriseError`; we catch it so boot completes cleanly and
      // logs the expected skip. EE: `AuditPurgeSchedulerLive` wires the
      // cron worker in `ee/src/audit/purge-scheduler.ts`.
      const auditPurgeScheduler = yield* AuditPurgeScheduler;
      yield* auditPurgeScheduler.startAuditPurgeScheduler().pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.debug(
              { err },
              "Audit purge scheduler did not start — enterprise required or backend error",
            );
          }),
        ),
      );

      // ── Periodic fiber: scheduled internal-DB backups (#4457) ────────────
      // Wires the previously-dead backup automation through the
      // `BackupsManager` Tag (EE-implemented via `BackupsManagerLive`; the
      // noop's `available: false` gates the fiber off on self-hosted without
      // /ee). Each tick interprets the configured schedule as a cadence
      // window and atomically claims it in the DB (`INSERT … ON CONFLICT DO
      // NOTHING` on the partial UNIQUE `backups.scheduled_window` index), so
      // exactly one backup runs per region per window regardless of replica
      // count — restart-safe catch-up semantics instead of the retired
      // minute-matching cron loop. A won claim runs create→verify→purge;
      // verification depth follows ATLAS_BACKUP_VERIFY_SCRATCH_URL (#2941).
      // The `yield* Migration` barrier above sequences this after
      // `MigrationLive`, so the eager boot tick can't race migration 0177
      // adding `scheduled_window`. The /health `backups` component is the
      // matching tripwire: it degrades when the newest verified backup is
      // older than the cadence window, so "fiber gated off by mistake" is
      // visible instead of boot-green-but-broken.
      const backupsManager = yield* BackupsManager;
      yield* registerPeriodicFiber({
        name: "scheduled_backup",
        // Check interval, not the backup cadence — each tick is a cheap
        // claim attempt that no-ops while the current window is satisfied.
        intervalMs: SCHEDULED_BACKUP_CHECK_INTERVAL_MS,
        gate: {
          check: () => {
            if (!backupsManager.available) return false;
            // Boot-consumed kill switch for the scheduled path only — the
            // manual admin backup path is unaffected. Single shared
            // predicate, mirrored by the /health tripwire's expectation
            // gate (lib/backups/health.ts) — never duplicate the value set.
            if (isScheduledBackupEnvDisabled()) return false;
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          failLog: "Scheduled-backup gate check failed — skipping",
          skipLog:
            "Scheduled backups not started — enterprise backups unavailable, internal DB not configured, or ATLAS_BACKUP_SCHEDULED_ENABLED=false",
        },
        // Two liveness wraps on the tick:
        //
        // 1. Timeout: nothing in create→verify→purge bounds wall time, and a
        //    pg_dump hung on a network partition (or a stuck S3 upload) would
        //    otherwise wedge this fiber forever — `Effect.repeat` never
        //    advances, and the stale-claim reaper (which lives in this same
        //    fiber's next tick) is hostage to the wedge. 2h is far above any
        //    sane internal-DB dump and well inside the 6h stale-claim
        //    threshold, so the reap on a later tick marks the carcass row
        //    failed. Note: interrupting the Effect does NOT kill the spawned
        //    pg_dump/psql OS process — it may linger until it exits on its
        //    own; the claim semantics stay correct either way.
        //
        // 2. Defect demotion: the cycle's call graph still contains
        //    `Effect.promise(internalQuery…)` seams (ensureTable /
        //    getBackupConfig), whose rejections become DEFECTS — and since
        //    `spanResultAttributes` can't combine with `viaCause`, an escaped
        //    defect would exit `Effect.repeat` and permanently kill this
        //    fiber on the first transient DB blip (the exact silent-death
        //    class #4457 exists to eliminate). With the demotion,
        //    `onTickFailure` logs it and the loop survives.
        tick: backupsManager.runScheduledBackupCycle().pipe(
          Effect.timeoutFail({
            duration: "2 hours",
            onTimeout: () =>
              new Error(
                "Scheduled backup cycle exceeded 2h — likely a hung pg_dump or storage upload; the stale-claim reap will mark the row failed",
              ),
          }),
          Effect.catchAllDefect((defect) =>
            Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
          ),
        ),
        // Result attributes on the raw tick (orphan_task_reconcile pattern):
        // recovery is applied OUTSIDE the span, so a failed cycle records an
        // ERROR span instead of OK-with-fabricated-attributes.
        spanResultAttributes: (result) => ({
          "atlas.scheduled_backup.status": result.status,
          ...(result.status === "ran" && {
            "atlas.scheduled_backup.backup_id": result.backupId,
            "atlas.scheduled_backup.verified": result.verified,
            "atlas.scheduled_backup.verify_level": result.verifyLevel,
            "atlas.scheduled_backup.purged": result.purged,
          }),
        }),
        onTickFailure: {
          // error, not warn: a failed cycle means this cadence window may
          // produce no backup at all (a failed attempt keeps its claim), so
          // on-call must see it — the /health tripwire corroborates.
          level: "error",
          message:
            "Scheduled backup cycle failed — this cadence window may have no verified backup (see /health backups component)",
        },
        startLog: "Scheduled internal-DB backup fiber started",
      });

      // ── Periodic fiber: BYOT catalog refresh (#2284; folded onto the fiber
      // seam by #4195) ─────────────────────────────────────────────────────
      // Daily refresh of workspace_model_catalog rows whose `fetched_at` is
      // older than the TTL. Gated on an internal DB (nothing to walk without
      // one); self-hosted installs without EE simply have no configs to walk.
      // The scan → forEach → tally → audit cycle body is the shared
      // `runPeriodicDbCycle` skeleton; this registration owns only the fiber.
      yield* registerPeriodicFiber({
        name: "byot_catalog_refresh",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the interval constant synchronously at build time (same pattern as stripe_teardown_sweep)
          const { getByotCatalogRefreshIntervalMs } = require("@atlas/api/lib/scheduler/byot-catalog-refresh") as {
            getByotCatalogRefreshIntervalMs: () => number;
          };
          return getByotCatalogRefreshIntervalMs();
        },
        gate: {
          check: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          skipLog: "No internal database — BYOT catalog refresh scheduler not started",
        },
        tick: Effect.tryPromise({
          try: () => import("@atlas/api/lib/scheduler/byot-catalog-refresh"),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(Effect.flatMap((m) => m.runByotCatalogRefreshCycle())),
        spanResultAttributes: (result) => ({
          "atlas.byot.status": result.status,
          "atlas.byot.inspected": result.inspected,
          "atlas.byot.refreshed": result.refreshed,
          "atlas.byot.failed": result.failed,
        }),
        onTickFailure: {
          level: "warn",
          message: "BYOT catalog refresh tick failed — will retry next interval",
        },
        startLog: "BYOT catalog refresh scheduler started",
      });

      // ── Periodic fiber: shared OpenAPI spec refresh (#2970, Tier-1; #4195) ──
      // Periodic conditional-GET of the cross-workspace public-spec cache
      // (Stripe/GitHub/Notion). A `304` re-arms freshness for every workspace
      // for free; a `200` re-normalizes the changed doc once. Process-local
      // cache (no DB), so it starts unconditionally (no gate); an empty cache
      // makes the cycle a no-op. Not a `runPeriodicDbCycle` caller — it has no
      // internal-DB working set (the variance the #4195 skeleton isolates).
      yield* registerPeriodicFiber({
        name: "openapi_spec_refresh",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the settings-backed interval synchronously at build time
          const { getSharedSpecRefreshIntervalMs } = require("@atlas/api/lib/scheduler/openapi-spec-refresh") as {
            getSharedSpecRefreshIntervalMs: () => number;
          };
          return getSharedSpecRefreshIntervalMs();
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { runOpenApiSpecRefreshCycle } = await import(
              "@atlas/api/lib/scheduler/openapi-spec-refresh"
            );
            return runOpenApiSpecRefreshCycle();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        spanResultAttributes: (result) => ({
          "atlas.openapi_spec_refresh.inspected": result.inspected,
          "atlas.openapi_spec_refresh.updated": result.updated,
          "atlas.openapi_spec_refresh.not_modified": result.notModified,
          "atlas.openapi_spec_refresh.failed": result.failed,
        }),
        onTickFailure: {
          level: "warn",
          message: "Shared OpenAPI spec refresh tick failed — will retry next interval",
        },
        startLog: "Shared OpenAPI spec refresh scheduler started",
      });

      // ── Periodic fiber: Tier-2 per-install OpenAPI re-discovery (#2978; #4195) ──
      // Periodic re-probe of each installed openapi-generic datasource whose
      // per-install `spec_refresh_interval` has elapsed, updating the persisted
      // snapshot + drift diff + watermark. Orthogonal to the Tier-1 shared-cache
      // refresh above (this one mutates per-install snapshots; that one only
      // warms the process-local public-spec cache). Gated on an internal DB; its
      // cycle body is the shared `runPeriodicDbCycle` skeleton.
      yield* registerPeriodicFiber({
        name: "openapi_install_rediscover",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the interval synchronously at build time
          const { getInstallRediscoverIntervalMs } = require("@atlas/api/lib/scheduler/openapi-install-rediscover") as {
            getInstallRediscoverIntervalMs: () => number;
          };
          return getInstallRediscoverIntervalMs();
        },
        gate: {
          check: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          skipLog: "No internal database — OpenAPI rediscover scheduler not started",
        },
        tick: Effect.tryPromise({
          try: () => import("@atlas/api/lib/scheduler/openapi-install-rediscover"),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(Effect.flatMap((m) => m.runOpenApiInstallRediscoverCycle())),
        spanResultAttributes: (result) => ({
          "atlas.openapi_rediscover.status": result.status,
          "atlas.openapi_rediscover.inspected": result.inspected,
          "atlas.openapi_rediscover.due": result.due,
          "atlas.openapi_rediscover.refreshed": result.refreshed,
          "atlas.openapi_rediscover.breaking": result.breaking,
          "atlas.openapi_rediscover.failed": result.failed,
        }),
        onTickFailure: {
          level: "warn",
          message: "OpenAPI install rediscover tick failed — will retry next interval",
        },
        startLog: "OpenAPI install rediscover scheduler started",
      });

      // Start knowledge bundle sync scheduler (#4211) — periodic pull of every
      // enabled `bundle-sync` knowledge collection's endpoint, re-running the
      // #4207 ingest (diff via upsert-by-path; synced changes land draft).
      // Cadence via the ATLAS_KNOWLEDGE_SYNC_INTERVAL_HOURS settings knob
      // (nightly default). No-ops per-cycle when the internal DB is
      // unavailable; safe to start unconditionally.
      yield* Effect.tryPromise({
        try: async () => {
          const { startKnowledgeBundleSyncScheduler } = await import(
            "@atlas/api/lib/scheduler/knowledge-bundle-sync"
          );
          startKnowledgeBundleSyncScheduler();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.error(
            { err: errorMessage(err) },
            "Knowledge bundle sync scheduler failed to start",
          );
          return Effect.void;
        }),
      );

      // ── Periodic fiber: OAuth state cleanup (#1273) — every 10 min ──
      yield* registerPeriodicFiber({
        name: "oauth_state_cleanup",
        intervalMs: 10 * 60 * 1000,
        tick: Effect.tryPromise({
          try: async () => {
            const { cleanExpiredOAuthState } = await import(
              "@atlas/api/lib/auth/oauth-state"
            );
            await cleanExpiredOAuthState();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "OAuth state cleanup tick failed" },
      });

      // ── Periodic fiber: rate-limit cleanup (#1274) — every 60s ──────
      // Interval matches WINDOW_MS in middleware.ts (sliding-window duration).
      yield* registerPeriodicFiber({
        name: "rate_limit_cleanup",
        intervalMs: 60 * 1000,
        tick: Effect.try({
          try: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { rateLimitCleanupTick } = require("@atlas/api/lib/auth/middleware") as {
              rateLimitCleanupTick: () => void;
            };
            rateLimitCleanupTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Rate limit cleanup tick failed" },
      });

      // ── Periodic fiber: demo rate-limit cleanup — interval from DEMO_CLEANUP_INTERVAL_MS ──
      yield* registerPeriodicFiber({
        name: "demo_rate_limit_cleanup",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { DEMO_CLEANUP_INTERVAL_MS } = require("@atlas/api/lib/demo") as {
            DEMO_CLEANUP_INTERVAL_MS: number;
          };
          return DEMO_CLEANUP_INTERVAL_MS;
        },
        tick: Effect.tryPromise({
          try: async () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { demoCleanupTick } = require("@atlas/api/lib/demo") as {
              demoCleanupTick: () => Promise<void>;
            };
            await demoCleanupTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "error", message: "Demo rate-limit cleanup tick failed" },
      });

      // ── Periodic fiber: contact rate-limit cleanup — every 60s ────
      // Unauthenticated public endpoint with a per-IP map; without
      // periodic eviction the map leaks one entry per distinct source IP
      // until process restart.
      yield* registerPeriodicFiber({
        name: "contact_rate_limit_cleanup",
        intervalMs: 60 * 1000,
        tick: Effect.tryPromise({
          try: async () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { contactCleanupTick } = require("@atlas/api/lib/contact") as {
              contactCleanupTick: () => Promise<void>;
            };
            await contactCleanupTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "error", message: "Contact rate-limit cleanup tick failed" },
      });

      // ── Periodic fiber: trial-signup rate-limit cleanup — every 60s ──
      // Same leak shape as the contact limiter (#3654): the unauthenticated
      // `start_trial` bootstrap keys two per-IP/per-email maps; `peek` only
      // trims timestamps WITHIN a live entry, never removes the key, so
      // without this sweep a spammer cycling distinct IPs/emails grows the
      // maps until restart. `trialAttemptCleanupTick` evicts fully-stale keys.
      yield* registerPeriodicFiber({
        name: "trial_rate_limit_cleanup",
        intervalMs: 60 * 1000,
        tick: Effect.tryPromise({
          try: async () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { trialAttemptCleanupTick } = require("@atlas/api/lib/trial-abuse") as {
              trialAttemptCleanupTick: () => Promise<void>;
            };
            await trialAttemptCleanupTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "error", message: "Trial rate-limit cleanup tick failed" },
      });

      // ── Periodic fiber: abuse detection cleanup — every 5 min ──────
      yield* registerPeriodicFiber({
        name: "abuse_cleanup",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { ABUSE_CLEANUP_INTERVAL_MS } = require("@atlas/api/lib/security/abuse") as {
            ABUSE_CLEANUP_INTERVAL_MS: number;
          };
          return ABUSE_CLEANUP_INTERVAL_MS;
        },
        tick: Effect.try({
          try: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { abuseCleanupTick } = require("@atlas/api/lib/security/abuse") as {
              abuseCleanupTick: () => void;
            };
            abuseCleanupTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Abuse cleanup tick failed" },
      });

      // ── Periodic fiber: dashboard public rate-limit cleanup — every 60s ─
      yield* registerPeriodicFiber({
        name: "dashboard_rate_limit_cleanup",
        intervalMs: () => {
          try {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require("@atlas/api/api/routes/dashboards") as {
              DASHBOARD_RATE_CLEANUP_INTERVAL_MS: number;
            };
            return mod.DASHBOARD_RATE_CLEANUP_INTERVAL_MS;
          } catch {
            // intentionally ignored: use default interval if module can't be resolved
            return 60_000;
          }
        },
        tick: Effect.try({
          try: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { dashboardRateLimitCleanupTick } = require("@atlas/api/api/routes/dashboards") as {
              dashboardRateLimitCleanupTick: () => void;
            };
            dashboardRateLimitCleanupTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Dashboard rate-limit cleanup tick failed" },
      });

      // ── Periodic fiber: conversation public rate sweep — every 60s ──
      yield* registerPeriodicFiber({
        name: "conversation_rate_sweep",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { CONVERSATION_RATE_SWEEP_INTERVAL_MS } = require("@atlas/api/api/routes/conversations") as {
            CONVERSATION_RATE_SWEEP_INTERVAL_MS: number;
          };
          return CONVERSATION_RATE_SWEEP_INTERVAL_MS;
        },
        tick: Effect.try({
          try: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { conversationRateSweepTick } = require("@atlas/api/api/routes/conversations") as {
              conversationRateSweepTick: () => void;
            };
            conversationRateSweepTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Conversation rate sweep tick failed" },
      });

      // ── Periodic fiber: region-probe public rate sweep — every 60s ──
      yield* registerPeriodicFiber({
        name: "region_probe_rate_sweep",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { REGION_PROBE_RATE_SWEEP_INTERVAL_MS } = require("@atlas/api/api/routes/region-routing") as {
            REGION_PROBE_RATE_SWEEP_INTERVAL_MS: number;
          };
          return REGION_PROBE_RATE_SWEEP_INTERVAL_MS;
        },
        tick: Effect.try({
          try: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { regionProbeRateSweepTick } = require("@atlas/api/api/routes/region-routing") as {
              regionProbeRateSweepTick: () => void;
            };
            regionProbeRateSweepTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Region probe rate sweep tick failed" },
      });

      // ── Periodic fiber: share token cleanup — every 60 min ─────────
      yield* registerPeriodicFiber({
        name: "share_token_cleanup",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { SHARE_CLEANUP_INTERVAL_MS } = require("@atlas/api/api/routes/conversations") as {
            SHARE_CLEANUP_INTERVAL_MS: number;
          };
          return SHARE_CLEANUP_INTERVAL_MS;
        },
        tick: Effect.tryPromise({
          try: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports
            const { shareCleanupTick: tick } = require("@atlas/api/api/routes/conversations") as {
              shareCleanupTick: () => Promise<void>;
            };
            return tick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "error", message: "Unexpected error in share cleanup tick" },
      });

      // ── Periodic fiber: agent_runs retention sweep (#3745, ADR-0020) ──
      // Deletes terminal (done/failed) durable-session runs past the retention
      // window; non-terminal runs are never touched. Resolves the
      // `DurableSession` Tag — Noop when there is no internal DB, so the fiber
      // forks but sweeps nothing. The retention window is read per-tick (no
      // orgId → platform/env/default) so an operator setting change takes
      // effect without a restart. Hourly, like the share-token sweep.
      const durableSession = yield* DurableSession;
      const durableState = yield* DurableState;
      yield* registerPeriodicFiber({
        name: "agent_runs_retention_sweep",
        intervalMs: 60 * 60 * 1000,
        tick: Effect.gen(function* () {
          // #3757 — sweep working memory BEFORE the runs sweep, on the SAME window:
          // the memory sweep dates a session by its newest `agent_runs` row, so the
          // terminal runs must still be present when it runs. The runs sweep then
          // deletes those terminal rows. Memory is thus swept WITH its session
          // (no separate sweeper). A session with a live run keeps its memory.
          yield* durableState.sweepExpired(getRetentionDays());
          yield* durableSession.sweepTerminal(getRetentionDays());
          yield* durableSession.sweepParked(getMaxParkMinutes());
        }),
        // Per-tick catch (inside repeat) so the loop survives a transient fault
        // and keeps sweeping — same resilience shape as the share-token sweep.
        // `viaCause`: a defect here is genuinely unexpected — `sweepTerminal`
        // already self-catches DB errors → -1, so this only fires on an escaped
        // defect (e.g. `getRetentionDays()` throwing). `error`, not `warn`,
        // matching the sibling share-token sweep's unexpected-error level.
        // #3748 — the same tick also fails `parked` runs past the max-park window
        // (a turn awaiting a human approval decision that never landed), reading
        // the operator-global window per-tick so a settings change takes effect
        // without a restart.
        onTickFailure: {
          level: "error",
          message: "agent_runs retention sweep tick failed",
          viaCause: true,
        },
      });

      // ── Periodic fiber: stale region-migration reaper (#4459, ADR-0024) ──
      // Fails `region_migrations` rows stuck `in_progress` past the stale
      // threshold (anchored to `requested_at` — no started_at column — so the
      // retry reset refreshes it; see `resetMigrationForRetry`). A migrating
      // workspace is write-locked
      // (`isWorkspaceMigrating`), so if the API process crashes mid-migration
      // the lock would otherwise persist until an admin happened to request
      // ANOTHER migration — previously the only call site of
      // `failStaleMigrations` (the request route still calls it
      // opportunistically for instant recovery at request time; this fiber is
      // the bounded-window guarantee). Cadence ≤ threshold, pinned by
      // `migrate.test.ts`, so the worst-case unlock window is threshold + one
      // interval (~6 min) with no operator action. Gated on an internal DB —
      // without one there are no `region_migrations` rows to reap.
      //
      // Error ordering: `spanResultAttributes` attaches the reaped count, so
      // the span wraps the RAW tick (a failed tick records ERROR, not a
      // status-OK span with a fabricated zero) and loop-liveness recovery is
      // applied OUTSIDE it — the orphan_task_reconcile pattern.
      yield* registerPeriodicFiber({
        name: "region_migration_stale_reap",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the interval constant synchronously at build time (same pattern as orphan_task_reconcile)
          const { STALE_MIGRATION_REAP_INTERVAL_MS } = require("@atlas/api/lib/residency/migrate") as {
            STALE_MIGRATION_REAP_INTERVAL_MS: number;
          };
          return STALE_MIGRATION_REAP_INTERVAL_MS;
        },
        gate: {
          check: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          failLog:
            "Stale region-migration reaper gate check failed — crashed migrations will NOT auto-unlock",
          skipLog: "No internal database — stale region-migration reaper not started",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { failStaleMigrations } = await import(
              "@atlas/api/lib/residency/migrate"
            );
            // Throws when stale rows were found but NONE could be reaped —
            // that tick must surface as span ERROR + warn, not a quiet zero.
            return failStaleMigrations();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        spanResultAttributes: (result) => ({
          "atlas.region_migration.stale_found": result.found,
          "atlas.region_migration.stale_reaped": result.reaped,
        }),
        onTickFailure: {
          level: "warn",
          message: "Stale region-migration reap tick failed — will retry next interval",
        },
        startLog: "Stale region-migration reaper started",
      });

      // ── Periodic fiber: region-migration source-data cleanup (#4458, ADR-0024) ──
      // The destructive half of migration Phase 4: once a completed
      // migration's 7-day grace period elapses, `runSourceCleanupSweep`
      // deletes the workspace's rows from the source region's internal DB.
      // The deletion scope derives from the bundle-scope registry (#4460):
      // exported pillars (already moved) plus the `stays` residue; `platform`
      // tables are never touched. Each migration's cleanup is one transaction
      // (deletes + `source_cleaned_at` stamp), so a partial failure rolls
      // back to "still due" and is retried next sweep — and the cutover
      // guard refuses to delete a workspace homed back in this region. Gated
      // on an internal DB — without one there are no migrations to clean.
      // Note the gate's failLog is emitted at debug (helper behavior): a
      // fiber that never started is observable only as an ABSENCE of
      // `atlas.scheduler.region_migration_source_cleanup` spans against the
      // hourly cadence — for this fiber that absence is a residency-promise
      // gap, so treat it as alertable.
      //
      // Error ordering: `spanResultAttributes` attaches the SweepSummary
      // buckets, so the span wraps the RAW tick (a failed tick records
      // ERROR, not a status-OK span with fabricated zeros) and loop-liveness
      // recovery is applied OUTSIDE it — the region_migration_stale_reap
      // pattern. The tick throws only when attempts failed outright and
      // nothing succeeded or resolved (guard-skips count as resolved;
      // blocked rows are counted, not thrown).
      yield* registerPeriodicFiber({
        name: "region_migration_source_cleanup",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports -- read the interval constant synchronously at build time (same pattern as region_migration_stale_reap)
          const { SOURCE_CLEANUP_SWEEP_INTERVAL_MS } = require("@atlas/api/lib/residency/cleanup") as {
            SOURCE_CLEANUP_SWEEP_INTERVAL_MS: number;
          };
          return SOURCE_CLEANUP_SWEEP_INTERVAL_MS;
        },
        gate: {
          check: () => {
            // oxlint-disable-next-line @typescript-eslint/no-require-imports -- sync gate check at layer build time; dynamic import would force the whole gen async for a boolean
            const { hasInternalDB } = require("@atlas/api/lib/db/internal") as {
              hasInternalDB: () => boolean;
            };
            return hasInternalDB();
          },
          failLog:
            "Region-migration source-cleanup gate check failed — migrated source data will NOT be deleted",
          skipLog: "No internal database — region-migration source cleanup not started",
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { runSourceCleanupSweep } = await import(
              "@atlas/api/lib/residency/cleanup"
            );
            // Throws when migrations were due but every attempt failed
            // outright — that tick must surface as span ERROR + warn, not a
            // quiet zero.
            return runSourceCleanupSweep();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        spanResultAttributes: (result) => ({
          "atlas.region_migration.cleanup_due": result.due,
          "atlas.region_migration.cleanup_cleaned": result.cleaned,
          "atlas.region_migration.cleanup_skipped": result.skipped,
          // Persistent non-zero across sweeps = operator signal (region
          // misconfiguration or an ambiguous organization row).
          "atlas.region_migration.cleanup_blocked": result.blocked,
        }),
        onTickFailure: {
          level: "warn",
          message: "Region-migration source-cleanup tick failed — will retry next interval",
        },
        startLog: "Region-migration source-data cleanup sweep started",
      });

      // ── Periodic fiber: orphan plugin-task reconcile (#2944) — hourly ──
      // Counts `scheduled_tasks` whose `plugin_id` has no live
      // `workspace_plugins` row — the residue a non-atomic plugin uninstall
      // leaves when the post-DELETE task cleanup fails. The count rides the
      // per-tick span as a result attribute (one of two cleanup fibers that
      // attach one — see `region_migration_stale_reap` above), so an operator querying traces sees orphan
      // accumulation; a `log.warn` fires on the same tick when > 0. The
      // destructive sweep is gated behind `ATLAS_ORPHAN_TASK_RECONCILE`
      // (default off — measure-only); the module no-ops when the internal DB
      // is absent.
      //
      // Error ordering matters: `spanResultAttributes` makes the helper wrap
      // the RAW tick in the span, so a failed tick records span status ERROR
      // + the exception (rather than a misleading status-OK span carrying a
      // fabricated `count=0`), and the loop-liveness recovery is applied
      // OUTSIDE the span — it logs the failure and lets the hourly fiber
      // survive a DB blip without painting the failed tick green or
      // asserting a false-healthy zero into traces.
      yield* registerPeriodicFiber({
        name: "orphan_task_reconcile",
        intervalMs: () => {
          // oxlint-disable-next-line @typescript-eslint/no-require-imports
          const { ORPHAN_TASK_RECONCILE_INTERVAL_MS } = require("@atlas/api/lib/scheduler/orphan-task-reconcile") as {
            ORPHAN_TASK_RECONCILE_INTERVAL_MS: number;
          };
          return ORPHAN_TASK_RECONCILE_INTERVAL_MS;
        },
        tick: Effect.tryPromise({
          try: async () => {
            const { runOrphanTaskReconcileTick } = await import(
              "@atlas/api/lib/scheduler/orphan-task-reconcile"
            );
            return runOrphanTaskReconcileTick();
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        spanResultAttributes: (result) => ({
          "atlas.orphan_tasks.count": result.orphanedTasks,
          "atlas.orphan_tasks.installs": result.orphanedInstalls,
          "atlas.orphan_tasks.reconcile_enabled": result.reconcileEnabled,
          "atlas.orphan_tasks.deleted": result.deleted,
        }),
        onTickFailure: { level: "warn", message: "Orphan plugin-task reconcile tick failed" },
      });

      // ── Periodic fiber: sub-processor change-feed publisher (#1924) ──
      // Cron sweep, not build-hook: the source JSON can be hot-edited
      // via PR without a www deploy, and a sweep handles every path
      // uniformly. Default 6h tick — compliance change notifications
      // are not latency-sensitive, and a long interval keeps load on
      // www.useatlas.dev negligible. `Effect.repeat(Schedule.spaced)`
      // runs the tick once eagerly on boot, so the first sweep happens
      // within seconds of API start, not after the first 6h window.
      // oxlint-disable-next-line @typescript-eslint/no-require-imports
      const subProcessorPublisher = require("@atlas/api/lib/sub-processor-publisher") as {
        subProcessorPublisherTick: () => Promise<void>;
        SUBPROCESSOR_PUBLISH_INTERVAL_MS: number;
      };
      yield* registerPeriodicFiber({
        name: "sub_processor_publisher",
        intervalMs: subProcessorPublisher.SUBPROCESSOR_PUBLISH_INTERVAL_MS,
        tick: Effect.tryPromise({
          try: () => subProcessorPublisher.subProcessorPublisherTick(),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
        onTickFailure: { level: "warn", message: "Sub-processor publisher tick failed" },
      });

      // ── Periodic fiber: SaaS CRM outbox flusher (#2729) ─────────────
      // The flusher polls `crm_outbox` for pending / due rows, claims
      // them via single-statement UPDATE … RETURNING, and hands each
      // to the dispatcher Tag-bound by `SaasCrmLive`.
      //
      // Gate is `saasCrm.dispatcher !== null` (not `available`):
      // post-#2849, the dispatcher routes per-row, and customer-
      // workspace rows have nothing to do with the operator's Twenty
      // probe / env creds. We mount the flusher whenever ANY dispatch
      // path is viable; per-row classification handles operator-
      // pipeline rows when the operator side is broken (they
      // dead-letter with an actionable permanent message).
      const saasCrm = yield* SaasCrm;
      if (saasCrm.dispatcher !== null && hasInternalDB()) {
        const outboxDispatcher = saasCrm.dispatcher;
        const outboxDb: OutboxDB = { query: internalQuery };

        // Startup recovery: any `in_flight` row at boot is the carcass
        // of a crash mid-dispatch. Reset stale rows to `pending`
        // (preserving siblings still actively dispatched in a multi-
        // pod deploy) and dead-letter rows that crashed past the
        // retry budget. Runs BEFORE the tick starts.
        yield* Effect.tryPromise({
          try: (): Promise<OutboxRecoveryResult> =>
            recoverOutboxInFlight(outboxDb, OUTBOX_STARTUP_STALE_MS),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.tap((result: OutboxRecoveryResult) =>
            Effect.sync(() => {
              if (result.reset > 0 || result.deadLettered > 0) {
                log.warn(
                  {
                    reset: result.reset,
                    deadLettered: result.deadLettered,
                    staleAgeMs: OUTBOX_STARTUP_STALE_MS,
                    event: "lead_outbox.startup_recovery",
                  },
                  `Recovered crm_outbox carcasses at boot — ${result.reset} reset to pending, ${result.deadLettered} dead-lettered`,
                );
              }
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log.error(
                { err: errorMessage(err), event: "lead_outbox.startup_recovery_failed" },
                "Outbox startup recovery failed — stranded in_flight rows will block until next restart",
              );
            }),
          ),
        );

        // Shutdown-recovery finalizer — registered BEFORE the two
        // `Effect.forkScoped` calls below. Effect scope finalizers run
        // LIFO; the `forkScoped` calls each register an implicit
        // fiber-interrupt finalizer at their fork point, so this
        // ordering guarantees: tick + watchdog fibers are interrupted
        // (and `Fiber.interrupt` awaits cleanup completion) BEFORE the
        // recovery sweep runs. If we registered the finalizer AFTER
        // the forks, LIFO would invert the order — the sweep would
        // race an in-flight tick + dead-letter branch, leaving the
        // active row in an inconsistent terminal state (Codex P1 on
        // #2864).
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Final recovery sweep: a SIGTERM mid-flush leaves the
            // active row in `in_flight` until the next pod boot. Reset
            // here so the replacement pod picks it up on its first
            // tick rather than waiting for the next restart cycle.
            yield* Effect.tryPromise({
              try: (): Promise<OutboxRecoveryResult> =>
                recoverOutboxInFlight(outboxDb, OUTBOX_SHUTDOWN_STALE_MS),
              catch: (err) => (err instanceof Error ? err : new Error(String(err))),
            }).pipe(
              Effect.tap((result: OutboxRecoveryResult) =>
                Effect.sync(() => {
                  log.info(
                    {
                      reset: result.reset,
                      deadLettered: result.deadLettered,
                      staleAgeMs: OUTBOX_SHUTDOWN_STALE_MS,
                      event: "lead_outbox.shutdown_recovery",
                    },
                    `Outbox shutdown sweep — ${result.reset} reset to pending, ${result.deadLettered} dead-lettered`,
                  );
                }),
              ),
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  log.warn(
                    { err: errorMessage(err), event: "lead_outbox.shutdown_recovery_failed" },
                    "Outbox shutdown recovery sweep failed — next boot will mop up",
                  );
                }),
              ),
            );
          }),
        );

        // Region gate. EU/APAC API pods set `ATLAS_CRM_OUTBOX_FLUSHER_ENABLED=false`
        // because the lead-capture pipeline at crm.useatlas.dev only
        // writes to US's internal Postgres — EU/APAC `crm_outbox`
        // tables stay permanently empty, and a 5s polling loop there
        // burns ~17k idle UPDATE statements per region per day. The
        // recovery sweeps above + the shutdown finalizer above stay
        // wired regardless so a future flip-back-on inherits clean
        // state (and a region that DOES get crm_outbox rows enqueued
        // via some other path still mops up crash carcasses at boot).
        // Nested-if (rather than early-return) because we're inside
        // the outer Effect.gen that registers the scheduler finalizer
        // below — bailing out here with `return` would skip that wiring.
        const flusherEnabled = isOutboxFlusherEnabled();
        if (!flusherEnabled) {
          log.info(
            { event: "lead_outbox.flusher_disabled_by_env" },
            "CRM outbox flusher disabled by ATLAS_CRM_OUTBOX_FLUSHER_ENABLED=false — recovery sweeps still run on boot/shutdown",
          );
        }

        if (flusherEnabled) {
        const backstopSweepMs = getOutboxBackstopSweepIntervalMs();
        // One rate limiter per Layer scope — `lastWarnAt` lives on the
        // instance, so a sustained 101+ pending depth fires exactly
        // one log.warn per minute regardless of how many ticks elapse.
        const outboxWarnLimiter = new OutboxWarnRateLimiter(getOutboxWarnThreshold());

        // Edge-trigger doorbell (#2874). `enqueue` rings it inline the
        // instant a row lands; per-row retry timers ring it at each
        // transient row's due-time; the loop below WAITS on it (or the
        // backstop) instead of polling every 5s. Registered process-
        // globally so the request-path `enqueue` (EE dispatcher,
        // backfill) reaches the live doorbell, and de-registered +
        // closed in a finalizer so a post-shutdown kick is inert.
        const outboxSignal = new OutboxFlusherSignal();
        setActiveOutboxFlusherSignal(outboxSignal);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            setActiveOutboxFlusherSignal(null);
            outboxSignal.close();
          }),
        );

        // Fiber-liveness state. The flusher silently stalled in prod
        // after a permanent dead-letter (1.6.0 #DharmaIncident — 25
        // minutes of zero ticks despite a claimable pending row); the
        // claim/heartbeat logs alone couldn't tell "alive idle" from
        // "dead fiber". `outboxLastTickAt` + the watchdog below keep
        // that gap closed — now sized off the backstop interval, since
        // an idle edge-triggered fiber legitimately sleeps a full
        // backstop between ticks.
        let outboxTickCount = 0;
        let outboxLastTickAt = Date.now();
        // Trigger for the NEXT tick. First tick after boot is `boot`;
        // thereafter it's whatever woke the wait — a `kick` (inline
        // enqueue or retry timer) or a `backstop` timeout.
        let outboxNextTrigger: "boot" | "kick" | "backstop" = "boot";

        // Watchdog gate: a healthy idle fiber wakes once per backstop, so
        // flag a stall only after it misses ~2 backstops (60s floor so a
        // sub-minute backstop still leaves slack). Pure in-memory — no SQL,
        // zero statements.
        const OUTBOX_STALL_THRESHOLD_MS = Math.max(60_000, backstopSweepMs * 2);
        // Poll the watchdog often enough to bound detection lag without
        // burning CPU: at most every 30s, faster if the backstop is short.
        const OUTBOX_WATCHDOG_POLL_MS = Math.min(30_000, backstopSweepMs);

        // A failed tick (boot racing migrations, a brief PG blip) re-arms
        // a SHORT retry instead of waiting a full backstop, so a queue with
        // pending rows recovers in seconds once the DB is back rather than
        // sitting idle up to 300s (Codex P2). Capped by the backstop so a
        // sub-5s backstop never lengthens on failure.
        const OUTBOX_FAILED_RETRY_MS = Math.min(5_000, backstopSweepMs);

        // One tick cycle. `drainOutbox` claims all currently-due rows in
        // batches (so a burst/backlog drains in one wake instead of one
        // batch per backstop — Codex P1), then refreshes the depth gauges.
        // `observe` policy differs by trigger: `boot`/`kick` always refresh
        // (so an event wake leaves a fresh `pending_count`, even draining
        // 1→0 — Codex P2); an idle `backstop` skips the snapshot to stay at
        // ~1 statement/sweep (idle US pod ~288 statements/day). `outboxSignal`
        // is threaded in as the retry scheduler so a transient failure
        // re-arms its own wakeup.
        const runOutboxCycle = (trigger: "boot" | "kick" | "backstop") =>
          drainOutboxQueue({
            db: outboxDb,
            dispatcher: outboxDispatcher,
            batchLimit: OUTBOX_FLUSH_BATCH_LIMIT,
            limiter: outboxWarnLimiter,
            pendingGauge: crmOutboxPendingCount,
            deadGauge: crmOutboxDeadCount,
            logger: log,
            retryScheduler: outboxSignal,
            observe: trigger === "backstop" ? "when-claimed" : "always",
          });

        // Park until a kick or the backstop deadline. `Effect.async` so a
        // scope-finalize interrupt cancels the parked waiter cleanly (the
        // returned Effect runs `cancel()` on interruption); `outboxSignal`
        // is `close()`d by the finalizer above as a belt-and-suspenders.
        const waitForOutboxWake = (
          timeoutMs: number,
        ): Effect.Effect<"kick" | "timeout"> =>
          Effect.async<"kick" | "timeout">((resume) => {
            const cancel = outboxSignal.wait(timeoutMs, (reason) =>
              resume(Effect.succeed(reason)),
            );
            return Effect.sync(cancel);
          });

        const outboxLoopBody = Effect.gen(function* () {
          // Stamp liveness AT TICK START (not completion) so a long
          // backlog-draining tick doesn't trip the watchdog. The watchdog
          // asks "did the fiber wake recently", not "did a tick finish".
          // (Codex P1, 2026-05-26.)
          outboxLastTickAt = Date.now();
          const trigger = outboxNextTrigger;

          const outcome = yield* Effect.tryPromise({
            try: () => runOutboxCycle(trigger),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catchAll((err) => Effect.succeed({ ok: false as const, err })),
          );

          outboxTickCount += 1;
          crmOutboxFlusherWakes.add(1, { trigger });

          if (!outcome.ok) {
            // Liveness was already stamped at tick start, so the watchdog
            // stays quiet — a tick that erred out is still "fiber awake".
            log.warn(
              {
                tickCount: outboxTickCount,
                trigger,
                err: errorMessage(outcome.err),
                event: "lead_outbox.tick_failed",
              },
              "Outbox flush tick failed — re-arming a short retry",
            );
          } else if (outcome.result.flush.claimed > 0) {
            // Active tick — same structured event as the poll design so
            // `tick_complete` greps still match every claim cycle. `claimed`
            // is now the total across all drained batches; `batches` and
            // `drainCapped` surface a multi-batch drain.
            const r = outcome.result;
            log.info(
              {
                tickCount: outboxTickCount,
                trigger,
                claimed: r.flush.claimed,
                ok: r.flush.ok,
                transient: r.flush.transient,
                permanent: r.flush.permanent,
                batches: r.batches,
                drainCapped: r.drainCapped,
                event: "lead_outbox.tick_complete",
              },
              `Outbox tick (${trigger}): ${r.flush.claimed} claimed across ${r.batches} batch(es) (ok=${r.flush.ok}, transient=${r.flush.transient}, dead=${r.flush.permanent})`,
            );
            if (r.drainCapped) {
              // No silent truncation: a capped drain left more due rows for
              // the next backstop. Surface it so a sustained backlog that
              // can't drain in one wake is observable.
              log.warn(
                {
                  tickCount: outboxTickCount,
                  trigger,
                  maxBatches: r.batches,
                  event: "lead_outbox.drain_capped",
                },
                `Outbox drain hit the per-wake batch cap (${r.batches}) with rows still due — remainder rolls to the next backstop sweep`,
              );
            }
          } else {
            // Idle tick — heartbeat proves the fiber is alive. Now
            // backstop-spaced (≈ once per interval), so it fires every
            // idle tick rather than every Nth; depth is omitted because an
            // idle backstop deliberately skips the snapshot (see
            // runOutboxCycle).
            log.info(
              {
                tickCount: outboxTickCount,
                trigger,
                event: "lead_outbox.heartbeat",
              },
              `Outbox heartbeat tick=${outboxTickCount} (${trigger}, queue idle)`,
            );
          }

          // Park on the doorbell until the next kick or backstop deadline.
          // Re-arm a SHORT retry instead of sleeping the full backstop when
          // there's known work to resume: a failed tick (Codex P2), OR a
          // capped drain that already proved more due rows remain
          // (CodeRabbit follow-up). Both keep an already-awake fiber from
          // idling 300s on top of a backlog it knows about; a successful,
          // fully-drained tick parks for the full backstop.
          const needsFastFollowup = !outcome.ok || outcome.result.drainCapped;
          const waitMs = needsFastFollowup ? OUTBOX_FAILED_RETRY_MS : backstopSweepMs;
          const reason = yield* waitForOutboxWake(waitMs);
          outboxNextTrigger = reason === "kick" ? "kick" : "backstop";
        });

        // forkScoped, not fork — see registerPeriodicFiber for the #2864 rationale.
        // The recovery sweep finalizer is registered ABOVE this fork
        // (not below) so LIFO finalizer order interrupts this fiber
        // (and the watchdog below) before the sweep runs.
        yield* Effect.forkScoped(
          withFiberDeathLog(
            "lead_outbox_flusher",
            outboxLoopBody.pipe(Effect.forever),
          ),
        );

        // Stall watchdog — separate fiber that asserts the main tick
        // fiber is still incrementing `outboxLastTickAt`. If the gap
        // exceeds OUTBOX_STALL_THRESHOLD_MS we log an error so the
        // silent-stall failure mode is at least observable in Grafana /
        // log search. The watchdog itself does NOT restart the fiber —
        // recovery would require unwinding shared state we don't fully
        // understand yet; better to surface the symptom and let an
        // operator redeploy than to mask it with auto-recovery.
        let lastStallLogAt = 0;
        const outboxWatchdog = Effect.sync(() => {
          const sinceMs = Date.now() - outboxLastTickAt;
          if (sinceMs < OUTBOX_STALL_THRESHOLD_MS) return;
          // Throttle the stall log to once per minute so a real stall
          // doesn't bury the rest of the deploy log.
          const now = Date.now();
          if (now - lastStallLogAt < 60_000) return;
          lastStallLogAt = now;
          log.error(
            {
              tickCount: outboxTickCount,
              sinceLastTickMs: sinceMs,
              thresholdMs: OUTBOX_STALL_THRESHOLD_MS,
              event: "lead_outbox.tick_stall",
            },
            `Outbox flusher fiber appears stalled — no tick in ${Math.round(sinceMs / 1000)}s (threshold ${Math.round(OUTBOX_STALL_THRESHOLD_MS / 1000)}s). Redeploy to restart; investigate the prior tick_complete / tick_failed line for the trigger.`,
          );
        });
        // forkScoped, not fork — see registerPeriodicFiber for the #2864 rationale.
        yield* Effect.forkScoped(
          withFiberDeathLog(
            "lead_outbox_watchdog",
            outboxWatchdog.pipe(
              Effect.repeat(Schedule.spaced(Duration.millis(OUTBOX_WATCHDOG_POLL_MS))),
            ),
          ),
        );
        log.info(
          {
            backstopSweepMs,
            batchLimit: OUTBOX_FLUSH_BATCH_LIMIT,
            watchdogPollMs: OUTBOX_WATCHDOG_POLL_MS,
            stallThresholdMs: OUTBOX_STALL_THRESHOLD_MS,
          },
          "CRM outbox flusher started (edge-triggered, #2874) — kick on enqueue + per-row retry timer + backstop sweep; heartbeat=lead_outbox.heartbeat (per backstop when idle); stall watchdog=lead_outbox.tick_stall",
        );
        } // close `if (flusherEnabled)`
      } else {
        log.debug(
          {
            saasCrmAvailable: saasCrm.available,
            dispatcherPresent: saasCrm.dispatcher !== null,
            hasInternalDB: hasInternalDB(),
          },
          "CRM outbox flusher not started — no dispatcher (self-hosted / no EE / no internal DB)",
        );
      }

      // ── Periodic fiber: transactional-email outbox flusher (#2942) ──
      // Durable at-least-once delivery for password-reset / verification
      // emails so a SUSTAINED provider outage no longer drops a send.
      // `sendTransactionalEmail` enqueues a pending row when the
      // in-process retry path is exhausted; this flusher claims, re-sends
      // via the RAW `sendEmail` (no re-enqueue loop), and stamps terminal
      // status. Unlike the CRM flusher this is NOT enterprise-gated — the
      // dispatcher is core `sendEmail`, and transactional auth email
      // happens in every deploy mode that has an internal DB. Gate is
      // therefore `hasInternalDB()` only.
      if (hasInternalDB()) {
        const emailOutboxDb: EmailOutboxDB = { query: internalQuery };
        const emailDispatcher = makeEmailDispatcher(sendEmail);

        // Startup recovery: reset stale `in_flight` carcasses from a
        // crash mid-send, dead-letter rows past the retry budget. Runs
        // BEFORE the tick starts.
        yield* Effect.tryPromise({
          try: (): Promise<EmailOutboxRecoveryResult> =>
            recoverEmailOutboxInFlight(emailOutboxDb, EMAIL_OUTBOX_STARTUP_STALE_MS),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.tap((result: EmailOutboxRecoveryResult) =>
            Effect.sync(() => {
              if (result.reset > 0 || result.deadLettered > 0) {
                log.warn(
                  {
                    reset: result.reset,
                    deadLettered: result.deadLettered,
                    staleAgeMs: EMAIL_OUTBOX_STARTUP_STALE_MS,
                    event: "email_outbox.startup_recovery",
                  },
                  `Recovered email_outbox carcasses at boot — ${result.reset} reset to pending, ${result.deadLettered} dead-lettered`,
                );
              }
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log.error(
                { err: errorMessage(err), event: "email_outbox.startup_recovery_failed" },
                "Email outbox startup recovery failed — stranded in_flight rows will block until next restart",
              );
            }),
          ),
        );

        // Shutdown-recovery finalizer — registered BEFORE the forks below
        // so LIFO finalizer order interrupts the tick + watchdog fibers
        // (awaiting their cleanup) before this sweep runs, avoiding a race
        // with an in-flight tick. Same ordering rationale as the CRM block.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: (): Promise<EmailOutboxRecoveryResult> =>
                recoverEmailOutboxInFlight(emailOutboxDb, EMAIL_OUTBOX_SHUTDOWN_STALE_MS),
              catch: (err) => (err instanceof Error ? err : new Error(String(err))),
            }).pipe(
              Effect.tap((result: EmailOutboxRecoveryResult) =>
                Effect.sync(() => {
                  log.info(
                    {
                      reset: result.reset,
                      deadLettered: result.deadLettered,
                      staleAgeMs: EMAIL_OUTBOX_SHUTDOWN_STALE_MS,
                      event: "email_outbox.shutdown_recovery",
                    },
                    `Email outbox shutdown sweep — ${result.reset} reset to pending, ${result.deadLettered} dead-lettered`,
                  );
                }),
              ),
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  log.warn(
                    { err: errorMessage(err), event: "email_outbox.shutdown_recovery_failed" },
                    "Email outbox shutdown recovery sweep failed — next boot will mop up",
                  );
                }),
              ),
            );
          }),
        );

        // Region/opt-out gate. Recovery sweeps above + the shutdown
        // finalizer stay wired regardless so a flip-back-on inherits clean
        // state. Nested-if (not early-return) so we don't skip the main
        // scheduler finalizer below.
        const emailFlusherEnabled = isEmailOutboxFlusherEnabled();
        if (!emailFlusherEnabled) {
          log.info(
            { event: "email_outbox.flusher_disabled_by_env" },
            "Email outbox flusher disabled by ATLAS_EMAIL_OUTBOX_FLUSHER_ENABLED=false — recovery sweeps still run on boot/shutdown",
          );
        }

        if (emailFlusherEnabled) {
          const emailTickIntervalMs = getEmailOutboxTickIntervalMs();
          const emailWarnLimiter = new EmailOutboxWarnRateLimiter(getEmailOutboxWarnThreshold());
          let emailTickCount = 0;
          let emailLastTickAt = Date.now();
          const EMAIL_HEARTBEAT_EVERY_N_TICKS = Math.max(
            1,
            Math.round(60_000 / Math.max(1, emailTickIntervalMs)),
          );
          const EMAIL_STALL_THRESHOLD_MS = Math.max(15_000, emailTickIntervalMs * 2);

          const emailTick = Effect.sync(() => {
            // Liveness stamped at tick START so a legitimately long tick
            // (sequential re-sends with per-row network calls) doesn't
            // trip the watchdog.
            emailLastTickAt = Date.now();
          }).pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: () =>
                  runEmailOutboxTick({
                    db: emailOutboxDb,
                    dispatcher: emailDispatcher,
                    batchLimit: EMAIL_OUTBOX_FLUSH_BATCH_LIMIT,
                    limiter: emailWarnLimiter,
                    pendingGauge: emailOutboxPendingCount,
                    deadGauge: emailOutboxDeadCount,
                    logger: log,
                  }),
                catch: (err) => (err instanceof Error ? err : new Error(String(err))),
              }),
            ),
            Effect.tap(({ flush: result, snapshot }) =>
              Effect.sync(() => {
                emailTickCount += 1;
                if (result.claimed > 0) {
                  log.info(
                    {
                      tickCount: emailTickCount,
                      claimed: result.claimed,
                      ok: result.ok,
                      transient: result.transient,
                      permanent: result.permanent,
                      event: "email_outbox.tick_complete",
                    },
                    `Email outbox tick: ${result.claimed} claimed (ok=${result.ok}, transient=${result.transient}, dead=${result.permanent})`,
                  );
                  return;
                }
                if (emailTickCount % EMAIL_HEARTBEAT_EVERY_N_TICKS === 0) {
                  log.info(
                    {
                      tickCount: emailTickCount,
                      pending: snapshot.pending,
                      dead: snapshot.dead,
                      event: "email_outbox.heartbeat",
                    },
                    `Email outbox heartbeat tick=${emailTickCount} (queue idle: pending=${snapshot.pending}, dead=${snapshot.dead})`,
                  );
                }
              }),
            ),
            Effect.catchAll((err) =>
              Effect.sync(() => {
                emailTickCount += 1;
                log.warn(
                  {
                    tickCount: emailTickCount,
                    err: errorMessage(err),
                    event: "email_outbox.tick_failed",
                  },
                  "Email outbox flush tick failed — will retry on next interval",
                );
              }),
            ),
          );
          // forkScoped, not fork — see registerPeriodicFiber (#2864). Recovery finalizer is
          // registered ABOVE this fork so LIFO interrupts this fiber before
          // the sweep runs.
          yield* Effect.forkScoped(
            withFiberDeathLog(
              "email_outbox_flusher",
              emailTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(emailTickIntervalMs)))),
            ),
          );

          // Stall watchdog — surfaces a silently-dead fiber as an error
          // log without auto-restarting (operator redeploys). Polls at
          // tick cadence to bound detection lag.
          let emailLastStallLogAt = 0;
          const emailWatchdog = Effect.sync(() => {
            const sinceMs = Date.now() - emailLastTickAt;
            if (sinceMs < EMAIL_STALL_THRESHOLD_MS) return;
            const now = Date.now();
            if (now - emailLastStallLogAt < 60_000) return;
            emailLastStallLogAt = now;
            log.error(
              {
                tickCount: emailTickCount,
                sinceLastTickMs: sinceMs,
                thresholdMs: EMAIL_STALL_THRESHOLD_MS,
                event: "email_outbox.tick_stall",
              },
              `Email outbox flusher fiber appears stalled — no tick in ${Math.round(sinceMs / 1000)}s (threshold ${Math.round(EMAIL_STALL_THRESHOLD_MS / 1000)}s). Redeploy to restart.`,
            );
          });
          // forkScoped, not fork — see registerPeriodicFiber for the #2864 rationale.
          yield* Effect.forkScoped(
            withFiberDeathLog(
              "email_outbox_watchdog",
              emailWatchdog.pipe(
                Effect.repeat(Schedule.spaced(Duration.millis(emailTickIntervalMs))),
              ),
            ),
          );
          log.info(
            {
              intervalMs: emailTickIntervalMs,
              batchLimit: EMAIL_OUTBOX_FLUSH_BATCH_LIMIT,
              heartbeatEveryNTicks: EMAIL_HEARTBEAT_EVERY_N_TICKS,
              stallThresholdMs: EMAIL_STALL_THRESHOLD_MS,
            },
            "Email outbox flusher started — heartbeat=email_outbox.heartbeat (every ~60s when idle); stall watchdog=email_outbox.tick_stall",
          );
        } // close `if (emailFlusherEnabled)`
      } else {
        log.debug(
          { hasInternalDB: hasInternalDB() },
          "Email outbox flusher not started — no internal DB",
        );
      }

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

          // #4195 — the BYOT catalog refresh (#2284), shared OpenAPI spec
          // refresh (#2970), and Tier-2 install re-discovery (#2978) no longer
          // need explicit stop calls here: they are now `registerPeriodicFiber`
          // fibers forked `forkScoped` on this Layer's scope, so scope shutdown
          // interrupts them automatically (no `setInterval` handle to clear).

          // Stop the knowledge bundle sync scheduler (#4211) — still a
          // self-rescheduling `setTimeout` + `unref()` scheduler (not yet
          // folded onto `registerPeriodicFiber` like the #4195 trio above),
          // so its pending timer must be cleared explicitly here.
          yield* Effect.tryPromise({
            try: async () => {
              const { stopKnowledgeBundleSyncScheduler } = await import(
                "@atlas/api/lib/scheduler/knowledge-bundle-sync"
              );
              stopKnowledgeBundleSyncScheduler();
            },
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) => {
              log.warn(
                { err: errorMessage(err) },
                "Failed to stop knowledge bundle sync scheduler",
              );
              return Effect.void;
            }),
          );

          log.info("Schedulers shut down via Effect scope");
        }),
      );

      return { backend } satisfies SchedulerShape;
    }),
  );
}

// ══════════════════════════════════════════════════════════════════════
// ██  DPA Guard Layer (#1969)
// ══════════════════════════════════════════════════════════════════════

/**
 * SaaS-region platform email DPA guard (#1969). Enforces that, in SaaS
 * deploy mode, the platform email transport is Resend (the vendor listed
 * on /dpa). Self-hosted is unaffected.
 *
 * Depends on `Config` (for `deployMode`) and `Settings` (so the in-process
 * settings cache is warm before `getSetting("ATLAS_EMAIL_PROVIDER")` is
 * read). On violation the Layer fails with `DpaInconsistencyError`, which
 * propagates out of `runtime.runtimeEffect` in server.ts and exits the
 * process — the intended behavior for a DPA misconfig.
 *
 * `Layer.effectDiscard` is correct here over `Layer.effect`: the guard
 * has no service to expose; it runs once at boot and either passes or
 * fails the Layer. No phantom Tag, no shape, no consumers.
 */
export const DpaGuardLive: Layer.Layer<never, Error, Config | Settings> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    yield* Settings; // sequence after settings cache is loaded

    yield* Effect.try({
      try: () =>
        assertSaasPlatformEmailIsResend({
          isSaas: () => config.deployMode === "saas",
        }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  MigrationGuardLive (#1988 C9) — sibling of DpaGuardLive
// ══════════════════════════════════════════════════════════════════════

/**
 * Sibling shape to `DpaGuardLive` — both are `Layer.effectDiscard`
 * SaaS-mode boot guards that depend on a domain Tag they need to
 * assert against (`Settings` for DPA, `Migration` here) and fail with
 * a tagged error when the contract is violated. The error class
 * (`MigrationsRequiredError`) lives in `saas-guards.ts` next to its
 * siblings; this Layer lives here because it directly yields the
 * `Migration` Tag defined above. Putting the Layer in `saas-guards.ts`
 * would force every consumer of that module (test layers, future
 * sibling guards) to pull the full Layer DAG via `layers.ts`'s dynamic
 * imports — kept here so the boot-only modules stay walled off from
 * request-path consumers.
 *
 * Why promote `MigrationLive`'s soft failure to fatal in SaaS:
 *
 * `MigrationLive` is intentionally non-fatal so a self-hosted operator
 * running a stateless instance (no `DATABASE_URL`) can still boot.
 * Without this guard the same fallback fires in SaaS — `loadSettings()`
 * hits the `42P01 / does not exist` branch in `lib/settings.ts`, the
 * cache stays empty, and every subsequent `getSetting()` resolves
 * through env-vars only. That bypasses every admin override the boot
 * guards depend on (e.g. the DPA guard's `ATLAS_EMAIL_PROVIDER`
 * lookup), so a partial-schema region would silently boot with the
 * wrong contract surface. Promote the failure here so the silent
 * downgrade chain can never start.
 */
export const MigrationGuardLive: Layer.Layer<never, MigrationsRequiredError, Config | Migration> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { config } = yield* Config;
    if (config.deployMode !== "saas") return;
    // Skip when there's no internal DB at all — `InternalDbGuardLive`
    // already fails boot for that case in SaaS, and a duplicate
    // failure here would just obscure the actual misconfig.
    if (!readSaasEnv().DATABASE_URL) return;

    const migration = yield* Migration;
    if (migration.migrated) return;

    yield* Effect.fail(
      new MigrationsRequiredError({
        ...(migration.error !== undefined && { cause: migration.error }),
        message:
          `SaaS region booted but Drizzle migrations did not complete. The internal DB schema is ` +
          `incomplete; settings reads would fall back to env-vars only and bypass admin overrides ` +
          `that other boot guards (DPA, plan limits) rely on. ` +
          (migration.error !== undefined
            ? `Underlying error: ${migration.error}. `
            : `Inspect the prior 'Boot migration failed' log line for the underlying cause. `) +
          `Re-run after the schema is repaired. See #1988.`,
      }),
    );
  }),
);

// ══════════════════════════════════════════════════════════════════════
// ██  AppLayer — compose the full startup DAG
// ══════════════════════════════════════════════════════════════════════

/**
 * Build the full application Layer DAG.
 *
 * Layer dependency graph (key #3743 edges marked):
 *   InternalDB          (no deps — creates pg.Pool via PgClient.layerFromPool)
 *   Migration           (← InternalDB — pool ready first; SCHEMA migrations only)
 *   ConnectionRegistry  (no deps — binds the global `connections` Tag, lifecycle-unmanaged)
 *   PluginRegistry      (← ConnectionRegistry + Migration — #3741 type-level edge:
 *                        plugin initialize() can't run before core migrations)
 *   ConnectionsHydrate  (← InternalDB + Migration + PluginRegistry — datasource
 *                        plugins must be registered before DB-stored conns load)
 *   AuthBootstrap       (← Migration + PluginRegistry — loadPluginSettings.disable
 *                        AFTER wiring, preserving pre-#3743 order)
 *   PoolWarmup          (← PluginRegistry + ConnectionsHydrate)
 *   All other layers    (independent peers)
 *
 * On shutdown, Effect disposes scoped layers via their finalizers. The wired
 * PluginRegistry layer's finalizer runs `plugins.teardownAll()`. InternalDB's
 * finalizer closes the pg.Pool. The global `connections` registry is
 * lifecycle-unmanaged here (its health fiber starts in `initializeConfig`, its
 * shutdown stays imperative in server.ts) — see `manageLifecycle: false` below.
 *
 * `pluginWiring` is provided by server.ts when `config.plugins?.length`. When
 * absent, an empty `PluginRegistryLive` backs the Tag purely as an ordering
 * barrier for ConnectionsHydrate / AuthBootstrap / PoolWarmup.
 */
export function buildAppLayer(
  config: ResolvedConfig,
  pluginWiring?: PluginWiringConfig,
): Layer.Layer<
  | Telemetry
  | Config
  | InternalDB
  | Migration
  | ConnectionRegistry
  | PluginRegistry
  | BackfillSaasTrial
  | CatalogSeed
  | BuiltinDatasourceCatalogSeed
  | ImplementationStatusOverride
  | ConnectionsHydrate
  | StagingSeed
  | SemanticSync
  | Settings
  | Scheduler
  | DurableSession
  | EnterpriseSubsystem,
  Error
> {
  const configLayer = Layer.succeed(Config, { config });
  const internalDBLayer = makeInternalDBLive();

  // DurableSession (#3745, ADR-0020) — real, internal-DB-backed store when an
  // internal DB is present; the Noop layer otherwise (same `hasInternalDB()`
  // gate as the EE Noop layers). The scheduler's retention-sweep fiber resolves
  // it via the Tag. The per-workspace `ATLAS_DURABILITY_ENABLED` flag is checked
  // at write time in the agent loop, not here.
  const durableSession = durableSessionLayer(hasInternalDB());

  // DurableState (#3754, ADR-0020) — per-session agent working memory. Same
  // `hasInternalDB()` gate / Noop-layer shape as DurableSession. The agent loop
  // calls the plain helpers directly; the Tag is exposed app-wide for Effect
  // callers + `Layer.provide` test injection. Per-workspace `ATLAS_DURABILITY_ENABLED`
  // is checked at turn time in the agent loop, not here.
  const durableState = durableStateLayer(hasInternalDB());

  // MigrationLive depends on InternalDB — provide it
  const migrationLayer = MigrationLive.pipe(Layer.provide(internalDBLayer));

  // ConnectionRegistry Tag bound to the GLOBAL `connections` singleton (#3743).
  // `manageLifecycle: false` — the global already runs its own health fiber
  // (started in `initializeConfig`) and is shut down imperatively in server.ts,
  // so this binding adds NO second fiber/finalizer; it only exposes the Tag for
  // the wired plugin layer's type-level dependency. Lazy `require` keeps the
  // heavyweight connection module out of layers.ts's eager import graph.
  const connectionRegistryLayer = makeConnectionRegistryLive(
    () => {
      // oxlint-disable-next-line @typescript-eslint/no-require-imports
      const { connections } = require("@atlas/api/lib/db/connection");
      return connections;
    },
    { manageLifecycle: false },
  );

  // PluginRegistry layer. When plugins are configured, the WIRED layer registers
  // + migrates + initializes + wires them — gated at the type level on
  // ConnectionRegistry + Migration (the #3741 structural fix). The wired layer
  // backs the GLOBAL `plugins` singleton (the rest of the app + the hydrate
  // bridge read the global), so pass `() => plugins`. Without configured
  // plugins, an empty `PluginRegistryLive` backs the Tag as an ordering barrier.
  const pluginRegistryLayer = pluginWiring
    ? makeWiredPluginRegistryLive(pluginWiring, () => {
        // oxlint-disable-next-line @typescript-eslint/no-require-imports
        const { plugins } = require("@atlas/api/lib/plugins/registry");
        return plugins;
      }).pipe(Layer.provide(Layer.merge(connectionRegistryLayer, migrationLayer)))
    : PluginRegistryLive;

  // BackfillSaasTrialLive depends on Migration (so the `organization`
  // table is guaranteed to exist) and InternalDB. Independent peer of
  // the other layers — Effect's mergeAll doesn't order independent
  // siblings, so the only real ordering is the Migration dependency.
  const backfillSaasTrialLayer = BackfillSaasTrialLive.pipe(
    Layer.provide(Layer.merge(internalDBLayer, migrationLayer)),
  );

  // CatalogSeedLive depends on Migration (so the install_model +
  // saas_eligible columns added by 0087 exist) and InternalDB. Same
  // shape as BackfillSaasTrialLive — independent peer otherwise.
  const catalogSeedLayer = CatalogSeedLive.pipe(
    Layer.provide(Layer.merge(internalDBLayer, migrationLayer)),
  );

  // BuiltinDatasourceCatalogSeedLive (#2743, slice 5) — depends on
  // Migration so 0092's pillar / implementation_status / auto_install
  // columns + 0093's INSERTs are guaranteed before the boot re-assert.
  // Independent peer of catalogSeedLayer; the two seeds touch disjoint
  // slug sets so ordering between them doesn't matter.
  const builtinDatasourceCatalogSeedLayer = BuiltinDatasourceCatalogSeedLive.pipe(
    Layer.provide(Layer.merge(internalDBLayer, migrationLayer)),
  );

  // BuiltinKnowledgeCatalogSeedLive (#4206/#4211, ADR-0028) — the built-in
  // Knowledge Base rows (`okf-upload`, `bundle-sync`), code-seeded through the
  // operator-curated seam. Depends on Migration so 0161's widened pillar CHECK
  // (admitting `pillar='knowledge'`) is guaranteed before the INSERTs.
  // Independent peer of the other seeds; disjoint slugs so ordering doesn't
  // matter.
  const builtinKnowledgeCatalogSeedLayer = BuiltinKnowledgeCatalogSeedLive.pipe(
    Layer.provide(Layer.merge(internalDBLayer, migrationLayer)),
  );

  // OpenApiDatasourceCatalogSeedLive (#2926, slice 2) — the built-in
  // `openapi-generic` REST datasource row, code-seeded per ADR-0007.
  // Independent peer of the two seeds above; disjoint slug so ordering
  // doesn't matter. Kept separate so the REST datasource never enters the
  // SQL slug allowlist / pool resolver.
  const openApiDatasourceCatalogSeedLayer = OpenApiDatasourceCatalogSeedLive.pipe(
    Layer.provide(Layer.merge(internalDBLayer, migrationLayer)),
  );

  // ImplementationStatusOverrideLive (#2747, slice 9) — depends on
  // BOTH seed Layers so the override is applied AFTER both finish
  // (the catalog seeder's upsert would otherwise clobber it). The
  // dependency edge enforces ordering at the type level; Effect's
  // memoization keeps the seed Layers from running twice.
  const implementationStatusOverrideLayer = ImplementationStatusOverrideLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        internalDBLayer,
        migrationLayer,
        catalogSeedLayer,
        builtinDatasourceCatalogSeedLayer,
      ),
    ),
  );

  // ConnectionsHydrate now also depends on PluginRegistry (#3743): the wired
  // plugin layer must register datasource plugins before `loadSavedConnections`
  // builds DB-stored plugin datasource pools (which look the plugin up in the
  // global registry). Same shared `pluginRegistryLayer` reference everywhere, so
  // Effect memoization keeps the wired layer built once (one `initializeAll`).
  const connectionsHydrateLayer = ConnectionsHydrateLive.pipe(
    Layer.provide(Layer.mergeAll(internalDBLayer, migrationLayer, pluginRegistryLayer)),
  );

  // AuthBootstrap (#3743) — post-schema bootstrap (plugin settings, abuse,
  // admin/seed) AFTER plugin wiring, preserving the pre-#3743 loadPluginSettings
  // order. Depends on Migration + the wired PluginRegistry, and — since #4000
  // (WS5) — on `AbuseResponse` (via `EnterpriseLayer`) so the EE abuse engine's
  // sync-policy registration runs before `restoreAbuseState`.
  const authBootstrapLayer = AuthBootstrapLive.pipe(
    Layer.provide(Layer.mergeAll(migrationLayer, pluginRegistryLayer, EnterpriseLayer)),
  );

  // PoolWarmup (#3743) — replaces the imperative `connections.warmup()`. Runs
  // after config datasources (PluginRegistry) AND DB-stored connections
  // (ConnectionsHydrate) are registered.
  const poolWarmupLayer = PoolWarmupLive.pipe(
    Layer.provide(Layer.merge(pluginRegistryLayer, connectionsHydrateLayer)),
  );

  // StagingSeedLive (#2914) — depends on Migration (so 0093's demo-postgres
  // catalog row exists) + the builtin datasource seeder (ordering barrier so
  // the row is re-asserted before the staging org installs it). Region-gated
  // to `staging`, so prod / self-hosted boots run it as an immediate no-op.
  const stagingSeedLayer = StagingSeedLive.pipe(
    Layer.provide(
      Layer.mergeAll(internalDBLayer, migrationLayer, builtinDatasourceCatalogSeedLayer),
    ),
  );

  // Independent layers (no Effect-level deps)
  const semanticSyncLayer = SemanticSyncLive;
  const settingsLayer = SettingsLive;
  // Scheduler depends on `AuditPurgeScheduler` (#2587 — split out of
  // `AuditRetention` in #2569) so it can start the EE audit purge worker
  // via the Tag — `EnterpriseLayer` provides both the no-op default and
  // the real EE implementation.
  //
  // `settingsLayer` is provided as an ordering barrier (#3392): the expert
  // scheduler reads ATLAS_EXPERT_SCHEDULER_ENABLED / _INTERVAL_HOURS via
  // getSetting() at layer-construction time, so `loadSettings()` must warm
  // the cache first or a platform DB override would race boot — same
  // Settings-edge rationale as ProactiveProviderKeyGuardLive below. Layer
  // memoization keeps the shared `settingsLayer` reference built once.
  //
  // `migrationLayer` is a second ordering barrier (#3446): the billing
  // reconcile fiber's eager boot tick must not run before migration 0128
  // creates `stripe_webhook_events`. Same shared reference as everywhere
  // else, so Effect memoization makes the edge free (Migration ←
  // InternalDB only — no cycle back into Scheduler).
  //
  // `durableSession` is provided so the retention-sweep fiber (#3745) can
  // resolve the `DurableSession` Tag — Noop when there is no internal DB, so
  // the fiber forks but sweeps nothing. `durableState` (#3757) is provided for
  // the same fiber's memory sweep — it rides the SAME tick + retention window,
  // so terminal/expired sessions take their working memory with them.
  const schedulerLayer = makeSchedulerLive(config).pipe(
    Layer.provide(
      Layer.mergeAll(EnterpriseLayer, settingsLayer, migrationLayer, durableSession, durableState),
    ),
  );

  // DpaGuardLive depends on Config + Settings — provide them so the boot
  // Layer fails on any SaaS DPA misconfig (#1969) before HTTP starts.
  const dpaGuardLayer = DpaGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, settingsLayer)),
  );

  // SaaS boot-guard family (#1978, extended in #1983 + #1988). Each
  // guard fails boot when a SaaS contract is violated. Self-hosted is
  // unaffected. The first four depend only on `Config` (the enterprise
  // / encryption / DB / rate-limit checks read env directly) so they
  // can run in parallel with the migration + sync layers.
  const enterpriseGuardLayer = EnterpriseGuardLive.pipe(Layer.provide(configLayer));
  const encryptionKeyGuardLayer = EncryptionKeyGuardLive.pipe(Layer.provide(configLayer));
  const internalDbGuardLayer = InternalDbGuardLive.pipe(Layer.provide(configLayer));
  const rateLimitGuardLayer = RateLimitGuardLive.pipe(Layer.provide(configLayer));
  // #3795 — fails boot when TURNSTILE_SECRET_KEY is unset in SaaS. Turnstile
  // gates the contact form + the start_trial MCP onboarding bootstrap;
  // verifyTurnstile fails closed, so a missing secret is a silent 100% signup
  // outage that boots green. `Config`-only and reads env directly, so it fails
  // fast as a peer of the other env-checking guards.
  const turnstileGuardLayer = TurnstileGuardLive.pipe(Layer.provide(configLayer));
  // #4461 — fails boot when sandbox.priority pins vercel-sandbox (the SaaS
  // deny-all posture) but the Vercel Sandbox credentials are absent/partial.
  // A missing/mis-stamped per-service VERCEL_TOKEN otherwise boots green while
  // every explore/executePython call hard-fails at first use. `Config`-only
  // (reads the resolved priority + env creds directly), so it fails fast as a
  // peer of the other env-checking guards; inert unless the priority pins
  // vercel-sandbox (self-hosted / differently-configured deploys pass).
  const sandboxCredsGuardLayer = SandboxCredsGuardLive.pipe(Layer.provide(configLayer));
  // #3178/#3200 — fails boot when the env-only MAIN-CHAT provider's required
  // config is incomplete in SaaS (boot-green-then-503 otherwise). Validates
  // required env as a SET (`getMissingProviderConfig`). `Config`-only and reads
  // env directly, so it fails fast as a peer of the other env-checking guards.
  const providerKeyGuardLayer = ProviderKeyGuardLive.pipe(Layer.provide(configLayer));
  // #3203 — sibling guard for the settings-backed PROACTIVE provider. Depends on
  // `Config` + `Settings` (like `DpaGuardLive`): the `Settings` edge sequences it
  // after `loadSettings()` warms the cache so `getSettingAuto("ATLAS_PROVIDER")`
  // sees DB overrides. Kept separate from the env guard above so that guard stays
  // `Config`-only and fast-failing.
  const proactiveProviderKeyGuardLayer = ProactiveProviderKeyGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, settingsLayer)),
  );
  // #2672 — walks the chat catalog and fails boot when an oauth+enabled
  // entry's adapter-builder requiredEnv keys are missing in SaaS. Since #3704
  // the presence check is "operator-credentials DB row OR env", so it reads
  // `operator_integration_credentials` (created by migration 0140) — hence the
  // `migrationLayer` edge (mirrors `MigrationGuardLive` below) so the table is
  // guaranteed to exist before the guard queries it. Without it the guard could
  // race migrations and crash a first-deploy boot on a missing relation.
  const chatAdapterEnvGuardLayer = ChatAdapterEnvGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, migrationLayer)),
  );
  // #3435 + #3703 — billing config validation. Gated on `deployMode === "saas"`
  // AND `STRIPE_SECRET_KEY` present, so self-hosted and pre-billing SaaS are
  // inert. Fails boot on the two env-only misconfigs (missing webhook secret,
  // non-standard key mode) and loudly warns (never crashes) on a missing price
  // ID (now a runtime-editable platform setting, #3703) and on the network
  // price-resolution / livemode-mismatch check. Depends on `Config` + `Settings`
  // (like `DpaGuardLive`): the `Settings` edge sequences it after
  // `loadSettings()` warms the cache so `getSettingAuto` sees price-ID overrides
  // rather than falling back to env. Lazy-imports the Stripe SDK + the
  // config-validation SSOT + settings inside its Effect body.
  const billingConfigGuardLayer = BillingConfigGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, settingsLayer)),
  );
  // #3687 — MCP-spine boot coherence guard. Gated on `deployMode === "saas"`
  // (hosted MCP is unconditionally mounted in SaaS, so SaaS IS the MCP-exposed
  // predicate); self-hosted is inert. FAILS boot when OAuth valid-audiences are
  // not derivable (deterministic env check) and WARNS when the
  // `mcp_action_policy` store is unreachable (live DB probe — warn, not fail, to
  // avoid wedging a region on a transient blip; runtime is already fail-closed).
  // Depends on `Config` + `Migration` (the policy table is created by migration
  // 0134 — same `migrationLayer` edge as `chatAdapterEnvGuardLayer` so the probe
  // can't race the migration). Lazy-imports oauth-audiences + the policy store
  // inside its Effect body.
  const mcpSpineGuardLayer = McpSpineGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, migrationLayer)),
  );
  // #1988 C7 + C8 — region routing claim and stale plugin config checks.
  // Both depend only on `Config`. PluginConfigGuardLive lazy-imports the
  // plugin registry + InternalDB inside its Effect body so it can run as
  // a peer of migrationLayer without a static cycle.
  const regionGuardLayer = RegionGuardLive.pipe(Layer.provide(configLayer));
  // #3743 — PluginConfigGuardLive now carries a PluginRegistry ordering edge so
  // it validates stored configs AFTER the wired plugin layer registers plugins.
  const pluginConfigGuardLayer = PluginConfigGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, pluginRegistryLayer)),
  );
  // #1988 C9 — depends on Migration so it can read its `migrated` flag.
  const migrationGuardLayer = MigrationGuardLive.pipe(
    Layer.provide(Layer.merge(configLayer, migrationLayer)),
  );

  // Merge all layers. InternalDB is included both directly and as a
  // dependency of migrationLayer — Effect memoizes same-reference Layers.
  //
  // Enterprise subsystem composition (#2563 slice 1/11, #2564 slice 2/11
  // of #2017): `EnterpriseLayer` is the composed no-op-defaults +
  // conditional-EE Layer from `./enterprise-layer`. Appended last so its
  // Tag bindings override the no-op defaults when EE loads (Layer.mergeAll
  // "last wins" semantics).
  return Layer.mergeAll(
    TelemetryLive,
    configLayer,
    internalDBLayer,
    migrationLayer,
    connectionRegistryLayer,
    pluginRegistryLayer,
    backfillSaasTrialLayer,
    catalogSeedLayer,
    builtinDatasourceCatalogSeedLayer,
    builtinKnowledgeCatalogSeedLayer,
    openApiDatasourceCatalogSeedLayer,
    implementationStatusOverrideLayer,
    connectionsHydrateLayer,
    authBootstrapLayer,
    poolWarmupLayer,
    stagingSeedLayer,
    semanticSyncLayer,
    settingsLayer,
    schedulerLayer,
    durableSession,
    durableState,
    dpaGuardLayer,
    enterpriseGuardLayer,
    encryptionKeyGuardLayer,
    internalDbGuardLayer,
    rateLimitGuardLayer,
    turnstileGuardLayer,
    sandboxCredsGuardLayer,
    providerKeyGuardLayer,
    proactiveProviderKeyGuardLayer,
    regionGuardLayer,
    pluginConfigGuardLayer,
    chatAdapterEnvGuardLayer,
    billingConfigGuardLayer,
    mcpSpineGuardLayer,
    migrationGuardLayer,
    EnterpriseLayer,
  );
}
