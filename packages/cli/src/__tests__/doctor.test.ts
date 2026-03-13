import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

// Mock pg before importing doctor — mock.module is process-global
// CLAUDE.md: mock ALL named exports
mock.module("pg", () => ({
  Pool: MockPool,
  Client: class {},
  Query: class {},
  defaults: {},
  types: {},
  escapeIdentifier: (s: string) => `"${s}"`,
  escapeLiteral: (s: string) => `'${s}'`,
}));

mock.module("mysql2/promise", () => ({
  createPool: mockMysqlCreatePool,
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

import {
  checkDatasourceUrl,
  checkDatabaseConnectivity,
  checkProvider,
  checkSandbox,
  checkInternalDb,
  maskConnectionString,
} from "../doctor";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

let mockPoolQueryResult: { rows: Record<string, unknown>[] } = { rows: [] };
let mockPoolConnectShouldFail = false;
let mockPoolConnectError = new Error("connection refused");
let mockPoolQueryFn: ((sql: string, params?: unknown[]) => { rows: Record<string, unknown>[] }) | null = null;

function MockPool() {
  return {
    connect: async () => {
      if (mockPoolConnectShouldFail) throw mockPoolConnectError;
      return {
        query: async (sql: string, params?: unknown[]) => {
          if (mockPoolQueryFn) return mockPoolQueryFn(sql, params);
          return mockPoolQueryResult;
        },
        release: () => {},
      };
    },
    end: async () => {},
  };
}

let mockMysqlQueryResult: unknown[] = [[]];
let mockMysqlConnectShouldFail = false;
let mockMysqlConnectError = new Error("connection refused");
let mockMysqlPoolCallCount = 0;
let mockMysqlSecondPoolShouldFail = false;
let mockMysqlSecondPoolQueryResult: unknown[] = [[]];

function mockMysqlCreatePool() {
  mockMysqlPoolCallCount++;
  const poolNum = mockMysqlPoolCallCount;
  return {
    getConnection: async () => {
      if (poolNum === 1 && mockMysqlConnectShouldFail) throw mockMysqlConnectError;
      if (poolNum > 1 && mockMysqlSecondPoolShouldFail) throw new Error("second pool failed");
      return {
        query: async () => poolNum === 1 ? mockMysqlQueryResult : mockMysqlSecondPoolQueryResult,
        release: () => {},
      };
    },
    end: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Env + temp dir helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  mockPoolConnectShouldFail = false;
  mockPoolQueryResult = { rows: [] };
  mockPoolQueryFn = null;
  mockMysqlConnectShouldFail = false;
  mockMysqlQueryResult = [[]];
  mockMysqlPoolCallCount = 0;
  mockMysqlSecondPoolShouldFail = false;
  mockMysqlSecondPoolQueryResult = [[]];
});

afterEach(() => {
  // Restore environment
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

});


// ---------------------------------------------------------------------------
// maskConnectionString
// ---------------------------------------------------------------------------

describe("maskConnectionString", () => {
  test("strips credentials from postgres URL", () => {
    const result = maskConnectionString("postgresql://user:secret@localhost:5432/mydb");
    expect(result).toBe("postgresql://localhost:5432/mydb");
    expect(result).not.toContain("user");
    expect(result).not.toContain("secret");
  });

  test("strips credentials from mysql URL", () => {
    const result = maskConnectionString("mysql://admin:p4ss@db.example.com:3306/app");
    expect(result).toBe("mysql://db.example.com:3306/app");
    expect(result).not.toContain("admin");
    expect(result).not.toContain("p4ss");
  });

  test("handles URL without port", () => {
    const result = maskConnectionString("postgresql://user:pass@host/db");
    expect(result).toBe("postgresql://host/db");
  });

  test("returns (invalid URL) for garbage input", () => {
    expect(maskConnectionString("not-a-url")).toBe("(invalid URL)");
  });
});

// ---------------------------------------------------------------------------
// checkDatasourceUrl
// ---------------------------------------------------------------------------

describe("checkDatasourceUrl", () => {
  test("pass when ATLAS_DATASOURCE_URL is set", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    const result = checkDatasourceUrl();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("localhost:5432/db");
    expect(result.detail).not.toContain("pass");
  });

  test("pass with ATLAS_DEMO_DATA fallback", () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL = "postgresql://u:p@host:5432/atlas";
    const result = checkDatasourceUrl();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("ATLAS_DEMO_DATA");
  });

  test("DATABASE_URL_UNPOOLED takes precedence over DATABASE_URL in demo mode", () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    process.env.ATLAS_DEMO_DATA = "true";
    process.env.DATABASE_URL_UNPOOLED = "postgresql://u:p@direct-host:5432/db";
    process.env.DATABASE_URL = "postgresql://u:p@pooled-host:5432/db";
    const result = checkDatasourceUrl();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("direct-host");
    expect(result.detail).not.toContain("pooled-host");
  });

  test("fail when ATLAS_DEMO_DATA=true but no fallback URL", () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    process.env.ATLAS_DEMO_DATA = "true";
    const result = checkDatasourceUrl();
    expect(result.status).toBe("fail");
  });

  test("fail when no URL configured", () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_DEMO_DATA;
    const result = checkDatasourceUrl();
    expect(result.status).toBe("fail");
    expect(result.fix).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// checkDatabaseConnectivity
// ---------------------------------------------------------------------------

describe("checkDatabaseConnectivity", () => {
  test("pass when postgres connects and returns version", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    mockPoolQueryResult = { rows: [{ version: "PostgreSQL 16.1 on x86_64" }] };
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("PostgreSQL 16.1");
  });

  test("fail when postgres connection fails with ECONNREFUSED", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("ECONNREFUSED");
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("ECONNREFUSED");
    expect(result.fix).toContain("running");
  });

  test("fail with timeout error shows network fix", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("Connection timeout expired");
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("network/firewall");
  });

  test("fail when no URL configured", async () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_DEMO_DATA;
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
  });

  test("warn for non-core database types", async () => {
    process.env.ATLAS_DATASOURCE_URL = "clickhouse://localhost:8123/db";
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("clickhouse");
  });

  test("pass when mysql connects", async () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://user:pass@localhost:3306/db";
    mockMysqlQueryResult = [[{ v: "8.0.35" }]];
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("MySQL 8.0.35");
  });

  test("fail when mysql connection fails with auth error", async () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://user:pass@localhost:3306/db";
    mockMysqlConnectShouldFail = true;
    mockMysqlConnectError = new Error("Access denied for user");
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Access denied");
    expect(result.fix).toContain("Authentication");
  });

  test("pass when postgres connects and ATLAS_SCHEMA exists", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.ATLAS_SCHEMA = "analytics";
    mockPoolQueryFn = (sql: string) => {
      if (sql.includes("pg_namespace")) return { rows: [{ "?column?": 1 }] };
      return { rows: [{ version: "PostgreSQL 16.1" }] };
    };
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("PostgreSQL 16.1");
  });

  test("fail when postgres ATLAS_SCHEMA does not exist, shows available schemas", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.ATLAS_SCHEMA = "analytics";
    mockPoolQueryFn = (sql: string) => {
      if (sql.includes("pg_namespace")) return { rows: [] };
      if (sql.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "public" }, { schema_name: "reporting" }] };
      }
      return { rows: [{ version: "PostgreSQL 16.1" }] };
    };
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("analytics");
    expect(result.fix).toContain("public");
    expect(result.fix).toContain("reporting");
  });

  test("fail when postgres ATLAS_SCHEMA does not exist and schema listing fails", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.ATLAS_SCHEMA = "analytics";
    mockPoolQueryFn = (sql: string) => {
      if (sql.includes("pg_namespace")) return { rows: [] };
      if (sql.includes("information_schema.schemata")) throw new Error("permission denied");
      return { rows: [{ version: "PostgreSQL 16.1" }] };
    };
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("analytics");
    expect(result.fix).not.toContain("Available");
  });

  test("skips schema check when ATLAS_SCHEMA is public", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.ATLAS_SCHEMA = "public";
    mockPoolQueryResult = { rows: [{ version: "PostgreSQL 16.1" }] };
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("pass");
  });

  test("skips schema check when ATLAS_SCHEMA is not set", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    delete process.env.ATLAS_SCHEMA;
    mockPoolQueryResult = { rows: [{ version: "PostgreSQL 16.1" }] };
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("pass");
  });

  test("fail when mysql ER_BAD_DB_ERROR, shows available databases", async () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://user:pass@localhost:3306/nonexistent";
    mockMysqlConnectShouldFail = true;
    mockMysqlConnectError = new Error("ER_BAD_DB_ERROR: Unknown database 'nonexistent'");
    mockMysqlSecondPoolShouldFail = false;
    mockMysqlSecondPoolQueryResult = [[{ schema_name: "mydb" }, { schema_name: "testdb" }]];
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("mydb");
    expect(result.fix).toContain("testdb");
  });

  test("fail when mysql ER_BAD_DB_ERROR and database listing fails", async () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://user:pass@localhost:3306/nonexistent";
    mockMysqlConnectShouldFail = true;
    mockMysqlConnectError = new Error("ER_BAD_DB_ERROR: Unknown database 'nonexistent'");
    mockMysqlSecondPoolShouldFail = true;
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("Database not found");
    expect(result.fix).not.toContain("Available");
  });
});

