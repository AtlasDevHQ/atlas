/**
 * Plugin SDK helpers — factory function, createPlugin, type guards, and the
 * shared sandbox-plugin infrastructure (`collectSemanticFiles`,
 * `runHealthCheckWithTimeout`).
 */

import * as fs from "fs";
import * as path from "path";
import type {
  AtlasPlugin,
  AtlasPluginBase,
  AtlasDatasourcePlugin,
  AtlasContextPlugin,
  AtlasInteractionPlugin,
  AtlasActionPlugin,
  AtlasSandboxPlugin,
  AtlasPluginContext,
  ConfigSchemaField,
  EntityProvider,
  ParserDialect,
  PluginDBConnection,
  PluginDBType,
  PluginHealthResult,
  PluginHooks,
  PluginLogger,
  QueryValidationResult,
} from "./types";

const VALID_TYPES: Set<string> = new Set(["datasource", "context", "interaction", "action", "sandbox"]);

/**
 * Validate a plugin object's required fields and variant-specific structure.
 * Used by both definePlugin and createPlugin.
 *
 * @throws {Error} When required fields are missing or variant-specific structure is invalid.
 */
function validatePluginShape(plugin: AtlasPlugin): void {
  if (!plugin.id || !plugin.id.trim()) {
    throw new Error("Plugin id must not be empty");
  }
  if (!plugin.version || !plugin.version.trim()) {
    throw new Error("Plugin version must not be empty");
  }
  if (!Array.isArray(plugin.types) || plugin.types.length === 0) {
    throw new Error(`Plugin "types" must be a non-empty array of plugin types`);
  }
  for (const t of plugin.types) {
    if (!VALID_TYPES.has(t)) {
      throw new Error(`Invalid plugin type "${t}" — must be one of: datasource, context, interaction, action, sandbox`);
    }
  }
  if (plugin.onUninstall !== undefined && typeof plugin.onUninstall !== "function") {
    throw new Error('Plugin "onUninstall" must be a function when provided');
  }

  // Variant-specific structural checks — validate for each declared type
  if (plugin.types.includes("datasource")) {
    const ds = plugin as AtlasDatasourcePlugin;
    if (!ds.connection || typeof ds.connection !== "object") {
      throw new Error('Datasource plugin must have a "connection" property');
    }
    // A datasource plugin must expose at least one connection factory:
    //   - `create()`           — a static config-defined connection (self-host /
    //                            operator-baked datasource), wired at boot.
    //   - `createFromConfig()` — an ADAPTER-ONLY connection built per-(workspace,
    //                            install) from a DB-stored config (the SaaS
    //                            per-workspace model). Plugins registered purely
    //                            as adapters omit `create`.
    // Each, when present, must be a function.
    const hasCreate = ds.connection.create !== undefined;
    const hasCreateFromConfig = ds.connection.createFromConfig !== undefined;
    if (!hasCreate && !hasCreateFromConfig) {
      throw new Error(
        'Datasource plugin connection must have a "create()" or "createFromConfig()" factory function',
      );
    }
    if (hasCreate && typeof ds.connection.create !== "function") {
      throw new Error('Datasource plugin connection "create" must be a function when provided');
    }
    if (hasCreateFromConfig && typeof ds.connection.createFromConfig !== "function") {
      throw new Error('Datasource plugin connection "createFromConfig" must be a function when provided');
    }
    if (ds.entities !== undefined && !Array.isArray(ds.entities) && typeof ds.entities !== "function") {
      throw new Error('Datasource plugin "entities" must be an array or a function');
    }
    if (Array.isArray(ds.entities)) {
      for (const e of ds.entities) {
        if (!e || typeof e !== "object" || typeof (e as Record<string, unknown>).name !== "string" || typeof (e as Record<string, unknown>).yaml !== "string") {
          throw new Error('Each entity in "entities" must have string "name" and "yaml" fields');
        }
      }
    }
    if (ds.connection.validate !== undefined && typeof ds.connection.validate !== "function") {
      throw new Error('Datasource plugin connection "validate" must be a function');
    }
    if (ds.connection.parserDialect !== undefined && (typeof ds.connection.parserDialect !== "string" || !ds.connection.parserDialect.trim())) {
      throw new Error('Datasource plugin connection "parserDialect" must be a non-empty string');
    }
    if (ds.connection.forbiddenPatterns !== undefined) {
      if (!Array.isArray(ds.connection.forbiddenPatterns)) {
        throw new Error('Datasource plugin connection "forbiddenPatterns" must be an array of RegExp');
      }
      for (const p of ds.connection.forbiddenPatterns) {
        if (!(p instanceof RegExp)) {
          throw new Error('Datasource plugin connection "forbiddenPatterns" entries must each be a RegExp');
        }
      }
    }
    // Introspection (listObjects / profile) is no longer a connection-namespace
    // member — it is a capability of the BUILT connection createFromConfig returns
    // (PluginDBConnection.listObjects / .profile, #3667 / #3670). Nothing to
    // validate here; a built connection that omits them is query-only.
    if (ds.dialect !== undefined && (typeof ds.dialect !== "string" || !ds.dialect.trim())) {
      throw new Error('Datasource plugin "dialect" must be a non-empty string');
    }
  }
  if (plugin.types.includes("context")) {
    const ctx = plugin as AtlasContextPlugin;
    if (!ctx.contextProvider || typeof ctx.contextProvider !== "object") {
      throw new Error('Context plugin must have a "contextProvider" property');
    }
  }
  if (plugin.types.includes("interaction")) {
    const int = plugin as AtlasInteractionPlugin;
    if (int.routes !== undefined && typeof int.routes !== "function") {
      throw new Error('Interaction plugin "routes" must be a function when provided');
    }
  }
  if (plugin.types.includes("action")) {
    const act = plugin as AtlasActionPlugin;
    if (!Array.isArray(act.actions)) {
      throw new Error('Action plugin must have an "actions" array');
    }
  }
  if (plugin.types.includes("sandbox")) {
    const sb = plugin as AtlasSandboxPlugin;
    if (!sb.sandbox || typeof sb.sandbox !== "object") {
      throw new Error('Sandbox plugin must have a "sandbox" property');
    }
    if (typeof sb.sandbox.create !== "function") {
      throw new Error('Sandbox plugin sandbox must have a "create()" factory function');
    }
    if (sb.sandbox.priority !== undefined && (typeof sb.sandbox.priority !== "number" || isNaN(sb.sandbox.priority))) {
      throw new Error('Sandbox plugin "priority" must be a number');
    }
  }
}

