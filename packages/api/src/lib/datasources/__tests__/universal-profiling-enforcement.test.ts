/**
 * ENFORCEMENT TEST (#3667 AC #1) — "if it can connect, it can profile."
 *
 * This is the recurrence guard for the class of bug that bit BigQuery (#3664)
 * and Salesforce (#3663) twice: a datasource that can be CONNECTED over MCP but
 * fails CLOSED on the profiling seam because that seam re-derives its OWN,
 * narrower notion of "how do I reach this datasource" (the URL-shape gate in
 * `loadDatasourceProfileTarget`) instead of riding the query path's connection
 * resolution.
 *
 * It enumerates EVERY registered/provisionable datasource type from the single
 * source of truth ({@link MCP_PROVISIONABLE_CATALOG_SLUGS} plus the OAuth /
 * handler-managed datasource dbTypes) and asserts each resolves an end-to-end
 * profile path through the ONE unified resolver, {@link resolveLiveConnection}:
 * the same resolution querying uses (ConnectionRegistry for pg/mysql,
 * `createFromConfig` for url+config plugins, the OAuth `LazyPluginLoader` for
 * integration-pillar datasources like Salesforce). A connectable type that does
 * not resolve a live connection exposing the introspection capability
 * (`profile` / `listObjects`) FAILS this test — there is no gate left to fail
 * closed silently.
 *
 * If you add a new provisionable datasource type, this test forces you to give
 * it a profile path or it goes red — by construction, never a remembered
 * convention (the lockstep `resolveProfileCapability` "gestured at" but never
 * enforced across all types).
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { ProfilingResult, DatabaseObject } from "@useatlas/types";
import { createConnectionMock } from "../../../__mocks__/connection";

// ── The enumerated universe of connectable datasource types ───────────
//
// Derived from the PRODUCTION SSOT (`BUILTIN_DATASOURCE_CATALOG_SLUGS`),
// captured here before that module is mocked below. Deriving from the SSOT —
// rather than the narrower `MCP_PROVISIONABLE_CATALOG_SLUGS` subset this test
// used originally — is what keeps the guard fail-CLOSED: a new built-in
// datasource type lands in this enumeration automatically instead of being
// silently omitted. DuckDB was the live blind spot — connectable + profilable
// via `createFromConfig`, yet absent from the old subset, so a DuckDB profiler
// regression would not have turned this test red. `demo-postgres` is a demo
// alias that resolves to native postgres (`catalogSlugToDbType` → postgres) and
// is covered by the postgres case, so it's excluded from the iteration.
// Salesforce is in the SSOT and routes via the OAuth pillar (ADR-0014);
// `OAUTH_DATASOURCE_DBTYPES` drives that routing.
const { BUILTIN_DATASOURCE_CATALOG_SLUGS: REAL_BUILTIN_SLUGS } = await import(
  "@atlas/api/lib/db/datasource-pool-resolver"
);
const OAUTH_DATASOURCE_DBTYPES = ["salesforce"] as const;
const CONNECTABLE_DATASOURCE_DBTYPES: readonly string[] = REAL_BUILTIN_SLUGS.filter(
  (s: string) => s !== "demo-postgres",
);

// ── A one-table profiling result + one discovered object ──────────────
function oneTableResult(): ProfilingResult {
  return {
    profiles: [
      {
        table_name: "events",
        object_type: "table",
        row_count: 1,
        columns: [
          {
            name: "id",
            type: "int",
            nullable: false,
            unique_count: 1,
            null_count: 0,
            sample_values: [],
            is_primary_key: true,
            is_foreign_key: false,
            fk_target_table: null,
            fk_target_column: null,
            is_enum_like: false,
            profiler_notes: [],
          },
        ],
        primary_key_columns: ["id"],
        foreign_keys: [],
        inferred_foreign_keys: [],
        profiler_notes: [],
        table_flags: { possibly_abandoned: false, possibly_denormalized: false },
      },
    ],
    errors: [],
  };
}
const oneObject: DatabaseObject[] = [{ name: "events", type: "table" }];

// A built connection carrying the RELOCATED introspection capability (#3667):
// `listObjects` / `profile` are methods OF the live connection, bound to the
// creds that built it — they take NO url/config.
function builtLiveConnection() {
  return {
    query: mock(async () => ({ columns: [], rows: [] as Record<string, unknown>[] })),
    listObjects: mock(async (): Promise<DatabaseObject[]> => oneObject),
    profile: mock(async (): Promise<ProfilingResult> => oneTableResult()),
    close: mock(async () => {}),
  };
}

// ── Mock state (reset per test) ───────────────────────────────────────
let internalRows: Array<Record<string, unknown>> = [];
let poolConfigResult: Record<string, unknown> = {};
let pluginConn:
  | { dbType: string; createFromConfig?: unknown; profile?: unknown; listObjects?: unknown }
  | undefined;
let sfInstance: Record<string, unknown> | undefined;

// internal DB — the install-row lookup + persist gate.
const realInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mock(async () => internalRows),
  hasInternalDB: mock(() => true),
}));

// connection registry — the query-time live-connection resolver pg/mysql + the
// createFromConfig plugin pools share. `getForOrg`/`getForWorkspace` return a
// fake DBConnection so no real pool spins.
const fakeDbConn = { query: mock(async () => ({ columns: [], rows: [] })), close: mock(async () => {}) };
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      getForOrg: () => fakeDbConn,
      getForWorkspace: () => fakeDbConn,
      register: mock(() => {}),
      registerForWorkspace: mock(() => {}),
      registerDirectForWorkspace: mock(() => {}),
    },
  }),
);

// catalogSlug → dbType + the pool config the resolver reads.
void mock.module("@atlas/api/lib/db/datasource-pool-resolver", () => ({
  catalogSlugToDbType: (slug: string) => slug,
  resolveDatasourcePoolConfig: mock(() => poolConfigResult),
  BUILTIN_DATASOURCE_CATALOG_SLUGS: REAL_BUILTIN_SLUGS,
}));

// secrets — passthrough decrypt (the resolver decrypts the row config).
const realSecrets = await import("@atlas/api/lib/plugins/secrets");
void mock.module("@atlas/api/lib/plugins/secrets", () => ({
  ...realSecrets,
  parseConfigSchema: () => ({ state: "parsed", fields: [] }),
  decryptSecretFields: (c: Record<string, unknown>) => c,
  encryptSecretFields: (c: Record<string, unknown>) => c,
  maskSecretFields: (c: Record<string, unknown>) => c,
}));

// plugin registry bridge — the SINGLE structural lookup. The handler-managed
// predicate routes Salesforce to the OAuth path (ADR-0014: no createFromConfig).
void mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  findDatasourcePluginConnection: mock(async () => pluginConn),
  isHandlerManagedDatasourceDbType: (dbType: string) =>
    (OAUTH_DATASOURCE_DBTYPES as readonly string[]).includes(dbType),
  probePluginDatasourceConnection: mock(async () => ({ ok: true })),
  probeNativeDatasourceConnection: mock(async () => ({ ok: true })),
  registerDatasourceInstall: mock(async () => true),
  unregisterDatasourceInstall: mock(() => true),
}));

// native profilers — closures the resolver binds to the decrypted url for
// pg/mysql (core profiles those in-core). Mocked so no real DB is touched.
const realProfiler = await import("@atlas/api/lib/profiler");
void mock.module("@atlas/api/lib/profiler", () => ({
  ...realProfiler,
  profilePostgres: mock(async () => oneTableResult()),
  profileMySQL: mock(async () => oneTableResult()),
  listPostgresObjects: mock(async () => oneObject),
  listMySQLObjects: mock(async () => oneObject),
}));

// OAuth LazyPluginLoader — Salesforce's live connection is built from
// integration_credentials tokens here, NOT via createFromConfig (ADR-0014).
const realLazyLoader = await import("@atlas/api/lib/plugins/lazy-loader");
void mock.module("@atlas/api/lib/plugins/lazy-loader", () => ({
  ...realLazyLoader,
  lazyPluginLoader: {
    getOrInstantiate: mock(async () => sfInstance),
    hasBuilder: () => true,
  },
}));

const { resolveLiveConnection } = await import("../mcp-lifecycle.js");

// ── Per-type world setup ──────────────────────────────────────────────
function setupWorld(dbType: string): void {
  if (dbType === "salesforce") {
    // OAuth pillar: the install row carries instance_url / status (no url), the
    // live connection comes from the lazy loader, and introspection rides it.
    internalRows = [
      {
        catalog_id: "sf_cat",
        catalog_slug: "salesforce",
        config: { instance_url: "https://x.my.salesforce.com", status: "ok" },
        config_schema: [],
        group_id: null,
      },
    ];
    poolConfigResult = { dbType: "salesforce" };
    sfInstance = {
      query: mock(async () => ({ columns: [], rows: [] })),
      listObjects: mock(async (): Promise<DatabaseObject[]> => oneObject),
      profile: mock(async (): Promise<ProfilingResult> => oneTableResult()),
      teardown: mock(async () => {}),
    };
    pluginConn = undefined;
    return;
  }

  const isNative = dbType === "postgres" || dbType === "mysql";
  internalRows = [
    {
      catalog_id: `${dbType}_cat`,
      catalog_slug: dbType,
      config: { url: "enc:v1:…" },
      config_schema: [],
      group_id: null,
    },
  ];
  // BigQuery is the canonical non-url-shaped config-credential type — give it a
  // pool config with NO url to prove the deleted url-shape gate can't fail it.
  poolConfigResult =
    dbType === "bigquery"
      ? { dbType, projectId: "proj", schema: "analytics" }
      : { dbType, url: `${dbType}://host/db` };
  // Native pg/mysql have no plugin; the resolver binds in-core profilers.
  // Every other type is a createFromConfig plugin whose BUILT connection now
  // carries the relocated `profile` / `listObjects` (#3667 slice 4).
  pluginConn = isNative
    ? undefined
    : { dbType, createFromConfig: () => builtLiveConnection() };
  sfInstance = undefined;
}

beforeEach(() => {
  internalRows = [];
  poolConfigResult = {};
  pluginConn = undefined;
  sfInstance = undefined;
});

describe("universal datasource profiling — profilable iff connectable (#3667 AC #1)", () => {
  it("enumerates the full connectable universe (guards against a forgotten type)", () => {
    // Derived from the production SSOT, so any new built-in datasource appears
    // here automatically. Assert the milestone's named types are present —
    // including duckdb, the type the old MCP_PROVISIONABLE subset silently dropped.
    for (const t of [
      "postgres",
      "mysql",
      "clickhouse",
      "snowflake",
      "elasticsearch",
      "bigquery",
      "duckdb",
      "salesforce",
    ]) {
      expect(CONNECTABLE_DATASOURCE_DBTYPES).toContain(t);
    }
    // And nothing connectable was excluded except the documented demo alias.
    expect(CONNECTABLE_DATASOURCE_DBTYPES).not.toContain("demo-postgres");
  });

  for (const dbType of CONNECTABLE_DATASOURCE_DBTYPES) {
    it(`${dbType}: resolveLiveConnection yields a live connection exposing the profile capability`, async () => {
      setupWorld(dbType);

      const res = await resolveLiveConnection("org_1", `${dbType}_install`);

      // The unified resolver MUST NOT fail closed for any connectable type.
      expect(res.kind).toBe("ok");
      if (res.kind !== "ok") return;

      // Introspection is a capability OF the resolved live connection (#3667
      // slice 3) — bound to whatever creds built it, no url/config re-resolution.
      expect(typeof res.connection.profile).toBe("function");
      expect(typeof res.connection.listObjects).toBe("function");
      expect(res.connection.dbType).toBe(dbType);

      // And it actually profiles end-to-end (one table back).
      const profiled = await res.connection.profile({});
      expect(profiled.profiles.length).toBeGreaterThanOrEqual(1);
    });
  }
});
