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
 * **Profiler resolution (registry seam — ADR-0017).** Core profiles Postgres
 * and MySQL directly (the two engines `@atlas/api` owns). Other dbTypes live in
 * plugin packages that core must not import (ADR-0013), so the caller injects a
 * {@link DatasourceProfiler} via `opts.profileFn`. The SOURCE that produces that
 * `profileFn` from the plugin registry is `resolveProfileCapability` in
 * `lib/datasources/mcp-lifecycle.ts` (#3620): it resolves the plugin's
 * `connection.profile` off the registry by the SAME predicate provisioning uses,
 * so provisioning and profiling stay in lockstep (ADR-0017). This injection
 * point is unchanged — the seam fills it from the registry instead of the caller
 * hard-coding it.
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
  type GeneratedArtifact,
  type GeneratedSemanticLayer,
  type GenerateSemanticLayerOptions,
} from "@atlas/api/lib/semantic/generate";
import { registerPluginEntities, invalidateOrgWhitelist } from "@atlas/api/lib/semantic/whitelist";
import {
  bulkUpsertEntities,
  type SemanticEntityType,
} from "@atlas/api/lib/semantic/entities";
import { safeSemanticRowName } from "@atlas/api/lib/semantic/shapes";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
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
  /**
   * Schema / database to profile. `undefined` for a plugin dbType where the
   * caller passed no schema (ClickHouse database, ES index) — the plugin uses
   * its own default rather than a literal `"public"` (#3621 review). The in-core
   * pg profiler defaults a missing schema to `"public"`.
   */
  schema?: string;
  selectedTables?: string[];
  prefetchedObjects?: DatabaseObject[];
  progress?: ProfileProgressCallbacks;
  logger?: ProfileLogger;
  /**
   * The datasource's resolved, DECRYPTED connection config — the same record the
   * plugin's `createFromConfig` receives. Carried so plugins that hold
   * credentials in SEPARATE config fields (not embedded in the `url`) profile
   * with the TENANT's own credentials instead of operator env vars (ADR-0017
   * amendment). Elasticsearch is the motivating case: its `apiKey` / `username` /
   * `password` / SigV4 fields live alongside the endpoint `url`. Plugins whose
   * credentials are fully url-embedded (ClickHouse, Snowflake) and the in-core
   * pg/mysql profilers ignore this field; the CLI/static-config path omits it
   * (auth from env is legitimate there).
   *
   * SECURITY: like the decrypted `url`, this carries decrypted secret material —
   * it must NEVER leave the lib layer, reach the agent/LLM, or be logged.
   */
  config?: Readonly<Record<string, unknown>>;
}) => Promise<ProfilingResult>;

/**
 * Introspection options for a RESOLVED LIVE CONNECTION (#3667). Unlike
 * {@link DatasourceProfiler}, these carry NO `url` / `config`: the connection is
 * already authenticated and bound to its creds, so `profile`/`listObjects` are
 * capabilities OF the connection (alongside `query`) rather than static
 * functions that re-resolve auth. The host's profiler seam consumes these so a
 * new transport (OAuth, future) inherits profiling for free — there is no
 * url-shape gate to fail closed.
 */
export interface LiveConnectionProfileOptions {
  /** Schema / database / dataset to profile. Dialect-specific; omit for the connection's default. */
  schema?: string;
  /** Restrict profiling to these tables/views. Omit to profile every object. */
  selectedTables?: string[];
  /** Pre-listed objects (from a prior `listObjects`) — avoids a second catalog round-trip. */
  prefetchedObjects?: DatabaseObject[];
  /** Progress callbacks (e.g. the MCP progress bridge). */
  progress?: ProfileProgressCallbacks;
  /** Structured logger for profiler diagnostics. */
  logger?: ProfileLogger;
}

/** Introspection options for enumerating a resolved live connection's objects (#3667). */
export interface LiveConnectionListOptions {
  /** Schema / database to enumerate. Dialect-specific; omit for the connection's default. */
  schema?: string;
  /** Structured logger for diagnostics. */
  logger?: ProfileLogger;
}

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
  /**
   * The datasource's resolved, DECRYPTED connection config, forwarded into the
   * injected `profileFn` (ADR-0017 amendment) so separate-field-credential
   * plugins (Elasticsearch) profile with the tenant's own creds rather than
   * operator env. Ignored by the in-core pg/mysql profilers and by url-embedded
   * plugin profilers (ClickHouse / Snowflake). SECURITY: decrypted secret
   * material — never logged or surfaced to the agent.
   */
  config?: Readonly<Record<string, unknown>>;
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

