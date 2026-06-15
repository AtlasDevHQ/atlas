/**
 * `datasource-registry-bridge` — shared (workspace_plugins row, decrypted
 * config) → `ConnectionRegistry.register` glue used by both boot-time
 * `loadSavedConnections` (`db/internal.ts`) and the runtime
 * `WorkspaceInstaller.installDatasource` facade (`lib/effect/workspace-
 * installer.ts`).
 *
 * The boot path and the post-install path used to diverge: boot ran the
 * resolver inline inside `loadSavedConnections`, the route ran its own
 * `connections.register(id, { url, schema, description })` directly off
 * the request body. Post-#2744 both go through this helper so the
 * per-`db_type` register convention lives in exactly one place. If a
 * new dbType ships (or a tunable like `maxConnections` becomes
 * catalog-declared), only this file needs to change.
 *
 * Resolver runs unconditionally; the handler-managed skip + native-dbType
 * filter run after. This means a plugin-managed row (`clickhouse` /
 * `snowflake` / `bigquery` / `duckdb` / `elasticsearch`) missing a required
 * catalog field will throw from the resolver BEFORE reaching the filters —
 * only well-formed plugin rows reach the filter and return `false`. The
 * trade-off is intentional: surfacing config violations loud at boot beats
 * silently skipping rows that the catalog declared as required.
 *
 * Salesforce is the exception — it is OAuth-managed (tokens in
 * `integration_credentials`, connection built from those tokens via the
 * `LazyPluginLoader`), so this bridge skips it before the plugin path. See
 * `HANDLER_MANAGED_DATASOURCE_DBTYPES` and ADR-0014.
 *
 * Pure-ish: the only side effect is the registry mutation. No DB I/O,
 * no logging — callers handle errors and emit the appropriate breadcrumb.
 *
 * @see docs/adr/0007-unified-install-pipeline.md
 */

import { connections } from "@atlas/api/lib/db/connection";
import type { ConnectionPluginMeta, DBConnection } from "@atlas/api/lib/db/connection";
import type { DatabaseObject, ProfilingResult } from "@useatlas/types";
import type {
  DatasourceProfiler,
  LiveConnectionListOptions,
  LiveConnectionProfileOptions,
} from "@atlas/api/lib/effect/semantic-generator";

/**
 * What a built datasource connection looks like to core. `query`/`close` are
 * the query surface; `listObjects`/`profile` are the OPTIONAL introspection
 * capability (#3667, ADR-0017 universalization) — methods bound to whatever
 * creds built the connection, so the host's profiler seam consumes them WITHOUT
 * re-resolving auth from a url/config. A query-only datasource omits them and
 * the host degrades to its explicit `unsupported` outcome.
 *
 * The introspection option shapes are the host's `LiveConnection*Options` (no
 * `url`/`config` — those are already bound), structurally aligned with the SDK
 * `PluginConnectionProfileOptions` / `PluginConnectionListObjectsOptions` so a
 * plugin's built connection flows in with no adapter and no plugin import.
 */