/**
 * Identity-style factory for type inference and runtime validation when
 * authoring plugins. Validates required fields and variant-specific properties.
 *
 * For plugins that need typed configuration, use {@link createPlugin} instead.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "@useatlas/plugin-sdk";
 *
 * export default definePlugin({
 *   id: "my-datasource",
 *   types: ["datasource"],
 *   version: "1.0.0",
 *   connection: {
 *     create: () => myDBConnection,
 *     dbType: "postgres",
 *   },
 * });
 * ```
 */
export function definePlugin<T extends AtlasPlugin>(plugin: T): T {
  validatePluginShape(plugin);
  return plugin;
}

// ---------------------------------------------------------------------------
// createPlugin — typed config factory (Better Auth pattern)
// ---------------------------------------------------------------------------

/**
 * Options for {@link createPlugin}. The `create` function receives the
 * validated config and returns the plugin object.
 */
export interface CreatePluginOptions<TConfig, TPlugin extends AtlasPluginBase<TConfig>> {
  /**
   * Any object with a `parse(input)` method (e.g. a Zod schema) for validating
   * plugin configuration. Must throw on invalid input. Called at factory
   * invocation time so invalid config fails fast during `bun run dev` startup.
   */
  configSchema: { parse(input: unknown): TConfig };
  /** Build the plugin from validated config. */
  create(config: TConfig): TPlugin;
}

/**
 * Factory pattern for plugins that need typed configuration. Follows
 * Better Auth's `plugins: [myPlugin({ key: "value" })]` convention.
 *
 * The returned function validates config via the provided schema at call
 * time, then delegates to `create()` to build the plugin object.
 *
 * @throws The returned factory throws when config fails schema validation
 *   or when the created plugin fails structural validation (missing id,
 *   version, or variant-specific properties).
 *
 * @example
 * ```typescript
 * // bigquery-plugin.ts
 * import { createPlugin } from "@useatlas/plugin-sdk";
 * import { z } from "zod";
 *
 * export const bigqueryPlugin = createPlugin({
 *   configSchema: z.object({
 *     projectId: z.string(),
 *     dataset: z.string(),
 *   }),
 *   create: (config) => ({
 *     id: "bigquery",
 *     types: ["datasource"] as const,
 *     version: "1.0.0",
 *     config,
 *     connection: {
 *       create: () => makeBQConnection(config.projectId, config.dataset),
 *       dbType: "bigquery",
 *     },
 *   }),
 * });
 *
 * // atlas.config.ts
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { bigqueryPlugin } from "./bigquery-plugin";
 *
 * export default defineConfig({
 *   plugins: [bigqueryPlugin({ projectId: "my-proj", dataset: "analytics" })],
 * });
 * ```
 */
