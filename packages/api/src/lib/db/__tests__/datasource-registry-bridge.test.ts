/**
 * Tests for `datasource-registry-bridge` (#2744, #3253).
 *
 * The bridge is the shared (workspace_plugins row → ConnectionRegistry)
 * glue used by both boot-time `loadSavedConnections` and runtime
 * `WorkspaceInstaller.installDatasource`. Two behavioral contracts matter:
 *  - native postgres/mysql → cloneable config registration (#2744/#2783)
 *  - plugin dbTypes (clickhouse / …) → a live per-(workspace, install_id)
 *    connection built from the registered plugin's `createFromConfig` (#3253)
 * The per-dbType translation is delegated to `DatasourcePoolResolver`
 * (covered by its own tests).
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

// Per-(workspace, install_id) PLUGIN connections — the #3253 seam.
const wsPluginRegisterCalls: Array<{ workspaceId: string; installId: string; dbType: string; description?: string; targetHost?: string }> = [];
let wsPluginKeys = new Set<string>();

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
// Plugin connection registration seam (#3253).
const mockRegisterDirectForWorkspace = mock(
  (
    workspaceId: string,
    installId: string,
    _conn: unknown,
    dbType: string,
    description?: string,
    _validate?: unknown,
    _meta?: unknown,
    targetHost?: string,
  ) => {
    wsPluginRegisterCalls.push({ workspaceId, installId, dbType, description, targetHost });
    wsPluginKeys.add(wsKey(workspaceId, installId));
  },
);
const mockHasDirectForWorkspace = mock((workspaceId: string, installId: string) =>
  wsPluginKeys.has(wsKey(workspaceId, installId)),
);
const mockUnregisterDirectForWorkspace = mock((workspaceId: string, installId: string) =>
  wsPluginKeys.delete(wsKey(workspaceId, installId)),
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
    registerDirectForWorkspace: mockRegisterDirectForWorkspace,
    hasDirectForWorkspace: mockHasDirectForWorkspace,
    unregisterDirectForWorkspace: mockUnregisterDirectForWorkspace,
  },
}));

// Plugin registry seam — the bridge lazy-imports this to find a datasource
// plugin by dbType. `fakeDatasourcePlugins` is swapped per test.
let fakeDatasourcePlugins: unknown[] = [];
mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    getAll: () => fakeDatasourcePlugins,
  },
}));

const fakeClickhouseConn = {
  query: async () => ({ columns: [], rows: [] }),
  close: async () => {},
};
const mockCreateFromConfig = mock((_cfg: Readonly<Record<string, unknown>>) => fakeClickhouseConn);
const fakeClickhousePlugin = {
  id: "clickhouse-datasource",
  types: ["datasource"],
  connection: {
    dbType: "clickhouse",
    parserDialect: "PostgresQL",
    forbiddenPatterns: [/\bINSERT\b/i],
    createFromConfig: mockCreateFromConfig,
  },
};

type BridgeModule = typeof import("../datasource-registry-bridge");
let bridge!: BridgeModule;

beforeEach(async () => {
  bridge = await import("../datasource-registry-bridge");
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  wsRegisterCalls.length = 0;
  wsPluginRegisterCalls.length = 0;
  drainCalls.length = 0;
  registeredIds = new Set<string>();
  wsRegisteredKeys = new Set<string>();
  wsPluginKeys = new Set<string>();
  fakeDatasourcePlugins = [];
  mockRegister.mockClear();
  mockUnregister.mockClear();
  mockHas.mockClear();
  mockRegisterForWorkspace.mockClear();
  mockHasForWorkspace.mockClear();
  mockUnregisterForWorkspace.mockClear();
  mockHasWorkspacePoolsFor.mockClear();
  mockDrainWorkspacePool.mockClear();
  mockRegisterDirectForWorkspace.mockClear();
  mockHasDirectForWorkspace.mockClear();
  mockUnregisterDirectForWorkspace.mockClear();
  mockCreateFromConfig.mockClear();
});

afterEach(() => {
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  wsRegisterCalls.length = 0;
  wsPluginRegisterCalls.length = 0;
  drainCalls.length = 0;
  registeredIds = new Set<string>();
  wsRegisteredKeys = new Set<string>();
  wsPluginKeys = new Set<string>();
  fakeDatasourcePlugins = [];
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
  it("registers postgres installs", async () => {
    const ok = await bridge.registerDatasourceInstall(ROW("postgres"), {
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

  it("registers mysql installs (no schema)", async () => {
    const ok = await bridge.registerDatasourceInstall(ROW("mysql"), {
      url: "mysql://u@h/d",
    });
    expect(ok).toBe(true);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].schema).toBeUndefined();
  });

  it("builds a plugin (clickhouse) connection via the registered plugin's createFromConfig (#3253)", async () => {
    fakeDatasourcePlugins = [fakeClickhousePlugin];
    const ok = await bridge.registerDatasourceInstall(ROW("clickhouse"), {
      url: "clickhouse://u:p@h:8123/db",
    });
    expect(ok).toBe(true);
    // The plugin's runtime factory is called with the decrypted config.
    expect(mockCreateFromConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateFromConfig.mock.calls[0][0]).toMatchObject({ url: "clickhouse://u:p@h:8123/db" });
    // Registered as a per-(workspace, install_id) plugin connection, with the
    // plugin's dbType + host parsed from the URL for audit.
    expect(wsPluginRegisterCalls).toHaveLength(1);
    expect(wsPluginRegisterCalls[0]).toMatchObject({
      workspaceId: "ws-1",
      installId: "prod",
      dbType: "clickhouse",
      targetHost: "h",
    });
    // No native registration for a plugin type.
    expect(registerCalls).toHaveLength(0);
    expect(wsRegisterCalls).toHaveLength(0);
  });

  it("is idempotent for a plugin install — returns false on re-register", async () => {
    fakeDatasourcePlugins = [fakeClickhousePlugin];
    const first = await bridge.registerDatasourceInstall(ROW("clickhouse"), { url: "clickhouse://h:8123/db" });
    const second = await bridge.registerDatasourceInstall(ROW("clickhouse"), { url: "clickhouse://h:8123/db" });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("throws for a plugin dbType when no matching plugin is registered (#3253)", async () => {
    fakeDatasourcePlugins = []; // clickhouse plugin absent from atlas.config.ts
    await expect(
      bridge.registerDatasourceInstall(ROW("clickhouse"), { url: "clickhouse://h:8123/db" }),
    ).rejects.toThrow(/No datasource plugin registered for type "clickhouse"/);
    expect(wsPluginRegisterCalls).toHaveLength(0);
  });

  it("throws for a plugin present but lacking createFromConfig", async () => {
    fakeDatasourcePlugins = [
      { id: "ch", types: ["datasource"], connection: { dbType: "clickhouse" } },
    ];
    await expect(
      bridge.registerDatasourceInstall(ROW("clickhouse"), { url: "clickhouse://h:8123/db" }),
    ).rejects.toThrow(/No datasource plugin registered for type "clickhouse"/);
  });

  it("is idempotent for the same (workspace, install_id) — returns false on re-register", async () => {
    await bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    const second = await bridge.registerDatasourceInstall(ROW("postgres"), {
      url: "postgresql://u@different/d2",
    });
    expect(second).toBe(false);
    // Only one bare register call landed — the existing pool wasn't torn down.
    expect(registerCalls).toHaveLength(1);
  });

  it("registers two workspaces sharing an install_id independently (#2783)", async () => {
    const alpha = await bridge.registerDatasourceInstall(
      { ...ROW("postgres"), workspaceId: "ws-alpha" },
      { url: "postgresql://alpha-host/wh" },
    );
    const beta = await bridge.registerDatasourceInstall(
      { ...ROW("postgres"), workspaceId: "ws-beta" },
      { url: "postgresql://beta-host/wh" },
    );

    expect(alpha).toBe(true);
    expect(beta).toBe(true);

    expect(wsRegisterCalls).toHaveLength(2);
    expect(wsRegisterCalls[0]).toMatchObject({ workspaceId: "ws-alpha", installId: "prod", url: "postgresql://alpha-host/wh" });
    expect(wsRegisterCalls[1]).toMatchObject({ workspaceId: "ws-beta", installId: "prod", url: "postgresql://beta-host/wh" });

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].url).toBe("postgresql://alpha-host/wh");
  });

  it("throws when the resolver rejects (missing required field)", async () => {
    await expect(
      bridge.registerDatasourceInstall(ROW("postgres"), { schema: "public" }),
    ).rejects.toThrow(/missing required field `url`/);
    expect(registerCalls).toHaveLength(0);
  });

  it("throws when pillar is not datasource", async () => {
    await expect(
      bridge.registerDatasourceInstall(
        { ...ROW("postgres"), pillar: "chat" as never },
        { url: "postgresql://u@h/d" },
      ),
    ).rejects.toThrow(/pillar must be 'datasource'/);
  });

  it("forwards postgres schema 'public' (resolver contract — bridge does not filter)", async () => {
    const ok = await bridge.registerDatasourceInstall(ROW("postgres"), {
      url: "postgresql://u@h/d",
      schema: "public",
    });
    expect(ok).toBe(true);
    expect(registerCalls[0].schema).toBe("public");
  });
});

describe("unregisterDatasourceInstall", () => {
  it("removes both the per-workspace config and the bare row when registered", async () => {
    await bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    const result = bridge.unregisterDatasourceInstall("ws-1", "prod");
    expect(result).toBe(true);
    expect(wsRegisteredKeys.has(wsKey("ws-1", "prod"))).toBe(false);
    expect(unregisterCalls).toContain("prod");
  });

  it("closes + removes a DB-stored plugin connection (#3253)", async () => {
    fakeDatasourcePlugins = [fakeClickhousePlugin];
    await bridge.registerDatasourceInstall(ROW("clickhouse"), { url: "clickhouse://h:8123/db" });
    expect(wsPluginKeys.has(wsKey("ws-1", "prod"))).toBe(true);
    const result = bridge.unregisterDatasourceInstall("ws-1", "prod");
    expect(result).toBe(true);
    expect(mockUnregisterDirectForWorkspace).toHaveBeenCalledWith("ws-1", "prod");
    expect(wsPluginKeys.has(wsKey("ws-1", "prod"))).toBe(false);
  });

  it("eagerly drains the live org-pool clone for the (workspace, install_id) (#3109)", async () => {
    await bridge.registerDatasourceInstall(ROW("postgres"), { url: "postgresql://u@h/d" });
    bridge.unregisterDatasourceInstall("ws-1", "prod");
    expect(drainCalls).toEqual([{ workspaceId: "ws-1", installId: "prod" }]);
  });

  it("drains the targeted clone even when a sibling keeps the bare row", async () => {
    await bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-a" }, { url: "postgresql://a/d" });
    await bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-b" }, { url: "postgresql://b/d" });

    bridge.unregisterDatasourceInstall("ws-a", "prod");
    expect(drainCalls).toEqual([{ workspaceId: "ws-a", installId: "prod" }]);
    expect(unregisterCalls).not.toContain("prod");
  });

  it("keeps the shared bare row when a sibling workspace still owns the install_id", async () => {
    await bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-a" }, { url: "postgresql://a/d" });
    await bridge.registerDatasourceInstall({ ...ROW("postgres"), workspaceId: "ws-b" }, { url: "postgresql://b/d" });

    const result = bridge.unregisterDatasourceInstall("ws-a", "prod");
    expect(result).toBe(true);

    expect(wsRegisteredKeys.has(wsKey("ws-a", "prod"))).toBe(false);
    expect(wsRegisteredKeys.has(wsKey("ws-b", "prod"))).toBe(true);
    expect(unregisterCalls).not.toContain("prod");
  });

  it("returns false when install_id was never registered", async () => {
    const result = bridge.unregisterDatasourceInstall("ws-1", "never-registered");
    expect(result).toBe(false);
    expect(unregisterCalls).toHaveLength(0);
  });
});
