/**
 * Lib-layer tests for the PLUGIN-managed half of the MCP `profile_datasource`
 * flow (#3552 — ADR-0017): `loadDatasourceProfileTarget` reads the registry-
 * resolved capability (the SAME predicate provisioning uses) and carries the
 * plugin's `profileFn`, and `runSemanticProfile` feeds that `profileFn` into the
 * shared `SemanticGenerator` so a plugin datasource is profiled → entities +
 * table whitelist + draft persistence, exactly as pg/mysql are.
 *
 * The native pg/mysql persistence path is covered live in
 * `mcp-profile-persist-pg.test.ts`. Here the candidate is a plugin-managed type
 * (ClickHouse / Snowflake tracer types) whose profiler is INJECTED (no live
 * cluster) — proving:
 *   1. `loadDatasourceProfileTarget` resolves a `plugin` target with the
 *      registry-resolved `profileFn` (NOT a hardcoded pg/mysql discriminant);
 *   2. a plugin without `connection.profile` (or no plugin) is `unsupported`,
 *      in lockstep with provisioning — never a silent empty layer;
 *   3. `runSemanticProfile` profiles via the injected `profileFn`, persists the
 *      generated entities as DRAFTS under the install's `connection_group_id`,
 *      and registers the in-memory whitelist so the tables are queryable.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { ProfilingResult } from "@useatlas/types";
import { createConnectionMock } from "../../../__mocks__/connection";
import type { LiveDatasourceConnection } from "../mcp-lifecycle.js";

// ── internal DB (loadDatasourceProfileTarget row + persist gate) ──────
const realInternal = await import("@atlas/api/lib/db/internal");
let internalRows: Array<Record<string, unknown>> = [];
const mockInternalQuery = mock<(...a: unknown[]) => Promise<unknown>>(async () => internalRows);
const mockHasInternalDB = mock<() => boolean>(() => true);
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mockHasInternalDB,
}));

// `mcp-lifecycle` imports the connection registry at module load — mock it so no
// real pool spins. `runSemanticProfile`'s whitelist registration goes through the
// real `whitelist` module (not this mock).
mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ connections: { register: mock(() => {}) } }),
);

// catalogSlug → dbType + the pool config the profile target reads its url from.
let poolConfigResult: unknown = { dbType: "clickhouse", url: "clickhouse://h:8443/analytics" };
mock.module("@atlas/api/lib/db/datasource-pool-resolver", () => ({
  catalogSlugToDbType: (slug: string) => {
    if (slug === "clickhouse") return "clickhouse";
    if (slug === "snowflake") return "snowflake";
    if (slug === "bigquery") return "bigquery";
    if (slug === "elasticsearch") return "elasticsearch";
    throw new Error(`unknown slug ${slug}`);
  },
  resolveDatasourcePoolConfig: mock(() => poolConfigResult),
  BUILTIN_DATASOURCE_CATALOG_SLUGS: ["postgres", "mysql", "clickhouse", "snowflake", "bigquery", "elasticsearch"],
}));

// The plugin registry seam — fully controllable per test. `findDatasourcePluginConnection`
// is the SINGLE lookup both provisioning and profiling derive from.
let pluginConn:
  | { dbType: string; createFromConfig?: unknown; profile?: unknown; listObjects?: unknown }
  | undefined;
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  findDatasourcePluginConnection: mock(async () => pluginConn),
  isHandlerManagedDatasourceDbType: (dbType: string) => dbType === "salesforce",
  probePluginDatasourceConnection: mock(async () => ({ ok: true })),
  probeNativeDatasourceConnection: mock(async () => ({ ok: true })),
  registerDatasourceInstall: mock(async () => true),
  unregisterDatasourceInstall: mock(() => true),
}));

// Secrets passthrough — the profile target decrypts the row config.
const realSecrets = await import("@atlas/api/lib/plugins/secrets");
mock.module("@atlas/api/lib/plugins/secrets", () => ({
  ...realSecrets,
  parseConfigSchema: () => ({ state: "parsed", fields: [] }),
  decryptSecretFields: (c: Record<string, unknown>) => c,
  encryptSecretFields: (c: Record<string, unknown>) => c,
  maskSecretFields: (c: Record<string, unknown>) => c,
}));

// Capture the durable draft-persistence WITHOUT a real DB: spy `bulkUpsertEntities`
// (the seam `SemanticGenerator.persist` uses by default) and return the row count
// it received, so the "every row landed" success contract is exercised.
type UpsertRow = { entityType: string; name: string; yamlContent: string; connectionGroupId?: string | null };
let upsertCalls: Array<{ orgId: string; rows: UpsertRow[] }> = [];
const realEntities = await import("@atlas/api/lib/semantic/entities");
mock.module("@atlas/api/lib/semantic/entities", () => ({
  ...realEntities,
  bulkUpsertEntities: mock(async (orgId: string, rows: UpsertRow[]) => {
    upsertCalls.push({ orgId, rows });
    return rows.length; // every row landed → success
  }),
}));

const { resolveLiveConnection, profileLiveDatasource } = await import("../mcp-lifecycle.js");
const whitelist = await import("@atlas/api/lib/semantic/whitelist");

// A profiler returning one analyzable table, recording its calls — a stand-in for
// the real `plugins/clickhouse/src/profiler.ts` `profileClickHouse`, injected so the
// test needs no live cluster.
function chProfiler(): ((args: {
  url: string;
  schema?: string;
  config?: Readonly<Record<string, unknown>>;
}) => Promise<ProfilingResult>) & {
  calls: Array<{ url: string; schema?: string; config?: Readonly<Record<string, unknown>> }>;
} {
  const fn = Object.assign(
    (args: { url: string; schema?: string; config?: Readonly<Record<string, unknown>> }) => {
      fn.calls.push({ url: args.url, schema: args.schema, config: args.config });
      return Promise.resolve<ProfilingResult>({
        profiles: [
          {
            table_name: "events",
            object_type: "table",
            row_count: 10,
            columns: [
              {
                name: "id",
                type: "UInt64",
                nullable: false,
                unique_count: 10,
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
      });
    },
    { calls: [] as Array<{ url: string; schema?: string; config?: Readonly<Record<string, unknown>> }> },
  );
  return fn;
}

beforeEach(() => {
  internalRows = [];
  upsertCalls = [];
  mockHasInternalDB.mockReturnValue(true);
  poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h:8443/analytics" };
  pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}), profile: chProfiler() };
  whitelist._resetWhitelists();
  whitelist._resetPluginEntities();
  whitelist._resetOrgWhitelists();
});

// A one-table profiling result + a LiveConnection-bound profile spy for the
// profileLiveDatasource tests (it consumes a resolved LiveDatasourceConnection,
// not url/config — #3667).
function oneTable(): ProfilingResult {
  return {
    profiles: [
      {
        table_name: "events",
        object_type: "table",
        row_count: 10,
        columns: [
          {
            name: "id",
            type: "UInt64",
            nullable: false,
            unique_count: 10,
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

function liveProfileSpy() {
  const fn = Object.assign(
    (opts: { schema?: string }) => {
      fn.calls.push({ schema: opts.schema });
      return Promise.resolve(oneTable());
    },
    { calls: [] as Array<{ schema?: string }> },
  );
  return fn;
}

/** A fake resolved live connection whose `profile` records the bound-options it receives. */
function fakeLiveConn(over: {
  dbType?: string;
  connectionGroupId?: string | null;
  profile?: ReturnType<typeof liveProfileSpy>;
}): LiveDatasourceConnection {
  const profile = over.profile ?? liveProfileSpy();
  return {
    dbType: (over.dbType ?? "clickhouse") as LiveDatasourceConnection["dbType"],
    connectionGroupId: over.connectionGroupId ?? null,
    query: async () => ({ columns: [], rows: [] }),
    listObjects: async () => [],
    profile,
    close: async () => {},
  };
}

