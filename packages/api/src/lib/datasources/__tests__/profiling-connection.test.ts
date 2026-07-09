/**
 * Lib-layer tests for `resolveProfilingConnection` (#3657, ADR-0017
 * §Amendment(#3667), #4197) — the ONE profiler home the in-product wizard AND
 * the agent's `profileTable` tool ride.
 *
 * The guarantee: both consumers resolve the SAME live connection MCP does
 * (`resolveLiveConnection`), and introspection is a capability OF that
 * connection. There is no second profiler seam (`resolveWizardProfiler` is
 * gone), no url/config threading, no per-call native signature adaptation.
 *
 * SaaS is the primary path (workspace_plugins → resolveLiveConnection). The
 * env-var `default` / `__demo__` fast path is a self-hosted/dev BYPRODUCT, pinned
 * here so the dev demo keeps profiling.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { DatabaseObject, ProfilingResult } from "@useatlas/types";

// ── resolveLiveConnection — the shared spine, controllable per test ───
type LiveResult =
  | { kind: "ok"; connection: Record<string, unknown>; defaultSchema: string | undefined }
  | { kind: "not_found" }
  | { kind: "unsupported"; dbType: string; message: string }
  | { kind: "reconnect_required"; dbType: string; message: string };
let liveByScope: Map<string, LiveResult>;
const resolveLiveConnectionSpy = mock(async (orgId: string) => liveByScope.get(orgId) ?? { kind: "not_found" });
void mock.module("@atlas/api/lib/datasources/mcp-lifecycle", () => ({
  resolveLiveConnection: resolveLiveConnectionSpy,
}));

// native profilers — bound by the env-var byproduct path for pg/mysql.
const listPostgresObjectsSpy = mock(async (): Promise<DatabaseObject[]> => [{ name: "users", type: "table" }]);
const listMySQLObjectsSpy = mock(async (): Promise<DatabaseObject[]> => [{ name: "products", type: "table" }]);
const profilePostgresSpy = mock(async (): Promise<ProfilingResult> => ({ profiles: [], errors: [] }));
const profileMySQLSpy = mock(async (): Promise<ProfilingResult> => ({ profiles: [], errors: [] }));
void mock.module("@atlas/api/lib/profiler", () => ({
  listPostgresObjects: listPostgresObjectsSpy,
  listMySQLObjects: listMySQLObjectsSpy,
  profilePostgres: profilePostgresSpy,
  profileMySQL: profileMySQLSpy,
}));

// `DEMO_CONNECTION_ID` is a plain const — use the real module rather than a
// partial mock (mock.module requires every export be present).

// db/connection — keep detectDBType real, stub the registry pool.
const realConn = await import("@atlas/api/lib/db/connection");
const fakeRegistryConn = { query: mock(async () => ({ columns: [], rows: [] })), close: mock(async () => {}) };
let registryHas = true;
void mock.module("@atlas/api/lib/db/connection", () => ({
  ...realConn,
  connections: { get: () => fakeRegistryConn, has: () => registryHas },
}));

const { resolveProfilingConnection } = await import("../profiling-connection.js");

function liveConn(dbType: string) {
  return {
    dbType,
    connectionGroupId: null,
    query: mock(async () => ({ columns: [], rows: [] })),
    listObjects: mock(async (): Promise<DatabaseObject[]> => [{ name: "events", type: "table" }]),
    profile: mock(async (): Promise<ProfilingResult> => ({ profiles: [], errors: [] })),
    close: mock(async () => {}),
  };
}

beforeEach(() => {
  liveByScope = new Map();
  registryHas = true;
  resolveLiveConnectionSpy.mockClear();
  listPostgresObjectsSpy.mockClear();
  listMySQLObjectsSpy.mockClear();
  profilePostgresSpy.mockClear();
  profileMySQLSpy.mockClear();
  delete process.env.ATLAS_DATASOURCE_URL;
});

describe("resolveProfilingConnection — SaaS primary (resolveLiveConnection)", () => {
  it("ok: returns the resolved live connection + dbType + effective schema", async () => {
    const connection = liveConn("clickhouse");
    liveByScope.set("org_1", { kind: "ok", connection, defaultSchema: "analytics" });

    const ctx = await resolveProfilingConnection("ch_install", "org_1");
    expect(ctx.kind).toBe("ok");
    if (ctx.kind !== "ok") return;
    // The SAME connection the shared resolver returned — no second seam.
    expect(ctx.connection).toBe(connection as unknown as typeof ctx.connection);
    expect(ctx.dbType).toBe("clickhouse");
    // Plugin dbType: configured schema passes through (no literal "public").
    expect(ctx.querySchema).toBe("analytics");
  });

  it("ok postgres with no configured schema → querySchema defaults to public", async () => {
    liveByScope.set("org_1", { kind: "ok", connection: liveConn("postgres"), defaultSchema: undefined });
    const ctx = await resolveProfilingConnection("pg_install", "org_1");
    expect(ctx.kind === "ok" && ctx.querySchema).toBe("public");
  });

  it("unsupported → unsupported (actionable message passed through)", async () => {
    liveByScope.set("org_1", { kind: "unsupported", dbType: "weird", message: "no plugin" });
    const ctx = await resolveProfilingConnection("x", "org_1");
    expect(ctx.kind).toBe("unsupported");
    if (ctx.kind === "unsupported") expect(ctx.message).toBe("no plugin");
  });

  it("reconnect_required → reconnect_required (OAuth token stale)", async () => {
    liveByScope.set("org_1", { kind: "reconnect_required", dbType: "salesforce", message: "reconnect it" });
    const ctx = await resolveProfilingConnection("sf", "org_1");
    expect(ctx.kind).toBe("reconnect_required");
  });

  it("workspace scope is tried before the global config row", async () => {
    liveByScope.set("__global__", { kind: "ok", connection: liveConn("postgres"), defaultSchema: null as unknown as undefined });
    // Nothing for org_1 → falls back to __global__.
    const ctx = await resolveProfilingConnection("pg", "org_1");
    expect(ctx.kind).toBe("ok");
    expect(resolveLiveConnectionSpy).toHaveBeenNthCalledWith(1, "org_1", "pg");
    expect(resolveLiveConnectionSpy).toHaveBeenNthCalledWith(2, "__global__", "pg");
  });

  it("not_found in every scope and not an env-var id → not_found", async () => {
    const ctx = await resolveProfilingConnection("missing", "org_1");
    expect(ctx.kind).toBe("not_found");
  });
});

describe("resolveProfilingConnection — env-var byproduct (self-hosted/dev)", () => {
  it("default + ATLAS_DATASOURCE_URL (postgres) → native live connection, schema public", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://h/db";
    const ctx = await resolveProfilingConnection("default", null);
    expect(ctx.kind).toBe("ok");
    if (ctx.kind !== "ok") return;
    expect(ctx.dbType).toBe("postgres");
    expect(ctx.querySchema).toBe("public");
    await ctx.connection.listObjects({ schema: "public" });
    expect(listPostgresObjectsSpy).toHaveBeenCalledTimes(1);
    await ctx.connection.profile({ selectedTables: ["users"] });
    expect(profilePostgresSpy).toHaveBeenCalledTimes(1);
  });

  it("__demo__ + ATLAS_DATASOURCE_URL (mysql) → native live connection, schema undefined", async () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://h/db";
    const ctx = await resolveProfilingConnection("__demo__", null);
    expect(ctx.kind).toBe("ok");
    if (ctx.kind !== "ok") return;
    expect(ctx.dbType).toBe("mysql");
    expect(ctx.querySchema).toBeUndefined();
    await ctx.connection.listObjects();
    expect(listMySQLObjectsSpy).toHaveBeenCalledTimes(1);
  });

  it("non-pg/mysql env URL → unsupported (core detectDBType supports pg/mysql only)", async () => {
    process.env.ATLAS_DATASOURCE_URL = "clickhouse://h/db";
    const ctx = await resolveProfilingConnection("default", null);
    // Env-var is native-only by construction; a plugin datasource installs via
    // a workspace_plugins row (the SaaS path), not ATLAS_DATASOURCE_URL.
    expect(ctx.kind).toBe("unsupported");
  });

  it("no ATLAS_DATASOURCE_URL → not_found for default", async () => {
    const ctx = await resolveProfilingConnection("default", "org_1");
    expect(ctx.kind).toBe("not_found");
  });

  it("gated on registry presence: not registered → not_found even with the env URL set", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://h/db";
    registryHas = false;
    const ctx = await resolveProfilingConnection("default", null);
    expect(ctx.kind).toBe("not_found");
  });

  it("other underscore-prefixed ids are never env-var profilable", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://h/db";
    const ctx = await resolveProfilingConnection("draft_test", "org_1");
    expect(ctx.kind).toBe("not_found");
  });
});