export function createPlugin<TConfig, TPlugin extends AtlasPluginBase<TConfig>>(
  options: CreatePluginOptions<TConfig, TPlugin>,
): (config: TConfig) => TPlugin {
  return (rawConfig: TConfig) => {
    let config: TConfig;
    try {
      config = options.configSchema.parse(rawConfig);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin config validation failed: ${detail}`, { cause: err });
    }

    let plugin: TPlugin;
    try {
      plugin = options.create(config);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Plugin create() failed: ${detail}`, { cause: err });
    }

    validatePluginShape(plugin as unknown as AtlasPlugin);
    return plugin;
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isDatasourcePlugin(
  plugin: AtlasPlugin,
): plugin is AtlasDatasourcePlugin {
  return plugin.types.includes("datasource");
}

export function isContextPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasContextPlugin {
  return plugin.types.includes("context");
}

export function isInteractionPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasInteractionPlugin {
  return plugin.types.includes("interaction");
}

export function isActionPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasActionPlugin {
  return plugin.types.includes("action");
}

export function isSandboxPlugin(
  plugin: AtlasPlugin,
): plugin is AtlasSandboxPlugin {
  return plugin.types.includes("sandbox");
}

// ---------------------------------------------------------------------------
// Sandbox helpers — shared infrastructure for AtlasSandboxPlugin authors
// ---------------------------------------------------------------------------

/** Minimal logger surface used by the sandbox helpers (pino/PluginLogger compatible). */
export interface SandboxHelperLogger {
  warn(msg: string): void;
}

/** A single semantic-layer file collected for upload into a sandbox. */
export interface CollectedSemanticFile {
  /** POSIX-style path under the sandbox dir, e.g. `"semantic/entities/users.yml"`. */
  path: string;
  /**
   * Raw file bytes (binary-safe — the collector does no encoding round-trip).
   * Typed as the portable `Uint8Array` so the published SDK surface carries no
   * Node `Buffer` global; the runtime value IS a Node `Buffer`, so call sites
   * that want string content use `Buffer.from(content).toString("utf-8")` (or
   * `new TextDecoder().decode(content)`).
   */
  content: Uint8Array;
}

/**
 * Recursively collect every file under `localDir` into `{ path, content }`
 * tuples, rooting each remote path at `sandboxDir`. The semantic tree is the
 * payload a sandbox plugin uploads into its microVM so the explore tool can
 * `cat`/`grep`/`ls` it.
 *
 * **Security — symlink-escape guard (single-sourced, #3373):** a symlink whose
 * real target resolves OUTSIDE the semantic root is skipped (and logged),
 * never uploaded. Containment is checked with `path.relative` against the
 * realpath-resolved root, so prefix collisions (`${root}_evil/…`) and `..`
 * traversal are both rejected — a bare `startsWith(root)` would not catch the
 * former. Unreadable directories/files (and an unreadable/missing root) are
 * skipped with a warning rather than throwing, so a partially-readable tree
 * still yields the files it can. Symlink cycles (a directory symlink resolving
 * to an already-walked directory, e.g. a self-link back to the root) are broken
 * via a visited-realpath set, so a self-referential tree terminates instead of
 * re-uploading the same files until the OS aborts with `ELOOP`.
 *
 * @param localDir   Absolute path to the local semantic directory to walk.
 * @param sandboxDir Remote path prefix for the returned `path` values.
 * @param logger     Optional logger; `warn` is called for each skipped entry.
 */
export function collectSemanticFiles(
  localDir: string,
  sandboxDir: string,
  logger?: SandboxHelperLogger,
): CollectedSemanticFile[] {
  const results: CollectedSemanticFile[] = [];

  // Resolve the root once so the containment check compares real paths. If the
  // root can't be resolved (missing/unreadable), behave like an unreadable
  // directory: warn and return nothing.
  let semanticRoot: string;
  try {
    semanticRoot = fs.realpathSync(localDir);
  } catch (err) {
    logger?.warn(
      `[plugin-sdk] Skipping unreadable semantic root ${localDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return results;
  }

  function isInsideSemanticRoot(realPath: string): boolean {
    const rel = path.relative(semanticRoot, realPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  // Real directories already walked, keyed by realpath. Seeded with the root so
  // a directory symlink resolving back to an ancestor (a cycle) is skipped
  // instead of re-walked. Only directory symlinks are tracked — a tree of real
  // directories cannot cycle, so non-symlink recursion stays as before (and
  // distinct symlinks to the same in-root dir keep their prior dup behavior).
  const visitedDirs = new Set<string>([semanticRoot]);

  function walk(dir: string, relative: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger?.warn(
        `[plugin-sdk] Skipping unreadable directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const remotePath = `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        try {
          const realPath = fs.realpathSync(entryPath);
          if (!isInsideSemanticRoot(realPath)) {
            logger?.warn(
              `[plugin-sdk] Skipping symlink escaping semantic root: ${entryPath} -> ${realPath}`,
            );
            continue;
          }
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            if (visitedDirs.has(realPath)) {
              // Symlink cycle — this dir's real path was already walked. Skip so
              // a self-referential tree terminates instead of looping forever.
              continue;
            }
            visitedDirs.add(realPath);
            walk(entryPath, remotePath);
          } else if (stat.isFile()) {
            results.push({ path: remotePath, content: fs.readFileSync(entryPath) });
          }
        } catch (err) {
          logger?.warn(
            `[plugin-sdk] Skipping unreadable symlink ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (entry.isDirectory()) {
        walk(entryPath, remotePath);
      } else if (entry.isFile()) {
        try {
          results.push({ path: remotePath, content: fs.readFileSync(entryPath) });
        } catch (err) {
          logger?.warn(
            `[plugin-sdk] Skipping unreadable file ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  walk(localDir, sandboxDir);
  return results;
}

/**
 * Wrap a health probe with the measured-health-check bracket every plugin
 * otherwise hand-rolls: `performance.now()` latency measurement,
 * instanceof-Error narrowing, and `latencyMs` stamping — nothing else (no
 * cleanup or timeout ceremony; see {@link runHealthCheckWithTimeout} for the
 * sandbox-shaped variant, which composes this).
 *
 * The probe returns a `PluginHealthResult` without `latencyMs` (stamped here,
 * measured from probe start to settle) — healthy or unhealthy, with whatever
 * `message` it wants. A thrown error (or rejected promise) becomes
 * `{ healthy: false, message }` with the message narrowed via
 * `err instanceof Error ? err.message : String(err)`. Probes that need a
 * custom failure message or a `logger.warn` on failure keep their own inner
 * `catch` and return an unhealthy result instead of throwing.
 *
 * @example
 * ```typescript
 * async healthCheck(): Promise<PluginHealthResult> {
 *   return measuredHealthCheck(async () => {
 *     await conn.query("SELECT 1", 5000);
 *     return { healthy: true };
 *   });
 * }
 * ```
 */
export async function measuredHealthCheck(
  fn: () =>
    | (Omit<PluginHealthResult, "latencyMs"> & { latencyMs?: never })
    | Promise<Omit<PluginHealthResult, "latencyMs"> & { latencyMs?: never }>,
): Promise<PluginHealthResult> {
  const start = performance.now();
  try {
    const result = await fn();
    return { ...result, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      healthy: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

/** Options for {@link runHealthCheckWithTimeout}. */
export interface HealthCheckTimeoutOptions {
  /** Milliseconds before the probe is abandoned and reported as timed out. */
  timeoutMs: number;
  /**
   * Safety-net cleanup, invoked ONLY when the probe times out or throws (never
   * on a returned result — the probe owns its own happy-path teardown). Must be
   * idempotent and guarded: it typically destroys a sandbox reference the probe
   * captured, so it should no-op when that reference is already cleared. Errors
   * thrown here are logged, never propagated.
   */
  cleanup: () => void | Promise<void>;
  /**
   * Optional logger; `warn` is called on every failing branch — the probe
   * timing out, the probe throwing, and `cleanup` throwing. (Success and a
   * returned unhealthy result are not logged; the latter is the probe's to
   * report.)
   */
  logger?: SandboxHelperLogger;
}

// Distinct sentinel so a probe that resolves to a string can never be mistaken
// for the timeout branch.
const HEALTH_CHECK_TIMEOUT = Symbol("plugin-sdk:health-check-timeout");

/**
 * Run a sandbox `healthCheck()` probe under a timeout, attaching a measured
 * `latencyMs` and running cleanup-in-every-failing-branch (single-sourced,
 * #3373). Composes {@link measuredHealthCheck} for the latency bracket +
 * error narrowing, adding the `Promise.race` timeout and safety-net cleanup
 * on top.
 *
 * The probe (`fn`) creates whatever it needs, performs the check, tears down
 * its own resources on the happy path, and returns a `PluginHealthResult`
 * without `latencyMs` (added here). When the `Promise.race` timeout wins — or
 * the probe throws — `cleanup` runs to reap any resource the probe captured but
 * could not release. `latencyMs` measures the probe only, stamped when it
 * settles (or times out) — cleanup time is never included.
 *
 * **Why not `await using`?** The timeout can win while the probe is still
 * mid-create/exec, and the sandbox SDKs expose no `AbortSignal` on create — a
 * scope-bound disposer would only fire once the (possibly hung) operation
 * settled, leaking the microVM past the timeout. An explicit, guarded `cleanup`
 * reference reaped here fires immediately instead.
 */
export async function runHealthCheckWithTimeout(
  fn: () => Promise<Omit<PluginHealthResult, "latencyMs"> & { latencyMs?: never }>,
  options: HealthCheckTimeoutOptions,
): Promise<PluginHealthResult> {
  const { timeoutMs, cleanup, logger } = options;
  // Fail fast on a misconfigured timeout: setTimeout coerces NaN/negative to 0,
  // which would silently report every probe as timed-out/unhealthy.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `runHealthCheckWithTimeout: timeoutMs must be a positive, finite number (got ${timeoutMs})`,
    );
  }
  let timer: ReturnType<typeof setTimeout>;
  // Tracks how the probe settled so the failing branches (timeout / throw) —
  // and ONLY those — trigger the warn + cleanup after measuredHealthCheck has
  // narrowed the error and stamped latency. A probe that RETURNS an unhealthy
  // result owns its own teardown and logging, so it is not a failing branch.
  // (The assertion defeats CFA literal-narrowing: the reassignments happen
  // inside the probe closure, which TS does not track across the await.)
  type ProbeOutcome = "returned" | "timeout" | "threw";
  let outcome = "threw" as ProbeOutcome;

  const result = await measuredHealthCheck(async () => {
    const raced = await Promise.race([
      fn(),
      new Promise<typeof HEALTH_CHECK_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(HEALTH_CHECK_TIMEOUT), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer!));

    if (raced === HEALTH_CHECK_TIMEOUT) {
      outcome = "timeout";
      // Thrown so measuredHealthCheck stamps latency at the moment the
      // timeout fired; its narrowing turns this into the result message.
      throw new Error(`Health check timed out after ${timeoutMs}ms`);
    }
    outcome = "returned";
    return raced;
  });

  if (outcome !== "returned") {
    logger?.warn(
      outcome === "timeout"
        ? `[plugin-sdk] Health check timed out after ${timeoutMs}ms`
        : `[plugin-sdk] Health check probe failed: ${result.message}`,
    );
    try {
      await cleanup();
    } catch (err) {
      logger?.warn(
        `[plugin-sdk] Health-check cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// createDatasourcePlugin — datasource assembly factory (#4192)
// ---------------------------------------------------------------------------

/**
 * Per-instance runtime handed to every {@link CreateDatasourcePluginOptions}
 * callback. One object per factory invocation, so state (logger, cached static
 * connection) is never shared between two plugin instances built from the same
 * blueprint.
 */
export interface DatasourcePluginRuntime<
  TConfig,
  TConn extends PluginDBConnection = PluginDBConnection,
> {
  /** The config-time config this plugin instance was built from. */
  readonly config: TConfig;
  /**
   * Plugin-scoped logger — live accessor, set when the host calls
   * `initialize()` and `undefined` before. Read it at call time (not capture
   * time) inside long-lived closures such as hook handlers.
   */
  readonly logger: PluginLogger | undefined;
  /** Whether the config defines a static (boot-wired) datasource, vs adapter-only. */
  readonly hasStaticConfig: boolean;
  /**
   * The static connection. Cached per plugin instance when
   * `cacheStaticConnection` is set (stateful sessions — jsforce, ES client);
   * otherwise built fresh on every call. Throws in adapter-only mode.
   */
  staticConnection(): TConn;
}

/**
 * Blueprint for {@link createDatasourcePlugin}. Identity + connection statics
 * are plain fields; behavior is supplied as callbacks that all receive the
 * per-instance {@link DatasourcePluginRuntime}.
 */
export interface CreateDatasourcePluginOptions<
  TConfig,
  TRuntimeConfig,
  TConn extends PluginDBConnection = PluginDBConnection,
> {
  /** Unique plugin id (e.g. `"clickhouse-datasource"`). Also the ConnectionRegistry key in static mode. */
  id: string;
  /** Human-readable name (e.g. `"ClickHouse DataSource"`). */
  name: string;
  /** SemVer version. Defaults to `"0.1.0"`. */
  version?: string;
  /**
   * Brand used in the standard `initialize()` log lines ("<label> datasource
   * plugin initialized …"). Defaults to `name` with a trailing " DataSource"
   * stripped (so "ClickHouse DataSource" logs as "ClickHouse").
   */
  logLabel?: string;
  /** Database type identifier (SQL dialect selection). */
  dbType: PluginDBType;
  /** node-sql-parser dialect. Ignored when {@link validate} is provided. */
  parserDialect?: ParserDialect;
  /** Extra regex guards on top of the base DML/DDL guard. Ignored when {@link validate} is provided. */
  forbiddenPatterns?: RegExp[];
  /** Custom query validator for non-SQL datasources (SOQL, …). Replaces the standard SQL pipeline. */
  validate?(query: string): QueryValidationResult | Promise<QueryValidationResult>;
  /**
   * Dialect guidance for the agent system prompt. The function form receives
   * whether the instance runs static (for mode-aware guidance, e.g. a
   * static-only query tool).
   */
  dialect: string | ((hasStaticConfig: boolean) => string);
  /**
   * Lenient config-time schema — every connection field optional so the plugin
   * can register as an ADAPTER ONLY (`plugin({})` parses, exposing
   * `createFromConfig` to the datasource bridge with no static datasource).
   */
  configSchema: { parse(input: unknown): TConfig };
  /**
   * Strict schema for a fully-specified connection. `createFromConfig`
   * re-validates the decrypted per-(workspace, install) config of a DB-stored
   * datasource through it before building the connection.
   */
  connectionConfigSchema: { parse(input: unknown): TRuntimeConfig };
  /**
   * Optional pre-parse normalization of the raw runtime config (e.g. BigQuery's
   * catalog snake_case → factory camelCase). The ORIGINAL raw config is still
   * what {@link attachIntrospection} receives as `runtimeConfig`.
   */
  normalizeRuntimeConfig?(raw: Readonly<Record<string, unknown>>): unknown;
  /**
   * Static-vs-adapter-only mode predicate. Defaults to a non-empty string
   * `url` on the config — override for non-url-shaped datasources (BigQuery's
   * projectId/keyFilename/credentials, DuckDB's url-or-path, ES's
   * completeness check).
   */
  hasStaticConfig?(config: TConfig): boolean;
  /**
   * Non-secret target identifier for the static-mode `initialize()` log line
   * (host, account, `project: <id>` — NEVER a credential). Only called when
   * the instance is static.
   */
  describeStaticTarget(config: TConfig): string;
  /**
   * Build a connection from a strict-validated runtime config — the
   * `createFromConfig` core. Also the default static-connection builder (the
   * config-time config is run through {@link connectionConfigSchema}) unless
   * {@link createStaticConnection} overrides it.
   */
  buildConnection(parsed: TRuntimeConfig, runtime: DatasourcePluginRuntime<TConfig, TConn>): PluginDBConnection;
  /**
   * Bind introspection to the BUILT connection (#3667 / ADR-0017): return
   * `{ ...built, listObjects, profile }` closing over the creds that built it.
   * `parsed` is the strict-validated config; `runtimeConfig` is the raw record
   * `createFromConfig` received (plugins whose profiler authenticates from
   * config fields — BigQuery, ES — forward it verbatim; url-shaped plugins
   * ignore it). Applied on the `createFromConfig` path only — the static
   * boot-wired connection keeps the plain built shape, exactly as before.
   */
  attachIntrospection(
    built: PluginDBConnection,
    ctx: { parsed: TRuntimeConfig; runtimeConfig: Readonly<Record<string, unknown>> },
    runtime: DatasourcePluginRuntime<TConfig, TConn>,
  ): PluginDBConnection;
  /**
   * Static connection builder for `connection.create()` (and the default
   * health probe). Defaults to `buildConnection(connectionConfigSchema.parse(config))`.
   * Override when the static path diverges from the runtime path (BigQuery's
   * ADC-without-projectId, ES's `allowAmbientAwsCreds: true`). Required when
   * `TConn` is narrower than {@link PluginDBConnection}.
   */
  createStaticConnection?(runtime: DatasourcePluginRuntime<TConfig, TConn>): TConn;
  /**
   * Cache the static connection per plugin instance (stateful sessions —
   * jsforce, the ES client). `connection.create()`, `runtime.staticConnection()`
   * and the factory-emitted `teardown()` (close + reset, close errors logged)
   * all share the one cached connection. Fresh-per-call plugins (stateless
   * HTTP transports, pools built at boot) leave this unset.
   */
  cacheStaticConnection?: boolean;
  /**
   * Static-mode health probe, run inside {@link measuredHealthCheck} (latency
   * stamping + error narrowing). Defaults to a fresh-connection `SELECT 1`
   * (5s timeout) that warns on failure and close-guards in `finally`. Probes
   * that must scrub errors (credential-bearing messages) or ping non-SQL
   * endpoints override this — keep your own `catch` so the scrubbed message is
   * what surfaces.
   */
  healthProbe?(
    runtime: DatasourcePluginRuntime<TConfig, TConn>,
  ): Promise<Omit<PluginHealthResult, "latencyMs"> & { latencyMs?: never }>;
  /**
   * Extra `initialize()` work, run AFTER the standard mode log line (read-only
   * warnings, static-mode tool registration, …). The shared logger is already
   * bound when this runs.
   */
  onInitialize?(ctx: AtlasPluginContext, runtime: DatasourcePluginRuntime<TConfig, TConn>): void | Promise<void>;
  /** Plugin hooks. The function form builds them per instance with runtime access (lazy logger). */
  hooks?: PluginHooks | ((runtime: DatasourcePluginRuntime<TConfig, TConn>) => PluginHooks);
  /** Serializable config schema for the admin install form (`getConfigSchema()`). */
  getConfigSchema?(): ConfigSchemaField[];
  /** Entity definitions. Defaults to `[]`. */
  entities?: EntityProvider;
  /**
   * Extra teardown, run AFTER the factory has closed the cached static
   * connection (when {@link cacheStaticConnection} is set). A plugin with no
   * cache and no extra teardown gets no `teardown` method, as before.
   */
  teardown?(runtime: DatasourcePluginRuntime<TConfig, TConn>): void | Promise<void>;
}

/**
 * Factory returned by {@link createDatasourcePlugin}: call it with config for
 * the schema-validated `atlas.config.ts` path, or use `.build()` to assemble
 * without config-schema validation (pre-validated config — tests / custom
 * wiring, the old `buildXPlugin` seam).
 */
export interface DatasourcePluginFactory<TConfig> {
  (config: TConfig): AtlasDatasourcePlugin<TConfig>;
  /** Assemble from an already-validated config, bypassing the config schema. */
  build(config: TConfig): AtlasDatasourcePlugin<TConfig>;
}

/** Default static-mode predicate: a non-empty string `url` on the config. */
function configHasUrl(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  const url = (config as { url?: unknown }).url;
  return typeof url === "string" && url.length > 0;
}

/**
 * Assembly factory for datasource plugins — the sibling of {@link createPlugin}
 * that absorbs the identical plugin-object assembly the url-shaped datasources
 * hand-rolled (#4192): the static-vs-adapter-only mode branch, the
 * `createFromConfig` strict-parse → build → attach-introspection wrapper
 * (ADR-0013 per-workspace connections; ADR-0017 introspection as a capability
 * of the BUILT connection), the standard `initialize()` mode logging, the
 * adapter-only + measured static health check, and optional static-connection
 * caching with close-guarded teardown.
 *
 * Per-dialect substance stays in the plugin: it supplies the schema pair, a
 * `buildConnection`, an `attachIntrospection`, and (only where it diverges)
 * mode predicate, static builder, probe, hooks, and initialize extras.
 *
 * @example
 * ```typescript
 * export const mydbPlugin = createDatasourcePlugin({
 *   id: "mydb-datasource",
 *   name: "MyDB DataSource",
 *   dbType: "mydb",
 *   parserDialect: "PostgresQL",
 *   forbiddenPatterns: MYDB_FORBIDDEN_PATTERNS,
 *   dialect: "This datasource uses MyDB SQL dialect.",
 *   configSchema: MyDBConfigSchema,               // lenient — {} parses (adapter-only)
 *   connectionConfigSchema: MyDBConnectionSchema, // strict — url required
 *   describeStaticTarget: (c) => extractHost(c.url!),
 *   buildConnection: (parsed, rt) => createMyDBConnection({ url: parsed.url, logger: rt.logger }),
 *   attachIntrospection: (built, { parsed }) => ({
 *     ...built,
 *     listObjects: (o) => listMyDBObjects({ url: parsed.url, schema: o?.schema }),
 *     profile: (o) => profileMyDB({ url: parsed.url, ...o }),
 *   }),
 * });
 * ```
 */
/**
 * When `TConn` is narrower than {@link PluginDBConnection}, the default
 * `buildStatic` (`buildConnection(...) as TConn`) is unsound — `buildConnection`
 * only promises a `PluginDBConnection`. This conditional makes
 * `createStaticConnection` a REQUIRED member of the options in exactly that
 * case, so a narrowing plugin that forgets it fails `tsgo` (#4278). When `TConn`
 * is the `PluginDBConnection` default, `PluginDBConnection extends TConn` holds
 * and the requirement collapses to `unknown` (stays optional). Intersecting a
 * required member with the interface's optional one makes it required — a
 * narrower `TConn` therefore *cannot* reach the `as TConn` fallback, which makes
 * that cast provably safe rather than discipline-guarded.
 */
type StaticConnectionRequirement<TConfig, TConn extends PluginDBConnection> =
  PluginDBConnection extends TConn
    ? unknown
    : { createStaticConnection(runtime: DatasourcePluginRuntime<TConfig, TConn>): TConn };

export function createDatasourcePlugin<
  TConfig,
  TRuntimeConfig,
  TConn extends PluginDBConnection = PluginDBConnection,
>(
  options: CreateDatasourcePluginOptions<TConfig, TRuntimeConfig, TConn> &
    StaticConnectionRequirement<TConfig, TConn>,
): DatasourcePluginFactory<TConfig> {
  // Derive the log label by stripping a trailing " DataSource" suffix without a
  // polynomial-backtracking regex: `\s+` before an anchored literal is a ReDoS
  // hazard on an attacker-influenced plugin name (CodeQL js/polynomial-redos).
  // endsWith + trimEnd is single-pass and reproduces the old /\s+DataSource$/
  // exactly — only strips when ≥1 whitespace separated the suffix.
  let derivedLabel = options.name;
  if (derivedLabel.endsWith("DataSource")) {
    const head = derivedLabel.slice(0, -"DataSource".length);
    const trimmedHead = head.trimEnd();
    if (trimmedHead.length < head.length) derivedLabel = trimmedHead;
  }
  const logLabel = options.logLabel ?? derivedLabel;
  const version = options.version ?? "0.1.0";
  const isStatic = options.hasStaticConfig ?? configHasUrl;

  const build = (config: TConfig): AtlasDatasourcePlugin<TConfig> => {
    let log: PluginLogger | undefined;
    let cachedConn: TConn | undefined;
    const hasStaticConfig = isStatic(config);

    /**
     * Fresh static connection. Default: run the config-time config through the
     * STRICT schema and reuse `buildConnection` — sound because static mode
     * implies a fully-specified config. The `as TConn` fallback is now
     * type-guaranteed, not discipline-guarded: {@link StaticConnectionRequirement}
     * forces `createStaticConnection` to be present whenever `TConn` narrows
     * below `PluginDBConnection`, so this branch is reachable only when
     * `TConn` IS `PluginDBConnection` (where `buildConnection`'s return type
     * already satisfies it). TS still needs the cast because `TConn` stays
     * abstract inside the generic body.
     */
    const buildStatic = (): TConn =>
      options.createStaticConnection
        ? options.createStaticConnection(runtime)
        : (options.buildConnection(options.connectionConfigSchema.parse(config), runtime) as TConn);

    const runtime: DatasourcePluginRuntime<TConfig, TConn> = {
      config,
      hasStaticConfig,
      get logger() {
        return log;
      },
      staticConnection(): TConn {
        if (!hasStaticConfig) {
          throw new Error(
            `${logLabel} datasource plugin is adapter-only — no static datasource configured`,
          );
        }
        if (!options.cacheStaticConnection) return buildStatic();
        cachedConn ??= buildStatic();
        return cachedConn;
      },
    };

    /**
     * Default static health probe: fresh connection + `SELECT 1`, warn on
     * failure, close-guarded in `finally` so a throwing `close()` can never
     * mask the probe result. Never touches the cached connection.
     */
    const defaultHealthProbe = async (): Promise<Omit<PluginHealthResult, "latencyMs">> => {
      let conn: PluginDBConnection | undefined;
      try {
        conn = buildStatic();
        await conn.query("SELECT 1", 5000);
        return { healthy: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        (log ?? console).warn(`${logLabel} health check failed: ${message}`);
        return { healthy: false, message };
      } finally {
        if (conn) {
          try {
            await conn.close();
          } catch (closeErr) {
            (log ?? console).warn(
              `[${options.id}] Failed to close health-check connection: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
            );
          }
        }
      }
    };

    const connection: AtlasDatasourcePlugin<TConfig>["connection"] = {
      // DB-driven (admin-UI-registered) datasources: build a connection from
      // the per-(workspace, install) config decrypted from `workspace_plugins`,
      // re-validated through the strict schema. Always available — this is the
      // SaaS per-workspace path (ADR-0013) and the only path in adapter-only
      // mode. Introspection is attached as a capability OF the built connection,
      // bound to the creds that built it (#3667 / ADR-0017).
      createFromConfig: (runtimeConfig) => {
        const parsed = options.connectionConfigSchema.parse(
          options.normalizeRuntimeConfig ? options.normalizeRuntimeConfig(runtimeConfig) : runtimeConfig,
        );
        const built = options.buildConnection(parsed, runtime);
        return options.attachIntrospection(built, { parsed, runtimeConfig }, runtime);
      },
      dbType: options.dbType,
    };
    if (options.parserDialect !== undefined) connection.parserDialect = options.parserDialect;
    if (options.forbiddenPatterns !== undefined) connection.forbiddenPatterns = options.forbiddenPatterns;
    if (options.validate !== undefined) connection.validate = options.validate;
    // When the config defines a static datasource the plugin wires a
    // config-defined connection at boot; without one it registers adapter-only.
    if (hasStaticConfig) connection.create = () => runtime.staticConnection();

    const plugin: AtlasDatasourcePlugin<TConfig> = {
      id: options.id,
      types: ["datasource"] as const,
      version,
      name: options.name,
      config,
      connection,
      entities: options.entities ?? [],
      dialect: typeof options.dialect === "function" ? options.dialect(hasStaticConfig) : options.dialect,

      async initialize(ctx) {
        log = ctx.logger;
        if (hasStaticConfig) {
          ctx.logger.info(
            `${logLabel} datasource plugin initialized (${options.describeStaticTarget(config)})`,
          );
        } else {
          ctx.logger.info(
            `${logLabel} datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections`,
          );
        }
        await options.onInitialize?.(ctx, runtime);
      },

      async healthCheck(): Promise<PluginHealthResult> {
        // Adapter-only: no static datasource to probe. The plugin itself is a
        // healthy adapter; per-workspace connections are health-checked by the
        // ConnectionRegistry once installed.
        if (!hasStaticConfig) {
          return { healthy: true, message: "adapter-only: no static datasource configured" };
        }
        return measuredHealthCheck(() =>
          options.healthProbe ? options.healthProbe(runtime) : defaultHealthProbe(),
        );
      },
    };

    if (options.hooks !== undefined) {
      plugin.hooks = typeof options.hooks === "function" ? options.hooks(runtime) : options.hooks;
    }
    if (options.getConfigSchema !== undefined) plugin.getConfigSchema = options.getConfigSchema;
    if (options.cacheStaticConnection || options.teardown) {
      plugin.teardown = async () => {
        if (cachedConn) {
          try {
            await cachedConn.close();
          } catch (err) {
            log?.warn(
              { err: err instanceof Error ? err.message : String(err) },
              `Failed to close ${logLabel} connection during teardown`,
            );
          }
          cachedConn = undefined;
        }
        await options.teardown?.(runtime);
      };
    }

    return plugin;
  };

  const validated = createPlugin<TConfig, AtlasDatasourcePlugin<TConfig>>({
    configSchema: options.configSchema,
    create: build,
  });

  return Object.assign((config: TConfig) => validated(config), { build });
}