// ---------------------------------------------------------------------------
// checkProvider
// ---------------------------------------------------------------------------

describe("checkProvider", () => {
  test("pass when anthropic key is set", () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = checkProvider();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("anthropic");
    expect(result.detail).toContain("claude-opus-4-6");
  });

  test("pass with custom model", () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    process.env.ATLAS_MODEL = "claude-sonnet-4-6";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = checkProvider();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("claude-sonnet-4-6");
  });

  test("fail when API key is missing", () => {
    process.env.ATLAS_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    const result = checkProvider();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("OPENAI_API_KEY");
    expect(result.fix).toContain("OPENAI_API_KEY");
  });

  test("pass for ollama (no key needed)", () => {
    process.env.ATLAS_PROVIDER = "ollama";
    const result = checkProvider();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("ollama");
  });

  test("warn for unknown provider", () => {
    process.env.ATLAS_PROVIDER = "not-real";
    const result = checkProvider();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not-real");
  });

  test("defaults to anthropic when no provider set", () => {
    delete process.env.ATLAS_PROVIDER;
    delete process.env.VERCEL;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = checkProvider();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("anthropic");
  });

  test("defaults to gateway on Vercel", () => {
    delete process.env.ATLAS_PROVIDER;
    process.env.VERCEL = "1";
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const result = checkProvider();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("gateway");
  });
});

