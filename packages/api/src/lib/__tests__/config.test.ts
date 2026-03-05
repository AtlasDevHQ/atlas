/**
 * Tests for atlas.config.ts declarative configuration.
 *
 * Covers:
 * - defineConfig() type-safe helper
 * - configFromEnv() env var fallback
 * - Zod validation (validateAndResolve)
 * - loadConfig() from file vs env var fallback
 * - applyDatasources() wiring into ConnectionRegistry
 * - validateToolConfig() warnings
 * - initializeConfig() integration
 * - Backward compatibility
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

// Mock database drivers so ConnectionRegistry.register() works without real DBs
mock.module("pg", () => ({
  Pool: class MockPool {
    async query() { return { rows: [], fields: [] }; }
    async connect() {
      return { async query() { return { rows: [], fields: [] }; }, release() {} };
    }
    async end() {}
  },
}));

mock.module("mysql2/promise", () => ({
  createPool: () => ({
    async getConnection() {
      return { async execute() { return [[], []]; }, release() {} };
    },
    async end() {},
  }),
}));

// Cache-busting imports
const configModPath = resolve(__dirname, "../config.ts");
const configMod = await import(`${configModPath}?t=${Date.now()}`);
const {
  defineConfig,
  configFromEnv,
  validateAndResolve,
  loadConfig,
  getConfig,
  applyDatasources,
  validateToolConfig,
  initializeConfig,
  _resetConfig,
} = configMod as typeof import("../config");

const connModPath = resolve(__dirname, "../db/connection.ts");
const connMod = await import(`${connModPath}?t=${Date.now()}`);
const ConnectionRegistry = connMod.ConnectionRegistry as typeof import("../db/connection").ConnectionRegistry;

// Temporary directory for config file tests — uses unique names per test
const tmpBase = resolve(__dirname, ".tmp-config-test");

function ensureTmpDir(subdir: string): string {
  const dir = resolve(tmpBase, subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmpBase() {
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

describe("defineConfig", () => {
  it("returns the config object unchanged (pass-through)", () => {
    const config = defineConfig({
      datasources: {
        default: { url: "postgresql://localhost/db" },
      },
    });
    expect(config.datasources).toEqual({
      default: { url: "postgresql://localhost/db" },
    });
  });

  it("allows minimal config (empty object)", () => {
    const config = defineConfig({});
    expect(config).toEqual({});
  });

  it("accepts all fields", () => {
    const config = defineConfig({
      datasources: {
        default: { url: "postgresql://host/data" },
        warehouse: { url: "postgresql://host/wh", schema: "analytics", description: "Data warehouse" },
      },
      tools: ["explore", "executeSQL"],
      auth: "api-key",
      semanticLayer: "./custom-semantic",
    });
    expect(config.tools).toEqual(["explore", "executeSQL"]);
    expect(config.auth).toBe("api-key");
    expect(config.semanticLayer).toBe("./custom-semantic");
  });

  it("preserves description through defineConfig", () => {
    const config = defineConfig({
      datasources: {
        warehouse: { url: "postgresql://host/wh", description: "Analytics warehouse" },
      },
    });
    expect(config.datasources!.warehouse.description).toBe("Analytics warehouse");
  });

  it("accepts pool config fields (maxConnections, idleTimeoutMs, rateLimit)", () => {
    const config = defineConfig({
      datasources: {
        default: {
          url: "postgresql://host/db",
          maxConnections: 20,
          idleTimeoutMs: 60000,
          rateLimit: { queriesPerMinute: 30, concurrency: 3 },
        },
      },
      maxTotalConnections: 200,
    });
    expect(config.datasources!.default.maxConnections).toBe(20);
    expect(config.datasources!.default.idleTimeoutMs).toBe(60000);
    expect(config.datasources!.default.rateLimit!.queriesPerMinute).toBe(30);
    expect(config.maxTotalConnections).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// configFromEnv
// ---------------------------------------------------------------------------

describe("configFromEnv", () => {
  const origUrl = process.env.ATLAS_DATASOURCE_URL;
  const origSchema = process.env.ATLAS_SCHEMA;

  beforeEach(() => {
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_SCHEMA;
  });

  afterEach(() => {
    if (origUrl !== undefined) process.env.ATLAS_DATASOURCE_URL = origUrl;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origSchema !== undefined) process.env.ATLAS_SCHEMA = origSchema;
    else delete process.env.ATLAS_SCHEMA;
  });

  it("builds config from ATLAS_DATASOURCE_URL", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/test";
    const config = configFromEnv();
    expect(config.source).toBe("env");
    expect(config.datasources.default).toEqual({ url: "postgresql://host/test" });
    expect(config.tools).toEqual(["explore", "executeSQL"]);
    expect(config.auth).toBe("auto");
    expect(config.semanticLayer).toBe("./semantic");
  });

  it("includes schema when ATLAS_SCHEMA is set", () => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/db";
    process.env.ATLAS_SCHEMA = "analytics";
    const config = configFromEnv();
    expect(config.datasources.default).toEqual({
      url: "postgresql://host/db",
      schema: "analytics",
    });
  });

  it("returns empty datasources when ATLAS_DATASOURCE_URL is not set", () => {
    const config = configFromEnv();
    expect(config.datasources).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateAndResolve (Zod validation)
// ---------------------------------------------------------------------------

describe("validateAndResolve", () => {
  it("validates and resolves a minimal config", () => {
    const resolved = validateAndResolve({});
    expect(resolved.source).toBe("file");
    expect(resolved.datasources).toEqual({});
    expect(resolved.tools).toEqual(["explore", "executeSQL"]);
    expect(resolved.auth).toBe("auto");
    expect(resolved.semanticLayer).toBe("./semantic");
  });

  it("resolves a full config", () => {
    const resolved = validateAndResolve({
      datasources: {
        default: { url: "postgresql://host/data" },
        warehouse: { url: "postgresql://host/wh", schema: "sales" },
      },
      tools: ["explore"],
      auth: "managed",
      semanticLayer: "./custom",
    });
    expect(resolved.datasources.warehouse).toEqual({
      url: "postgresql://host/wh",
      schema: "sales",
    });
    expect(resolved.tools).toEqual(["explore"]);
    expect(resolved.auth).toBe("managed");
    expect(resolved.semanticLayer).toBe("./custom");
  });

  it("preserves description through validateAndResolve", () => {
    const resolved = validateAndResolve({
      datasources: {
        default: { url: "postgresql://host/data" },
        warehouse: { url: "postgresql://host/wh", description: "Analytics warehouse" },
      },
    });
    expect(resolved.datasources.warehouse.description).toBe("Analytics warehouse");
    expect(resolved.datasources.default.description).toBeUndefined();
  });

  it("throws on invalid auth value", () => {
    expect(() => validateAndResolve({ auth: "invalid-mode" })).toThrow(
      "Invalid atlas.config.ts",
    );
  });

  it("throws on empty datasource URL", () => {
    expect(() =>
      validateAndResolve({ datasources: { default: { url: "" } } }),
    ).toThrow("Invalid atlas.config.ts");
  });

  it("throws on non-string datasource URL", () => {
    expect(() =>
      validateAndResolve({ datasources: { default: { url: 123 } } }),
    ).toThrow("Invalid atlas.config.ts");
  });

  it("throws when tools is not an array", () => {
    expect(() => validateAndResolve({ tools: "explore" })).toThrow(
      "Invalid atlas.config.ts",
    );
  });

  it("accepts all valid auth modes", () => {
    const validModes = ["auto", "none", "api-key", "managed", "byot"] as const;
    for (const auth of validModes) {
      const resolved = validateAndResolve({ auth });
      expect(resolved.auth).toBe(auth);
    }
  });

  it("throws on function input (type guard)", () => {
    expect(() => validateAndResolve(() => ({}))).toThrow(
      "must export a plain object. Got function",
    );
  });

  it("throws on array input (type guard)", () => {
    expect(() => validateAndResolve([{ datasources: {} }])).toThrow(
      "must export a plain object. Got array",
    );
  });

  it("throws on string input (type guard)", () => {
    expect(() => validateAndResolve("not an object")).toThrow(
      "must export a plain object. Got string",
    );
  });

  it("accepts and resolves pool/rate-limit fields", () => {
    const resolved = validateAndResolve({
      datasources: {
        default: {
          url: "postgresql://host/data",
          maxConnections: 20,
          idleTimeoutMs: 60000,
          rateLimit: { queriesPerMinute: 30, concurrency: 3 },
        },
      },
      maxTotalConnections: 200,
    });
    expect(resolved.datasources.default.maxConnections).toBe(20);
    expect(resolved.datasources.default.idleTimeoutMs).toBe(60000);
    expect(resolved.datasources.default.rateLimit!.queriesPerMinute).toBe(30);
    expect(resolved.maxTotalConnections).toBe(200);
  });

  it("defaults work when pool/rate-limit fields are omitted", () => {
    const resolved = validateAndResolve({
      datasources: {
        default: { url: "postgresql://host/data" },
      },
    });
    expect(resolved.datasources.default.maxConnections).toBeUndefined();
    expect(resolved.datasources.default.idleTimeoutMs).toBeUndefined();
    expect(resolved.datasources.default.rateLimit).toBeUndefined();
    expect(resolved.maxTotalConnections).toBe(100);
  });

  it("includes field path in error messages", () => {
    try {
      validateAndResolve({ datasources: { bad: { url: "" } } });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("datasources.bad.url");
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig (file loading)
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  const origUrl = process.env.ATLAS_DATASOURCE_URL;
  const origSchema = process.env.ATLAS_SCHEMA;
  let testCounter = 0;

  beforeEach(() => {
    _resetConfig();
    delete process.env.ATLAS_DATASOURCE_URL;
    delete process.env.ATLAS_SCHEMA;
    testCounter++;
  });

  afterEach(() => {
    _resetConfig();
    if (origUrl !== undefined) process.env.ATLAS_DATASOURCE_URL = origUrl;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origSchema !== undefined) process.env.ATLAS_SCHEMA = origSchema;
    else delete process.env.ATLAS_SCHEMA;
  });

  afterEach(cleanTmpBase);

  it("falls back to env vars when no config file exists", async () => {
    const dir = ensureTmpDir(`load-env-${testCounter}`);
    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/test";
    process.env.ATLAS_SCHEMA = "custom";

    const config = await loadConfig(dir);
    expect(config.source).toBe("env");
    expect(config.datasources.default).toEqual({
      url: "postgresql://host/test",
      schema: "custom",
    });
  });

  it("loads config from atlas.config.ts file", async () => {
    const dir = ensureTmpDir(`load-ts-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default {
        datasources: {
          default: { url: "postgresql://host/data" },
          warehouse: { url: "postgresql://host/wh", schema: "sales" },
        },
        tools: ["explore", "executeSQL"],
        auth: "api-key",
        semanticLayer: "./my-semantic",
      };`,
    );

    const config = await loadConfig(dir);
    expect(config.source).toBe("file");
    expect(Object.keys(config.datasources)).toEqual(["default", "warehouse"]);
    expect(config.datasources.warehouse).toEqual({
      url: "postgresql://host/wh",
      schema: "sales",
    });
    expect(config.auth).toBe("api-key");
    expect(config.semanticLayer).toBe("./my-semantic");
  });

  it("loads config from atlas.config.js file", async () => {
    const dir = ensureTmpDir(`load-js-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.js"),
      `module.exports = {
        datasources: {
          default: { url: "postgresql://host/fallback" },
        },
      };`,
    );

    const config = await loadConfig(dir);
    expect(config.source).toBe("file");
    expect(config.datasources.default.url).toBe("postgresql://host/fallback");
  });

  it("populates getConfig() after loading", async () => {
    const dir = ensureTmpDir(`load-getconfig-${testCounter}`);
    expect(getConfig()).toBeNull();

    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/test";
    const config = await loadConfig(dir);
    expect(getConfig()).toBe(config);
  });

  it("applies defaults for omitted fields in config file", async () => {
    const dir = ensureTmpDir(`load-defaults-${testCounter}`);
    writeFileSync(resolve(dir, "atlas.config.ts"), `export default {};`);

    const config = await loadConfig(dir);
    expect(config.source).toBe("file");
    expect(config.datasources).toEqual({});
    expect(config.tools).toEqual(["explore", "executeSQL"]);
    expect(config.auth).toBe("auto");
    expect(config.semanticLayer).toBe("./semantic");
  });

  it("throws on invalid auth value in config file", async () => {
    const dir = ensureTmpDir(`load-bad-auth-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { auth: "invalid-mode" };`,
    );

    await expect(loadConfig(dir)).rejects.toThrow("Invalid atlas.config.ts");
  });

  it("throws on empty datasource URL in config file", async () => {
    const dir = ensureTmpDir(`load-bad-url-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { datasources: { default: { url: "" } } };`,
    );

    await expect(loadConfig(dir)).rejects.toThrow("Invalid atlas.config.ts");
  });

  it("throws on malformed config file (syntax error)", async () => {
    const dir = ensureTmpDir(`load-syntax-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default {{{ broken`,
    );

    await expect(loadConfig(dir)).rejects.toThrow("Failed to load config file");
  });

  it("throws when config file has only named exports (no default)", async () => {
    const dir = ensureTmpDir(`load-named-only-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export const config = { datasources: { default: { url: "postgresql://host/data" } } };`,
    );

    await expect(loadConfig(dir)).rejects.toThrow(
      "does not have a default export",
    );
  });

  it("throws when config file exports a function instead of an object", async () => {
    const dir = ensureTmpDir(`load-function-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default () => ({ datasources: {} });`,
    );

    await expect(loadConfig(dir)).rejects.toThrow(
      "must export a plain object",
    );
  });

  it("throws when config file exports an array instead of an object", async () => {
    const dir = ensureTmpDir(`load-array-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default [{ datasources: {} }];`,
    );

    await expect(loadConfig(dir)).rejects.toThrow(
      "must export a plain object. Got array",
    );
  });

  it("prefers atlas.config.ts over atlas.config.js", async () => {
    const dir = ensureTmpDir(`load-prefer-ts-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { auth: "api-key" };`,
    );
    writeFileSync(
      resolve(dir, "atlas.config.js"),
      `module.exports = { auth: "managed" };`,
    );

    const config = await loadConfig(dir);
    expect(config.auth).toBe("api-key");
  });
});

// ---------------------------------------------------------------------------
// applyDatasources (wiring into ConnectionRegistry)
// ---------------------------------------------------------------------------

describe("applyDatasources", () => {
  let testRegistry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    testRegistry = new ConnectionRegistry();
  });

  afterEach(() => {
    testRegistry._reset();
  });

  it("registers datasources from config into ConnectionRegistry", async () => {
    await applyDatasources(
      {
        datasources: {
          analytics: { url: "postgresql://host/analytics" },
          reporting: { url: "mysql://host/reporting" },
        },
        tools: ["explore", "executeSQL"],
        auth: "auto",
        semanticLayer: "./semantic",
        maxTotalConnections: 100,
        source: "file",
      },
      testRegistry,
    );

    expect(testRegistry.list()).toContain("analytics");
    expect(testRegistry.list()).toContain("reporting");
    expect(testRegistry.get("analytics")).toBeDefined();
    expect(testRegistry.get("reporting")).toBeDefined();
  });

  it("skips registration when datasources is empty (env var fallback)", async () => {
    await applyDatasources(
      {
        datasources: {},
        tools: ["explore", "executeSQL"],
        auth: "auto",
        semanticLayer: "./semantic",
        maxTotalConnections: 100,
        source: "env",
      },
      testRegistry,
    );

    expect(testRegistry.list()).toEqual([]);
  });

  it("registers default datasource from config file", async () => {
    await applyDatasources(
      {
        datasources: {
          default: { url: "postgresql://host/main" },
        },
        tools: ["explore", "executeSQL"],
        auth: "auto",
        semanticLayer: "./semantic",
        maxTotalConnections: 100,
        source: "file",
      },
      testRegistry,
    );

    expect(testRegistry.list()).toContain("default");
    const conn = testRegistry.get("default");
    expect(conn).toBeDefined();
    expect(conn.query).toBeFunction();
  });

  it("registers multiple datasource types", async () => {
    await applyDatasources(
      {
        datasources: {
          pg: { url: "postgresql://host/db", schema: "sales" },
          mysql: { url: "mysql://host/db" },
        },
        tools: [],
        auth: "auto",
        semanticLayer: "./semantic",
        maxTotalConnections: 100,
        source: "file",
      },
      testRegistry,
    );

    expect(testRegistry.list().sort()).toEqual(["mysql", "pg"]);
    expect(testRegistry.getDBType("pg")).toBe("postgres");
    expect(testRegistry.getDBType("mysql")).toBe("mysql");
  });

  it("passes description through to ConnectionRegistry", async () => {
    await applyDatasources(
      {
        datasources: {
          main: { url: "postgresql://user:pass@host:5432/main", description: "Primary DB" },
          reporting: { url: "mysql://user:pass@host:3306/reporting" },
        },
        tools: [],
        auth: "auto",
        semanticLayer: "./semantic",
        maxTotalConnections: 100,
        source: "file",
      },
      testRegistry,
    );

    const meta = testRegistry.describe();
    const mainMeta = meta.find((m) => m.id === "main");
    expect(mainMeta!.description).toBe("Primary DB");
    const reportingMeta = meta.find((m) => m.id === "reporting");
    expect(reportingMeta!.description).toBeUndefined();
  });

  it("passes pool config (maxConnections, idleTimeoutMs) to ConnectionRegistry", async () => {
    await applyDatasources(
      {
        datasources: {
          default: {
            url: "postgresql://host/main",
            maxConnections: 25,
            idleTimeoutMs: 45000,
          },
        },
        tools: [],
        auth: "auto",
        semanticLayer: "./semantic",
        maxTotalConnections: 100,
        source: "file",
      },
      testRegistry,
    );

    expect(testRegistry.list()).toContain("default");
    expect(testRegistry.get("default")).toBeDefined();
  });

  it("throws with datasource ID when registration fails", async () => {
    // An invalid schema name (contains SQL injection chars) triggers
    // the regex guard in createPostgresDB, causing register() to throw.
    await expect(
      applyDatasources(
        {
          datasources: {
            good: { url: "postgresql://host/ok" },
            broken: { url: "postgresql://host/db", schema: "bad; DROP TABLE" },
          },
          tools: [],
          auth: "auto",
          semanticLayer: "./semantic",
          maxTotalConnections: 100,
          source: "file",
        },
        testRegistry,
      ),
    ).rejects.toThrow(/Failed to register datasource "broken"/);
  });
});

// ---------------------------------------------------------------------------
// validateToolConfig
// ---------------------------------------------------------------------------

describe("validateToolConfig", () => {
  it("does not throw for valid tool names", async () => {
    // Use the real defaultRegistry (from the non-cache-busted import path)
    const { defaultRegistry } = await import("@atlas/api/lib/tools/registry");
    await expect(
      validateToolConfig(
        {
          datasources: {},
          tools: ["explore", "executeSQL"],
          auth: "auto",
          semanticLayer: "./semantic",
          maxTotalConnections: 100,
          source: "env",
        },
        defaultRegistry,
      ),
    ).resolves.toBeUndefined();
  });

  it("throws for unknown tool names", async () => {
    const { defaultRegistry } = await import("@atlas/api/lib/tools/registry");
    await expect(
      validateToolConfig(
        {
          datasources: {},
          tools: ["explore", "unknownTool"],
          auth: "auto",
          semanticLayer: "./semantic",
          maxTotalConnections: 100,
          source: "env",
        },
        defaultRegistry,
      ),
    ).rejects.toThrow("Unknown tool(s) in config: unknownTool");
  });

  it("includes available tools in unknown tool error message", async () => {
    const { defaultRegistry } = await import("@atlas/api/lib/tools/registry");
    try {
      await validateToolConfig(
        {
          datasources: {},
          tools: ["typoTool"],
          auth: "auto",
          semanticLayer: "./semantic",
          maxTotalConnections: 100,
          source: "env",
        },
        defaultRegistry,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Available:");
      expect(msg).toContain("explore");
      expect(msg).toContain("executeSQL");
    }
  });
});

// ---------------------------------------------------------------------------
// initializeConfig (integration)
// ---------------------------------------------------------------------------

describe("initializeConfig", () => {
  const origUrl = process.env.ATLAS_DATASOURCE_URL;
  let testCounter = 0;
  let testConnRegistry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    _resetConfig();
    testConnRegistry = new ConnectionRegistry();
    delete process.env.ATLAS_DATASOURCE_URL;
    testCounter++;
  });

  afterEach(() => {
    _resetConfig();
    testConnRegistry._reset();
    cleanTmpBase();
    if (origUrl !== undefined) process.env.ATLAS_DATASOURCE_URL = origUrl;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  it("works with env vars when no config file", async () => {
    const dir = ensureTmpDir(`init-env-${testCounter}`);
    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/env";

    const config = await initializeConfig(dir, {
      connectionRegistry: testConnRegistry,
    });
    expect(config.source).toBe("env");
    // env-synthesized config includes default datasource
    expect(testConnRegistry.list()).toContain("default");
  });

  it("throws on invalid config file", async () => {
    const dir = ensureTmpDir(`init-invalid-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { auth: 12345 };`,
    );

    await expect(
      initializeConfig(dir, { connectionRegistry: testConnRegistry }),
    ).rejects.toThrow("Invalid atlas.config.ts");
  });

  it("loads file config and registers datasources", async () => {
    const dir = ensureTmpDir(`init-file-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default {
        datasources: {
          main: { url: "postgresql://host/main" },
          secondary: { url: "mysql://host/sec" },
        },
      };`,
    );

    const config = await initializeConfig(dir, {
      connectionRegistry: testConnRegistry,
    });
    expect(config.source).toBe("file");
    expect(testConnRegistry.list()).toContain("main");
    expect(testConnRegistry.list()).toContain("secondary");
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  const origUrl = process.env.ATLAS_DATASOURCE_URL;
  let testCounter = 0;
  let testConnRegistry: InstanceType<typeof ConnectionRegistry>;

  beforeEach(() => {
    _resetConfig();
    testConnRegistry = new ConnectionRegistry();
    delete process.env.ATLAS_DATASOURCE_URL;
    testCounter++;
  });

  afterEach(() => {
    _resetConfig();
    testConnRegistry._reset();
    cleanTmpBase();
    if (origUrl !== undefined) process.env.ATLAS_DATASOURCE_URL = origUrl;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  it("env-var-only deploy: default datasource registered from env", async () => {
    const dir = ensureTmpDir(`compat-env-${testCounter}`);
    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/legacy";

    // Simulate the no-config-file path
    const config = await loadConfig(dir);
    expect(config.source).toBe("env");
    // configFromEnv includes the default datasource from ATLAS_DATASOURCE_URL
    expect(config.datasources.default.url).toBe("postgresql://host/legacy");

    // applyDatasources registers the default from the env-synthesized config
    await applyDatasources(config, testConnRegistry);
    expect(testConnRegistry.list()).toContain("default");

    // getDefault() returns the pre-registered connection (no lazy-init needed)
    const conn = testConnRegistry.getDefault();
    expect(conn).toBeDefined();
  });

  it("env-var-only deploy without ATLAS_DATASOURCE_URL: getDefault() lazy-inits", async () => {
    const dir = ensureTmpDir(`compat-no-env-${testCounter}`);
    // ATLAS_DATASOURCE_URL is not set

    const config = await loadConfig(dir);
    expect(config.source).toBe("env");
    expect(config.datasources).toEqual({});

    // applyDatasources skips (no datasources in env config)
    await applyDatasources(config, testConnRegistry);
    expect(testConnRegistry.list()).toEqual([]);

    // getDefault() would throw since no default registered and no env var
    expect(() => testConnRegistry.getDefault()).toThrow(
      "No analytics datasource configured",
    );
  });

  it("config file with default datasource pre-registers, blocking env var lookup", async () => {
    const dir = ensureTmpDir(`compat-file-${testCounter}`);
    process.env.ATLAS_DATASOURCE_URL = "postgresql://host/should-not-use";

    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default {
        datasources: {
          default: { url: "postgresql://host/from-config" },
        },
      };`,
    );

    const config = await loadConfig(dir);
    expect(config.source).toBe("file");

    await applyDatasources(config, testConnRegistry);
    expect(testConnRegistry.list()).toContain("default");
    // The connection was registered from config, not from env var
    expect(config.datasources.default.url).toBe("postgresql://host/from-config");
  });
});

// ---------------------------------------------------------------------------
// Plugin validation in validateAndResolve
// ---------------------------------------------------------------------------

describe("plugin validation", () => {
  it("accepts valid plugin objects", () => {
    const resolved = validateAndResolve({
      plugins: [
        {
          id: "my-plugin",
          type: "datasource",
          version: "1.0.0",
          connection: { create: () => ({}), dbType: "postgres" },
        },
        {
          id: "ctx-plugin",
          type: "context",
          version: "2.0.0",
          contextProvider: { load: async () => "" },
        },
      ],
    });
    expect(resolved.plugins).toHaveLength(2);
  });

  it("accepts empty plugins array", () => {
    const resolved = validateAndResolve({ plugins: [] });
    expect(resolved.plugins).toBeUndefined();
  });

  it("throws when plugin is missing id", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { type: "datasource", version: "1.0.0" },
        ],
      }),
    ).toThrow('missing "id"');
  });

  it("throws when plugin has empty id", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { id: "  ", type: "datasource", version: "1.0.0" },
        ],
      }),
    ).toThrow('empty "id"');
  });

  it("throws when plugin is missing type", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { id: "my-plugin", version: "1.0.0" },
        ],
      }),
    ).toThrow('missing "type"');
  });

  it("throws when plugin has invalid type", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { id: "my-plugin", type: "invalid", version: "1.0.0" },
        ],
      }),
    ).toThrow('invalid type "invalid"');
  });

  it("throws when plugin is missing version", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { id: "my-plugin", type: "datasource" },
        ],
      }),
    ).toThrow('missing "version"');
  });

  it("throws when plugin has empty version", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { id: "my-plugin", type: "datasource", version: "" },
        ],
      }),
    ).toThrow('empty "version"');
  });

  it("throws when plugin is null", () => {
    expect(() =>
      validateAndResolve({
        plugins: [null],
      }),
    ).toThrow("expected a plugin object, got null");
  });

  it("throws when plugin is undefined", () => {
    expect(() =>
      validateAndResolve({
        plugins: [undefined],
      }),
    ).toThrow("expected a plugin object, got undefined");
  });

  it("throws when plugin is a string", () => {
    expect(() =>
      validateAndResolve({
        plugins: ["not-a-plugin"],
      }),
    ).toThrow("expected a plugin object, got string");
  });

  it("throws on duplicate plugin IDs", () => {
    expect(() =>
      validateAndResolve({
        plugins: [
          { id: "my-plugin", type: "datasource", version: "1.0.0" },
          { id: "my-plugin", type: "context", version: "2.0.0" },
        ],
      }),
    ).toThrow('duplicate id "my-plugin"');
  });

  it("uses generic label for whitespace-only id (not the whitespace as name)", () => {
    try {
      validateAndResolve({
        plugins: [
          { id: "  ", type: "datasource", version: "1.0.0" },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("plugin at index 0");
      expect(msg).toContain('empty "id"');
    }
  });

  it("includes plugin id in error message when available", () => {
    try {
      validateAndResolve({
        plugins: [
          { id: "good", type: "datasource", version: "1.0.0" },
          { id: "bad-plugin", type: "invalid", version: "1.0.0" },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain('"bad-plugin"');
    }
  });

  it("collects multiple errors across plugins", () => {
    try {
      validateAndResolve({
        plugins: [
          { type: "datasource", version: "1.0.0" },  // missing id
          { id: "p2", version: "1.0.0" },             // missing type
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('missing "id"');
      expect(msg).toContain('missing "type"');
    }
  });

  it("accepts plugins produced by createPlugin factory", () => {
    // Simulate what createPlugin returns — a plain object with id, type, version, config
    const factoryPlugin = {
      id: "bigquery",
      type: "datasource",
      version: "1.0.0",
      config: { projectId: "my-proj", dataset: "analytics" },
      connection: { create: () => ({}), dbType: "bigquery" },
    };

    const resolved = validateAndResolve({ plugins: [factoryPlugin] });
    expect(resolved.plugins).toHaveLength(1);
  });
});