describe("resolveLiveConnection — plugin types (#3667)", () => {
  it("resolves a plugin clickhouse install to a live connection bound to the install's group + decrypted config", async () => {
    const profile = chProfiler();
    // Built connection has no introspection → resolveLiveConnection adapts the
    // plugin's (legacy) static profile bound to the resolved url + decrypted config.
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}), profile };
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: { url: "enc:v1:…" }, config_schema: [], group_id: "warehouse" },
    ];
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.connection.dbType).toBe("clickhouse");
    expect(res.connection.connectionGroupId).toBe("warehouse");
    expect(typeof res.connection.profile).toBe("function");
    // The bound profile delegates to the plugin profiler with the resolved url
    // + the TENANT's decrypted config — never re-resolving auth.
    await res.connection.profile({ schema: "analytics" });
    expect(profile.calls).toHaveLength(1);
    expect(profile.calls[0].url).toBe("clickhouse://h:8443/analytics");
    expect(profile.calls[0].schema).toBe("analytics");
  });

  it("carries the install's DECRYPTED config so a separate-field-credential profiler (ES) gets the tenant's creds", async () => {
    poolConfigResult = { dbType: "elasticsearch", url: "elasticsearch://es.tenant:9200" };
    const profile = chProfiler();
    pluginConn = { dbType: "elasticsearch", createFromConfig: () => ({}), profile };
    internalRows = [
      {
        catalog_id: "cat_es",
        catalog_slug: "elasticsearch",
        config: { url: "elasticsearch://es.tenant:9200", apiKey: "tenant-es-key" },
        config_schema: [],
        group_id: null,
      },
    ];
    const res = await resolveLiveConnection("org_1", "es");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    await res.connection.profile({});
    // The decrypted tenant config reached the profiler verbatim (apiKey is in a
    // SEPARATE field, not the url) — operator ATLAS_ES_* env is never consulted.
    expect(profile.calls[0].config).toEqual({ url: "elasticsearch://es.tenant:9200", apiKey: "tenant-es-key" });
  });

  it("bigquery (non-url-shaped) resolves to ok — the URL-shape gate is GONE (#3664/#3667)", async () => {
    // BigQuery's pool config has NO url (service-account multi-field). With the
    // gate deleted, the unified resolver builds a profilable live connection and
    // the profiler reads creds from the decrypted config — no synthetic url.
    poolConfigResult = {
      dbType: "bigquery",
      projectId: "my-project",
      schema: "analytics",
    };
    const profile = chProfiler();
    pluginConn = { dbType: "bigquery", createFromConfig: () => ({}), profile };
    internalRows = [
      {
        catalog_id: "cat_bq",
        catalog_slug: "bigquery",
        config: { service_account_json: '{"project_id":"my-project"}', project_id: "my-project", schema: "analytics" },
        config_schema: [],
        group_id: null,
      },
    ];
    const res = await resolveLiveConnection("org_1", "bq");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.connection.dbType).toBe("bigquery");
    await res.connection.profile({});
    // No url is fabricated — the profiler authenticates from the decrypted config.
    expect(profile.calls[0].url).toBe("");
    expect(profile.calls[0].config).toMatchObject({ project_id: "my-project" });
  });

  it("native pg resolves WITHOUT a plugin (in-core profilers bound to the resolved url)", async () => {
    poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "public" };
    pluginConn = undefined;
    internalRows = [
      { catalog_id: "cat_pg", catalog_slug: "postgres", config: { url: "enc:v1:…" }, config_schema: [], group_id: null },
    ];
    const res = await resolveLiveConnection("org_1", "pg");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.connection.dbType).toBe("postgres");
    expect(typeof res.connection.profile).toBe("function");
  });

  it("a provisionable plugin with NO profile capability → unsupported (never a silent empty layer)", async () => {
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}) }; // createFromConfig but no profile
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [], group_id: null },
    ];
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") {
      expect(res.dbType).toBe("clickhouse");
      expect(res.message).toContain("connection.profile");
    }
  });

  it("no registered plugin → unsupported", async () => {
    pluginConn = undefined;
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [], group_id: null },
    ];
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("unsupported");
  });

  it("not_found for an unknown install", async () => {
    internalRows = [];
    const res = await resolveLiveConnection("org_1", "nope");
    expect(res.kind).toBe("not_found");
  });
});