/**
 * The org-scoped semantic-store upsert seam {@link SemanticGeneratorShape.persist}
 * delegates to. Matches the signature of {@link bulkUpsertEntities} so the live
 * path uses it verbatim; tests inject a fake to exercise persistence without an
 * internal DB. Returns the number of rows successfully upserted.
 */
export type EntityUpsertFn = (
  orgId: string,
  rows: ReadonlyArray<{
    entityType: SemanticEntityType;
    name: string;
    yamlContent: string;
    connectionGroupId?: string | null;
  }>,
) => Promise<number>;

/** Inputs for {@link SemanticGeneratorShape.persist}. */
export interface PersistSemanticLayerOptions {
  /** Workspace the generated rows belong to. */
  orgId: string;
  /**
   * Connection-group scope for every persisted row (the group the profiled
   * datasource belongs to — group-of-one for a standalone connection, `null`
   * for the flat default group). Set DIRECTLY (not resolved from an install id)
   * so the rows land in the same scope the whitelist loader reads.
   */
  connectionGroupId: string | null;
  /** Generated entity artifacts (one per profiled table). */
  entities: ReadonlyArray<GeneratedArtifact>;
  /** Generated metric artifacts (omitted profiles produce none). */
  metrics?: ReadonlyArray<GeneratedArtifact>;
  /**
   * Upsert override for tests. Defaults to {@link bulkUpsertEntities} — the
   * content-mode-aware draft upsert the wizard `/save` + import endpoint use.
   */
  upsert?: EntityUpsertFn;
}

/** Outcome of {@link SemanticGeneratorShape.persist}. */
export interface PersistSemanticLayerResult {
  /** Entity rows successfully persisted (as drafts). */
  entitiesPersisted: number;
  /** Metric rows successfully persisted (as drafts). */
  metricsPersisted: number;
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
   * DURABLY persist a generated semantic layer to the org semantic store
   * (`semantic_entities`) so the table whitelist survives an MCP-server
   * restart AND is visible to the API process (hosted web `/chat` runs in a
   * different process than a stdio MCP server, so the in-memory whitelist
   * alone is not cross-surface).
   *
   * Rows land as **`draft`** (via the content-mode-aware {@link bulkUpsertEntities}
   * seam the wizard `/save` + import endpoint share): profiled output is
   * machine-generated and unreviewed, so it stays out of the published
   * `/chat` whitelist until an admin promotes it through the atomic publish
   * endpoint (`/api/v1/admin/publish`). Developer mode already overlays drafts,
   * so the profiling agent can query immediately in-session.
   *
   * Fails with {@link ProfilingFailedError} (`reason: "persist_error"`) when
   * NOT every row lands — a partial upsert would silently recreate the
   * connected-but-unqueryable gap for the dropped tables, so it fails loud.
   */
  readonly persist: (
    opts: PersistSemanticLayerOptions,
  ) => Effect.Effect<PersistSemanticLayerResult, ProfilingFailedError>;

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
    // #3662 — mirror the wizard's `effectiveSchema` (#3621) on the MCP seam:
    // default a missing schema to `"public"` ONLY for native Postgres (its
    // canonical search-path). A plugin dbType — where `"public"` is meaningless
    // (ClickHouse database, Elasticsearch index) — passes the user-provided
    // schema through, or `undefined` so the plugin profiler uses its OWN default
    // (e.g. ClickHouse's `default`, or the URL-embedded database) instead of
    // overriding it with a literal `"public"` and profiling zero objects. MySQL
    // ignores schema either way.
    const schema = opts.dbType === "postgres" ? opts.schema ?? "public" : opts.schema;
    const profiler = resolveProfiler(opts.dbType, opts.profileFn);
    if (profiler instanceof ProfilingFailedError) {
      return yield* Effect.fail(profiler);
    }

