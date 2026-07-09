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
import { IntegrationReconnectRequiredError } from "@atlas/api/lib/effect/errors";

// ── internal DB (loadDatasourceProfileTarget row + persist gate) ──────
const realInternal = await import("@atlas/api/lib/db/internal");
let internalRows: Array<Record<string, unknown>> = [];
const mockInternalQuery = mock<(...a: unknown[]) => Promise<unknown>>(async () => internalRows);
const mockHasInternalDB = mock<() => boolean>(() => true);
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mockHasInternalDB,
}));

// `mcp-lifecycle` imports the connection registry at module load — mock it so no
// real pool spins. `runSemanticProfile`'s whitelist registration goes through the
// real `whitelist` module (not this mock).
void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ connections: { register: mock(() => {}) } }),
);

// catalogSlug → dbType + the pool config the profile target reads its url from.
let poolConfigResult: unknown = { dbType: "clickhouse", url: "clickhouse://h:8443/analytics" };
void mock.module("@atlas/api/lib/db/datasource-pool-resolver", () => ({
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
void mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  findDatasourcePluginConnection: mock(async () => pluginConn),
  isHandlerManagedDatasourceDbType: (dbType: string) => dbType === "salesforce",
  probePluginDatasourceConnection: mock(async () => ({ ok: true })),
  probeNativeDatasourceConnection: mock(async () => ({ ok: true })),
  registerDatasourceInstall: mock(async () => true),
  unregisterDatasourceInstall: mock(() => true),
}));

