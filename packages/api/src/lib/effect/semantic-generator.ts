/**
 * SemanticGenerator — profile a datasource and generate its semantic layer.
 *
 * This is **Blocker #1** of the MCP V2 datasource flagship (#3506 / PRD #3483):
 * the shared, API-callable seam that turns a live connection into a *queryable*
 * semantic layer. Without it an MCP-created datasource is connected-but-
 * unqueryable — empty table whitelist, no entities. Both the CLI (`atlas init`,
 * via the pure {@link generateSemanticLayer} core) and a future long-running MCP
 * datasource tool drive the same generation logic, so the two can never drift.
 *
 * The service composes three responsibilities:
 *   1. **profile** — run the dialect profiler, enforce the failure threshold,
 *      and apply the analysis heuristics, yielding analyzed `TableProfile`s.
 *   2. **generate** — assemble entity/catalog/glossary/metric YAML (pure;
 *      delegates to {@link generateSemanticLayer}).
 *   3. **registerWhitelist** — make the generated tables queryable by populating
 *      the in-memory table whitelist for a connection.
 *
 * `profileAndGenerate` ties all three together for a programmatic caller.
 *
 * **Profiler resolution (registry seam — ADR-0013 sibling).** Core profiles
 * Postgres and MySQL directly (the two engines `@atlas/api` owns). Other
 * dbTypes live in plugin packages that core must not import (ADR-0013), so the
 * caller injects a {@link DatasourceProfiler} via `opts.profileFn`. This keeps
 * THIS extraction scoped while pointing at the eventual registry-resolved
 * profiler seam (PRD #3303) — when that lands, the registry supplies `profileFn`
 * instead of the caller.
 */

import { Context, Effect, Layer } from "effect";
import type {
  DatabaseObject,
  ProfileError,
  ProfilingResult,
  TableProfile,
} from "@useatlas/types";
import type { DBType } from "@atlas/api/lib/db/connection";
import {
  profilePostgres,
  profileMySQL,
  checkFailureThreshold,
  type ProfileLogger,
  type ProfileProgressCallbacks,
} from "@atlas/api/lib/profiler";
import {
  analyzeTableProfiles,
  generateSemanticLayer,
  type GeneratedSemanticLayer,
  type GenerateSemanticLayerOptions,
} from "@atlas/api/lib/semantic/generate";
import { registerPluginEntities } from "@atlas/api/lib/semantic/whitelist";
import { createLogger } from "@atlas/api/lib/logger";
import { ProfilingFailedError } from "./errors";

const log = createLogger("effect:semantic-generator");

// ── Profiler seam ────────────────────────────────────────────────────

/**
 * A function that profiles a single datasource into a {@link ProfilingResult}.
 *
 * Core resolves this for Postgres/MySQL; callers inject it for plugin dbTypes
 * (ClickHouse, Snowflake, DuckDB, Salesforce, …) whose adapters core must not
 * import (ADR-0013). The shape mirrors the core `profilePostgres`/`profileMySQL`
 * signatures, normalized to a single options object.
 */
export type DatasourceProfiler = (args: {
  url: string;
  schema: string;
  selectedTables?: string[];
  prefetchedObjects?: DatabaseObject[];
  progress?: ProfileProgressCallbacks;
  logger?: ProfileLogger;
}) => Promise<ProfilingResult>;

// ── Option / result shapes ───────────────────────────────────────────

/** Inputs for profiling one connection into analyzed profiles. */
export interface ProfileConnectionOptions {
  /** Connection string / URL for the datasource. */
  url: string;
  /** Datasource dialect. */
  dbType: DBType;
  /** Schema to profile (Postgres). Defaults to `"public"`. */
  schema?: string;
  /** Restrict profiling to these tables/views. Omit to profile all. */
  selectedTables?: string[];
  /** Pre-listed database objects (avoids a second catalog round-trip). */
  prefetchedObjects?: DatabaseObject[];
  /** Progress callbacks (e.g. a CLI progress bar). */
  progress?: ProfileProgressCallbacks;
  /** Structured logger for profiler diagnostics. */
  logger?: ProfileLogger;
  /** Continue past the failure-rate threshold instead of aborting. */
  force?: boolean;
  /**
   * Profiler override for non-core dbTypes. Required for any dbType other than
   * `postgres`/`mysql`; ignored (but honored if present) for those two.
   */
  profileFn?: DatasourceProfiler;
}

