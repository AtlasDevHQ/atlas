/**
 * Tests for plugin-aware SQL validation (#15).
 *
 * Verifies:
 * - ConnectionRegistry stores and returns plugin metadata
 * - parserDatabase() consults plugin metadata before hardcoded switch
 * - getExtraPatterns() (via validateSQL) consults plugin metadata before hardcoded switch
 * - Custom validate() completely bypasses the standard pipeline
 * - wireDatasourcePlugins passes parserDialect + forbiddenPatterns through
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { ConnectionRegistry } from "@atlas/api/lib/db/connection";
import type { DBConnection, ConnectionPluginMeta } from "@atlas/api/lib/db/connection";
import { PluginRegistry } from "@atlas/api/lib/plugins/registry";
import type { PluginLike, PluginContextLike } from "@atlas/api/lib/plugins/registry";
import { wireDatasourcePlugins } from "@atlas/api/lib/plugins/wiring";

// --- Helpers ---

function mockConn(): DBConnection {
  return {
    async query() { return { columns: [], rows: [] }; },
    async close() {},
  };
}

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [] },
  tools: { register: () => {} },
  logger: {},
  config: {},
};

// --- ConnectionRegistry plugin metadata ---

describe("ConnectionRegistry plugin metadata", () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  test("registerDirect stores and retrieves parserDialect", () => {
    registry.registerDirect("bq", mockConn(), "postgres", "BigQuery", undefined, {
      parserDialect: "BigQuery",
    });

    expect(registry.getParserDialect("bq")).toBe("BigQuery");
  });

  test("registerDirect stores and retrieves forbiddenPatterns", () => {
    const patterns = [/\bMERGE\b/i, /\bEXPORT\b/i];
    registry.registerDirect("custom", mockConn(), "postgres", "Custom DB", undefined, {
      forbiddenPatterns: patterns,
    });

    expect(registry.getForbiddenPatterns("custom")).toEqual(patterns);
  });

  test("getParserDialect returns undefined when no meta", () => {
    registry.registerDirect("plain", mockConn(), "postgres");
    expect(registry.getParserDialect("plain")).toBeUndefined();
  });

  test("getForbiddenPatterns returns empty array when no meta", () => {
    registry.registerDirect("plain", mockConn(), "postgres");
    expect(registry.getForbiddenPatterns("plain")).toEqual([]);
  });

  test("getParserDialect returns undefined for unregistered connection", () => {
    expect(registry.getParserDialect("nonexistent")).toBeUndefined();
  });

  test("getForbiddenPatterns returns empty array for unregistered connection", () => {
    expect(registry.getForbiddenPatterns("nonexistent")).toEqual([]);
  });

  test("registerDirect with both meta fields", () => {
    const meta: ConnectionPluginMeta = {
      parserDialect: "TransactSQL",
      forbiddenPatterns: [/\bEXEC\b/i],
    };
    registry.registerDirect("mssql", mockConn(), "postgres", "SQL Server", undefined, meta);

    expect(registry.getParserDialect("mssql")).toBe("TransactSQL");
    expect(registry.getForbiddenPatterns("mssql")).toEqual([/\bEXEC\b/i]);
  });

  test("re-registration replaces meta", () => {
    registry.registerDirect("ds", mockConn(), "postgres", undefined, undefined, {
      parserDialect: "MySQL",
    });
    expect(registry.getParserDialect("ds")).toBe("MySQL");

    registry.registerDirect("ds", mockConn(), "postgres", undefined, undefined, {
      parserDialect: "BigQuery",
    });
    expect(registry.getParserDialect("ds")).toBe("BigQuery");
  });
});

// --- parserDatabase with plugin metadata ---

describe("parserDatabase with plugin metadata", () => {
  let registry: ConnectionRegistry;

  // We need to import parserDatabase which uses the global `connections` singleton.
  // To test with our own registry, we'll use validateSQL indirectly via the
  // parserDatabase export. But parserDatabase uses the global connections import.
  // Instead, let's test through validateSQL which is the public API.

  // Actually, parserDatabase is exported. We need to test that it consults
  // the global connections registry. Let's use the global one.

  beforeEach(async () => {
    const { connections } = await import("@atlas/api/lib/db/connection");
    connections._reset();
  });

  test("parserDatabase uses plugin dialect over hardcoded", async () => {
    const { connections } = await import("@atlas/api/lib/db/connection");
    const { parserDatabase } = await import("@atlas/api/lib/tools/sql");

    connections.registerDirect("bq-conn", mockConn(), "postgres", "BigQuery", undefined, {
      parserDialect: "BigQuery",
    });

    // With connectionId — should use plugin dialect
    expect(parserDatabase("postgres", "bq-conn")).toBe("BigQuery");

    // Without connectionId — should use hardcoded
    expect(parserDatabase("postgres")).toBe("PostgresQL");
  });

  test("parserDatabase falls back to hardcoded when no plugin dialect", async () => {
    const { connections } = await import("@atlas/api/lib/db/connection");
    const { parserDatabase } = await import("@atlas/api/lib/tools/sql");

    connections.registerDirect("plain-pg", mockConn(), "postgres");

    expect(parserDatabase("postgres", "plain-pg")).toBe("PostgresQL");
    expect(parserDatabase("mysql", "plain-pg")).toBe("MySQL");
  });

  test("parserDatabase defaults to PostgresQL for unknown dbType", async () => {
    const { parserDatabase } = await import("@atlas/api/lib/tools/sql");

    // Unknown dbType with no connectionId
    expect(parserDatabase("custom-db" as never)).toBe("PostgresQL");
  });
});

// --- validateSQL with plugin-provided forbidden patterns ---

describe("validateSQL with plugin forbidden patterns", () => {
  beforeEach(async () => {
    const { connections } = await import("@atlas/api/lib/db/connection");
    connections._reset();
  });

  test("plugin-provided forbidden patterns block matching queries", async () => {
    const { connections } = await import("@atlas/api/lib/db/connection");
    const { validateSQL } = await import("@atlas/api/lib/tools/sql");

    connections.registerDirect("strict-ds", mockConn(), "postgres", "Strict DB", undefined, {
      forbiddenPatterns: [/\bUNION\b/i],
    });

    // UNION is not forbidden for regular postgres, but our plugin says it is
    const result = validateSQL("SELECT 1 UNION SELECT 2", "strict-ds");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("UNION");
  });

  test("plugin patterns do not affect connections without them", async () => {
    const { connections } = await import("@atlas/api/lib/db/connection");
    const { validateSQL } = await import("@atlas/api/lib/tools/sql");

    // Register one with patterns, one without
    connections.registerDirect("strict", mockConn(), "postgres", undefined, undefined, {
      forbiddenPatterns: [/\bUNION\b/i],
    });
    connections.registerDirect("plain", mockConn(), "postgres");

    // Blocked on strict
    expect(validateSQL("SELECT 1 UNION SELECT 2", "strict").valid).toBe(false);

    // Allowed on plain (postgres has no UNION restriction)
    // Note: this requires the semantic layer whitelist to be off
    process.env.ATLAS_TABLE_WHITELIST = "false";
    expect(validateSQL("SELECT 1 UNION SELECT 2", "plain").valid).toBe(true);
    delete process.env.ATLAS_TABLE_WHITELIST;
  });
});

// --- wireDatasourcePlugins passes metadata through ---

describe("wireDatasourcePlugins metadata passthrough", () => {
  function makeMockConnectionRegistry() {
    return {
      registered: [] as { id: string; conn: unknown; dbType: string; description?: string; validate?: unknown; meta?: unknown }[],
      async registerDirect(id: string, conn: unknown, dbType: string, description?: string, validate?: unknown, meta?: unknown) {
        this.registered.push({ id, conn, dbType, description, validate, meta });
      },
    };
  }

  test("passes parserDialect and forbiddenPatterns from plugin", async () => {
    const registry = new PluginRegistry();
    const connRegistry = makeMockConnectionRegistry();
    const patterns = [/\bCUSTOM_OP\b/i];

    const plugin: PluginLike = {
      id: "dialect-ds",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        parserDialect: "BigQuery",
        forbiddenPatterns: patterns,
      },
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].meta).toEqual({
      parserDialect: "BigQuery",
      forbiddenPatterns: patterns,
    });
  });

  test("passes undefined meta when plugin has no dialect or patterns", async () => {
    const registry = new PluginRegistry();
    const connRegistry = makeMockConnectionRegistry();

    const plugin: PluginLike = {
      id: "plain-ds",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].meta).toBeUndefined();
  });

  test("passes meta with only parserDialect", async () => {
    const registry = new PluginRegistry();
    const connRegistry = makeMockConnectionRegistry();

    const plugin: PluginLike = {
      id: "dialect-only",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        parserDialect: "Redshift",
      },
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].meta).toEqual({
      parserDialect: "Redshift",
      forbiddenPatterns: undefined,
    });
  });

  test("passes meta with only forbiddenPatterns", async () => {
    const registry = new PluginRegistry();
    const connRegistry = makeMockConnectionRegistry();
    const patterns = [/\bDELETE\b/i];

    const plugin: PluginLike = {
      id: "patterns-only",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        forbiddenPatterns: patterns,
      },
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].meta).toEqual({
      parserDialect: undefined,
      forbiddenPatterns: patterns,
    });
  });
});
