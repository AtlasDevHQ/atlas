/**
 * Lib-layer tests for the PLUGIN-managed half of MCP datasource provisioning
 * (#3547): the capability-derived gate (`resolveProvisionCapability`) and the
 * plugin-aware validate-before-persist pre-flight in `provisionDatasource`.
 *
 * The native pg/mysql path (ephemeral `connections.register` → `healthCheck`
 * probe) is covered by `mcp-lifecycle.test.ts`. Here the candidate is a
 * plugin-managed SQL type (ClickHouse / Snowflake), whose pre-flight goes
 * through `probePluginDatasourceConnection` (`createFromConfig` → `SELECT 1` →
 * close) instead — and which is gated by whether a plugin implementing
 * `createFromConfig` is registered for the dbType.
 *
 * Two invariants the MCP `create_datasource` tool relies on:
 *   1. A type with no registered plugin resolves to `unsupported` — never a
 *      throw, never a persist.
 *   2. A failed plugin probe persists NOTHING and returns a credential-scrubbed
 *      `health_error` (the secret URL never rides the message).
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { createConnectionMock } from "../../../__mocks__/connection";

// ── internal DB (duplicate-id check) ──────────────────────────────────
// Spread the real module so EVERY export (InternalDB Tag, etc.) stays present —
// the mocked workspace-installer reshapes the import graph such that a real
// module named-imports `InternalDB`, so a partial mock would break linking.
// Only the two I/O entry points this suite drives are overridden.
const realInternal = await import("@atlas/api/lib/db/internal");
let internalRows: Array<Record<string, unknown>> = [];
const mockInternalQuery = mock<(...a: unknown[]) => Promise<unknown>>(async () => internalRows);
const mockHasInternalDB = mock<() => boolean>(() => true);
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mockHasInternalDB,
}));

// `provisionDatasource`'s plugin path never touches the ConnectionRegistry, but
// `mcp-lifecycle` imports it at module load — mock it so no real pg pool spins.
const registerSpy = mock<(id: string, cfg: unknown) => void>(() => {});
mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ connections: { register: registerSpy } }),
);

// catalogSlug → dbType: clickhouse maps 1:1; an unknown slug throws (the real
// resolver's contract), which `resolveProvisionCapability` turns into `unsupported`.
mock.module("@atlas/api/lib/db/datasource-pool-resolver", () => ({
  catalogSlugToDbType: (slug: string) => {
    if (slug === "clickhouse") return "clickhouse";
    if (slug === "snowflake") return "snowflake";
    if (slug === "bigquery") return "bigquery";
    throw new Error(`unknown slug ${slug}`);
  },
  resolveDatasourcePoolConfig: mock(() => ({ dbType: "clickhouse", url: "x" })),
  BUILTIN_DATASOURCE_CATALOG_SLUGS: ["postgres", "mysql", "clickhouse", "snowflake", "bigquery"],
}));

// The plugin test-connect seam — fully controllable per test.
let pluginConn:
  | { dbType: string; createFromConfig?: unknown; profile?: unknown; listObjects?: unknown }
  | undefined;
let probeOutcome:
  | { ok: true }
  | { ok: false; reason: "no_plugin" | "connect_failed"; message: string } = { ok: true };
const probeSpy = mock<(dbType: string, cfg: Record<string, unknown>) => Promise<unknown>>(
  async () => probeOutcome,
);
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  findDatasourcePluginConnection: mock(async () => pluginConn),
  isHandlerManagedDatasourceDbType: (dbType: string) => dbType === "salesforce",
  probePluginDatasourceConnection: probeSpy,
  // Native probe seam (#3605) — imported by mcp-lifecycle but never reached on
  // the plugin provision path under test; stubbed so the import resolves.
  probeNativeDatasourceConnection: mock(async () => ({ ok: true })),
  registerDatasourceInstall: mock(async () => true),
  unregisterDatasourceInstall: mock(() => true),
}));

// Secrets passthrough (loadDatasourceProfileTarget imports these too). Spread the
// real module so the form-install handler graph (pulled transitively via the
// REST install seam) keeps every named export it imports.
const realSecrets = await import("@atlas/api/lib/plugins/secrets");
mock.module("@atlas/api/lib/plugins/secrets", () => ({
  ...realSecrets,
  parseConfigSchema: () => ({ state: "parsed", fields: [] }),
  decryptSecretFields: (c: Record<string, unknown>) => c,
  encryptSecretFields: (c: Record<string, unknown>) => c,
  maskSecretFields: (c: Record<string, unknown>) => c,
}));

// Installer seam — a fake `WorkspaceInstaller` Layer so the happy path persists
// without a real DB. `installDatasource` returns a masked install row.
const installDatasourceSpy = mock((_org: unknown, _slug: string, _opts: unknown) =>
  Effect.succeed({
    installId: "wh",
    dbType: "clickhouse",
    status: "draft" as const,
    maskedUrl: "clickhouse://***@h:8443/db",
    description: undefined,
    schema: undefined,
    groupId: null,
  }),
);
const InstallerTag = Context.GenericTag<{ installDatasource: typeof installDatasourceSpy }>(
  "WorkspaceInstaller",
);
mock.module("@atlas/api/lib/effect/workspace-installer", () => ({
  WorkspaceInstaller: InstallerTag,
  WorkspaceInstallerLive: Layer.succeed(InstallerTag, { installDatasource: installDatasourceSpy }),
  mapInstallError: (e: { message?: string }) => ({
    status: 400 as const,
    code: "bad_request",
    message: e?.message ?? "install error",
    body: {},
  }),
}));

const {
  resolveProvisionCapability,
  resolveProfileCapabilityByDbType,
  provisionDatasource,
} = await import("../mcp-lifecycle.js");
const { SemanticGenerator, SemanticGeneratorLive } = await import(
  "@atlas/api/lib/effect/semantic-generator"
);

const CH_SECRET_URL = "clickhouse://admin:topsecret@warehouse.internal:8443/analytics";

beforeEach(() => {
  internalRows = [];
  mockHasInternalDB.mockReturnValue(true);
  registerSpy.mockClear();
  probeSpy.mockClear();
  installDatasourceSpy.mockClear();
  probeOutcome = { ok: true };
  pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}) };
});

describe("resolveProvisionCapability", () => {
  it("native pg/mysql → kind:native", async () => {
    expect(await resolveProvisionCapability("postgres")).toEqual({ kind: "native", dbType: "postgres" });
    expect(await resolveProvisionCapability("mysql")).toEqual({ kind: "native", dbType: "mysql" });
  });

  it("a plugin type with a registered createFromConfig → kind:plugin", async () => {
    const cap = await resolveProvisionCapability("clickhouse");
    expect(cap).toEqual({ kind: "plugin", dbType: "clickhouse" });
  });

  it("a plugin type with NO registered plugin → unsupported (not a throw)", async () => {
    pluginConn = undefined;
    const cap = await resolveProvisionCapability("clickhouse");
    expect(cap.kind).toBe("unsupported");
  });

  it("an unknown catalog slug → unsupported (the resolver throw is swallowed)", async () => {
    const cap = await resolveProvisionCapability("mystery-db");
    expect(cap.kind).toBe("unsupported");
  });
});

describe("resolveProfileCapabilityByDbType (#3620 / #3667 — ADR-0017)", () => {
  it("native pg/mysql → kind:native (profiled in-core)", async () => {
    expect(await resolveProfileCapabilityByDbType("postgres")).toEqual({ kind: "native", dbType: "postgres" });
    expect(await resolveProfileCapabilityByDbType("mysql")).toEqual({ kind: "native", dbType: "mysql" });
  });

  it("a plugin that builds a connection (createFromConfig) → kind:plugin (profilable)", async () => {
    // #3667 — profilability is connectability: introspection rides the BUILT
    // connection, so the proxy checks createFromConfig (not a namespace profile).
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}) };
    const cap = await resolveProfileCapabilityByDbType("clickhouse");
    expect(cap.kind).toBe("plugin");
    if (cap.kind === "plugin") expect(cap.dbType).toBe("clickhouse");
  });

  it("stays in lockstep with provisioning: createFromConfig present → BOTH plugin", async () => {
    pluginConn = { dbType: "clickhouse", createFromConfig: () => ({}) };
    expect((await resolveProvisionCapability("clickhouse")).kind).toBe("plugin");
    expect((await resolveProfileCapabilityByDbType("clickhouse")).kind).toBe("plugin");
  });

  it("no registered plugin → unsupported (never a silent empty result)", async () => {
    pluginConn = undefined;
    const cap = await resolveProfileCapabilityByDbType("clickhouse");
    expect(cap.kind).toBe("unsupported");
    if (cap.kind === "unsupported") expect(cap.dbType).toBe("clickhouse");
  });

  it("an unknown dbType with no registered plugin → unsupported", async () => {
    pluginConn = undefined;
    const cap = await resolveProfileCapabilityByDbType("mystery-db");
    expect(cap.kind).toBe("unsupported");
  });

  it("an injected profiler flows through SemanticGenerator.profile (the injection seam)", async () => {
    // The host's profiler seam: a profiler injected at SemanticGenerator's
    // injection point produces analyzed profiles — without the engine knowing
    // anything about ClickHouse. (profileLiveDatasource feeds it a thin adapter
    // over the resolved live connection's bound profile().)
    const chResult = {
      profiles: [
        {
          table_name: "events",
          object_type: "table" as const,
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
    const profile = mock(async () => chResult);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SemanticGenerator;
        return yield* svc.profile({
          dbType: "clickhouse",
          url: "clickhouse://h:8123/db",
          profileFn: profile,
        });
      }).pipe(Effect.provide(SemanticGeneratorLive)),
    );

    expect(profile).toHaveBeenCalledTimes(1);
    expect(result.profiles.map((p) => p.table_name)).toEqual(["events"]);
    expect(result.errors).toEqual([]);
  });
});

describe("provisionDatasource — plugin path", () => {
  it("probes via createFromConfig (not the native registry) and persists a draft on success", async () => {
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "clickhouse",
      installId: "wh",
      config: { url: CH_SECRET_URL },
      secretKeys: ["url"],
    });
    // Plugin probe ran with the exact config the installer will persist.
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy.mock.calls[0][0]).toBe("clickhouse");
    expect(probeSpy.mock.calls[0][1]).toEqual({ url: CH_SECRET_URL });
    // Native pre-flight registry probe was NOT used.
    expect(registerSpy).not.toHaveBeenCalled();
    // Persisted as a draft via the installer.
    expect(installDatasourceSpy).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.value.installId).toBe("wh");
  });

  it("a failed plugin probe persists NOTHING and scrubs the secret URL", async () => {
    probeOutcome = {
      ok: false,
      reason: "connect_failed",
      message: `getaddrinfo ENOTFOUND for ${CH_SECRET_URL}`,
    };
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "clickhouse",
      installId: "wh",
      config: { url: CH_SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("health_error");
    expect(installDatasourceSpy).not.toHaveBeenCalled();
    if (outcome.kind === "health_error") {
      expect(outcome.message).not.toContain(CH_SECRET_URL);
      expect(outcome.message).not.toContain("topsecret");
      expect(outcome.message).toContain("[redacted]");
    }
  });

  it("rejects a duplicate install id (conflict) before probing", async () => {
    internalRows = [{ catalog_slug: "clickhouse" }];
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "clickhouse",
      installId: "wh",
      config: { url: CH_SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.status).toBe(409);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("an unsupported (no-plugin) type returns unsupported without probing", async () => {
    pluginConn = undefined;
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "clickhouse",
      installId: "wh",
      config: { url: CH_SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("unsupported");
    expect(probeSpy).not.toHaveBeenCalled();
    expect(installDatasourceSpy).not.toHaveBeenCalled();
  });
});

// #3547 AC4 — provision success + probe-failure rollback + credential scrub for
// EACH added plugin type. ClickHouse is covered above; Snowflake (url-shaped)
// and BigQuery (multi-field: service_account_json + project_id) below, so the
// per-type matrix is literal, not just generic.
describe("provisionDatasource — Snowflake (url-shaped)", () => {
  const SF_SECRET_URL = "snowflake://user:topsecret@acct.snowflakecomputing.com/db";

  beforeEach(() => {
    pluginConn = { dbType: "snowflake", createFromConfig: () => ({}) };
  });

  it("probes via createFromConfig and persists a draft on success", async () => {
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "snowflake",
      installId: "sf",
      config: { url: SF_SECRET_URL },
      secretKeys: ["url"],
    });
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy.mock.calls[0][0]).toBe("snowflake");
    expect(probeSpy.mock.calls[0][1]).toEqual({ url: SF_SECRET_URL });
    expect(registerSpy).not.toHaveBeenCalled();
    expect(installDatasourceSpy).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("ok");
  });

  it("a failed probe persists NOTHING and scrubs the secret URL", async () => {
    probeOutcome = { ok: false, reason: "connect_failed", message: `auth failed for ${SF_SECRET_URL}` };
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "snowflake",
      installId: "sf",
      config: { url: SF_SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("health_error");
    expect(installDatasourceSpy).not.toHaveBeenCalled();
    if (outcome.kind === "health_error") {
      expect(outcome.message).not.toContain(SF_SECRET_URL);
      expect(outcome.message).not.toContain("topsecret");
      expect(outcome.message).toContain("[redacted]");
    }
  });
});

describe("provisionDatasource — BigQuery (multi-field credential)", () => {
  const SA_JSON = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----SUPERSECRETKEYMATERIAL-----END PRIVATE KEY-----"}';
  const BQ_CONFIG = { service_account_json: SA_JSON, project_id: "my-gcp-project" };

  beforeEach(() => {
    pluginConn = { dbType: "bigquery", createFromConfig: () => ({}) };
  });

  it("probes with the FULL multi-field config and persists a draft on success", async () => {
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "bigquery",
      installId: "bq",
      config: { ...BQ_CONFIG },
      secretKeys: ["service_account_json"],
    });
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy.mock.calls[0][0]).toBe("bigquery");
    // Both the secret JSON and the non-secret project_id reach the probe.
    expect(probeSpy.mock.calls[0][1]).toEqual(BQ_CONFIG);
    expect(installDatasourceSpy).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("ok");
  });

  it("a failed probe persists NOTHING and scrubs the service_account_json key material", async () => {
    probeOutcome = {
      ok: false,
      reason: "connect_failed",
      message: `invalid credentials: ${SA_JSON}`,
    };
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "bigquery",
      installId: "bq",
      config: { ...BQ_CONFIG },
      secretKeys: ["service_account_json"],
    });
    expect(outcome.kind).toBe("health_error");
    expect(installDatasourceSpy).not.toHaveBeenCalled();
    if (outcome.kind === "health_error") {
      expect(outcome.message).not.toContain(SA_JSON);
      expect(outcome.message).not.toContain("SUPERSECRETKEYMATERIAL");
      expect(outcome.message).toContain("[redacted]");
    }
  });
});
