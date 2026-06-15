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

const { loadDatasourceProfileTarget, runSemanticProfile } = await import("../mcp-lifecycle.js");
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

describe("loadDatasourceProfileTarget — plugin types (#3552)", () => {
  it("resolves a plugin target carrying the registry-resolved profileFn (no pg/mysql hardcode)", async () => {
    const profile = chProfiler();
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}), profile };
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: { url: "enc:v1:…" }, config_schema: [], group_id: "warehouse" },
    ];
    const res = await loadDatasourceProfileTarget("org_1", "ch");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.target.dbType).toBe("clickhouse");
    expect(res.target.url).toBe("clickhouse://h:8443/analytics");
    // The resolved profileFn IS the plugin's profile — fed straight to SemanticGenerator.
    expect(res.target.profileFn).toBe(profile as unknown as typeof res.target.profileFn);
    // #3546 — the install's group scope drives where the persisted drafts land.
    expect(res.target.connectionGroupId).toBe("warehouse");
  });

  it("carries the install's DECRYPTED config so a separate-field-credential profiler (ES) gets the tenant's creds (ADR-0017 amendment)", async () => {
    // ES holds apiKey in a SEPARATE config field, not in the url. The target must
    // carry the decrypted config (here passed through by the secrets mock) so the
    // profiler authenticates with the TENANT's apiKey, never operator ATLAS_ES_* env.
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
    const res = await loadDatasourceProfileTarget("org_1", "es");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // The decrypted connection config rides on the target (secret material —
    // internal use only).
    expect(res.target.config).toEqual({ url: "elasticsearch://es.tenant:9200", apiKey: "tenant-es-key" });
  });

  it("bigquery (non-url-shaped) resolves to ok — synthetic url + decrypted config carried (#3664)", async () => {
    // BigQuery's pool config has NO url (service-account multi-field). The seam
    // synthesizes a `bigquery://<project>` identifier so it is profilable over
    // MCP, and carries the decrypted config so the profiler authenticates with
    // the tenant's own service-account creds.
    poolConfigResult = {
      dbType: "bigquery",
      serviceAccountJson: '{"type":"service_account","project_id":"my-project"}',
      projectId: "my-project",
      schema: "analytics",
    };
    const profile = chProfiler();
    pluginConn = { dbType: "bigquery", createFromConfig: () => ({}), profile };
    internalRows = [
      {
        catalog_id: "cat_bq",
        catalog_slug: "bigquery",
        config: {
          service_account_json: '{"type":"service_account","project_id":"my-project"}',
          project_id: "my-project",
          schema: "analytics",
        },
        config_schema: [],
        group_id: null,
      },
    ];
    const res = await loadDatasourceProfileTarget("org_1", "bq");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.target.dbType).toBe("bigquery");
    // Synthetic url derived from the project — NOT empty (it would fail the gate).
    expect(res.target.url).toBe("bigquery://my-project");
    // The dataset routing hint flows as the target schema.
    expect(res.target.schema).toBe("analytics");
    // The decrypted service-account config rides on the target (tenant creds).
    expect(res.target.config).toMatchObject({ project_id: "my-project" });
  });

  it("native pg/mysql resolves WITHOUT a profileFn (SemanticGenerator profiles in-core)", async () => {
    poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "public" };
    internalRows = [
      { catalog_id: "cat_pg", catalog_slug: "postgres", config: { url: "enc:v1:…" }, config_schema: [], group_id: null },
    ];
    const res = await loadDatasourceProfileTarget("org_1", "pg");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.target.dbType).toBe("postgres");
    expect(res.target.profileFn).toBeUndefined();
  });

  it("a provisionable plugin with NO connection.profile → unsupported (lockstep with provisioning)", async () => {
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}) }; // createFromConfig but no profile
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [], group_id: null },
    ];
    const res = await loadDatasourceProfileTarget("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") {
      expect(res.dbType).toBe("clickhouse");
      expect(res.message).toContain("connection.profile");
    }
  });

  it("no registered plugin → unsupported (never a silent empty layer)", async () => {
    pluginConn = undefined;
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [], group_id: null },
    ];
    const res = await loadDatasourceProfileTarget("org_1", "ch");
    expect(res.kind).toBe("unsupported");
  });

  it("not_found for an unknown install", async () => {
    internalRows = [];
    const res = await loadDatasourceProfileTarget("org_1", "nope");
    expect(res.kind).toBe("not_found");
  });
});