// ---------------------------------------------------------------------------
// checkSandbox
// ---------------------------------------------------------------------------

describe("checkSandbox", () => {
  test("pass on Vercel runtime", () => {
    process.env.ATLAS_RUNTIME = "vercel";
    const result = checkSandbox();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Vercel");
  });

  test("pass with sidecar URL", () => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX;
    process.env.ATLAS_SANDBOX_URL = "http://sidecar:8080";
    const result = checkSandbox();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Sidecar");
  });

  test("pass when nsjail explicitly requested and ATLAS_NSJAIL_PATH is valid", () => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX_URL;
    process.env.ATLAS_SANDBOX = "nsjail";
    // Point to any existing executable as a stand-in
    process.env.ATLAS_NSJAIL_PATH = "/bin/sh";
    const result = checkSandbox();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("nsjail");
    expect(result.detail).toContain("/bin/sh");
  });

  test("fail when nsjail explicitly requested but not found", () => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX_URL;
    process.env.ATLAS_SANDBOX = "nsjail";
    delete process.env.ATLAS_NSJAIL_PATH;
    const origPath = process.env.PATH;
    process.env.PATH = "/tmp/empty-path";
    try {
      const result = checkSandbox();
      expect(result.status).toBe("fail");
      expect(result.fix).toContain("nsjail");
    } finally {
      process.env.PATH = origPath;
    }
  });

  test("warn when no sandbox configured", () => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_NSJAIL_PATH;
    const origPath = process.env.PATH;
    process.env.PATH = "/tmp/empty-path";
    try {
      const result = checkSandbox();
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("just-bash");
    } finally {
      process.env.PATH = origPath;
    }
  });
});

// ---------------------------------------------------------------------------
// checkInternalDb
// ---------------------------------------------------------------------------

describe("checkInternalDb", () => {
  test("warn when DATABASE_URL not set", async () => {
    delete process.env.DATABASE_URL;
    const result = await checkInternalDb();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not set");
  });

  test("pass when connected with tables", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    mockPoolQueryResult = {
      rows: [{ tablename: "audit_log" }, { tablename: "user" }],
    };
    const result = await checkInternalDb();
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("audit_log");
    expect(result.detail).toContain("user");
  });

  test("warn when connected but no tables", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    mockPoolQueryResult = { rows: [] };
    const result = await checkInternalDb();
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("no Atlas tables");
  });

  test("fail when connection fails with ECONNREFUSED", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("ECONNREFUSED");
    const result = await checkInternalDb();
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("ECONNREFUSED");
    expect(result.fix).toContain("running");
  });

  test("fail with timeout error shows network fix", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("Connection timeout");
    const result = await checkInternalDb();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("network/firewall");
  });

  test("fail with auth error shows auth fix", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("password authentication failed for user");
    const result = await checkInternalDb();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("Authentication");
  });
});