export interface BuiltDatasourceConnection {
  query(sql: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  listObjects?(options?: LiveConnectionListOptions): Promise<DatabaseObject[]> | DatabaseObject[];
  profile?(options: LiveConnectionProfileOptions): Promise<ProfilingResult>;
}
import {
  type BuiltinDatasourceDbType,
  type DatasourcePoolConfig,
  type DatasourceWorkspacePluginRow,
  resolveDatasourcePoolConfig,
} from "@atlas/api/lib/db/datasource-pool-resolver";

/**
 * Structural shape of a datasource plugin's `connection` object, matched
 * against `PluginRegistry` entries by `dbType`. Declared locally (not imported
 * from `@useatlas/plugin-sdk`) so core `@atlas/api` stays decoupled from the
 * plugin packages — the same convention `lib/plugins/wiring.ts` uses, preserving
 * the core→plugin decoupling the adapter-to-plugin extraction established.
 */
interface DatasourceConnectionShape {
  dbType: string;
  /**
   * Build a connection from a runtime (DB-stored) config — see SDK
   * `AtlasDatasourcePlugin`. The built connection MAY carry the introspection
   * capability (`listObjects` / `profile`) as methods bound to the creds that
   * built it (#3667 — introspection is a capability OF the live connection, not
   * a static function that re-resolves auth from a url/config).
   */
  createFromConfig?(
    config: Readonly<Record<string, unknown>>,
  ): Promise<BuiltDatasourceConnection> | BuiltDatasourceConnection;
  validate?: (query: string) => { valid: boolean; reason?: string } | Promise<{ valid: boolean; reason?: string }>;
  parserDialect?: string;
  forbiddenPatterns?: RegExp[];
  /**
   * Introspection contract (ADR-0017, SDK `AtlasDatasourcePlugin.connection`).
   * Optional — query-only datasources omit it. `profile` is structurally the
   * host's {@link DatasourceProfiler}, so `resolveProfileCapability` can feed it
   * straight into `SemanticGenerator`'s injection point with no adapter. Matched
   * structurally off the registry — core never imports the plugin package.
   */
  listObjects?(options: {
    url: string;
    schema?: string;
    /**
     * The datasource's resolved, DECRYPTED connection config (ADR-0017
     * amendment, #3552 wizard equivalent). Carried so a separate-field-credential
     * plugin (Elasticsearch) enumerates with the TENANT's own credentials rather
     * than falling back to operator env. Url-embedded plugins ignore it.
     * SECURITY: decrypted secret material — never logged or surfaced to the agent.
     */
    config?: Readonly<Record<string, unknown>>;
  }): Promise<DatabaseObject[]> | DatabaseObject[];
  profile?: DatasourceProfiler;
}

/** Narrow a registry plugin to its datasource `connection` shape, or undefined if it isn't one. */
function getDatasourceConnection(plugin: unknown): DatasourceConnectionShape | undefined {
  const c = (plugin as { connection?: unknown } | null)?.connection;
  if (c && typeof c === "object" && typeof (c as { dbType?: unknown }).dbType === "string") {
    return c as DatasourceConnectionShape;
  }
  return undefined;
}

/**
 * Find the registered datasource plugin `connection` for a `dbType`, or
 * `undefined` when none is registered. The single home for the
 * `PluginRegistry.getAll()` → structural-shape → `dbType` match that both the
 * boot/install registration ({@link registerPluginDatasourceInstall}) and the
 * pre-flight probe ({@link probePluginDatasourceConnection}) consult — so
 * "which plugin builds this type" lives in exactly one place (#3547).
 *
 * Uses `getAll()` (not `getByType`, which filters to `status==="healthy"`): the
 * plugin is consulted purely as an ADAPTER via `createFromConfig`, independent
 * of whether a static config-defined connection of its dbType is healthy. Lazy-
 * imports the registry to keep it out of this module's static graph (several
 * tests partial-mock this bridge's imports).
 */
export async function findDatasourcePluginConnection(
  dbType: string,
): Promise<DatasourceConnectionShape | undefined> {
  const { plugins } = await import("@atlas/api/lib/plugins/registry");
  return plugins
    .getAll()
    .map(getDatasourceConnection)
    .find((c): c is DatasourceConnectionShape => c != null && c.dbType === dbType);
}

/** Outcome of {@link probePluginDatasourceConnection} — `message` is NOT scrubbed; the caller scrubs. */
export type PluginProbeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "no_plugin" | "connect_failed"; readonly message: string };

/** Probe query + timeout — a trivial connectivity check that every SQL-shaped plugin pool answers. */
const PLUGIN_PROBE_SQL = "SELECT 1";
const PLUGIN_PROBE_TIMEOUT_MS = 10_000;