describe("profileLiveDatasource — entities + whitelist + draft persistence (#3667)", () => {
  it("profiles the resolved live connection → persists drafts under the group + registers the whitelist", async () => {
    const profile = liveProfileSpy();
    const connection = fakeLiveConn({ dbType: "clickhouse", connectionGroupId: "warehouse", profile });
    const outcome = await profileLiveDatasource({ connection, connectionId: "wh", orgId: "org_1" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(profile.calls).toHaveLength(1);
    expect(outcome.result.entities.map((e) => e.table)).toContain("events");
    expect(outcome.persisted).not.toBeNull();
    expect(outcome.persisted?.entities).toBeGreaterThanOrEqual(1);
    const entityUpsert = upsertCalls.find((c) => c.rows.some((r) => r.entityType === "entity"));
    expect(entityUpsert?.orgId).toBe("org_1");
    expect(entityUpsert?.rows.every((r) => r.connectionGroupId === "warehouse")).toBe(true);
    expect(entityUpsert?.rows.some((r) => r.name.includes("events"))).toBe(true);
    const tables = whitelist.getWhitelistedTables("wh");
    expect([...tables].some((t) => t.includes("events"))).toBe(true);
  });

  it("ungrouped install → null scope on every persisted row (flat default bucket)", async () => {
    const connection = fakeLiveConn({ dbType: "snowflake", connectionGroupId: null });
    const outcome = await profileLiveDatasource({ connection, connectionId: "sf", orgId: "org_1" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    const entityUpsert = upsertCalls.find((c) => c.rows.some((r) => r.entityType === "entity"));
    expect(entityUpsert?.rows.every((r) => r.connectionGroupId === null)).toBe(true);
  });

  it("no orgId → no persistence, registers the in-memory whitelist immediately", async () => {
    const connection = fakeLiveConn({ dbType: "clickhouse" });
    const outcome = await profileLiveDatasource({ connection, connectionId: "wh-ephemeral" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.persisted).toBeNull();
    expect(upsertCalls).toHaveLength(0);
    const tables = whitelist.getWhitelistedTables("wh-ephemeral");
    expect([...tables].some((t) => t.includes("events"))).toBe(true);
  });

  // #3662 — the seam must NOT coerce a missing schema to "public" for a plugin
  // dbType (ClickHouse's default database is `default`, not `public`).
  it("clickhouse with NO schema → the connection profiler receives undefined, NOT \"public\"", async () => {
    const profile = liveProfileSpy();
    const connection = fakeLiveConn({ dbType: "clickhouse", profile });
    const outcome = await profileLiveDatasource({ connection, connectionId: "wh" });
    expect(outcome.kind).toBe("ok");
    expect(profile.calls[0].schema).toBeUndefined();
  });

  it("clickhouse with an explicit schema → passed through verbatim", async () => {
    const profile = liveProfileSpy();
    const connection = fakeLiveConn({ dbType: "clickhouse", profile });
    const outcome = await profileLiveDatasource({ connection, connectionId: "wh", schema: "analytics" });
    expect(outcome.kind).toBe("ok");
    expect(profile.calls[0].schema).toBe("analytics");
  });
});
