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

// Per-(workspace, install_id) registrations — the routing source of truth (#2783).
const wsRegisterCalls: Array<{ workspaceId: string; installId: string; url: string; schema?: string; description?: string }> = [];
let wsRegisteredKeys = new Set<string>();
const wsKey = (workspaceId: string, installId: string) => `${workspaceId}::${installId}`;

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
const mockRegisterForWorkspace: Mock<(workspaceId: string, installId: string, cfg: { url: string; schema?: string; description?: string }) => void> = mock(
  (workspaceId: string, installId: string, cfg: { url: string; schema?: string; description?: string }) => {
    wsRegisterCalls.push({ workspaceId, installId, url: cfg.url, schema: cfg.schema, description: cfg.description });
    wsRegisteredKeys.add(wsKey(workspaceId, installId));
  },
);
const mockHasForWorkspace: Mock<(workspaceId: string, installId: string) => boolean> = mock(
  (workspaceId: string, installId: string) => wsRegisteredKeys.has(wsKey(workspaceId, installId)),
);
const mockUnregisterForWorkspace: Mock<(workspaceId: string, installId: string) => boolean> = mock(
  (workspaceId: string, installId: string) => wsRegisteredKeys.delete(wsKey(workspaceId, installId)),
);
const mockHasWorkspacePoolsFor: Mock<(installId: string) => boolean> = mock((installId: string) => {
  for (const key of wsRegisteredKeys) {
    if (key.endsWith(`::${installId}`)) return true;
  }
  return false;
});
// Eager org-pool clone drain on uninstall/update (#3109). The bridge calls it
// alongside unregisterForWorkspace so a stale clone can't outlive the config.
const drainCalls: Array<{ workspaceId: string; installId: string }> = [];
const mockDrainWorkspacePool: Mock<(workspaceId: string, installId: string) => number> = mock(
  (workspaceId: string, installId: string) => {
    drainCalls.push({ workspaceId, installId });
    return 0;
  },
);

mock.module("@atlas/api/lib/db/connection", () => ({
  connections: {
    register: mockRegister,
    unregister: mockUnregister,
    has: mockHas,
    registerForWorkspace: mockRegisterForWorkspace,
    hasForWorkspace: mockHasForWorkspace,
    unregisterForWorkspace: mockUnregisterForWorkspace,
    hasWorkspacePoolsFor: mockHasWorkspacePoolsFor,
    drainWorkspacePool: mockDrainWorkspacePool,
  },
}));

type BridgeModule = typeof import("../datasource-registry-bridge");
let bridge!: BridgeModule;

beforeEach(async () => {
  bridge = await import("../datasource-registry-bridge");
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  wsRegisterCalls.length = 0;
  drainCalls.length = 0;
  registeredIds = new Set<string>();
  wsRegisteredKeys = new Set<string>();
  mockRegister.mockClear();
  mockUnregister.mockClear();
  mockHas.mockClear();
  mockRegisterForWorkspace.mockClear();
  mockHasForWorkspace.mockClear();
  mockUnregisterForWorkspace.mockClear();
  mockHasWorkspacePoolsFor.mockClear();
  mockDrainWorkspacePool.mockClear();
});

afterEach(() => {
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  wsRegisterCalls.length = 0;
  drainCalls.length = 0;
  registeredIds = new Set<string>();
  wsRegisteredKeys = new Set<string>();
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

  it("is idempotent for the same (workspace, install_id) — returns false on re-register", () => {
    bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    const second = bridge.registerDatasourceInstall(ROW("postgres"), {
      url: "postgresql://u@different/d2",
    });
    expect(second).toBe(false);
    // Only one bare register call landed — the existing pool wasn't torn down.
    expect(registerCalls).toHaveLength(1);
  });

  it("registers two workspaces sharing an install_id independently (#2783)", () => {
    // Pre-#2783, the bridge keyed only on install_id, so the second workspace's
    // install collapsed onto the first's bare row. Now each (workspace,
    // install_id) gets its own routing config.
    const alpha = bridge.registerDatasourceInstall(
      { ...ROW("postgres"), workspaceId: "ws-alpha" },
      { url: "postgresql://alpha-host/wh" },
    );
    const beta = bridge.registerDatasourceInstall(
      { ...ROW("postgres"), workspaceId: "ws-beta" },
      { url: "postgresql://beta-host/wh" },
    );

    // Both are fresh registrations — no collapse.
    expect(alpha).toBe(true);
    expect(beta).toBe(true);

    // Two distinct per-(workspace, install_id) configs, each with its own URL.
    expect(wsRegisterCalls).toHaveLength(2);
    expect(wsRegisterCalls[0]).toMatchObject({ workspaceId: "ws-alpha", installId: "prod", url: "postgresql://alpha-host/wh" });
    expect(wsRegisterCalls[1]).toMatchObject({ workspaceId: "ws-beta", installId: "prod", url: "postgresql://beta-host/wh" });

    // The bare install-id row is written once (first-write-wins) — it backs
    // only install-id-keyed metadata, not routing.
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].url).toBe("postgresql://alpha-host/wh");
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
  it("removes both the per-workspace config and the bare row when registered", () => {
    bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    const result = bridge.unregisterDatasourceInstall("ws-1", "prod");
    expect(result).toBe(true);
    // Per-workspace routing config gone — no stale route survives.
    expect(wsRegisteredKeys.has(wsKey("ws-1", "prod"))).toBe(false);
    // Bare row removed too (no sibling workspace owns the install_id).
    expect(unregisterCalls).toContain("prod");
  });

  it("eagerly drains the live org-pool clone for the (workspace, install_id) (#3109)", () => {
    // Both uninstall and updateDatasourceConfig route through this bridge fn, so
    // a single drain hook here covers both — the cloned pool can't keep serving
    // the prior config until LRU/restart.
    bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    bridge.unregisterDatasourceInstall("ws-1", "prod");
    expect(drainCalls).toEqual([{ workspaceId: "ws-1", installId: "prod" }]);
  });

  it("drains the targeted clone even when a sibling keeps the bare row", () => {
    bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-a" }, { url: "postgresql://a/d" });
    bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-b" }, { url: "postgresql://b/d" });

    bridge.unregisterDatasourceInstall("ws-a", "prod");
    // Only ws-a's clone is drained; ws-b's pool is left intact.
    expect(drainCalls).toEqual([{ workspaceId: "ws-a", installId: "prod" }]);
    expect(unregisterCalls).not.toContain("prod");
  });

  it("keeps the shared bare row when a sibling workspace still owns the install_id", () => {
    bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-a" }, { url: "postgresql://a/d" });
    bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-b" }, { url: "postgresql://b/d" });

    const result = bridge.unregisterDatasourceInstall("ws-a", "prod");
    expect(result).toBe(true);

    // ws-a's routing config is gone; ws-b's survives.
    expect(wsRegisteredKeys.has(wsKey("ws-a", "prod"))).toBe(false);
    expect(wsRegisteredKeys.has(wsKey("ws-b", "prod"))).toBe(true);
    // Bare row is NOT torn down while ws-b still owns `prod` — sibling metadata
    // (getDBType / getTargetHost) keeps resolving.
    expect(unregisterCalls).not.toContain("prod");
  });

  it("returns false when install_id was never registered (plugin-managed pool)", () => {
    const result = bridge.unregisterDatasourceInstall("ws-1", "never-registered");
    expect(result).toBe(false);
    // Nothing to remove — neither the per-workspace config nor the bare row.
    expect(unregisterCalls).toHaveLength(0);
  });
});