/** A built plugin connection, plus the OPTIONAL liveness surface some adapters expose. */
type ProbeableConnection = {
  query(sql: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  /**
   * A non-SQL liveness round-trip (e.g. Elasticsearch/OpenSearch `ping()` → cluster
   * info). Preferred over `SELECT 1` when present: the ES connection's `query()`
   * routes to the cluster SQL API (`/_sql`, optional on OpenSearch), so probing it
   * with `SELECT 1` would test the wrong surface — `ping()` is what the plugin's own
   * health check uses.
   */
  ping?(timeoutMs?: number): Promise<unknown>;
};

/**
 * Plugin-aware ephemeral test-connect for a CANDIDATE plugin-managed datasource
 * (#3547). Builds a throwaway connection via the registered plugin's
 * `createFromConfig(decryptedConfig)`, runs a liveness probe under a short
 * timeout — the connection's own `ping()` when it exposes one (ES/OpenSearch),
 * else a `SELECT 1` (ClickHouse/Snowflake/BigQuery) — and ALWAYS closes it,
 * registering nothing in the `ConnectionRegistry` and persisting nothing. The
 * plugin counterpart to the native `connections.register(probeId) → healthCheck`
 * pre-flight, so the MCP `create_datasource` validate-before-persist path is
 * uniform across native and plugin dbTypes.
 *
 * `message` carries the RAW driver error (which may echo the credential) — the
 * caller (`mcp-lifecycle.provisionDatasource`) runs it through
 * `scrubSecretsFromMessage` before it ever reaches a client/agent/log. Returning
 * the raw string keeps the secret-scrub seam in one place.
 */
export async function probePluginDatasourceConnection(
  dbType: string,
  decryptedConfig: Readonly<Record<string, unknown>>,
  timeoutMs: number = PLUGIN_PROBE_TIMEOUT_MS,
): Promise<PluginProbeOutcome> {
  const conn = await findDatasourcePluginConnection(dbType);
  if (!conn || typeof conn.createFromConfig !== "function") {
    return {
      ok: false,
      reason: "no_plugin",
      message:
        `No datasource plugin registered for type "${dbType}". Add the corresponding ` +
        `plugin (e.g. clickhousePlugin()) to the plugins array in atlas.config.ts.`,
    };
  }

  // Capture the narrowed factory before the nested closure below — TS resets the
  // `typeof conn.createFromConfig === "function"` narrowing inside the async IIFE.
  const createFromConfig = conn.createFromConfig;
  let built: ProbeableConnection | undefined;
  let timedOut = false;
  // Track whether the salvage-close has already fired so we never double-close
  // (once from the timeout branch, once from the probe's .finally() when it
  // eventually settles). Guards against a double-close when an adapter that
  // ignores its own timeoutMs both connects eagerly AND lets the query settle
  // after the deadline (#3580).
  let closedByTimeout = false;
  // The WHOLE build+probe runs under one deadline. `createFromConfig` has no
  // timeout of its own, and the `query`/`ping` timeoutMs is only honored if the
  // adapter chooses to — so an adapter that eagerly connects on build, or
  // ignores its own probe timeout, must not hang the MCP `create_datasource`
  // call against an unreachable host. On a deadline breach we close any
  // already-built connection immediately from the timeout callback (#3580) so a
  // slow-but-eternal query that NEVER settles can't leak a pool.
  const probeRun = (async () => {
    built = (await createFromConfig(decryptedConfig)) as ProbeableConnection;
    // Prefer the connection's native liveness check (ES/OpenSearch `ping`); fall
    // back to `SELECT 1` for SQL-only adapters that expose no `ping`.
    if (typeof built.ping === "function") {
      await built.ping(timeoutMs);
    } else {
      await built.query(PLUGIN_PROBE_SQL, timeoutMs);
    }
  })();
  // Secondary guard: if the probe eventually settles AFTER the timeout (and the
  // timeout already closed `built`), skip the double-close.
  void probeRun.catch(() => {}).finally(() => {
    if (timedOut && built && !closedByTimeout) void built.close().catch(() => {});
  });
  try {
    await withProbeTimeout(probeRun, timeoutMs, () => {
      timedOut = true;
      // #3580 — close the already-built connection immediately on timeout, not
      // only when the probe promise later settles. If `createFromConfig` resolved
      // and `built` is set but the query hangs indefinitely, the `.finally()`
      // on `probeRun` would never fire, leaking the pool. Closing here (in the
      // timeout callback, before `withProbeTimeout`'s promise rejects) ensures
      // the pool is always torn down on deadline breach.
      if (built) {
        closedByTimeout = true;
        void built.close().catch(() => {});
      }
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "connect_failed",
      message: timedOut
        ? `Connection probe exceeded ${timeoutMs}ms — the datasource may be unreachable.`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    // The timed-out path's salvage-close (above) owns teardown of a late build;
    // here we close only the connection we actually awaited in-deadline.
    if (!timedOut && built) {
      try {
        await built.close();
      } catch {
        // intentionally ignored: best-effort teardown of a throwaway probe
        // connection — a close failure must not mask the probe result, and this
        // module stays logger-free (callers own breadcrumbs).
      }
    }
  }
}

/**
 * Reject `p` if it has not settled within `ms`, invoking `onTimeout` so the
 * caller can flag the breach + salvage-close a late-resolving connection. Clears
 * its timer on settle so a resolved probe never keeps the event loop alive.
 */
function withProbeTimeout(p: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`probe timed out after ${ms}ms`));
    }, ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Outcome of {@link probeNativeDatasourceConnection} — `message` is NOT scrubbed; the caller scrubs. */
export type NativeProbeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "unhealthy" | "connect_error"; readonly message: string };

