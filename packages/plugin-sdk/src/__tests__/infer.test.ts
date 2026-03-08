/**
 * Type-level tests for $InferServerPlugin utility type.
 *
 * Tests use @ts-expect-error to verify that invalid assignments are rejected.
 * Runtime assertions prevent unused-variable warnings.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type {
  $InferServerPlugin,
  AtlasDatasourcePlugin,
  AtlasContextPlugin,
  AtlasSandboxPlugin,
  PluginAction,
} from "../types";
import { createPlugin, definePlugin } from "../helpers";

// ---------------------------------------------------------------------------
// Self-contained test plugins (no external dependencies)
// ---------------------------------------------------------------------------

const testDatasourcePlugin = createPlugin({
  configSchema: z.object({
    url: z.string(),
    database: z.string().optional(),
  }),
  create: (config) => ({
    id: "test-datasource",
    types: ["datasource"] as const,
    version: "1.0.0",
    name: "Test DataSource",
    config,
    connection: {
      create: () => ({
        query: async () => ({ columns: [], rows: [] }),
        close: async () => {},
      }),
      dbType: "postgres" as const,
    },
  }),
});

const testActionPlugin = createPlugin({
  configSchema: z.object({
    host: z.string(),
    apiToken: z.string(),
  }),
  create: (config) => ({
    id: "test-action",
    types: ["action"] as const,
    version: "2.0.0",
    config,
    actions: [] as PluginAction[],
  }),
});

const testInteractionPlugin = createPlugin({
  configSchema: z.object({
    transport: z.enum(["stdio", "sse"]).default("stdio"),
    port: z.number().optional(),
  }),
  create: (config) => ({
    id: "test-interaction",
    types: ["interaction"] as const,
    version: "0.1.0",
    name: "Test Interaction",
    config,
  }),
});

const testContextPlugin = createPlugin({
  configSchema: z.object({
    semanticDir: z.string().optional(),
  }),
  create: (config) => ({
    id: "test-context-factory",
    types: ["context"] as const,
    version: "0.3.0",
    name: "Test Context Factory",
    config,
    contextProvider: { load: async () => "context" },
  }),
});

const testSandboxPlugin = createPlugin({
  configSchema: z.object({
    image: z.string(),
    memoryLimit: z.number().optional(),
  }),
  create: (config) => ({
    id: "test-sandbox",
    types: ["sandbox"] as const,
    version: "1.0.0",
    name: "Test Sandbox",
    config,
    sandbox: {
      create: async () => ({
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      }),
      priority: 80,
    },
    security: {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: true,
      description: "Test sandbox with full isolation",
    },
  }),
});

function buildTestContextPlugin(
  config: { semanticDir?: string } = {},
): AtlasContextPlugin<{ semanticDir?: string }> {
  return definePlugin({
    id: "test-context",
    types: ["context"] as const,
    version: "0.2.0",
    name: "Test Context",
    config,
    contextProvider: {
      load: async () => "context data",
    },
  });
}

// ---------------------------------------------------------------------------
// Type inference from createPlugin() factory functions
// ---------------------------------------------------------------------------

describe("$InferServerPlugin — createPlugin factory functions", () => {
  test("infers Config from datasource factory", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;

    // Valid config assignment
    const _config: DS["Config"] = { url: "postgres://localhost" };
    expect(_config.url).toBe("postgres://localhost");

    // Optional field works
    const _config2: DS["Config"] = { url: "pg://localhost", database: "mydb" };
    expect(_config2.database).toBe("mydb");

    // @ts-expect-error — missing required 'url'
    const _bad: DS["Config"] = {};
    void _bad;
  });

  test("infers Types from datasource factory", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;

    const _types: DS["Types"] = ["datasource"] as const;
    expect(_types).toEqual(["datasource"]);

    // @ts-expect-error — wrong type array
    const _badTypes: DS["Types"] = ["action"] as const;
    void _badTypes;
  });

  test("infers Config from action factory", () => {
    type ACT = $InferServerPlugin<typeof testActionPlugin>;

    const _config: ACT["Config"] = { host: "https://example.com", apiToken: "tok" };
    expect(_config.host).toBe("https://example.com");

    // @ts-expect-error — missing 'apiToken'
    const _bad: ACT["Config"] = { host: "x" };
    void _bad;
  });

  test("infers Types from action factory", () => {
    type ACT = $InferServerPlugin<typeof testActionPlugin>;

    const _types: ACT["Types"] = ["action"] as const;
    expect(_types).toEqual(["action"]);

    // @ts-expect-error — wrong type array
    const _badTypes: ACT["Types"] = ["datasource"] as const;
    void _badTypes;
  });

  test("infers Config from interaction factory", () => {
    type INT = $InferServerPlugin<typeof testInteractionPlugin>;

    const _config: INT["Config"] = { transport: "stdio" };
    expect(_config.transport).toBe("stdio");

    // Optional port
    const _config2: INT["Config"] = { transport: "sse", port: 8080 };
    expect(_config2.port).toBe(8080);
  });

  test("infers Types from interaction factory", () => {
    type INT = $InferServerPlugin<typeof testInteractionPlugin>;

    const _types: INT["Types"] = ["interaction"] as const;
    expect(_types).toEqual(["interaction"]);

    // @ts-expect-error — wrong type array
    const _badTypes: INT["Types"] = ["context"] as const;
    void _badTypes;
  });

  test("infers Config from context factory", () => {
    type CTX = $InferServerPlugin<typeof testContextPlugin>;

    const _config: CTX["Config"] = { semanticDir: "/data" };
    expect(_config.semanticDir).toBe("/data");

    // Optional field — empty object is valid
    const _config2: CTX["Config"] = {};
    expect(_config2).toEqual({});
  });

  test("infers Types from context factory", () => {
    type CTX = $InferServerPlugin<typeof testContextPlugin>;

    const _types: CTX["Types"] = ["context"] as const;
    expect(_types).toEqual(["context"]);

    // @ts-expect-error — wrong type array
    const _badTypes: CTX["Types"] = ["datasource"] as const;
    void _badTypes;
  });

  test("infers Version from factory", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;
    // Version is inferred as string (from the return type)
    const _version: DS["Version"] = "1.0.0";
    expect(_version).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Type inference from definePlugin() / direct plugin objects
// ---------------------------------------------------------------------------

describe("$InferServerPlugin — definePlugin / direct objects", () => {
  test("infers from definePlugin return value", () => {
    const plugin = buildTestContextPlugin({ semanticDir: "/data" });
    type CTX = $InferServerPlugin<typeof plugin>;

    // buildTestContextPlugin returns AtlasContextPlugin<...> — Types is readonly PluginType[]
    const _types: CTX["Types"] = ["context"];
    expect(_types).toEqual(["context"]);
  });

  test("infers Config from direct plugin object", () => {
    const plugin = buildTestContextPlugin();
    type CTX = $InferServerPlugin<typeof plugin>;

    const _config: CTX["Config"] = { semanticDir: "/semantic" };
    expect(_config.semanticDir).toBe("/semantic");

    // Optional field — undefined is valid
    const _config2: CTX["Config"] = {};
    expect(_config2).toEqual({});
  });

  test("infers from inline definePlugin with satisfies", () => {
    const plugin = definePlugin({
      id: "inline-ds",
      types: ["datasource"] as const,
      version: "3.0.0",
      connection: {
        create: () => ({
          query: async () => ({ columns: [], rows: [] }),
          close: async () => {},
        }),
        dbType: "clickhouse" as const,
      },
    } satisfies AtlasDatasourcePlugin);

    type P = $InferServerPlugin<typeof plugin>;
    const _types: P["Types"] = ["datasource"] as const;
    expect(_types).toEqual(["datasource"]);
  });
});

// ---------------------------------------------------------------------------
// Datasource-specific: DbType
// ---------------------------------------------------------------------------

describe("$InferServerPlugin — DbType", () => {
  test("extracts DbType from datasource factory", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;

    const _dbType: DS["DbType"] = "postgres";
    expect(_dbType).toBe("postgres");

    // @ts-expect-error — wrong DbType literal (verifies narrowing via `as const`)
    const _bad: DS["DbType"] = "mysql";
    void _bad;
  });

  test("DbType is never for action plugin", () => {
    type ACT = $InferServerPlugin<typeof testActionPlugin>;

    type DbTypeIsNever = ACT["DbType"] extends never ? true : false;
    const _check: DbTypeIsNever = true;
    expect(_check).toBe(true);

    // @ts-expect-error — DbType is never for non-datasource plugins
    const _bad: ACT["DbType"] = "postgres";
    void _bad;
  });

  test("DbType is never for interaction plugin", () => {
    type INT = $InferServerPlugin<typeof testInteractionPlugin>;

    type DbTypeIsNever = INT["DbType"] extends never ? true : false;
    const _check: DbTypeIsNever = true;
    expect(_check).toBe(true);
  });

  test("DbType is never for context plugin", () => {
    type CTX = $InferServerPlugin<typeof testContextPlugin>;

    type DbTypeIsNever = CTX["DbType"] extends never ? true : false;
    const _check: DbTypeIsNever = true;
    expect(_check).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Action-specific: Actions
// ---------------------------------------------------------------------------

describe("$InferServerPlugin — Actions", () => {
  test("extracts Actions from action factory", () => {
    type ACT = $InferServerPlugin<typeof testActionPlugin>;

    // Actions should be an array type
    const _actions: ACT["Actions"] = [];
    expect(_actions).toEqual([]);
  });

  test("Actions is never for datasource plugin", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;

    type ActionsIsNever = DS["Actions"] extends never ? true : false;
    const _check: ActionsIsNever = true;
    expect(_check).toBe(true);

    // @ts-expect-error — Actions is never for non-action plugins
    const _bad: DS["Actions"] = [];
    void _bad;
  });

  test("Actions is never for context plugin", () => {
    const plugin = buildTestContextPlugin();
    type CTX = $InferServerPlugin<typeof plugin>;

    type ActionsIsNever = CTX["Actions"] extends never ? true : false;
    const _check: ActionsIsNever = true;
    expect(_check).toBe(true);
  });

  test("Actions is never for interaction plugin", () => {
    type INT = $InferServerPlugin<typeof testInteractionPlugin>;

    type ActionsIsNever = INT["Actions"] extends never ? true : false;
    const _check: ActionsIsNever = true;
    expect(_check).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sandbox-specific: Security
// ---------------------------------------------------------------------------

describe("$InferServerPlugin — Security", () => {
  test("extracts Security from sandbox factory", () => {
    type SB = $InferServerPlugin<typeof testSandboxPlugin>;

    // Security should be the security metadata type
    const _security: SB["Security"] = {
      networkIsolation: true,
      filesystemIsolation: true,
      unprivilegedExecution: true,
      description: "Full isolation",
    };
    expect(_security.networkIsolation).toBe(true);
  });

  test("Security reflects the concrete factory return type", () => {
    type SB = $InferServerPlugin<typeof testSandboxPlugin>;

    // The inferred type mirrors what the factory actually returns —
    // since testSandboxPlugin specifies all four fields, all are required
    const _security: SB["Security"] = {
      networkIsolation: false,
      filesystemIsolation: false,
      unprivilegedExecution: false,
      description: "none",
    };
    expect(_security.networkIsolation).toBe(false);
  });

  test("Security is never for datasource plugin", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;

    type SecurityIsNever = DS["Security"] extends never ? true : false;
    const _check: SecurityIsNever = true;
    expect(_check).toBe(true);

    // @ts-expect-error — Security is never for non-sandbox plugins
    const _bad: DS["Security"] = {};
    void _bad;
  });

  test("Security is never for action plugin", () => {
    type ACT = $InferServerPlugin<typeof testActionPlugin>;

    type SecurityIsNever = ACT["Security"] extends never ? true : false;
    const _check: SecurityIsNever = true;
    expect(_check).toBe(true);
  });

  test("Security is never for context plugin", () => {
    type CTX = $InferServerPlugin<typeof testContextPlugin>;

    type SecurityIsNever = CTX["Security"] extends never ? true : false;
    const _check: SecurityIsNever = true;
    expect(_check).toBe(true);
  });

  test("Security is never for interaction plugin", () => {
    type INT = $InferServerPlugin<typeof testInteractionPlugin>;

    type SecurityIsNever = INT["Security"] extends never ? true : false;
    const _check: SecurityIsNever = true;
    expect(_check).toBe(true);
  });

  test("infers Types as ['sandbox'] from sandbox factory", () => {
    type SB = $InferServerPlugin<typeof testSandboxPlugin>;

    const _types: SB["Types"] = ["sandbox"] as const;
    expect(_types).toEqual(["sandbox"]);

    // @ts-expect-error — wrong type array
    const _badTypes: SB["Types"] = ["datasource"] as const;
    void _badTypes;
  });

  test("infers Config from sandbox factory", () => {
    type SB = $InferServerPlugin<typeof testSandboxPlugin>;

    const _config: SB["Config"] = { image: "docker.io/sandbox:latest" };
    expect(_config.image).toBe("docker.io/sandbox:latest");

    const _config2: SB["Config"] = { image: "sandbox", memoryLimit: 512 };
    expect(_config2.memoryLimit).toBe(512);

    // @ts-expect-error — missing required 'image'
    const _bad: SB["Config"] = {};
    void _bad;
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("$InferServerPlugin — edge cases", () => {
  test("plugin with no config field — Config infers as unknown", () => {
    const plugin = definePlugin({
      id: "no-config",
      types: ["context"] as const,
      version: "1.0.0",
      contextProvider: { load: async () => "" },
    } satisfies AtlasContextPlugin);

    type P = $InferServerPlugin<typeof plugin>;
    // When config is absent from the object literal, TypeScript's structural
    // matching infers C=unknown from the optional `config?: C` field.
    // This is expected — the plugin didn't declare a config type.
    type ConfigIsUnknown = unknown extends P["Config"] ? true : false;
    const _check: ConfigIsUnknown = true;
    expect(_check).toBe(true);
  });

  test("infers Name when provided", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;
    // Name is inferred as string (from the return type)
    const _name: DS["Name"] = "Test DataSource";
    expect(_name).toBe("Test DataSource");
  });

  test("infers Id as string", () => {
    type DS = $InferServerPlugin<typeof testDatasourcePlugin>;
    const _id: DS["Id"] = "test-datasource";
    expect(_id).toBe("test-datasource");
  });

  test("works with buildXPlugin function return type", () => {
    // Simulates typeof buildClickHousePlugin — a function that returns a plugin object
    function buildPlugin(config: { url: string }): AtlasDatasourcePlugin<{ url: string }> {
      return {
        id: "custom",
        types: ["datasource"],
        version: "1.0.0",
        config,
        connection: {
          create: () => ({
            query: async () => ({ columns: [], rows: [] }),
            close: async () => {},
          }),
          dbType: "postgres",
        },
      };
    }

    // Infer from function (same as factory — a function that takes config and returns plugin)
    type P = $InferServerPlugin<typeof buildPlugin>;
    const _config: P["Config"] = { url: "pg://localhost" };
    expect(_config.url).toBe("pg://localhost");

    // buildPlugin returns AtlasDatasourcePlugin<...> — Types is readonly PluginType[]
    const _types: P["Types"] = ["datasource"];
    expect(_types).toEqual(["datasource"]);

    // @ts-expect-error — missing url
    const _bad: P["Config"] = {};
    void _bad;
  });

  test("works with optional-config factory function", () => {
    // Simulates contextYamlPlugin pattern — plain function with optional config
    function optionalConfigFactory(
      config: { dir?: string } = {},
    ): AtlasContextPlugin<{ dir?: string }> {
      return definePlugin({
        id: "optional-cfg",
        types: ["context"] as const,
        version: "1.0.0",
        config,
        contextProvider: { load: async () => "" },
      });
    }

    type P = $InferServerPlugin<typeof optionalConfigFactory>;
    // Returns AtlasContextPlugin<...> — Types is readonly PluginType[]
    const _types: P["Types"] = ["context"];
    expect(_types).toEqual(["context"]);

    const _config: P["Config"] = { dir: "/semantic" };
    expect(_config.dir).toBe("/semantic");
  });

  test("type alias compiles and works in type position", () => {
    type T = $InferServerPlugin<typeof testDatasourcePlugin>;

    const typeCheck: T["Types"] = ["datasource"] as const;
    expect(typeCheck).toEqual(["datasource"]);
  });
});