/** Outcome of {@link SemanticGeneratorShape.profile}. */
export interface ProfileConnectionResult {
  /** Profiles with analysis heuristics applied, ready for generation. */
  profiles: TableProfile[];
  /** Per-table profiling errors (below the abort threshold). */
  errors: ProfileError[];
  /** Wall-clock profiling duration in milliseconds. */
  elapsedMs: number;
}

/** Inputs for the end-to-end profile → generate (→ register) flow. */
export interface ProfileAndGenerateOptions extends ProfileConnectionOptions {
  /**
   * Connection-group identifier. Drives the entity `connection:` field and the
   * whitelist key. Omit (or `"default"`) for the default group.
   */
  connectionId?: string;
  /**
   * Register the generated entity tables into the in-memory whitelist so the
   * connection is immediately queryable. Defaults to `true`.
   */
  registerWhitelist?: boolean;
}

/** Outcome of {@link SemanticGeneratorShape.profileAndGenerate}. */
export interface ProfileAndGenerateResult extends GeneratedSemanticLayer {
  /** Analyzed profiles that produced the artifacts. */
  profiles: TableProfile[];
  /** Per-table profiling errors (below the abort threshold). */
  errors: ProfileError[];
  /** Wall-clock profiling duration in milliseconds. */
  elapsedMs: number;
}

// ── Service interface ────────────────────────────────────────────────

export interface SemanticGeneratorShape {
  /**
   * Profile a connection into analyzed `TableProfile`s. Fails with
   * {@link ProfilingFailedError} when the connection yields no tables, breaches
   * the failure threshold (without `force`), or has no profiler for its dbType.
   */
  readonly profile: (
    opts: ProfileConnectionOptions,
  ) => Effect.Effect<ProfileConnectionResult, ProfilingFailedError>;

  /**
   * Assemble semantic-layer artifacts from analyzed profiles. Pure — no I/O.
   * (Same engine the CLI uses; see {@link generateSemanticLayer}.)
   */
  readonly generate: (
    profiles: TableProfile[],
    opts: GenerateSemanticLayerOptions,
  ) => GeneratedSemanticLayer;

  /**
   * Register generated entity tables into the in-memory whitelist for a
   * connection, making them queryable by `executeSQL`. No files are written.
   */
  readonly registerWhitelist: (
    connectionId: string,
    entities: ReadonlyArray<{ table: string; yaml: string }>,
  ) => void;

  /**
   * Profile a connection, generate its semantic layer, and (by default)
   * register the tables into the whitelist — the one-call programmatic entry
   * point for an MCP datasource tool.
   */
  readonly profileAndGenerate: (
    opts: ProfileAndGenerateOptions,
  ) => Effect.Effect<ProfileAndGenerateResult, ProfilingFailedError>;
}

export class SemanticGenerator extends Context.Tag("SemanticGenerator")<
  SemanticGenerator,
  SemanticGeneratorShape
>() {}

// ── Implementation ───────────────────────────────────────────────────

/** Resolve the profiler for a dbType: core for pg/mysql, injected otherwise. */
function resolveProfiler(
  dbType: DBType,
  profileFn: DatasourceProfiler | undefined,
): DatasourceProfiler | ProfilingFailedError {
  if (profileFn) return profileFn;
  if (dbType === "postgres") {
    return ({ url, schema, selectedTables, prefetchedObjects, progress, logger }) =>
      profilePostgres(url, selectedTables, prefetchedObjects, schema, progress, logger);
  }
  if (dbType === "mysql") {
    return ({ url, selectedTables, prefetchedObjects, progress, logger }) =>
      profileMySQL(url, selectedTables, prefetchedObjects, progress, logger);
  }
  return new ProfilingFailedError({
    message:
      `No profiler available for dbType "${dbType}". Core profiles postgres/mysql; ` +
      `pass opts.profileFn to profile a plugin datasource.`,
    reason: "unsupported_db_type",
  });
}

