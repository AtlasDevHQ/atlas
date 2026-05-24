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
 *   ConnectionsHydrateLayer (depends on InternalDB + Migration — connections table must exist)
 *   TelemetryLayer          (no deps)
 *   ConfigLayer             (no deps — receives pre-resolved config via Layer.succeed)
 *   SemanticSyncLayer       (no deps)
 *   SettingsLayer           (no deps)
 *   SchedulerLayer          (no deps — receives config as function param)
 *
 *   AppLayer = mergeAll(Telemetry, Config, InternalDB, Migration, ConnectionsHydrate, SemanticSync, Settings, Scheduler)
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
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { InternalDB, makeInternalDBLive, hasInternalDB } from "@atlas/api/lib/db/internal";
import { assertSaasPlatformEmailIsResend } from "@atlas/api/lib/email/dpa-guard";
import {
  EnterpriseGuardLive,
  EncryptionKeyGuardLive,
  InternalDbGuardLive,
  RateLimitGuardLive,
  RegionGuardLive,
  PluginConfigGuardLive,
  ChatAdapterEnvGuardLive,
  MigrationsRequiredError,
} from "./saas-guards";
import { readSaasEnv } from "./saas-env";
import { EnterpriseLayer, type EnterpriseSubsystem } from "./enterprise-layer";
import { AuditPurgeScheduler } from "./services";

