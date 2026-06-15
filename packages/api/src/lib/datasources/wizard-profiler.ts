/**
 * Profiler-seam resolution for the in-product onboarding wizard (#3621, ADR-0017).
 *
 * The wizard's `/wizard/profile`, `/wizard/generate`, and `/wizard/enrich`
 * routes used to hard-code `profilePostgres`/`profileMySQL` and reject every
 * other `dbType` with "Wizard profiling is currently supported for PostgreSQL
 * and MySQL." This module replaces that gate with the registry-resolved profiler
 * seam: Postgres and MySQL keep the native in-core fast path, and any other
 * `dbType` whose datasource plugin implements the introspection contract
 * (`connection.listObjects` / `connection.profile`) dispatches through it.
 *
 * Capability classification is DELEGATED to {@link resolveProfileCapabilityByDbType}
 * (`mcp-lifecycle.ts`) — the SAME single plugin lookup
 * ({@link findDatasourcePluginConnection}) provisioning and the MCP profiling
 * surface use — so the plugin that provisions a datasource is the plugin that
 * profiles it, never a divergent second matcher (ADR-0017). The only thing this
 * module adds on top of the profile capability is the `listObjects` half (the
 * wizard's table-picker step needs it; the MCP surface profiles a fixed set so
 * it never lists), resolved off the SAME registry connection.
 *
 * Lives in `lib/` (not a route) so `lib/ must not import api/routes/` holds:
 * `api/routes/wizard.ts` imports DOWN into this helper.
 */

import type { DatabaseObject } from "@useatlas/types";
import type { DBType } from "@atlas/api/lib/db/connection";
import {
  listPostgresObjects,
  listMySQLObjects,
  profilePostgres,
  profileMySQL,
  type ProfileLogger,
  type ProfileProgressCallbacks,
} from "@atlas/api/lib/profiler";
import type { DatasourceProfiler } from "@atlas/api/lib/effect/semantic-generator";

/** Lists the discoverable tables/views of a datasource for the wizard picker. */
export type DatasourceListObjects = (args: {
  url: string;
  /**
   * Schema / database to enumerate. `undefined` for a plugin dbType where the
   * caller passed no schema — the plugin uses its own default rather than a
   * literal `"public"` (#3621 review). Native Postgres always receives a value.
   */
  schema?: string;
  logger?: ProfileLogger;
  /**
   * The datasource's resolved, DECRYPTED connection config (ADR-0017 amendment,
   * #3552 wizard equivalent). Carried so a separate-field-credential plugin
   * (Elasticsearch — `apiKey` / `username` / `password` / SigV4 live in config
   * fields, NOT in the `url`) enumerates with the TENANT's own credentials rather
   * than falling back to operator `ATLAS_ES_*` env (the per-tenant-creds rule).
   * Url-embedded plugins (ClickHouse / Snowflake) and native pg/mysql ignore it.
   *
   * SECURITY: DECRYPTED secret material — never logged or surfaced to the agent.
   */
  config?: Readonly<Record<string, unknown>>;
}) => Promise<DatabaseObject[]>;

/**
 * The wizard's profiling capability for a resolved `dbType`. Both functions are
 * normalized to a single options object so the route dispatches uniformly —
 * native pg/mysql adapt the positional core signatures, plugins pass through.
 */
export type WizardProfilerCapability =
  | {
      readonly kind: "ok";
      readonly listObjects: DatasourceListObjects;
      readonly profile: DatasourceProfiler;
    }
  | { readonly kind: "unsupported"; readonly message: string };

/** Native Postgres introspection, normalized to the seam's options shape. */
const POSTGRES_CAPABILITY: { listObjects: DatasourceListObjects; profile: DatasourceProfiler } = {
  listObjects: ({ url, schema, logger }) => listPostgresObjects(url, schema, logger),
  profile: ({ url, schema, selectedTables, prefetchedObjects, progress, logger }) =>
    profilePostgres(url, selectedTables, prefetchedObjects, schema, progress, logger),
};

/** Native MySQL introspection, normalized to the seam's options shape. */
const MYSQL_CAPABILITY: { listObjects: DatasourceListObjects; profile: DatasourceProfiler } = {
  listObjects: ({ url, logger }) => listMySQLObjects(url, logger),
  profile: ({ url, selectedTables, prefetchedObjects, progress, logger }) =>
    profileMySQL(url, selectedTables, prefetchedObjects, progress, logger),
};