function profileImpl(
  opts: ProfileConnectionOptions,
): Effect.Effect<ProfileConnectionResult, ProfilingFailedError> {
  return Effect.gen(function* () {
    const schema = opts.schema ?? "public";
    const profiler = resolveProfiler(opts.dbType, opts.profileFn);
    if (profiler instanceof ProfilingFailedError) {
      return yield* Effect.fail(profiler);
    }

    const start = Date.now();
    const result: ProfilingResult = yield* Effect.tryPromise({
      try: () =>
        profiler({
          url: opts.url,
          schema,
          selectedTables: opts.selectedTables,
          prefetchedObjects: opts.prefetchedObjects,
          progress: opts.progress,
          logger: opts.logger,
        }),
      catch: (err) =>
        new ProfilingFailedError({
          message: `Profiling failed: ${err instanceof Error ? err.message : String(err)}`,
          reason: "profiler_error",
        }),
    });
    const elapsedMs = Date.now() - start;

    if (result.profiles.length === 0) {
      return yield* Effect.fail(
        new ProfilingFailedError({
          message:
            "No tables or views were successfully profiled. Check database " +
            "permissions and that the schema is non-empty.",
          reason: "no_tables",
        }),
      );
    }

    const { shouldAbort } = checkFailureThreshold(result, opts.force ?? false);
    if (shouldAbort) {
      const totalCount = result.profiles.length + result.errors.length;
      return yield* Effect.fail(
        new ProfilingFailedError({
          message:
            `Profiling failed for ${result.errors.length}/${totalCount} tables ` +
            `(${Math.round((result.errors.length / totalCount) * 100)}%). ` +
            `Pass force to continue anyway.`,
          reason: "threshold_exceeded",
          failedCount: result.errors.length,
          totalCount,
        }),
      );
    }

    return {
      profiles: analyzeTableProfiles(result.profiles),
      errors: result.errors,
      elapsedMs,
    } satisfies ProfileConnectionResult;
  });
}

function generateImpl(
  profiles: TableProfile[],
  opts: GenerateSemanticLayerOptions,
): GeneratedSemanticLayer {
  return generateSemanticLayer(profiles, opts);
}

function registerWhitelistImpl(
  connectionId: string,
  entities: ReadonlyArray<{ table: string; yaml: string }>,
): void {
  // The in-memory whitelist registration path keys tables by connection id and
  // parses each entity's YAML with the same `EntityShape` validation as disk-
  // and DB-backed entities. No files are written — the registration is the
  // mechanism that makes a freshly-profiled connection queryable in-process.
  registerPluginEntities(
    connectionId,
    entities.map((e) => ({ name: e.table, yaml: e.yaml })),
  );
}

function profileAndGenerateImpl(
  opts: ProfileAndGenerateOptions,
): Effect.Effect<ProfileAndGenerateResult, ProfilingFailedError> {
  return Effect.gen(function* () {
    const { profiles, errors, elapsedMs } = yield* profileImpl(opts);

    const connectionId = opts.connectionId ?? "default";
    const sourceId = connectionId === "default" ? undefined : connectionId;
    const generated = generateImpl(profiles, {
      dbType: opts.dbType,
      schema: opts.schema,
      sourceId,
    });

    if (opts.registerWhitelist !== false) {
      registerWhitelistImpl(connectionId, generated.entities);
      log.info(
        { connectionId, entityCount: generated.entities.length },
        "Registered generated entities into the table whitelist",
      );
    }

    return { ...generated, profiles, errors, elapsedMs } satisfies ProfileAndGenerateResult;
  });
}

const service: SemanticGeneratorShape = {
  profile: profileImpl,
  generate: generateImpl,
  registerWhitelist: registerWhitelistImpl,
  profileAndGenerate: profileAndGenerateImpl,
} satisfies SemanticGeneratorShape;

// ── Layers ───────────────────────────────────────────────────────────

/**
 * Live layer for {@link SemanticGenerator}. The service holds no resources and
 * opens its own short-lived pools through the dialect profilers, so a plain
 * `Layer.succeed` suffices — no scope, no dependencies.
 */
export const SemanticGeneratorLive: Layer.Layer<SemanticGenerator> =
  Layer.succeed(SemanticGenerator, service);

/**
 * Test layer for {@link SemanticGenerator}. Identical to the live layer (the
 * service is deterministic and dependency-free); profiler behavior is injected
 * per-call via `opts.profileFn`, so no `mock.module()` is needed.
 */
export function createSemanticGeneratorTestLayer(): Layer.Layer<SemanticGenerator> {
  return Layer.succeed(SemanticGenerator, service);
}
