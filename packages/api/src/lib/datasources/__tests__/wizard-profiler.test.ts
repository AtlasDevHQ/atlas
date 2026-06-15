/**
 * Lib-layer tests for `resolveWizardProfiler` (#3621 / ADR-0017) — the
 * profiler-seam resolution the in-product onboarding wizard consumes.
 *
 * Two halves to pin:
 *   1. Native pg/mysql resolve to the in-core fast path (the `profilePostgres` /
 *      `profileMySQL` + `listPostgresObjects` / `listMySQLObjects` functions),
 *      normalized to the single-options shape — behavior unchanged from the
 *      pre-#3621 hard-coded switch.
 *   2. Any other dbType resolves through the SHARED capability resolver
 *      (`resolveProfileCapabilityByDbType`) + the SAME plugin lookup
 *      (`findDatasourcePluginConnection`): a plugin implementing BOTH
 *      `listObjects` and `profile` is `ok`; one missing either half is the
 *      actionable `unsupported` state (never a silent skip).
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";

// Native profiler functions — spied so we can assert the wizard dispatches to
// them for pg/mysql and threads the options through to the positional signatures.
const listPostgresObjectsSpy = mock<(url: string, schema?: string, logger?: unknown) => Promise<{ name: string; type: string }[]>>(
  async () => [{ name: "users", type: "table" }],
);
const listMySQLObjectsSpy = mock<(url: string, logger?: unknown) => Promise<{ name: string; type: string }[]>>(
  async () => [{ name: "products", type: "table" }],
);
const profilePostgresSpy = mock<(...args: unknown[]) => Promise<{ profiles: unknown[]; errors: unknown[] }>>(
  async () => ({ profiles: [], errors: [] }),
);
const profileMySQLSpy = mock<(...args: unknown[]) => Promise<{ profiles: unknown[]; errors: unknown[] }>>(
  async () => ({ profiles: [], errors: [] }),
);
mock.module("@atlas/api/lib/profiler", () => ({
  listPostgresObjects: listPostgresObjectsSpy,
  listMySQLObjects: listMySQLObjectsSpy,
  profilePostgres: profilePostgresSpy,
  profileMySQL: profileMySQLSpy,
}));

// Plugin capability resolver — controllable per test.
let capability:
  | { kind: "native"; dbType: string }
  | { kind: "plugin"; dbType: string; profileFn: unknown }
  | { kind: "unsupported"; dbType: string; message: string };
const resolveProfileCapabilityByDbTypeSpy = mock(async () => capability);
mock.module("@atlas/api/lib/datasources/mcp-lifecycle", () => ({
  resolveProfileCapabilityByDbType: resolveProfileCapabilityByDbTypeSpy,
}));

// Plugin registry lookup — controllable per test (the `listObjects` half).
let pluginConn: { dbType: string; listObjects?: unknown; profile?: unknown } | undefined;
const findDatasourcePluginConnectionSpy = mock(async () => pluginConn);
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  findDatasourcePluginConnection: findDatasourcePluginConnectionSpy,
}));

const { resolveWizardProfiler } = await import("../wizard-profiler.js");

beforeEach(() => {
  listPostgresObjectsSpy.mockClear();
  listMySQLObjectsSpy.mockClear();
  profilePostgresSpy.mockClear();
  profileMySQLSpy.mockClear();
  resolveProfileCapabilityByDbTypeSpy.mockClear();
  findDatasourcePluginConnectionSpy.mockClear();
  capability = { kind: "unsupported", dbType: "clickhouse", message: "no plugin" };
  pluginConn = undefined;
});

describe("resolveWizardProfiler — native dbTypes", () => {
  it("postgres → ok, dispatching to the native list/profile functions", async () => {
    const cap = await resolveWizardProfiler("postgres");
    expect(cap.kind).toBe("ok");
    if (cap.kind !== "ok") return;

    await cap.listObjects({ url: "postgresql://h/db", schema: "public" });
    expect(listPostgresObjectsSpy).toHaveBeenCalledTimes(1);
    // schema is threaded to the positional pg signature (2nd positional arg).
    expect(listPostgresObjectsSpy.mock.calls[0][1]).toBe("public");

    await cap.profile({ url: "postgresql://h/db", schema: "public", selectedTables: ["users"] });
    expect(profilePostgresSpy).toHaveBeenCalledTimes(1);
    // The plugin seam was never consulted for a native type.
    expect(resolveProfileCapabilityByDbTypeSpy).not.toHaveBeenCalled();
  });

  it("mysql → ok, dispatching to the native MySQL functions", async () => {
    const cap = await resolveWizardProfiler("mysql");
    expect(cap.kind).toBe("ok");
    if (cap.kind !== "ok") return;
    await cap.listObjects({ url: "mysql://h/db", schema: "public" });
    expect(listMySQLObjectsSpy).toHaveBeenCalledTimes(1);
    await cap.profile({ url: "mysql://h/db", schema: "public", selectedTables: ["products"] });
    expect(profileMySQLSpy).toHaveBeenCalledTimes(1);
    expect(resolveProfileCapabilityByDbTypeSpy).not.toHaveBeenCalled();
  });
});

describe("resolveWizardProfiler — plugin dbTypes", () => {
  it("a plugin implementing BOTH listObjects and profile → ok, carrying both", async () => {
    const profileFn = mock(async () => ({ profiles: [], errors: [] }));
    const listObjects = mock(async () => [{ name: "events", type: "table" }]);
    capability = { kind: "plugin", dbType: "clickhouse", profileFn };
    pluginConn = { dbType: "clickhouse", listObjects, profile: profileFn };

    const cap = await resolveWizardProfiler("clickhouse");
    expect(cap.kind).toBe("ok");
    if (cap.kind !== "ok") return;
    // The profile half is the SAME fn the shared capability resolver returned.
    expect(cap.profile).toBe(profileFn as unknown as typeof cap.profile);
    // listObjects resolves off the same plugin connection.
    await cap.listObjects({ url: "clickhouse://h/db", schema: "default" });
    expect(listObjects).toHaveBeenCalledTimes(1);
  });

  it("a plugin that profiles but has NO listObjects → unsupported (table picker can't run)", async () => {
    const profileFn = mock(async () => ({ profiles: [], errors: [] }));
    capability = { kind: "plugin", dbType: "clickhouse", profileFn };
    pluginConn = { dbType: "clickhouse", profile: profileFn }; // no listObjects

    const cap = await resolveWizardProfiler("clickhouse");
    expect(cap.kind).toBe("unsupported");
    if (cap.kind === "unsupported") {
      expect(cap.message).toContain("connection.listObjects");
    }
  });

  it("no plugin implementing profile → unsupported, surfacing the resolver's actionable message", async () => {
    capability = {
      kind: "unsupported",
      dbType: "clickhouse",
      message: "Datasource type \"clickhouse\" cannot be profiled in this deployment.",
    };
    const cap = await resolveWizardProfiler("clickhouse");
    expect(cap.kind).toBe("unsupported");
    if (cap.kind === "unsupported") {
      expect(cap.message).toContain("clickhouse");
    }
    // The shared resolver was consulted — one lookup, in lockstep with provisioning.
    expect(resolveProfileCapabilityByDbTypeSpy).toHaveBeenCalledWith("clickhouse");
  });
});
