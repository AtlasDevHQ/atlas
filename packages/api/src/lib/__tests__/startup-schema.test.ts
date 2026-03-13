/**
 * Tests for schema/database suggestion logic in startup.ts.
 *
 * PostgreSQL schema suggestions are tested via doctor.test.ts (which uses the
 * same logic pattern) because mock.module("pg") does not intercept require("pg")
 * used in startup.ts. MySQL mock.module works with require(), so MySQL database
 * suggestions are tested here.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";

// ---------------------------------------------------------------------------
// Control variables for mocks
// ---------------------------------------------------------------------------

let mockDatasourceUrl: string | null = null;
let mockMysqlConnectError: Error | null = null;
let mockMysqlPoolCallCount = 0;
let mockMysqlSecondPoolShouldFail = false;
let mockMysqlSecondPoolQueryResult: unknown[] = [[]];

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => ["orders.yml"],
}));

mock.module("@atlas/api/lib/db/connection", () => ({
  detectDBType: (url: string) => {
    if (url.startsWith("mysql")) return "mysql";
    return "postgres";
  },
  resolveDatasourceUrl: () => mockDatasourceUrl,
}));

mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
}));

mock.module("pg", () => ({
  Pool: class MockPool {
    async connect() {
      return {
        release: () => {},
        query: async () => ({ rows: [{ "?column?": 1 }] }),
      };
    }
    async end() {}
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => {
    mockMysqlPoolCallCount++;
    const poolNum = mockMysqlPoolCallCount;
    return {
      getConnection: async () => {
        if (poolNum === 1 && mockMysqlConnectError) throw mockMysqlConnectError;
        if (poolNum > 1 && mockMysqlSecondPoolShouldFail) throw new Error("second pool failed");
        return {
          release: () => {},
          execute: async () => {},
          query: async () => poolNum === 1 ? [[]] : mockMysqlSecondPoolQueryResult,
        };
      },
      end: async () => {},
    };
  },
  createConnection: async () => ({}),
  createPoolCluster: () => ({}),
  escape: (s: string) => `'${s}'`,
  escapeId: (s: string) => `\`${s}\``,
  format: (s: string) => s,
  raw: (s: string) => ({ toSqlString: () => s }),
  Types: {},
  Charsets: {},
  CharsetToEncoding: {},
  clearParserCache: () => {},
  setMaxParserCache: () => {},
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ source: "env" }),
  loadConfig: async () => ({ source: "env" }),
}));

mock.module("@atlas/api/lib/tools/explore-nsjail", () => ({
  findNsjailBinary: () => null,
  testNsjailCapabilities: async () => ({ ok: true }),
  isNsjailAvailable: () => false,
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  markNsjailFailed: () => {},
  markSidecarFailed: () => {},
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  invalidateExploreBackend: () => {},
}));

mock.module("@atlas/api/lib/auth/migrate", () => ({
  getMigrationError: () => null,
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

const { validateEnvironment, resetStartupCache } =
  await import("@atlas/api/lib/startup");

// ---------------------------------------------------------------------------
// Env snapshot
// ---------------------------------------------------------------------------

const MANAGED_VARS = [
  "ATLAS_DATASOURCE_URL", "DATABASE_URL", "ATLAS_API_KEY", "ATLAS_PROVIDER",
  "ATLAS_AUTH_MODE", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS", "ATLAS_AUTH_JWKS_URL", "ATLAS_AUTH_ISSUER",
  "ATLAS_AUTH_AUDIENCE", "ATLAS_SANDBOX", "ATLAS_SANDBOX_URL",
  "ATLAS_RUNTIME", "VERCEL", "ATLAS_SCHEMA",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED_VARS) saved[key] = process.env[key];
  resetStartupCache();
  resetAuthModeCache();

  for (const key of MANAGED_VARS) delete process.env[key];
  process.env.ATLAS_PROVIDER = "ollama";

  mockDatasourceUrl = null;
  mockMysqlConnectError = null;
  mockMysqlPoolCallCount = 0;
  mockMysqlSecondPoolShouldFail = false;
  mockMysqlSecondPoolQueryResult = [[]];
});

afterEach(() => {
  for (const key of MANAGED_VARS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
  resetStartupCache();
  resetAuthModeCache();
});

// ---------------------------------------------------------------------------
// MySQL database suggestions
// ---------------------------------------------------------------------------

describe("startup schema diagnostics — mysql", () => {
  it("suggests available databases on ER_BAD_DB_ERROR", async () => {
    mockDatasourceUrl = "mysql://user:pass@localhost:3306/nonexistent";
    mockMysqlConnectError = new Error("ER_BAD_DB_ERROR: Unknown database 'nonexistent'");
    mockMysqlSecondPoolShouldFail = false;
    mockMysqlSecondPoolQueryResult = [[{ schema_name: "appdb" }, { schema_name: "testdb" }]];

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "DB_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("does not exist");
    expect(err!.message).toContain("Available databases: appdb, testdb");
  });

  it("falls back to generic message when database listing fails", async () => {
    mockDatasourceUrl = "mysql://user:pass@localhost:3306/nonexistent";
    mockMysqlConnectError = new Error("ER_BAD_DB_ERROR: Unknown database 'nonexistent'");
    mockMysqlSecondPoolShouldFail = true;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "DB_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("does not exist");
    expect(err!.message).not.toContain("Available");
  });
});
