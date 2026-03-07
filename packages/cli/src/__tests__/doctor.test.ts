import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

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

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  confirm: async () => false,
  text: async () => "",
  select: async () => "",
  selectKey: async () => "",
  multiselect: async () => [],
  group: async () => ({}),
  groupMultiselect: async () => [],
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {} }),
  stream: { info: () => {} },
  tasks: async () => {},
  password: async () => "",
  isCancel: () => false,
  log: { info: () => {}, warn: () => {}, error: () => {}, step: () => {}, success: () => {}, message: () => {} },
  updateSettings: () => {},
}));

mock.module("picocolors", () => ({
  default: {
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    white: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    underline: (s: string) => s,
    italic: (s: string) => s,
    strikethrough: (s: string) => s,
    inverse: (s: string) => s,
    hidden: (s: string) => s,
    reset: (s: string) => s,
    bgRed: (s: string) => s,
    bgGreen: (s: string) => s,
    bgYellow: (s: string) => s,
    bgBlue: (s: string) => s,
    bgMagenta: (s: string) => s,
    bgCyan: (s: string) => s,
    bgWhite: (s: string) => s,
    isColorSupported: false,
    createColors: () => ({}),
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
  renderResults,
  runDoctor,
  type CheckResult,
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
// Env + temp dir helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
let tmpDir: string | null = null;

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

  // Cleanup temp dir
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

/** Create a temp directory with a semantic layer structure. */
function createTmpSemantic(entities: Record<string, string> = {}, metrics: string[] = []): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-doctor-test-"));
  const entDir = path.join(tmpDir, "semantic", "entities");
  const metDir = path.join(tmpDir, "semantic", "metrics");
  fs.mkdirSync(entDir, { recursive: true });
  fs.mkdirSync(metDir, { recursive: true });

  for (const [name, content] of Object.entries(entities)) {
    fs.writeFileSync(path.join(entDir, name), content);
  }
  for (const name of metrics) {
    fs.writeFileSync(path.join(metDir, name), "metric: stub\n");
  }

  return tmpDir;
}

/** Run a function with a temporary cwd (uses actual chdir for path.resolve). */
async function withCwd<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(orig);
  }
}

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
// checkSemanticLayer
// ---------------------------------------------------------------------------

describe("checkSemanticLayer", () => {
  test("fail when semantic/ does not exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-empty-"));
    tmpDir = dir;
    const result = await withCwd(dir, () => checkSemanticLayer());
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("atlas -- init");
  });

  test("fail when entities dir exists but is empty", async () => {
    const dir = createTmpSemantic({}, []);
    const result = await withCwd(dir, () => checkSemanticLayer());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("No entity files");
  });

  test("pass with valid entity files", async () => {
    const dir = createTmpSemantic(
      {
        "users.yml": "table: users\ndescription: User accounts\n",
        "orders.yml": "table: orders\ndescription: Customer orders\n",
      },
      ["users.yml"],
    );
    const result = await withCwd(dir, () => checkSemanticLayer());
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("2 entities, 1 metrics");
  });

  test("warn with parse errors and shows multiple errors", async () => {
    const dir = createTmpSemantic({
      "valid.yml": "table: valid\n",
      "bad1.yml": "not_a_table: true\n",
      "bad2.yml": ": invalid yaml [",
    });
    const result = await withCwd(dir, () => checkSemanticLayer());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("1 entities");
    expect(result.detail).toContain("parse error");
    expect(result.fix).toContain("bad1.yml");
  });

  test("validates per-source subdirectory entities", async () => {
    const dir = createTmpSemantic({ "main.yml": "table: main\n" });
    // Add a per-source subdirectory with entities
    const subEntDir = path.join(dir, "semantic", "warehouse", "entities");
    fs.mkdirSync(subEntDir, { recursive: true });
    fs.writeFileSync(path.join(subEntDir, "products.yml"), "table: products\n");
    fs.writeFileSync(path.join(subEntDir, "bad.yml"), "no_table: true\n");

    const result = await withCwd(dir, () => checkSemanticLayer());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("2 entities");
    expect(result.fix).toContain("warehouse/bad.yml");
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

// ---------------------------------------------------------------------------
// renderResults
// ---------------------------------------------------------------------------

describe("renderResults", () => {
  test("renders without crashing on typical results", () => {
    const results: CheckResult[] = [
      { status: "pass", name: "Check A", detail: "OK" },
      { status: "fail", name: "Check B", detail: "Failed", fix: "Do X" },
      { status: "warn", name: "Check C", detail: "Maybe", fix: "Consider Y" },
    ];
    expect(() => renderResults(results)).not.toThrow();
  });

  test("handles empty results array without crashing", () => {
    expect(() => renderResults([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runDoctor (exit code logic)
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  test("returns 0 when all checks pass", async () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.ATLAS_PROVIDER = "ollama";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/atlas";
    process.env.ATLAS_RUNTIME = "vercel";

    // Mock successful DB connections
    mockPoolQueryResult = { rows: [{ version: "PostgreSQL 16.1" }] };

    // Need semantic layer
    const dir = createTmpSemantic({ "t.yml": "table: t\n" });
    const exitCode = await withCwd(dir, () => runDoctor());
    expect(exitCode).toBe(0);
  });

  test("returns 1 when a critical check fails", async () => {
    // No datasource URL = critical failure
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_DEMO_DATA;
    process.env.ATLAS_PROVIDER = "ollama";

    const dir = createTmpSemantic({ "t.yml": "table: t\n" });
    const exitCode = await withCwd(dir, () => runDoctor());
    expect(exitCode).toBe(1);
  });

  test("returns 0 when only optional checks fail (Sandbox, Internal DB)", async () => {
    process.env.ATLAS_DATASOURCE_URL = "clickhouse://localhost:8123/db";
    process.env.ATLAS_PROVIDER = "ollama";
    delete process.env.DATABASE_URL;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_NSJAIL_PATH;
    const origPath = process.env.PATH;
    process.env.PATH = "/tmp/empty-path";

    const dir = createTmpSemantic({ "t.yml": "table: t\n" });
    try {
      const exitCode = await withCwd(dir, () => runDoctor());
      // Sandbox = warn, Internal DB = warn — both optional, exit 0
      expect(exitCode).toBe(0);
    } finally {
      process.env.PATH = origPath;
    }
  });

  test("returns 0 when checks only warn", async () => {
    process.env.ATLAS_DATASOURCE_URL = "clickhouse://localhost:8123/db";
    process.env.ATLAS_PROVIDER = "ollama";
    delete process.env.DATABASE_URL;
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    const origPath = process.env.PATH;
    process.env.PATH = "/tmp/empty-path";

    const dir = createTmpSemantic({ "t.yml": "table: t\n" });
    try {
      const exitCode = await withCwd(dir, () => runDoctor());
      expect(exitCode).toBe(0);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
