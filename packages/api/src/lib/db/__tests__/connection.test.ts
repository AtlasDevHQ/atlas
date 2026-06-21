/**
 * Tests for detectDBType and resolveDatasourceUrl from connection.ts.
 *
 * sql.test.ts registers a global mock.module for @/lib/db/connection which
 * persists across bun's test runner. To test the real implementation, we
 * import the source file via a cache-busting query string that bypasses the mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";

const modulePath = resolve(__dirname, "../connection.ts");
const mod = await import(`${modulePath}?t=${Date.now()}`);
const detectDBType = mod.detectDBType as (url?: string) => "postgres" | "mysql";
const resolveDatasourceUrl = mod.resolveDatasourceUrl as () => string | undefined;
const ConnectionRegistry = mod.ConnectionRegistry as typeof import("../connection").ConnectionRegistry;

// Env vars touched by tests — save/restore
const MANAGED_VARS = [
  "ATLAS_DATASOURCE_URL",
  "ATLAS_DEMO_DATA",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  for (const key of MANAGED_VARS) savedEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const key of MANAGED_VARS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
}

describe("resolveDatasourceUrl", () => {
  beforeEach(() => {
    saveEnv();
    for (const key of MANAGED_VARS) delete process.env[key];
  });

  afterEach(restoreEnv);

  it("returns ATLAS_DATASOURCE_URL when set", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://explicit@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://explicit@localhost/db");
  });

  it("returns ATLAS_DATASOURCE_URL even when ATLAS_DEMO_DATA=true", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://explicit@localhost/db";
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL = "postgresql://fallback@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://explicit@localhost/db");
  });

  it("returns DATABASE_URL_UNPOOLED when ATLAS_DEMO_DATA=true and both fallbacks set", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL_UNPOOLED = "postgresql://unpooled@localhost/db";
    process.env.DATABASE_URL = "postgresql://pooled@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://unpooled@localhost/db");
  });

  it("returns DATABASE_URL when ATLAS_DEMO_DATA=true and only DATABASE_URL set", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL = "postgresql://pooled@localhost/db";
    expect(resolveDatasourceUrl()).toBe("postgresql://pooled@localhost/db");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveDatasourceUrl()).toBeUndefined();
  });

  it("returns undefined when ATLAS_DEMO_DATA is not exactly 'true'", () => {
    process.env.ATLAS_DEMO_DATA = "TRUE";
    process.env.DATABASE_URL = "postgresql://fallback@localhost/db";
    expect(resolveDatasourceUrl()).toBeUndefined();
  });

  it("returns undefined when ATLAS_DEMO_DATA=true but no DATABASE_URL vars set", () => {
    process.env.ATLAS_DEMO_DATA = "true";
    expect(resolveDatasourceUrl()).toBeUndefined();
  });
});

describe("detectDBType", () => {
  beforeEach(() => {
    saveEnv();
    for (const key of MANAGED_VARS) delete process.env[key];
  });

  afterEach(restoreEnv);

  it("detects postgresql:// as postgres", () => {
    expect(detectDBType("postgresql://user:pass@localhost:5432/db")).toBe("postgres");
  });

  it("detects postgres:// as postgres", () => {
    expect(detectDBType("postgres://user:pass@localhost:5432/db")).toBe("postgres");
  });

  it("detects mysql:// as mysql", () => {
    expect(detectDBType("mysql://user:pass@localhost:3306/db")).toBe("mysql");
  });

  it("detects mysql2:// as mysql", () => {
    expect(detectDBType("mysql2://user:pass@localhost:3306/db")).toBe("mysql");
  });

  it("uses ATLAS_DATASOURCE_URL env var when no argument provided", () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://test@localhost/db";
    expect(detectDBType()).toBe("mysql");
  });

  it("throws when ATLAS_DATASOURCE_URL is unset and no argument provided", () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    expect(() => detectDBType()).toThrow("No database URL provided");
  });

  it("throws for empty string argument", () => {
    expect(() => detectDBType("")).toThrow("No database URL provided");
  });

  it("throws for non-core adapter URLs with plugin migration hint", () => {
    expect(() => detectDBType("duckdb://:memory:")).toThrow("now a plugin");
    expect(() => detectDBType("clickhouse://localhost:8123/default")).toThrow("now a plugin");
    expect(() => detectDBType("snowflake://user:pass@account/db")).toThrow("now a plugin");
    expect(() => detectDBType("salesforce://user:pass@login.salesforce.com")).toThrow("now a plugin");
  });

  it("suggests correct plugin name for TLS scheme variants", () => {
    expect(() => detectDBType("clickhouses://localhost:8443/default")).toThrow("@useatlas/clickhouse");
  });

  it("suggests @useatlas/elasticsearch for opensearch:// (no @useatlas/opensearch exists)", () => {
    expect(() => detectDBType("opensearch://search-domain.us-east-1.es.amazonaws.com")).toThrow(
      "@useatlas/elasticsearch"
    );
    expect(() => detectDBType("elasticsearch://host:9200")).toThrow("@useatlas/elasticsearch");
  });

  it("includes the detected scheme in the error message", () => {
    expect(() => detectDBType("duckdb://:memory:")).toThrow("duckdb://");
    expect(() => detectDBType("clickhouse://localhost")).toThrow("clickhouse://");
  });

  it("unrecognized URL throws an error", () => {
    expect(() => detectDBType("file:./data/test.db")).toThrow(
      "Unsupported database URL"
    );
  });

  // #3377 — the remediation copy must stay deploy-agnostic. SaaS admins
  // have no atlas.config.ts, so the in-product path (the marketplace
  // form-install on Admin → Connections) must be offered first;
  // atlas.config.ts remains the config-managed alternative, never the
  // only prescription.
  it("error copy offers the admin-console install path (#3377)", () => {
    expect(() => detectDBType("clickhouse://localhost:8123/default")).toThrow(
      "admin console"
    );
    expect(() => detectDBType("clickhouse://localhost:8123/default")).toThrow(
      "Admin → Connections"
    );
  });

  it("error copy keeps atlas.config.ts as a config-managed alternative, not the only remedy", () => {
    try {
      detectDBType("snowflake://user:pass@account/db");
      throw new Error("expected detectDBType to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("atlas.config.ts");
      expect(message).toContain("on a config-managed deploy");
      // Regression guard against the pre-#3377 copy that prescribed the
      // config edit unconditionally.
      expect(message).not.toContain("Install the appropriate datasource plugin");
    }
  });
});

describe("ConnectionRegistry.has()", () => {
  it("returns false for unregistered connection", () => {
    const registry = new ConnectionRegistry();
    expect(registry.has("nonexistent")).toBe(false);
    registry._reset();
  });

  it("returns true for registered connection", () => {
    const registry = new ConnectionRegistry();
    registry.registerDirect("test-conn", { query: async () => ({ columns: [], rows: [] }), close: async () => {} }, "postgres");
    expect(registry.has("test-conn")).toBe(true);
    registry._reset();
  });
});

describe("ConnectionRegistry.unregister()", () => {
  it("returns false for the default connection", () => {
    const registry = new ConnectionRegistry();
    registry.registerDirect("default", { query: async () => ({ columns: [], rows: [] }), close: async () => {} }, "postgres");
    expect(registry.unregister("default")).toBe(false);
    expect(registry.has("default")).toBe(true);
    registry._reset();
  });

  it("returns false for nonexistent connection", () => {
    const registry = new ConnectionRegistry();
    expect(registry.unregister("nonexistent")).toBe(false);
    registry._reset();
  });

  it("removes a registered connection and returns true", () => {
    const registry = new ConnectionRegistry();
    registry.registerDirect("warehouse", { query: async () => ({ columns: [], rows: [] }), close: async () => {} }, "postgres");
    expect(registry.unregister("warehouse")).toBe(true);
    expect(registry.has("warehouse")).toBe(false);
    registry._reset();
  });
});

describe("ConnectionRegistry — DB-stored plugin datasources (#3253 seam)", () => {
  const fakeConn = (label: string) => {
    let closed = false;
    return {
      query: async () => ({ columns: ["src"], rows: [{ src: label }] }),
      close: async () => {
        closed = true;
      },
      get closed() {
        return closed;
      },
    };
  };

  it("registerDirectForWorkspace + getForWorkspace round-trips the live connection", () => {
    const registry = new ConnectionRegistry();
    const conn = fakeConn("ch");
    registry.registerDirectForWorkspace("ws-1", "ch", conn, "clickhouse", "ClickHouse", undefined, undefined, "h.example");
    expect(registry.hasDirectForWorkspace("ws-1", "ch")).toBe(true);
    expect(registry.getForWorkspace("ws-1", "ch")).toBe(conn);
    expect(registry.getDBType("ch", "ws-1")).toBe("clickhouse");
    expect(registry.getTargetHost("ch", "ws-1")).toBe("h.example");
    registry._reset();
  });

  it("getForOrg returns the plugin connection (the org-pooling-ON / SaaS resolution path)", () => {
    // Regression guard: with pool.perOrg.enabled (staging + prod), the SQL path
    // resolves via getForOrg/getRegionAwareConnection, NOT getForWorkspace. A
    // plugin install lives only in workspacePluginEntries, so getForOrg must
    // short-circuit to it instead of throwing ConnectionNotRegisteredError.
    const registry = new ConnectionRegistry();
    const conn = fakeConn("ch");
    registry.registerDirectForWorkspace("ws-1", "ch", conn, "clickhouse");
    expect(registry.getForOrg("ws-1", "ch")).toBe(conn);
    // getForWorkspace agrees regardless of pooling mode.
    expect(registry.getForWorkspace("ws-1", "ch")).toBe(conn);
    registry._reset();
  });

  it("surfaces the plugin's validator / dialect / forbidden patterns (not native defaults)", () => {
    const registry = new ConnectionRegistry();
    const conn = fakeConn("ch");
    const validate = (q: string) => ({ valid: !/DROP/i.test(q) });
    const forbidden = [/\bINSERT\b/i];
    registry.registerDirectForWorkspace("ws-1", "ch", conn, "clickhouse", undefined, validate, {
      parserDialect: "PostgresQL",
      forbiddenPatterns: forbidden,
    });
    expect(registry.getValidator("ch", "ws-1")).toBe(validate);
    expect(registry.getParserDialect("ch", "ws-1")).toBe("PostgresQL");
    expect(registry.getForbiddenPatterns("ch", "ws-1")).toBe(forbidden);
    registry._reset();
  });

  it("routes two workspaces sharing an install_id to their own plugin connections", () => {
    const registry = new ConnectionRegistry();
    const a = fakeConn("a");
    const b = fakeConn("b");
    registry.registerDirectForWorkspace("ws-a", "ch", a, "clickhouse", undefined, undefined, undefined, "a.host");
    registry.registerDirectForWorkspace("ws-b", "ch", b, "clickhouse", undefined, undefined, undefined, "b.host");
    expect(registry.getForWorkspace("ws-a", "ch")).toBe(a);
    expect(registry.getForWorkspace("ws-b", "ch")).toBe(b);
    expect(registry.getTargetHost("ch", "ws-a")).toBe("a.host");
    expect(registry.getTargetHost("ch", "ws-b")).toBe("b.host");
    registry._reset();
  });

  it("re-registration closes the previous connection", async () => {
    const registry = new ConnectionRegistry();
    const first = fakeConn("first");
    const second = fakeConn("second");
    registry.registerDirectForWorkspace("ws-1", "ch", first, "clickhouse");
    registry.registerDirectForWorkspace("ws-1", "ch", second, "clickhouse");
    await Promise.resolve();
    expect(first.closed).toBe(true);
    expect(registry.getForWorkspace("ws-1", "ch")).toBe(second);
    registry._reset();
  });

  it("unregisterDirectForWorkspace closes + removes the connection", async () => {
    const registry = new ConnectionRegistry();
    const conn = fakeConn("ch");
    registry.registerDirectForWorkspace("ws-1", "ch", conn, "clickhouse");
    expect(registry.unregisterDirectForWorkspace("ws-1", "ch")).toBe(true);
    await Promise.resolve();
    expect(conn.closed).toBe(true);
    expect(registry.hasDirectForWorkspace("ws-1", "ch")).toBe(false);
    // Second call is a no-op.
    expect(registry.unregisterDirectForWorkspace("ws-1", "ch")).toBe(false);
    registry._reset();
  });

  it("describe() omits per-workspace plugin pools (bare entries only)", () => {
    // describe() is the agent/system-prompt + legacy path: it must keep
    // enumerating ONLY bare `entries`. The workspace-scoped enumerations below
    // are what surface plugin pools — #3844 (the admin list / health gap) is a
    // missing union there, not a change to this method.
    const registry = new ConnectionRegistry();
    registry.registerDirect("warehouse", fakeConn("pg"), "postgres", "PG");
    registry.registerDirectForWorkspace("ws-1", "ch", fakeConn("ch"), "clickhouse", "ClickHouse");
    expect(registry.describe().map((m) => m.id)).toEqual(["warehouse"]);
    registry._reset();
  });

  it("describeForWorkspace unions bare entries with the workspace's plugin pools", () => {
    // #3844 — a published ClickHouse install registers ONLY in the per-workspace
    // direct-plugin map, so the admin Connections list (which filters
    // describe() ∩ visible install_ids) dropped it. The workspace-scoped
    // describe surfaces it so the intersection keeps it.
    const registry = new ConnectionRegistry();
    registry.registerDirect("warehouse", fakeConn("pg"), "postgres", "PG");
    registry.registerDirectForWorkspace("ws-1", "ch", fakeConn("ch"), "clickhouse", "ClickHouse");
    const meta = registry.describeForWorkspace("ws-1");
    const byId = new Map(meta.map((m) => [m.id, m]));
    expect(byId.has("warehouse")).toBe(true);
    expect(byId.get("ch")).toMatchObject({ id: "ch", dbType: "clickhouse", description: "ClickHouse" });
    registry._reset();
  });

  it("describeForWorkspace: a workspace plugin pool wins an install_id collision with a bare entry", () => {
    // The documented precedence: when a workspace's plugin pool shares an
    // install_id with a bare entry (e.g. self-hosted `default`), the plugin
    // pool is the one actually routing this workspace's queries, so the
    // describe must surface its dbType — not the bare entry's. Guards the
    // `byId.set` override order in describeForWorkspace.
    const registry = new ConnectionRegistry();
    registry.registerDirect("default", fakeConn("pg"), "postgres", "Native default");
    registry.registerDirectForWorkspace("ws-1", "default", fakeConn("ch"), "clickhouse", "Plugin default");
    const meta = registry.describeForWorkspace("ws-1").find((m) => m.id === "default");
    expect(meta?.dbType).toBe("clickhouse");
    registry._reset();
  });

  it("describeForWorkspace scopes plugin pools to the requested workspace", () => {
    // Two workspaces share an install_id but own distinct plugin pools — each
    // describe must surface only its own, never the sibling's.
    const registry = new ConnectionRegistry();
    registry.registerDirectForWorkspace("ws-a", "ch", fakeConn("a"), "clickhouse");
    registry.registerDirectForWorkspace("ws-b", "snow", fakeConn("b"), "snowflake");
    expect(registry.describeForWorkspace("ws-a").map((m) => m.id)).toContain("ch");
    expect(registry.describeForWorkspace("ws-a").map((m) => m.id)).not.toContain("snow");
    expect(registry.describeForWorkspace("ws-b").map((m) => m.id)).toContain("snow");
    expect(registry.describeForWorkspace("ws-b").map((m) => m.id)).not.toContain("ch");
    registry._reset();
  });

  it("describeAllWorkspacePlugins enumerates every plugin pool flat (operator /health fleet view)", () => {
    // /health has no per-request workspace; the operator fleet view enumerates
    // EVERY plugin pool the same way it already enumerates every bare entry.
    const registry = new ConnectionRegistry();
    registry.registerDirectForWorkspace("ws-a", "ch", fakeConn("a"), "clickhouse", "ClickHouse");
    registry.registerDirectForWorkspace("ws-b", "snow", fakeConn("b"), "snowflake", "Snowflake");
    const ids = registry.describeAllWorkspacePlugins().map((m) => m.id);
    expect(ids).toContain("ch");
    expect(ids).toContain("snow");
    registry._reset();
  });

  it("describeAllWorkspacePlugins keeps a per-workspace entry on a cross-workspace install_id collision", () => {
    // Two workspaces install a plugin under the SAME install_id. The flat fleet
    // view is keyed by (workspace, install_id), so the array must carry BOTH
    // entries — it is NOT deduplicated by `.id`. The /health route collapses
    // them by id (last-write-wins) by design; the registry method itself keeps
    // both so a future per-workspace consumer isn't silently handed one.
    const registry = new ConnectionRegistry();
    registry.registerDirectForWorkspace("ws-a", "clickhouse", fakeConn("a"), "clickhouse");
    registry.registerDirectForWorkspace("ws-b", "clickhouse", fakeConn("b"), "clickhouse");
    const all = registry.describeAllWorkspacePlugins();
    expect(all).toHaveLength(2);
    expect(all.every((m) => m.id === "clickhouse")).toBe(true);
    registry._reset();
  });
});