/**
 * Native pg/mysql ephemeral test-connect — the native counterpart to
 * {@link probePluginDatasourceConnection}, so the validate-before-persist probe
 * is ONE seam across native + plugin dbTypes (#3605). Registers a THROWAWAY
 * probe id (never the real install id — a throwaway id can't leave the
 * install-id-keyed registry split-brained if persist later fails), health-checks
 * it, and ALWAYS unregisters in `finally`. Registers nothing durable and
 * persists nothing.
 *
 * Returns the RAW `message`; the caller (`mcp-lifecycle.preflightNativeConnection`)
 * runs it through `scrubSecretsFromMessage` before it reaches a client/agent/log,
 * keeping the secret-scrub seam in one place (parity with the plugin probe).
 *
 * Distinguishes `unhealthy` (the registry's `healthCheck` reported non-healthy —
 * its `message` is already DSN-scrubbed by the registry) from `connect_error`
 * (`register`/`healthCheck` threw) so the caller can reproduce the right
 * user-facing wording. NOTE the `status !== "healthy"` (NOT `=== "unhealthy"`)
 * check: a fresh pool's FIRST failed probe is `degraded`, so anything that isn't
 * `healthy` is a failed pre-flight — otherwise a broken connection slips past
 * validate-before-persist. The `__mcp_preflight_` id prefix is retained for
 * continuity (the id is ephemeral and never surfaced).
 */