const log = createLogger("effect:layers");

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
  /**
   * When `migrated === false`, the error message captured from the
   * `Effect.catchAll` in `MigrationLive`. `MigrationGuardLive` threads
   * this into `MigrationsRequiredError.cause` so the SaaS boot-failure
   * log line names the actual Drizzle / pg error rather than telling
   * the operator to "see the prior log".
   */
  readonly error?: string;
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

    const result = yield* Effect.tryPromise({
      try: async () => {
        const { migrateAuthTables } = await import(
          "@atlas/api/lib/auth/migrate"
        );
        await migrateAuthTables();
        return { migrated: true } satisfies MigrationShape;
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(
      Effect.catchAll((errMsg) => {
        log.error(
          { err: new Error(errMsg) },
          "Boot migration failed",
        );
        // Carry the underlying error message through the Migration Tag
        // so `MigrationGuardLive` can surface it on the boot-failure
        // log line in SaaS — review-flagged "MigrationsRequiredError
        // shouldn't punt to 'see prior log'" (#1988 PR review).
        return Effect.succeed({ migrated: false, error: errMsg } satisfies MigrationShape);
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
): Layer.Layer<ConnectionsHydrate, never, InternalDB | Migration> {
  return Layer.effect(
    ConnectionsHydrate,
    Effect.gen(function* () {
      const start = performance.now();
      const db = yield* InternalDB;
      const migration = yield* Migration;
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
  InternalDB | Migration
> = makeConnectionsHydrateLive();

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
        log.debug({ err: errorMessage(err) }, "Config not available for SaaS detection — defaulting to self-hosted");
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
              { err: errorMessage(err) },
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
): Layer.Layer<Scheduler, never, AuditPurgeScheduler> {
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
          log.debug({ err: errorMessage(err) }, "Email scheduler module not available — skipping");
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
              log.warn({ err: errorMessage(err) }, "Onboarding email tick failed");
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
          log.debug({ err: errorMessage(err) }, "Expert scheduler module not available — skipping");
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
              log.warn({ err: errorMessage(err) }, "Expert scheduler tick failed");
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
              { err: err instanceof Error ? err.message : String(err) },
              "Audit purge scheduler did not start — enterprise required or backend error",
            );
          }),
        ),
      );

      // Start BYOT catalog refresh scheduler (#2284) — daily refresh of
      // workspace_model_catalog rows whose `fetched_at` is older than TTL.
      // No-ops when the internal DB is unavailable; safe to start
      // unconditionally otherwise (self-hosted installs without EE simply
      // have no workspace configs to walk).
      yield* Effect.tryPromise({
        try: async () => {
          const { startByotCatalogRefreshScheduler } = await import(
            "@atlas/api/lib/scheduler/byot-catalog-refresh"
          );
          startByotCatalogRefreshScheduler();
        },
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.error({ err: errorMessage(err) }, "BYOT catalog refresh scheduler failed to start");
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
              { err: errorMessage(err) },
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
              { err: errorMessage(err) },
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
              { err: errorMessage(err) },
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
              { err: errorMessage(err) },
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
              { err: errorMessage(err) },
              "Dashboard rate-limit cleanup tick failed",
            );
          }),
        ),
      );
      let dashboardCleanupIntervalMs = 60_000;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require("@atlas/api/api/routes/dashboards") as {
          DASHBOARD_RATE_CLEANUP_INTERVAL_MS: number;
        };
        dashboardCleanupIntervalMs = mod.DASHBOARD_RATE_CLEANUP_INTERVAL_MS;
      } catch {
        // intentionally ignored: use default interval if module can't be resolved
      }
      const dashboardFiber = yield* Effect.fork(
        dashboardTick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(dashboardCleanupIntervalMs)))),
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
              { err: errorMessage(err) },
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
              { err: errorMessage(err) },
              "Unexpected error in share cleanup tick",
            );
          }),
        ),
      );
      const shareCleanupFiber = yield* Effect.fork(
        shareCleanupEffect.pipe(Effect.repeat(Schedule.spaced(Duration.millis(SHARE_CLEANUP_INTERVAL_MS)))),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(shareCleanupFiber));

      // ── Periodic fiber: sub-processor change-feed publisher (#1924) ──
      // Cron sweep, not build-hook: the source JSON can be hot-edited
      // via PR without a www deploy, and a sweep handles every path
      // uniformly. Default 6h tick — compliance change notifications
      // are not latency-sensitive, and a long interval keeps load on
      // www.useatlas.dev negligible. `Effect.repeat(Schedule.spaced)`
      // runs the tick once eagerly on boot, so the first sweep happens
      // within seconds of API start, not after the first 6h window.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const subProcessorPublisher = require("@atlas/api/lib/sub-processor-publisher") as {
        subProcessorPublisherTick: () => Promise<void>;
        SUBPROCESSOR_PUBLISH_INTERVAL_MS: number;
      };
      const subProcessorTick = Effect.tryPromise({
        try: () => subProcessorPublisher.subProcessorPublisherTick(),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            log.warn(
              { err: errorMessage(err) },
              "Sub-processor publisher tick failed",
            );
          }),
        ),
      );
      const subProcessorFiber = yield* Effect.fork(
        subProcessorTick.pipe(
          Effect.repeat(
            Schedule.spaced(
              Duration.millis(subProcessorPublisher.SUBPROCESSOR_PUBLISH_INTERVAL_MS),
            ),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => Fiber.interrupt(subProcessorFiber));

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

          // Stop the BYOT catalog refresh scheduler (#2284) alongside the
          // main scheduler so a Layer-scope shutdown clears its setInterval
          // timer (clearing the timer is what releases the `unref()`'d handle
          // from the event loop and lets the test process exit cleanly).
          yield* Effect.tryPromise({
            try: async () => {
              const { stopByotCatalogRefreshScheduler } = await import(
                "@atlas/api/lib/scheduler/byot-catalog-refresh"
              );
              stopByotCatalogRefreshScheduler();
            },
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) => {
              log.warn({ err: errorMessage(err) }, "Failed to stop BYOT catalog refresh scheduler");
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
  | Telemetry
  | Config
  | InternalDB
  | Migration
  | BackfillSaasTrial
  | CatalogSeed
  | BuiltinDatasourceCatalogSeed
  | ImplementationStatusOverride
  | ConnectionsHydrate
  | SemanticSync
  | Settings
  | Scheduler
  | EnterpriseSubsystem,
  Error
> {
  const configLayer = Layer.succeed(Config, { config });
  const internalDBLayer = makeInternalDBLive();

  // MigrationLive depends on InternalDB — provide it
  const migrationLayer = MigrationLive.pipe(Layer.provide(internalDBLayer));

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

  const connectionsHydrateLayer = ConnectionsHydrateLive.pipe(
    Layer.provide(Layer.merge(internalDBLayer, migrationLayer)),
  );

  // Independent layers (no Effect-level deps)
  const semanticSyncLayer = SemanticSyncLive;
  const settingsLayer = SettingsLive;
  // Scheduler depends on `AuditPurgeScheduler` (#2587 — split out of
  // `AuditRetention` in #2569) so it can start the EE audit purge worker
  // via the Tag — `EnterpriseLayer` provides both the no-op default and
  // the real EE implementation.
  const schedulerLayer = makeSchedulerLive(config).pipe(
    Layer.provide(EnterpriseLayer),
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
  // #2672 — walks the chat catalog and fails boot when an oauth+enabled
  // entry's adapter-builder requiredEnv keys are missing in SaaS. Depends
  // only on `Config` and reads env directly, so it runs in parallel with
  // the migration + sync layers alongside the other env-checking guards.
  const chatAdapterEnvGuardLayer = ChatAdapterEnvGuardLive.pipe(Layer.provide(configLayer));
  // #1988 C7 + C8 — region routing claim and stale plugin config checks.
  // Both depend only on `Config`. PluginConfigGuardLive lazy-imports the
  // plugin registry + InternalDB inside its Effect body so it can run as
  // a peer of migrationLayer without a static cycle.
  const regionGuardLayer = RegionGuardLive.pipe(Layer.provide(configLayer));
  const pluginConfigGuardLayer = PluginConfigGuardLive.pipe(Layer.provide(configLayer));
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
    backfillSaasTrialLayer,
    catalogSeedLayer,
    builtinDatasourceCatalogSeedLayer,
    implementationStatusOverrideLayer,
    connectionsHydrateLayer,
    semanticSyncLayer,
    settingsLayer,
    schedulerLayer,
    dpaGuardLayer,
    enterpriseGuardLayer,
    encryptionKeyGuardLayer,
    internalDbGuardLayer,
    rateLimitGuardLayer,
    regionGuardLayer,
    pluginConfigGuardLayer,
    chatAdapterEnvGuardLayer,
    migrationGuardLayer,
    EnterpriseLayer,
  );
}