/**
 * Resolve the wizard's profiling capability for a `dbType`.
 *
 * - `postgres` / `mysql` → the native in-core fast path (behavior unchanged).
 * - any other `dbType` → the registry-resolved plugin profiler, IF the plugin
 *   implements BOTH halves of the introspection contract. A plugin that
 *   provisions but does not (yet) implement `profile`, or has no `listObjects`,
 *   yields an actionable `unsupported` outcome (never a silent skip).
 */
export async function resolveWizardProfiler(
  dbType: DBType,
): Promise<WizardProfilerCapability> {
  if (dbType === "postgres") {
    return { kind: "ok", listObjects: POSTGRES_CAPABILITY.listObjects, profile: POSTGRES_CAPABILITY.profile };
  }
  if (dbType === "mysql") {
    return { kind: "ok", listObjects: MYSQL_CAPABILITY.listObjects, profile: MYSQL_CAPABILITY.profile };
  }

  // Plugin dbType — classify via the SHARED capability resolver (one lookup,
  // in lockstep with provisioning + MCP profiling). Lazy-imported so the heavy
  // `mcp-lifecycle` graph (workspace-installer, semantic-generator, Effect
  // layers) stays out of the wizard route's module-load path for the common
  // pg/mysql case — mirroring how `findDatasourcePluginConnection` lazy-imports
  // the plugin registry.
  const { resolveProfileCapabilityByDbType } = await import(
    "@atlas/api/lib/datasources/mcp-lifecycle"
  );
  const { findDatasourcePluginConnection } = await import(
    "@atlas/api/lib/db/datasource-registry-bridge"
  );
  const capability = await resolveProfileCapabilityByDbType(dbType);
  if (capability.kind === "unsupported") {
    return { kind: "unsupported", message: capability.message };
  }
  // `native` can't happen here (pg/mysql handled above), but be defensive: a
  // native classification with no plugin still has no `listObjects` for the
  // wizard picker, so treat it as unsupported with the same actionable message.
  if (capability.kind === "native") {
    return {
      kind: "unsupported",
      message: notProfilableMessage(dbType),
    };
  }

  // capability.kind === "plugin" — carries the profiler. Re-resolve the SAME
  // plugin connection for its `listObjects` half (the wizard table picker needs
  // it; the MCP surface profiles a fixed table set and never lists).
  const conn = await findDatasourcePluginConnection(dbType);
  if (!conn || typeof conn.listObjects !== "function") {
    return {
      kind: "unsupported",
      message:
        `Datasource type "${dbType}" implements profiling but not table discovery ` +
        `(connection.listObjects). Upgrade the datasource plugin, or profile it with ` +
        `the Atlas CLI (atlas init).`,
    };
  }
  const listObjects = conn.listObjects.bind(conn);
  return {
    kind: "ok",
    // Thread `config` (the decrypted tenant creds — ADR-0017 amendment / #3552
    // wizard equivalent) and `schema` into the plugin's `listObjects` so a
    // separate-field-credential plugin (ES) enumerates with the TENANT's own
    // credentials, not operator env. The plugin contract has no logger slot
    // (`PluginListObjectsOptions` is `{ url, schema?, config? }`), so the route's
    // `logger` is accepted by this seam but not forwardable to the plugin —
    // captured here so it is no longer silently dropped (#3621 review).
    listObjects: ({ url, schema, config, logger }) => {
      void logger; // intentionally unused: plugin listObjects has no logger param
      return Promise.resolve(
        listObjects({
          url,
          ...(schema !== undefined ? { schema } : {}),
          ...(config !== undefined ? { config } : {}),
        }),
      );
    },
    profile: capability.profileFn,
  };
}

function notProfilableMessage(dbType: string): string {
  return (
    `Datasource type "${dbType}" cannot be profiled in this deployment. No registered plugin ` +
    `implements the profiling contract (connection.profile) for it. Install or upgrade the ` +
    `corresponding datasource plugin, or profile it with the Atlas CLI (atlas init).`
  );
}

export type { ProfileProgressCallbacks };