describe("runSemanticProfile — plugin profileFn (#3552: entities + whitelist + draft persistence)", () => {
  it("profiles ClickHouse via the injected profileFn → persists drafts under the group + registers the whitelist", async () => {
    const profile = chProfiler();
    const outcome = await runSemanticProfile({
      url: "clickhouse://h:8443/analytics",
      dbType: "clickhouse",
      profileFn: profile,
      connectionId: "wh",
      orgId: "org_1",
      connectionGroupId: "warehouse",
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // The injected plugin profiler ran (the engine never imports ClickHouse).
    expect(profile.calls).toHaveLength(1);
    expect(profile.calls[0].url).toBe("clickhouse://h:8443/analytics");

    // Entities were generated for the profiled table.
    expect(outcome.result.entities.map((e) => e.table)).toContain("events");

    // Durably persisted as DRAFTS under the install's connection group (#3546).
    expect(outcome.persisted).not.toBeNull();
    expect(outcome.persisted?.entities).toBeGreaterThanOrEqual(1);
    // The persist seam received entity rows scoped to the group.
    const entityUpsert = upsertCalls.find((c) => c.rows.some((r) => r.entityType === "entity"));
    expect(entityUpsert).toBeDefined();
    expect(entityUpsert?.orgId).toBe("org_1");
    expect(entityUpsert?.rows.every((r) => r.connectionGroupId === "warehouse")).toBe(true);
    expect(entityUpsert?.rows.some((r) => r.name.includes("events"))).toBe(true);

    // The in-memory whitelist is populated so an in-process executeSQL is permitted.
    const tables = whitelist.getWhitelistedTables("wh");
    expect([...tables].some((t) => t.includes("events"))).toBe(true);
  });

  it("forwards the decrypted tenant config into the injected profileFn (ADR-0017 amendment)", async () => {
    // The seam carries `config` straight into SemanticGenerator.profile, which
    // forwards it into the plugin profileFn args — so a separate-field-credential
    // profiler (ES) authenticates with the tenant's own creds.
    poolConfigResult = { dbType: "elasticsearch", url: "elasticsearch://es.tenant:9200" };
    const profile = chProfiler();
    const tenantConfig = { url: "elasticsearch://es.tenant:9200", apiKey: "tenant-es-key" };
    const outcome = await runSemanticProfile({
      url: "elasticsearch://es.tenant:9200",
      dbType: "elasticsearch",
      profileFn: profile,
      config: tenantConfig,
      connectionId: "es",
      orgId: "org_1",
      connectionGroupId: null,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(profile.calls).toHaveLength(1);
    // The tenant's decrypted config reached the profiler verbatim.
    expect(profile.calls[0].config).toEqual(tenantConfig);
  });

  it("Snowflake (url-shaped) profiles via the injected profileFn too — per-type parity", async () => {
    poolConfigResult = { dbType: "snowflake", url: "snowflake://acct/db" };
    const profile = chProfiler();
    const outcome = await runSemanticProfile({
      url: "snowflake://acct/db",
      dbType: "snowflake",
      profileFn: profile,
      connectionId: "sf",
      orgId: "org_1",
      connectionGroupId: null,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(profile.calls).toHaveLength(1);
    expect(outcome.persisted?.entities).toBeGreaterThanOrEqual(1);
    // Ungrouped install → null scope on every persisted row (flat default bucket).
    const entityUpsert = upsertCalls.find((c) => c.rows.some((r) => r.entityType === "entity"));
    expect(entityUpsert?.rows.every((r) => r.connectionGroupId === null)).toBe(true);
  });

  it("no orgId → no persistence, registers the in-memory whitelist immediately", async () => {
    const profile = chProfiler();
    const outcome = await runSemanticProfile({
      url: "clickhouse://h:8443/analytics",
      dbType: "clickhouse",
      profileFn: profile,
      connectionId: "wh-ephemeral",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.persisted).toBeNull();
    expect(upsertCalls).toHaveLength(0);
    const tables = whitelist.getWhitelistedTables("wh-ephemeral");
    expect([...tables].some((t) => t.includes("events"))).toBe(true);
  });
});

// =====================================================================
// #3662 — the MCP seam must NOT coerce a missing schema to "public" for a
// plugin dbType. This mirrors the #3621 wizard `effectiveSchema` fix: "public"
// is Postgres's canonical default search-path, but it's meaningless for a
// plugin dbType (ClickHouse's default database is `default`, not `public`).
// Leaking "public" overrides the URL-embedded database and profiles zero
// objects against a nonexistent database — the exact bug class #3621 fixed,
// surviving on the sibling MCP seam.
// =====================================================================
describe("runSemanticProfile — schema default does not leak to plugin dbTypes (#3662)", () => {
  it("clickhouse with NO configured schema → the plugin profiler receives undefined, NOT \"public\"", async () => {
    const profile = chProfiler();
    const outcome = await runSemanticProfile({
      url: "clickhouse://h:8443/analytics",
      dbType: "clickhouse",
      profileFn: profile,
      connectionId: "wh",
      // no `schema` — relying on the URL-embedded database.
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(profile.calls).toHaveLength(1);
    // The bug: this would be "public", overriding the URL's `analytics` database.
    expect(profile.calls[0].schema).toBeUndefined();
  });

  it("clickhouse with an explicit schema → passed through verbatim", async () => {
    const profile = chProfiler();
    const outcome = await runSemanticProfile({
      url: "clickhouse://h:8443/analytics",
      dbType: "clickhouse",
      profileFn: profile,
      schema: "analytics",
      connectionId: "wh",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(profile.calls).toHaveLength(1);
    expect(profile.calls[0].schema).toBe("analytics");
  });
});
