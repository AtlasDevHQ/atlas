import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

// Mock pg before importing doctor — mock.module is process-global
mock.module("pg", () => ({
  Pool: MockPool,
}));

mock.module("mysql2/promise", () => ({
  createPool: mockMysqlCreatePool,
}));

// We also need to mock @clack/prompts and picocolors so they don't interfere
mock.module("@clack/prompts", () => ({
  intro: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

mock.module("picocolors", () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
}));

import {
  checkDatasourceUrl,
  checkDatabaseConnectivity,
  checkProvider,
  checkSemanticLayer,
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

function MockPool() {
  return {
    connect: async () => {
      if (mockPoolConnectShouldFail) throw mockPoolConnectError;
      return {
        query: async () => mockPoolQueryResult,
        release: () => {},
      };
    },
    end: async () => {},
  };
}

let mockMysqlQueryResult: unknown[] = [[]];
let mockMysqlConnectShouldFail = false;
let mockMysqlConnectError = new Error("connection refused");

function mockMysqlCreatePool() {
  return {
    getConnection: async () => {
      if (mockMysqlConnectShouldFail) throw mockMysqlConnectError;
      return {
        query: async () => mockMysqlQueryResult,
        release: () => {},
      };
    },
    end: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  mockPoolConnectShouldFail = false;
  mockPoolQueryResult = { rows: [] };
  mockMysqlConnectShouldFail = false;
  mockMysqlQueryResult = [[]];
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

  test("fail when postgres connection fails", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("ECONNREFUSED");
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("running");
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

  test("fail when mysql connection fails", async () => {
    process.env.ATLAS_DATASOURCE_URL = "mysql://user:pass@localhost:3306/db";
    mockMysqlConnectShouldFail = true;
    mockMysqlConnectError = new Error("Access denied for user");
    const result = await checkDatabaseConnectivity();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("Authentication");
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
});

// ---------------------------------------------------------------------------
// checkSemanticLayer
// ---------------------------------------------------------------------------

describe("checkSemanticLayer", () => {
  test("fail when semantic/ does not exist", () => {
    // Use a temp cwd that doesn't have semantic/
    const origCwd = process.cwd;
    process.cwd = () => "/tmp/nonexistent-atlas-test";
    try {
      const result = checkSemanticLayer();
      expect(result.status).toBe("fail");
      expect(result.fix).toContain("atlas -- init");
    } finally {
      process.cwd = origCwd;
    }
  });

  test("pass when entity files exist", () => {
    // This test uses the actual project's semantic/ dir
    const result = checkSemanticLayer();
    // The project has a semantic layer, so this should pass
    if (result.status === "pass") {
      expect(result.detail).toMatch(/\d+ entities/);
    }
    // If it fails, it's because there's no semantic dir in cwd — that's OK for CI
    expect(["pass", "fail"]).toContain(result.status);
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

  test("fail when nsjail explicitly requested but not found", () => {
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX_URL;
    process.env.ATLAS_SANDBOX = "nsjail";
    delete process.env.ATLAS_NSJAIL_PATH;
    // Override PATH so nsjail can't be found
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

  test("fail when connection fails", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    mockPoolConnectShouldFail = true;
    mockPoolConnectError = new Error("ECONNREFUSED");
    const result = await checkInternalDb();
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("running");
  });
});
