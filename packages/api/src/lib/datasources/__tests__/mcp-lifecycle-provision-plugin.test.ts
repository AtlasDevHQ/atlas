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
    throw new Error(`unknown slug ${slug}`);
  },
  resolveDatasourcePoolConfig: mock(() => ({ dbType: "clickhouse", url: "x" })),
  BUILTIN_DATASOURCE_CATALOG_SLUGS: ["postgres", "mysql", "clickhouse", "snowflake"],
}));

// The plugin test-connect seam — fully controllable per test.
let pluginConn: { dbType: string; createFromConfig?: unknown } | undefined;
let probeOutcome:
  | { ok: true }
  | { ok: false; reason: "no_plugin" | "connect_failed"; message: string } = { ok: true };
const probeSpy = mock<(dbType: string, cfg: Record<string, unknown>) => Promise<unknown>>(
  async () => probeOutcome,
);
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  findDatasourcePluginConnection: mock(async () => pluginConn),
  probePluginDatasourceConnection: probeSpy,
  registerDatasourceInstall: mock(async () => true),
  unregisterDatasourceInstall: mock(() => true),
}));

// Secrets passthrough (loadDatasourceProfileTarget imports these too).
mock.module("@atlas/api/lib/plugins/secrets", () => ({
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

const { resolveProvisionCapability, provisionDatasource } = await import("../mcp-lifecycle.js");

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

describe("provisionDatasource — plugin path", () => {
  it("probes via createFromConfig (not the native registry) and persists a draft on success", async () => {
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "clickhouse",
      installId: "wh",
      url: CH_SECRET_URL,
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
      url: CH_SECRET_URL,
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
      url: CH_SECRET_URL,
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
      url: CH_SECRET_URL,
    });
    expect(outcome.kind).toBe("unsupported");
    expect(probeSpy).not.toHaveBeenCalled();
    expect(installDatasourceSpy).not.toHaveBeenCalled();
  });
});