    const start = Date.now();
    // #3581 — preserve cooperative cancellation. `OperationCancelledError` is
    // raised by the MCP progress bridge when the client aborts mid-profile.
    // Wrapping it in `ProfilingFailedError` erases its identity and surfaces a
    // spurious `validation_failed`. We map the raw rejection into the error
    // channel (`catch: (err) => err`) and then, in `catchAll`, route a
    // cancellation to `Effect.die` (a DEFECT) while every other failure becomes
    // a typed `ProfilingFailedError`. NOTE: a `catch` that returns
    // `Effect.die(...)`, or `throw`s, does NOT reliably escalate to a defect —
    // `tryPromise`'s `catch` is a value mapper, so the return value is wrapped
    // as a Fail. `catchAll` is the correct seam to choose die-vs-fail.
    // `runSemanticProfile`'s `causeToError` path then extracts the defect and
    // re-throws it; the MCP layer recognises `instanceof OperationCancelledError`.
    //
    // Detected by name (not `instanceof`) because `OperationCancelledError`
    // lives in `@atlas/mcp` which `@atlas/api` must not import (ADR-0013 /
    // core→plugin decoupling).
    const result: ProfilingResult = yield* Effect.tryPromise({
      try: () =>
        profiler({
          url: opts.url,
          schema,
          selectedTables: opts.selectedTables,
          prefetchedObjects: opts.prefetchedObjects,
          progress: opts.progress,
          logger: opts.logger,
          // Decrypted tenant config for separate-field-credential / non-url-shaped
          // plugins (Elasticsearch's apiKey, BigQuery's service_account_json +
          // project — #3664). The in-core pg/mysql profilers and url-embedded
          // plugin profilers (ClickHouse/Snowflake) ignore it. Never logged
          // (ADR-0017 amendment). NOTE: BigQuery depends on this forwarding —
          // without it, its profiler falls back to ADC/operator env.
          ...(opts.config !== undefined ? { config: opts.config } : {}),
        }),
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        if (err instanceof Error && err.name === "OperationCancelledError") {
          // Cooperative cancellation → surface as a defect so its identity
          // survives to the MCP layer instead of becoming `validation_failed`.
          return Effect.die(err);
        }
        if (err instanceof Error && err.name === "IntegrationReconnectRequiredError") {
          // #3667 — an OAuth datasource (Salesforce) whose token is revoked /
          // permanently un-refreshable mid-profile throws this from inside the
          // injected `profileFn` (the live OAuth connection's bound `profile()`).
          // Its first API call (describeGlobal) happens here, NOT at connection
          // resolution, so the resolver's reconnect mapping never sees it.
          // Wrapping it in a generic `ProfilingFailedError` would erase its
          // identity and surface a bare "Profiling failed" instead of the
          // actionable reconnect prompt. Surface it as a DEFECT (like
          // cancellation) so `profileLiveDatasource`'s `causeToError` recovers
          // the original error and maps it to `reconnect_required`. Detected by
          // name (mirroring the cancellation handling) to keep the generator off
          // any error-class import cycle.
          return Effect.die(err);
        }
        // #3579 — scrub DSN userinfo from profiler error messages. A verbose
        // driver error can echo the connection string (scheme://user:pass@host).
        // `errorMessage` strips `scheme://***@host` patterns and truncates to
        // 512 chars — the same scrub the create/pre-flight path applies via
        // `scrubSecretsFromMessage`'s `errorMessage` fallback.
        return Effect.fail(
          new ProfilingFailedError({
            message: `Profiling failed: ${errorMessage(err)}`,
            reason: "profiler_error",
          }),
        );
      }),
    );
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

/**
 * Map a generated artifact to its semantic-store row `name`, or `null` when the
 * name can't be made safe. The derivation (basename + `SAFE_TABLE_NAME`) lives
 * in the shared {@link safeSemanticRowName} — the SAME function the wizard
 * `/save` path uses — so the two durable write paths key rows identically and
 * can't drift (#3550). This wrapper only adds the persist-path's skip logging.
 *
 * The row `name` is only the upsert key — queryability keys on the entity YAML's
 * `table:` field (set by the generator), not this name. Entity + metric rows for
 * the same table share the name but differ by `entity_type`, so the 0063 partial
 * unique index keeps them distinct. Callers must filter out the `null` results
 * (logged here, never silently swallowed).
 */
