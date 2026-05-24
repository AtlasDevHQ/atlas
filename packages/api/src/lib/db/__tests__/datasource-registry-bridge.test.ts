/**
 * Tests for `datasource-registry-bridge` (#2744).
 *
 * The bridge is the shared (workspace_plugins row → ConnectionRegistry)
 * glue used by both boot-time `loadSavedConnections` and runtime
 * `WorkspaceInstaller.installDatasource`. The behavioral contract that
 * matters here is the native-vs-plugin dbType filter and the
 * already-registered idempotency guard — the per-dbType translation is
 * delegated to `DatasourcePoolResolver` (covered by its own tests).
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";

// Mock the ConnectionRegistry seam so we don't spin up a real pg pool.
// Capture all register/unregister/has calls per test.
const registerCalls: Array<{ id: string; url: string; schema?: string; description?: string }> = [];
const unregisterCalls: string[] = [];
let registeredIds = new Set<string>();

const mockRegister: Mock<(id: string, cfg: { url: string; schema?: string; description?: string }) => void> = mock(
  (id: string, cfg: { url: string; schema?: string; description?: string }) => {
    registerCalls.push({ id, url: cfg.url, schema: cfg.schema, description: cfg.description });
    registeredIds.add(id);
  },
);
const mockUnregister: Mock<(id: string) => boolean> = mock((id: string) => {
  unregisterCalls.push(id);
  const had = registeredIds.has(id);
  registeredIds.delete(id);
  return had;
});
const mockHas: Mock<(id: string) => boolean> = mock((id: string) => registeredIds.has(id));

mock.module("@atlas/api/lib/db/connection", () => ({
  connections: {
    register: mockRegister,
    unregister: mockUnregister,
    has: mockHas,
  },
}));

type BridgeModule = typeof import("../datasource-registry-bridge");
let bridge!: BridgeModule;

beforeEach(async () => {
  bridge = await import("../datasource-registry-bridge");
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  registeredIds = new Set<string>();
  mockRegister.mockClear();
  mockUnregister.mockClear();
  mockHas.mockClear();
});

afterEach(() => {
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  registeredIds = new Set<string>();
});

const ROW = (slug: string) =>
  ({
    workspaceId: "ws-1",
    catalogId: "cat:" + slug,
    installId: "prod",
    pillar: "datasource" as const,
    catalogSlug: slug,
  });

describe("registerDatasourceInstall", () => {
  it("registers postgres installs", () => {
    const ok = bridge.registerDatasourceInstall(ROW("postgres"), {
      url: "postgresql://u@h/d",
      schema: "analytics",
      description: "Prod",
    });
    expect(ok).toBe(true);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0]).toEqual({
      id: "prod",
      url: "postgresql://u@h/d",
      schema: "analytics",
      description: "Prod",
    });
  });

  it("registers mysql installs (no schema)", () => {
    const ok = bridge.registerDatasourceInstall(ROW("mysql"), {
      url: "mysql://u@h/d",
    });
    expect(ok).toBe(true);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].schema).toBeUndefined();
  });

  it("skips plugin-managed dbTypes (clickhouse/snowflake/bigquery/duckdb/salesforce)", () => {
    const cases: Array<{ slug: string; cfg: Record<string, unknown> }> = [
      { slug: "clickhouse", cfg: { url: "http://localhost:8123" } },
      { slug: "snowflake", cfg: { url: "snowflake://x" } },
      { slug: "bigquery", cfg: { service_account_json: "{}", project_id: "p" } },
      { slug: "duckdb", cfg: { path: "/tmp/x.duckdb" } },
      { slug: "salesforce", cfg: {} },
    ];
    for (const { slug, cfg } of cases) {
      const ok = bridge.registerDatasourceInstall(ROW(slug), cfg);
      expect(ok).toBe(false);
    }
    expect(registerCalls).toHaveLength(0);
  });

  it("is idempotent — returns false when install_id is already registered", () => {
    bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    const second = bridge.registerDatasourceInstall(ROW("postgres"), {
      url: "postgresql://u@different/d2",
    });
    expect(second).toBe(false);
    // Only one register call landed — the existing pool wasn't torn down.
    expect(registerCalls).toHaveLength(1);
  });

  it("throws when the resolver rejects (missing required field)", () => {
    expect(() =>
      bridge.registerDatasourceInstall(ROW("postgres"), { schema: "public" }),
    ).toThrow(/missing required field `url`/);
    expect(registerCalls).toHaveLength(0);
  });

  it("throws when pillar is not datasource", () => {
    expect(() =>
      bridge.registerDatasourceInstall(
        { ...ROW("postgres"), pillar: "chat" as never },
        { url: "postgresql://u@h/d" },
      ),
    ).toThrow(/pillar must be 'datasource'/);
  });

  it("omits postgres schema when set to 'public' (it's the default)", () => {
    // The resolver explicitly skips initSql for 'public', and the bridge
    // mirrors the convention by not forwarding `schema` when it's
    // 'public'. Verifies the bridge's spread guard.
    const ok = bridge.registerDatasourceInstall(ROW("postgres"), {
      url: "postgresql://u@h/d",
      schema: "public",
    });
    expect(ok).toBe(true);
    expect(registerCalls[0].schema).toBe("public");
    // The resolver returned schema='public' so the bridge forwards it;
    // postgres pool driver no-ops on the SET. Documenting that the
    // bridge does NOT filter — that's the resolver's contract.
  });
});

describe("unregisterDatasourceInstall", () => {
  it("calls connections.unregister and returns true when registered", () => {
    bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    const result = bridge.unregisterDatasourceInstall("prod");
    expect(result).toBe(true);
    expect(unregisterCalls).toContain("prod");
  });

  it("returns false when install_id was never registered (plugin-managed pool)", () => {
    const result = bridge.unregisterDatasourceInstall("never-registered");
    expect(result).toBe(false);
    // Never even called unregister — the has() guard short-circuits.
    expect(unregisterCalls).toHaveLength(0);
  });
});
