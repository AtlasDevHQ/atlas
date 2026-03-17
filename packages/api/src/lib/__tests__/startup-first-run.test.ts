import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Control variables for mocks — mutated per-test in beforeEach
// ---------------------------------------------------------------------------

let mockDatasourceUrl: string | null = null;
let mockSemanticFiles: string[] | Error = ["orders.yml"];
let mockPgConnectError: Error | null = null;
let mockMysqlConnectError: Error | null = null;
let mockConfigResult: Record<string, unknown> | null = { source: "env" };
let mockConfigLoadError: Error | null = null;

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => {
    if (mockSemanticFiles instanceof Error) throw mockSemanticFiles;
    return mockSemanticFiles;
  },
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    detectDBType: (url: string) => {
      if (url.startsWith("mysql")) return "mysql";
      return "postgres";
    },
    resolveDatasourceUrl: () => mockDatasourceUrl,
  }),
);

mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
}));

mock.module("pg", () => ({
  Pool: class MockPool {
    async connect() {
      if (mockPgConnectError) throw mockPgConnectError;
      return {
        release: () => {},
        query: async () => ({ rows: [{ "?column?": 1 }] }),
      };
    }
    async end() {}
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => ({
    getConnection: async () => {
      if (mockMysqlConnectError) throw mockMysqlConnectError;
      return { release: () => {} };
    },
    end: async () => {},
  }),
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigResult,
  loadConfig: async () => {
    if (mockConfigLoadError) throw mockConfigLoadError;
    mockConfigResult = { source: "env" };
    return mockConfigResult;
  },
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

const { validateEnvironment, getStartupWarnings, resetStartupCache } =
  await import("@atlas/api/lib/startup");

const { maskConnectionUrl } = await import("@atlas/api/lib/security");

// ---------------------------------------------------------------------------
// Env snapshot — capture/restore only the vars this test touches
// ---------------------------------------------------------------------------

const MANAGED_VARS = [
  "ATLAS_DATASOURCE_URL", "DATABASE_URL", "ATLAS_API_KEY", "ATLAS_PROVIDER",
  "ATLAS_AUTH_MODE", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS", "ATLAS_AUTH_JWKS_URL", "ATLAS_AUTH_ISSUER",
  "ATLAS_AUTH_AUDIENCE", "ATLAS_SANDBOX", "ATLAS_SANDBOX_URL",
  "ATLAS_RUNTIME", "VERCEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID", "AI_GATEWAY_API_KEY", "ATLAS_DEMO_DATA",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED_VARS) saved[key] = process.env[key];
  resetStartupCache();
  resetAuthModeCache();

  // Clean all managed vars
  for (const key of MANAGED_VARS) delete process.env[key];

  // Default: ollama (no key needed), no datasource, semantic layer present, config loaded
  process.env.ATLAS_PROVIDER = "ollama";
  mockDatasourceUrl = null;
  mockSemanticFiles = ["orders.yml"];
  mockPgConnectError = null;
  mockMysqlConnectError = null;
  mockConfigResult = { source: "env" };
  mockConfigLoadError = null;
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
// 1. Missing LLM provider API key
// ---------------------------------------------------------------------------

describe("first-run: missing LLM provider API key", () => {
  it("includes env var name and signup URL for anthropic", async () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_API_KEY");
    expect(err).toBeDefined();
    expect(err!.message).toContain("ANTHROPIC_API_KEY");
    expect(err!.message).toContain(".env");
    expect(err!.message).toContain("console.anthropic.com");
  });

  it("includes env var name and signup URL for openai", async () => {
    process.env.ATLAS_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_API_KEY");
    expect(err).toBeDefined();
    expect(err!.message).toContain("OPENAI_API_KEY");
    expect(err!.message).toContain("platform.openai.com");
  });

  it("includes env var name and signup URL for gateway", async () => {
    process.env.ATLAS_PROVIDER = "gateway";
    delete process.env.AI_GATEWAY_API_KEY;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_API_KEY");
    expect(err).toBeDefined();
    expect(err!.message).toContain("AI_GATEWAY_API_KEY");
    expect(err!.message).toContain("vercel.com");
  });

  it("includes env var name without signup URL for bedrock", async () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    delete process.env.AWS_ACCESS_KEY_ID;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_API_KEY");
    expect(err).toBeDefined();
    expect(err!.message).toContain("AWS_ACCESS_KEY_ID");
    expect(err!.message).toContain(".env");
  });

  it("no error when using ollama (no key required)", async () => {
    process.env.ATLAS_PROVIDER = "ollama";

    const errors = await validateEnvironment();
    expect(errors.find((e) => e.code === "MISSING_API_KEY")).toBeUndefined();
  });

  it("no error when API key is set", async () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

    const errors = await validateEnvironment();
    expect(errors.find((e) => e.code === "MISSING_API_KEY")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Missing datasource URL
// ---------------------------------------------------------------------------

describe("first-run: missing datasource URL", () => {
  it("warns with format examples when ATLAS_DATASOURCE_URL not set", async () => {
    mockDatasourceUrl = null;

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) =>
        w.includes("ATLAS_DATASOURCE_URL") && w.includes("postgresql://"),
      ),
    ).toBe(true);
  });

  it("errors when DATABASE_URL is set but ATLAS_DATASOURCE_URL is not", async () => {
    mockDatasourceUrl = null;
    process.env.DATABASE_URL = "postgresql://atlas:atlas@localhost:5432/atlas";

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_DATASOURCE_URL");
    expect(err).toBeDefined();
    expect(err!.message).toContain("ATLAS_DATASOURCE_URL");
  });
});

// ---------------------------------------------------------------------------
// 3. Empty semantic layer
// ---------------------------------------------------------------------------

describe("first-run: empty semantic layer", () => {
  it("suggests running atlas init when no entities found", async () => {
    mockSemanticFiles = [];

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_SEMANTIC_LAYER");
    expect(err).toBeDefined();
    expect(err!.message).toContain("atlas");
    expect(err!.message).toContain("init");
  });

  it("suggests --demo option for demo data", async () => {
    mockSemanticFiles = [];

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_SEMANTIC_LAYER");
    expect(err).toBeDefined();
    expect(err!.message).toContain("--demo");
  });
});

// ---------------------------------------------------------------------------
// 4. Database unreachable — masked URLs
// ---------------------------------------------------------------------------

describe("first-run: database unreachable", () => {
  // Note: mock.module("pg") does not intercept require("pg") (native binding).
  // MySQL tests verify the masked URL integration; maskConnectionUrl is unit-tested below.

  it("shows masked URL in mysql connection error", async () => {
    mockDatasourceUrl = "mysql://admin:p4ssw0rd@mysql.example.com:3306/appdb";
    mockMysqlConnectError = new Error("connect ECONNREFUSED");

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "DB_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("***@mysql.example.com:3306");
    expect(err!.message).toContain("Database unreachable");
    expect(err!.message).not.toContain("p4ssw0rd");
    expect(err!.message).not.toContain("admin:p4ssw0rd");
  });

  it("does not leak connection credentials in mysql error messages", async () => {
    mockDatasourceUrl = "mysql://user:MyS3cretPass@host:3306/db";
    mockMysqlConnectError = new Error("timeout expired");

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "DB_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).not.toContain("MyS3cretPass");
    expect(err!.message).not.toContain("user:MyS3cretPass");
  });

  it("includes ECONNREFUSED hint for mysql", async () => {
    mockDatasourceUrl = "mysql://user:pass@host:3306/db";
    mockMysqlConnectError = new Error("connect ECONNREFUSED 127.0.0.1:3306");

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "DB_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("Database unreachable at 127.0.0.1:3306");
  });

  it("reports malformed postgres URL without leaking credentials", async () => {
    mockDatasourceUrl = "not-a-valid-url";

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "DB_UNREACHABLE");
    expect(err).toBeDefined();
    expect(err!.message).toContain("malformed");
  });
});

// ---------------------------------------------------------------------------
// 4b. maskConnectionUrl — unit tests
// ---------------------------------------------------------------------------

describe("maskConnectionUrl", () => {
  it("masks username and password in postgresql URL", () => {
    expect(maskConnectionUrl("postgresql://user:s3cret@host:5432/db")).toBe(
      "postgresql://***@host:5432/db",
    );
  });

  it("masks username and password in mysql URL", () => {
    expect(maskConnectionUrl("mysql://admin:p4ss@host:3306/db")).toBe(
      "mysql://***@host:3306/db",
    );
  });

  it("preserves URL without credentials", () => {
    expect(maskConnectionUrl("postgresql://host:5432/db")).toBe(
      "postgresql://host:5432/db",
    );
  });

  it("masks username-only URLs", () => {
    const result = maskConnectionUrl("postgresql://user@host:5432/db");
    expect(result).toContain("***@host:5432");
    expect(result).not.toContain("user@");
  });

  it("returns <invalid-url> for unparseable URLs", () => {
    expect(maskConnectionUrl("not-a-url")).toBe("<invalid-url>");
  });

  it("preserves non-sensitive query parameters", () => {
    const result = maskConnectionUrl("postgresql://user:pass@host:5432/db?sslmode=require");
    expect(result).toContain("sslmode=require");
    expect(result).not.toContain("pass");
  });

  it("masks sensitive query parameters", () => {
    const result = maskConnectionUrl("postgresql://user:pass@host:5432/db?password=secret&sslmode=require");
    expect(result).not.toContain("secret");
    expect(result).toContain("password=***");
    expect(result).toContain("sslmode=require");
  });
});

// ---------------------------------------------------------------------------
// 5. Invalid atlas.config.ts
// ---------------------------------------------------------------------------

describe("first-run: invalid atlas.config.ts", () => {
  it("shows Zod validation error with field path", async () => {
    mockConfigResult = null;
    mockConfigLoadError = new Error(
      "Invalid atlas.config.ts:\n  - datasources.default.url: Datasource URL must not be empty",
    );

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "INVALID_CONFIG");
    expect(err).toBeDefined();
    expect(err!.message).toContain("datasources.default.url");
    expect(err!.message).toContain("Datasource URL must not be empty");
  });

  it("no error when config is already loaded", async () => {
    mockConfigResult = { source: "file" };
    mockConfigLoadError = null;

    const errors = await validateEnvironment();
    expect(errors.find((e) => e.code === "INVALID_CONFIG")).toBeUndefined();
  });

  it("no error when no config file exists (env var fallback)", async () => {
    mockConfigResult = null;
    mockConfigLoadError = null;

    const errors = await validateEnvironment();
    expect(errors.find((e) => e.code === "INVALID_CONFIG")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Auth misconfiguration
// ---------------------------------------------------------------------------

describe("first-run: auth misconfiguration", () => {
  it("shows current length and generation hint for weak BETTER_AUTH_SECRET", async () => {
    process.env.BETTER_AUTH_SECRET = "too-short";

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "WEAK_AUTH_SECRET");
    expect(err).toBeDefined();
    expect(err!.message).toContain("currently 9");
    expect(err!.message).toContain("openssl rand");
  });

  it("shows specific guidance for BYOT mode missing ATLAS_AUTH_ISSUER", async () => {
    process.env.ATLAS_AUTH_JWKS_URL =
      "https://idp.example.com/.well-known/jwks.json";
    delete process.env.ATLAS_AUTH_ISSUER;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_AUTH_ISSUER");
    expect(err).toBeDefined();
    expect(err!.message).toContain("ATLAS_AUTH_ISSUER");
    expect(err!.message).toContain("issuer URL");
  });

  it("shows guidance when ATLAS_AUTH_MODE is explicit but prereq is missing", async () => {
    process.env.ATLAS_AUTH_MODE = "managed";
    delete process.env.BETTER_AUTH_SECRET;

    const errors = await validateEnvironment();
    const err = errors.find((e) => e.code === "MISSING_AUTH_PREREQ");
    expect(err).toBeDefined();
    expect(err!.message).toContain("BETTER_AUTH_SECRET");
    expect(err!.message).toContain("32 characters");
  });
});