export async function probeNativeDatasourceConnection(config: {
  readonly url: string;
  readonly schema?: string;
  readonly description?: string;
}): Promise<NativeProbeOutcome> {
  const probeId = `__mcp_preflight_${crypto.randomUUID()}`;
  connections.register(probeId, {
    url: config.url,
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.schema !== undefined ? { schema: config.schema } : {}),
  });
  try {
    const health = await connections.healthCheck(probeId);
    if (health.status !== "healthy") {
      return {
        ok: false,
        reason: "unhealthy",
        message: health.message ?? "Connection probe could not reach the datasource.",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "connect_error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always drain the probe pool — success persists via the installer's own
    // fresh registration, failure persists nothing.
    connections.unregister(probeId);
  }
}

/**
 * Datasource dbTypes whose per-workspace connections are NOT built by this
 * bridge from `workspace_plugins.config`. Salesforce is the sole member:
 *
 *   - It installs via OAuth (`SalesforceOAuthInstallHandler`), persisting the
 *     refresh/access tokens in `integration_credentials` (per ADR-0005 /
 *     ADR-0007 — "OAuth-token storage is NOT part of the install-record
 *     unification"). Its `workspace_plugins.config` carries `instance_url` /
 *     `scopes` / `status` (+ `org_id` / `org_user_id`) — never a `url`.
 *   - Its per-workspace connection is built from those OAuth tokens via the
 *     `LazyPluginLoader` (a jsforce session — see `salesforce/lazy-builder.ts`),
 *     NOT from `workspace_plugins.config` via `createFromConfig`, and NOT
 *     queried through `executeSQL` / `ConnectionRegistry`.
 *
 * Because the OAuth config has no `url`, handing it to the plugin's
 * `createFromConfig` (which requires a `salesforce://…` url) would throw on
 * every boot, and a naive "no plugin registered" path would print a warning
 * telling operators to add `salesforcePlugin()` to atlas.config.ts — the exact
 * inert registration #3302 removed. Skipping here keeps the boot loop quiet and
 * records the decision in code: do NOT register `salesforcePlugin({})` expecting
 * the bridge to wire it. See ADR-0014 (Salesforce datasource stays on OAuth).
 *
 * Typed against `BuiltinDatasourceDbType` (not `string`) so a typo'd member is
 * a compile error rather than a silently-never-matching entry.
 */
const HANDLER_MANAGED_DATASOURCE_DBTYPES: ReadonlySet<BuiltinDatasourceDbType> =
  new Set(["salesforce"]);

/**
 * Whether a datasource dbType is OAuth / handler-managed — its per-workspace
 * connection is built from `integration_credentials` tokens via the
 * `LazyPluginLoader`, NOT from `workspace_plugins.config` via `createFromConfig`
 * (ADR-0014). The unified live-connection resolver (#3667,
 * `mcp-lifecycle.resolveLiveConnection`) reads this to route such datasources to
 * the OAuth path instead of the `createFromConfig` bridge — the SAME single
 * choke point the boot/install registration uses, so the two can't drift.
 */
export function isHandlerManagedDatasourceDbType(dbType: string): boolean {
  return (HANDLER_MANAGED_DATASOURCE_DBTYPES as ReadonlySet<string>).has(dbType);
}

/** Best-effort host for audit logging from a plugin pool config's URL (no credentials). */
function pluginTargetHost(poolConfig: DatasourcePoolConfig): string {
  const url = (poolConfig as { url?: unknown }).url;
  if (typeof url === "string") {
    try {
      return new URL(url).hostname || "(plugin)";
    } catch {
      // intentionally ignored: targetHost is a best-effort audit label, not a
      // routing/security value — a malformed URL falls back to "(plugin)".
      return "(plugin)";
    }
  }
  return "(plugin)";
}

/**
 * Register a DB-stored datasource of a PLUGIN type (clickhouse / snowflake /
 * bigquery / duckdb / salesforce / elasticsearch). Looks up the plugin in the
 * registry by `dbType`, builds a per-(workspace, install_id) connection via the
 * plugin's `connection.createFromConfig(decryptedConfig)`, and registers it
 * with the plugin's validator / dialect / forbidden patterns so SQL validation
 * stays correct.
 *
 * Throws (caught + logged per-row by `loadSavedConnections` at boot; surfaced
 * to the admin on the install path) when no plugin is registered for the
 * dbType, or the plugin doesn't implement `createFromConfig`.
 */
async function registerPluginDatasourceInstall(
  row: DatasourceWorkspacePluginRow,
  poolConfig: DatasourcePoolConfig,
  decryptedConfig: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  // Shared registry lookup — the same seam the pre-flight probe consults so
  // "which plugin builds this type" lives in one place (#3547).
  const conn = await findDatasourcePluginConnection(poolConfig.dbType);

  if (!conn || typeof conn.createFromConfig !== "function") {
    throw new Error(
      `No datasource plugin registered for type "${poolConfig.dbType}". Add the ` +
        `corresponding plugin (e.g. clickhousePlugin()) to the plugins array in ` +
        `atlas.config.ts, listed before any datasources that use it.`,
    );
  }

  const already = connections.hasDirectForWorkspace(row.workspaceId, row.installId);
  const built = await conn.createFromConfig(decryptedConfig);
  const meta: ConnectionPluginMeta = {
    ...(conn.parserDialect ? { parserDialect: conn.parserDialect } : {}),
    ...(conn.forbiddenPatterns ? { forbiddenPatterns: conn.forbiddenPatterns } : {}),
  };
  connections.registerDirectForWorkspace(
    row.workspaceId,
    row.installId,
    // Single structural assertion (DBConnection is a superset of the plugin's
    // {query,close} shape) — mirrors lib/plugins/wiring.ts; no `unknown` launder.
    built as DBConnection,
    poolConfig.dbType,
    (poolConfig as { description?: string }).description,
    conn.validate,
    meta,
    pluginTargetHost(poolConfig),
  );
  return !already;
}

/**
 * Resolve `(row, decryptedConfig)` and register the resulting native pool
 * with the `ConnectionRegistry`.
 *
 * Returns:
 *   - `true`  — a fresh registration was performed (the per-(workspace,
 *               install_id) config and/or the bare install_id row was new)
 *   - `false` — the dbType is handler-managed (Salesforce / OAuth — skipped
 *               entirely, see `HANDLER_MANAGED_DATASOURCE_DBTYPES`), OR the
 *               dbType is plugin-managed (filter short-circuit), OR BOTH the
 *               per-(workspace, install_id) config and the bare install_id were
 *               already registered (full idempotent re-register)
 *
 * Throws on any resolver violation (missing required field, invalid
 * schema identifier, unknown catalog slug). Resolver runs before the
 * native filter — a plugin-managed row with malformed config throws
 * here, never reaching the short-circuit branch.
 *
 * The native-only filter matches the prior in-line check in
 * `loadSavedConnections` — without it, `connections.register` would
 * reject every plugin-managed dbType at the URL-scheme check and the
 * boot loop would log a noisy warning per row.
 */
export async function registerDatasourceInstall(
  row: DatasourceWorkspacePluginRow,
  decryptedConfig: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const poolConfig: DatasourcePoolConfig = resolveDatasourcePoolConfig(row, decryptedConfig);

  // Handler-managed (OAuth) datasources — Salesforce — never register a pool
  // here. Their connection is built from tokens in `integration_credentials`
  // via the `LazyPluginLoader`, not from `workspace_plugins.config` via
  // `createFromConfig`. Returning `false` (nothing registered) keeps the boot
  // loop from feeding an OAuth config (no `url`) to the plugin's
  // `createFromConfig` and logging a misleading per-row warning. See ADR-0014.
  if (HANDLER_MANAGED_DATASOURCE_DBTYPES.has(poolConfig.dbType)) {
    return false;
  }

  // Plugin-managed dbTypes can't be cloned by the core `createConnection`
  // switch — build a live per-(workspace, install_id) connection from the
  // registered plugin's `createFromConfig` instead (#3253 seam).
  if (poolConfig.dbType !== "postgres" && poolConfig.dbType !== "mysql") {
    return registerPluginDatasourceInstall(row, poolConfig, decryptedConfig);
  }

  const config = {
    url: poolConfig.url,
    ...(poolConfig.description !== undefined ? { description: poolConfig.description } : {}),
    ...(poolConfig.dbType === "postgres" && poolConfig.schema
      ? { schema: poolConfig.schema }
      : {}),
  };

  // Per-(workspace, install_id) config registration — the routing source of
  // truth that retires the `DISTINCT ON (install_id)` multi-tenant collision
  // (#2783). `getForOrg(workspaceId, installId)` clones an org pool from THIS
  // config, so two workspaces sharing an install_id route to their own DBs.
  // Config-only + upsert (no live pool to tear down), so it's registered
  // unconditionally — a datasource config update replaces the base config used
  // for SUBSEQUENT org-pool clones here. The update path drains the existing
  // clone first via `unregisterDatasourceInstall` →
  // `connections.drainWorkspacePool`, so the next query re-clones from this new
  // config without waiting for LRU eviction / restart (#3109).
  const compositeExisted = connections.hasForWorkspace(row.workspaceId, row.installId);
  connections.registerForWorkspace(row.workspaceId, row.installId, config);

  // Bare install-id registration keeps install-id-keyed readers
  // (getDBType / getTargetHost / validators) and self-hosted
  // `connections.get(installId)` working. Idempotent on the bare id so a
  // healthy pre-registered pool isn't torn down — the route layer
  // pre-`healthCheck`'s a fresh pool before writing the DB row, and boot's
  // `loadSavedConnections` registers the first workspace's row. Two workspaces
  // sharing an install_id collapse onto one bare row by design (it backs only
  // install-id-keyed metadata, not routing — routing uses the per-workspace
  // config above).
  const bareExisted = connections.has(row.installId);
  if (!bareExisted) {
    connections.register(row.installId, config);
  }

  // Fresh if either registration newly landed — the boot loader counts these.
  return !compositeExisted || !bareExisted;
}

/**
 * Unregister an install from the `ConnectionRegistry`. Returns `false`
 * when nothing was registered (plugin-managed pool, or a soft-archived row
 * that never landed in the registry). Mirrors {@link registerDatasourceInstall}
 * so the install / uninstall paths in `WorkspaceInstaller` stay symmetric.
 *
 * Symmetric with the dual-registration in {@link registerDatasourceInstall}:
 *  1. Removes the per-(workspace, install_id) routing config — `getForOrg`
 *     resolves it with priority over the bare entry, so leaving it would let
 *     an uninstalled datasource keep routing to a stale URL (#2783).
 *  2. Drains the live org-pool clone for this (workspace, install_id) so a
 *     config update / uninstall propagates immediately instead of serving the
 *     OLD config until LRU eviction / restart (#3109). Step 1 drops the routing
 *     config; this drops the live pool, keeping them symmetric.
 *  3. Closes + drops a DB-stored plugin connection (clickhouse / snowflake / …)
 *     held in `workspacePluginEntries` for this (workspace, install_id) — the
 *     plugin counterpart to step 1+2's native teardown (#3253).
 *  4. Removes the shared bare `entries` row ONLY when no OTHER workspace still
 *     owns the install_id (`hasWorkspacePoolsFor`). A sibling sharing the
 *     install_id keeps the bare row so its install-id-keyed metadata
 *     (getDBType / getTargetHost / validators) keeps resolving.
 *
 * The registry's own `unregister` throws if the id isn't present; we guard
 * with `has()` so the soft-archive path (status → archived) is a no-op for the
 * BARE row when the install never populated it (plugin datasources never do —
 * their teardown is step 3's `unregisterDirectForWorkspace`).
 */
export function unregisterDatasourceInstall(workspaceId: string, installId: string): boolean {
  const removedWorkspace = connections.unregisterForWorkspace(workspaceId, installId);
  // Eagerly tear down the live org-pool clone for this (workspace, install_id)
  // so a config update / uninstall takes effect on the next query — without
  // this the cloned pool keeps the prior config until LRU/restart (#3109).
  connections.drainWorkspacePool(workspaceId, installId);
  // Close + drop a DB-stored plugin connection (clickhouse / snowflake / …) for
  // this (workspace, install_id) — the plugin counterpart to the native
  // unregisterForWorkspace + drain above (#3253 seam).
  const removedPlugin = connections.unregisterDirectForWorkspace(workspaceId, installId);
  // Drop the shared bare row only once the last workspace owning this
  // install_id is gone — siblings keep their install-id-keyed metadata.
  const removedBare =
    !connections.hasWorkspacePoolsFor(installId) &&
    connections.has(installId) &&
    connections.unregister(installId);
  return removedWorkspace || removedPlugin || removedBare;
}