function artifactRowName(artifact: GeneratedArtifact): string | null {
  const name = safeSemanticRowName(artifact.table);
  if (name === null) {
    log.warn(
      { table: artifact.table },
      "artifactRowName: skipping artifact — name does not match SAFE_TABLE_NAME; " +
        "the generated name contains characters not permitted in a semantic-store row key",
    );
  }
  return name;
}

function persistImpl(
  opts: PersistSemanticLayerOptions,
): Effect.Effect<PersistSemanticLayerResult, ProfilingFailedError> {
  return Effect.gen(function* () {
    const upsert = opts.upsert ?? bulkUpsertEntities;

    const entityRows = opts.entities
      .map((e) => {
        const name = artifactRowName(e);
        if (name === null) return null;
        return { entityType: "entity" as const, name, yamlContent: e.yaml, connectionGroupId: opts.connectionGroupId };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // CONTRACT (#3550): both durable write paths persist metrics to
    // `semantic_entities` (DB) as the source of truth for queryability. This
    // MCP path persists entities AND metrics to the DB; the wizard `/save`
    // handler (`api/routes/wizard.ts`) does the same, keying its metric rows
    // through the shared `safeSemanticRowName` used by `artifactRowName` here.
    // Both then promote via the atomic `/api/v1/admin/publish` endpoint. The DB
    // is what makes a profiled connection queryable across process restarts and
    // visible to the web `/chat` process (which can't read disk artifacts
    // written by a stdio MCP server). Don't reintroduce a disk-only metric path
    // for either caller without updating the other.
    const metricRows = (opts.metrics ?? [])
      .map((m) => {
        const name = artifactRowName(m);
        if (name === null) return null;
        return { entityType: "metric" as const, name, yamlContent: m.yaml, connectionGroupId: opts.connectionGroupId };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const entitiesPersisted = yield* Effect.tryPromise({
      try: () => upsert(opts.orgId, entityRows),
      catch: (err) =>
        new ProfilingFailedError({
          message: `Failed to persist generated entities: ${err instanceof Error ? err.message : String(err)}`,
          reason: "persist_error",
        }),
    });

    const metricsPersisted = metricRows.length === 0
      ? 0
      : yield* Effect.tryPromise({
          try: () => upsert(opts.orgId, metricRows),
          catch: (err) =>
            new ProfilingFailedError({
              message: `Failed to persist generated metrics: ${err instanceof Error ? err.message : String(err)}`,
              reason: "persist_error",
            }),
        });

    // bulkUpsertEntities swallows per-row failures and returns a success count.
    // A short count means the YAML parsed but the DB rejected the row — landing
    // some tables as queryable and silently dropping others. Fail loud rather
    // than report success on a partially-queryable connection (#3546 / #2142).
    if (entitiesPersisted < entityRows.length || metricsPersisted < metricRows.length) {
      return yield* Effect.fail(
        new ProfilingFailedError({
          message:
            `Persisted ${entitiesPersisted}/${entityRows.length} entities and ` +
            `${metricsPersisted}/${metricRows.length} metrics. Some generated tables ` +
            `did not land in the semantic store and will not be queryable — retry profiling.`,
          reason: "persist_error",
        }),
      );
    }

    // Drop this process's cached org whitelist so the freshly-persisted drafts
    // are read on the next `loadOrgWhitelist` (developer mode overlays drafts).
    // Cross-process surfaces (the API process behind web `/chat`) pick the rows
    // up on their own cache TTL expiry / invalidation — the durable rows are the
    // cross-surface contract; this just makes the SAME process see them now.
    invalidateOrgWhitelist(opts.orgId);

    log.info(
      {
        orgId: opts.orgId,
        connectionGroupId: opts.connectionGroupId,
        entitiesPersisted,
        metricsPersisted,
      },
      "Persisted generated semantic layer to the org store as drafts",
    );

    return { entitiesPersisted, metricsPersisted } satisfies PersistSemanticLayerResult;
  });
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
  persist: persistImpl,
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