// Secrets passthrough — the profile target decrypts the row config.
const realSecrets = await import("@atlas/api/lib/plugins/secrets");
void mock.module("@atlas/api/lib/plugins/secrets", () => ({
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
void mock.module("@atlas/api/lib/semantic/entities", () => ({
  ...realEntities,
  bulkUpsertEntities: mock(async (orgId: string, rows: UpsertRow[]) => {
    upsertCalls.push({ orgId, rows });
    return rows.length; // every row landed → success
  }),
}));

const { resolveLiveConnection, profileLiveDatasource } = await import("../mcp-lifecycle.js");
const whitelist = await import("@atlas/api/lib/semantic/whitelist");

beforeEach(() => {
  internalRows = [];
  upsertCalls = [];
  mockHasInternalDB.mockReturnValue(true);
  poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h:8443/analytics" };
  pluginConn = pluginWithBuiltProfile("clickhouse", liveProfileSpy());
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

// A plugin whose createFromConfig returns a BUILT connection carrying the
// relocated introspection (#3667) — `profile`/`listObjects` are capabilities of
// the built connection, bound to the creds createFromConfig resolved (so the
// host never re-resolves auth / passes a url). The profile spy records the
// bound options it receives (schema only — no url/config).
function pluginWithBuiltProfile(dbType: string, profile: ReturnType<typeof liveProfileSpy>) {
  return {
    dbType,
    createFromConfig: () => ({
      query: async () => ({ columns: [], rows: [] }),
      close: async () => {},
      listObjects: async () => [],
      profile,
    }),
  };
}

// A plugin that CAPTURES the config `createFromConfig` is called with + the
// close() invocations on the built connection — the #2850 per-tenant-creds seam
// (decrypted tenant config flows INTO createFromConfig) and the no-leak
// discipline are otherwise untested at the host level (the relocated
// introspection binds whatever config createFromConfig receives).
function capturingPlugin(dbType: string, opts: { withProfile: boolean } = { withProfile: true }) {
  const createCalls: Array<Readonly<Record<string, unknown>>> = [];
  const close = mock(async () => {});
  return {
    createCalls,
    close,
    plugin: {
      dbType,
      createFromConfig: (cfg: Readonly<Record<string, unknown>>) => {
        createCalls.push(cfg);
        return {
          query: async () => ({ columns: [], rows: [] }),
          close,
          listObjects: async () => [],
          ...(opts.withProfile ? { profile: liveProfileSpy() } : {}),
        };
      },
    },
  };
}

describe("resolveLiveConnection — plugin types (#3667)", () => {
  it("resolves a plugin clickhouse install to a live connection carrying the group + the built-connection's profile", async () => {
    const profile = liveProfileSpy();
    pluginConn = pluginWithBuiltProfile("clickhouse", profile);
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: { url: "enc:v1:…" }, config_schema: [], group_id: "warehouse" },
    ];
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.connection.dbType).toBe("clickhouse");
    expect(res.connection.connectionGroupId).toBe("warehouse");
    expect(typeof res.connection.profile).toBe("function");
    // Profiling consumes the built connection's bound profile — no url is passed
    // (the connection is already authenticated); the schema passes through.
    await res.connection.profile({ schema: "analytics" });
    expect(profile.calls).toHaveLength(1);
    expect(profile.calls[0].schema).toBe("analytics");
  });

  it("bigquery (non-url-shaped) resolves to ok — the URL-shape gate is GONE (#3664/#3667)", async () => {
    // BigQuery's pool config has NO url (service-account multi-field). With the
    // gate deleted, the unified resolver builds a profilable live connection whose
    // creds are bound at createFromConfig — no synthetic url, no fail-closed gate.
    poolConfigResult = { dbType: "bigquery", projectId: "my-project", schema: "analytics" };
    const profile = liveProfileSpy();
    pluginConn = pluginWithBuiltProfile("bigquery", profile);
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
    expect(profile.calls).toHaveLength(1);
    // The pool config's dataset (`schema`) is the connection's default scope.
    expect(profile.calls[0].schema).toBe("analytics");
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

  it("a provisionable plugin whose BUILT connection has NO profile → unsupported (never a silent empty layer)", async () => {
    // createFromConfig builds a query-only connection (no relocated introspection).
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }) };
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

  // #2850 — the per-tenant-creds seam: the resolver MUST pass the DECRYPTED
  // tenant config into createFromConfig (the relocated profile/listObjects bind
  // whatever creds it receives). The old loadDatasourceProfileTarget test pinned
  // this via `target.config`; that assertion was lost in the relocation.
  it("passes the install's DECRYPTED config into createFromConfig (tenant creds bound at build, #2850)", async () => {
    const cap = capturingPlugin("elasticsearch");
    pluginConn = cap.plugin;
    poolConfigResult = { dbType: "elasticsearch", url: "elasticsearch://es.tenant:9200" };
    // decryptSecretFields is mocked passthrough, so the row config IS the decrypted config.
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
    expect(cap.createCalls).toHaveLength(1);
    // The tenant's own decrypted creds (apiKey) reach createFromConfig — never {}
    // or the still-encrypted row, which would force an operator-env fallback.
    expect(cap.createCalls[0]).toEqual({ url: "elasticsearch://es.tenant:9200", apiKey: "tenant-es-key" });
  });

  // No-leak discipline: the unsupported early-return must close the built
  // (lazy) connection, or a query-only plugin leaks one per profile attempt.
  it("closes the built connection when it exposes no profile (no leak on the unsupported branch)", async () => {
    const cap = capturingPlugin("clickhouse", { withProfile: false });
    pluginConn = cap.plugin;
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: { url: "enc:v1:…" }, config_schema: [], group_id: null },
    ];
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    expect(cap.close).toHaveBeenCalledTimes(1);
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

  // #3667 — an OAuth token (Salesforce) revoked MID-profile throws
  // IntegrationReconnectRequiredError from inside the connection's profile()
  // (its first API call lands here, not at resolution). It must map to the
  // distinct `reconnect_required` outcome, NOT a generic `error`/"Profiling
  // failed" — so the agent gets the actionable reconnect prompt.
  it("a mid-profile IntegrationReconnectRequiredError → reconnect_required (not a generic error)", async () => {
    const connection: LiveDatasourceConnection = {
      dbType: "salesforce" as LiveDatasourceConnection["dbType"],
      connectionGroupId: null,
      query: async () => ({ columns: [], rows: [] }),
      listObjects: async () => [],
      profile: async () => {
        throw new IntegrationReconnectRequiredError({
          message: "Salesforce session could not be refreshed (invalid_grant).",
          workspaceId: "org_1",
          platform: "salesforce",
          upstreamError: "invalid_grant",
        });
      },
      close: async () => {},
    };
    const outcome = await profileLiveDatasource({ connection, connectionId: "sf", orgId: "org_1" });
    expect(outcome.kind).toBe("reconnect_required");
    if (outcome.kind === "reconnect_required") {
      expect(outcome.dbType).toBe("salesforce");
      expect(outcome.message).toContain("reconnected");
    }
  });
});
