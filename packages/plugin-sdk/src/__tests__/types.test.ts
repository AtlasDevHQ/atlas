/* eslint-disable @typescript-eslint/no-explicit-any -- tests deliberately pass invalid config to verify runtime validation */
import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { tool } from "ai";
import {
  definePlugin,
  createPlugin,
  isDatasourcePlugin,
  isContextPlugin,
  isInteractionPlugin,
  isActionPlugin,
  isSandboxPlugin,
} from "../helpers";
import type {
  AtlasDatasourcePlugin,
  AtlasContextPlugin,
  AtlasInteractionPlugin,
  AtlasActionPlugin,
  AtlasSandboxPlugin,
} from "../types";

/** Minimal AI SDK tool for use in tests. */
const mockTool = tool({ description: "mock", inputSchema: z.object({}) });

describe("definePlugin", () => {
  test("returns input unchanged for datasource plugin", () => {
    const plugin: AtlasDatasourcePlugin = {
      id: "test-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("returns input unchanged for context plugin", () => {
    const plugin: AtlasContextPlugin = {
      id: "test-ctx",
      types: ["context"],
      version: "1.0.0",
      contextProvider: {
        load: async () => "extra context",
      },
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("returns input unchanged for interaction plugin", () => {
    const plugin: AtlasInteractionPlugin = {
      id: "test-int",
      types: ["interaction"],
      version: "1.0.0",
      routes: () => {},
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("returns input unchanged for action plugin", () => {
    const plugin: AtlasActionPlugin = {
      id: "test-action",
      types: ["action"],
      version: "1.0.0",
      actions: [
        {
          name: "doSomething",
          description: "Does something",
          tool: mockTool,
          actionType: "test:do",
          reversible: false,
          defaultApproval: "manual",
          requiredCredentials: [],
        },
      ],
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("returns input unchanged for sandbox plugin", () => {
    const plugin: AtlasSandboxPlugin = {
      id: "test-sandbox",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: () => ({
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
        priority: 75,
      },
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });
});

describe("type guards", () => {
  const datasource: AtlasDatasourcePlugin = {
    id: "ds",
    types: ["datasource"],
    version: "1.0.0",
    connection: {
      create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
      dbType: "postgres",
    },
  };

  const context: AtlasContextPlugin = {
    id: "ctx",
    types: ["context"],
    version: "1.0.0",
    contextProvider: { load: async () => "" },
  };

  const interaction: AtlasInteractionPlugin = {
    id: "int",
    types: ["interaction"],
    version: "1.0.0",
    routes: () => {},
  };

  const action: AtlasActionPlugin = {
    id: "act",
    types: ["action"],
    version: "1.0.0",
    actions: [],
  };

  const sandbox: AtlasSandboxPlugin = {
    id: "sb",
    types: ["sandbox"],
    version: "1.0.0",
    sandbox: {
      create: () => ({
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      }),
    },
  };

  test("isDatasourcePlugin correctly identifies datasource", () => {
    expect(isDatasourcePlugin(datasource)).toBe(true);
    expect(isDatasourcePlugin(context)).toBe(false);
    expect(isDatasourcePlugin(interaction)).toBe(false);
    expect(isDatasourcePlugin(action)).toBe(false);
    expect(isDatasourcePlugin(sandbox)).toBe(false);
  });

  test("isContextPlugin correctly identifies context", () => {
    expect(isContextPlugin(context)).toBe(true);
    expect(isContextPlugin(datasource)).toBe(false);
    expect(isContextPlugin(interaction)).toBe(false);
    expect(isContextPlugin(action)).toBe(false);
    expect(isContextPlugin(sandbox)).toBe(false);
  });

  test("isInteractionPlugin correctly identifies interaction", () => {
    expect(isInteractionPlugin(interaction)).toBe(true);
    expect(isInteractionPlugin(datasource)).toBe(false);
    expect(isInteractionPlugin(context)).toBe(false);
    expect(isInteractionPlugin(action)).toBe(false);
    expect(isInteractionPlugin(sandbox)).toBe(false);
  });

  test("isActionPlugin correctly identifies action", () => {
    expect(isActionPlugin(action)).toBe(true);
    expect(isActionPlugin(datasource)).toBe(false);
    expect(isActionPlugin(context)).toBe(false);
    expect(isActionPlugin(interaction)).toBe(false);
    expect(isActionPlugin(sandbox)).toBe(false);
  });

  test("isSandboxPlugin correctly identifies sandbox", () => {
    expect(isSandboxPlugin(sandbox)).toBe(true);
    expect(isSandboxPlugin(datasource)).toBe(false);
    expect(isSandboxPlugin(context)).toBe(false);
    expect(isSandboxPlugin(interaction)).toBe(false);
    expect(isSandboxPlugin(action)).toBe(false);
  });
});

describe("plugin with hooks and schema", () => {
  test("definePlugin accepts hooks with matcher pattern", () => {
    const plugin = definePlugin({
      id: "hooked",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      hooks: {
        beforeQuery: [
          {
            matcher: (ctx) => ctx.sql.includes("sensitive"),
            handler: () => {},
          },
        ],
        afterQuery: [{ handler: () => {} }],
        onRequest: [
          {
            matcher: (ctx) => ctx.path.startsWith("/api/"),
            handler: () => {},
          },
        ],
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.hooks?.beforeQuery).toHaveLength(1);
    expect(plugin.hooks?.afterQuery).toHaveLength(1);
    expect(plugin.hooks?.onRequest).toHaveLength(1);
  });

  test("definePlugin accepts schema definitions", () => {
    const plugin = definePlugin({
      id: "with-schema",
      types: ["action"],
      version: "1.0.0",
      actions: [],
      schema: {
        plugin_settings: {
          fields: {
            key: { type: "string", required: true, unique: true },
            value: { type: "string", required: true },
            enabled: { type: "boolean", defaultValue: true },
          },
        },
      },
    } satisfies AtlasActionPlugin);

    expect(plugin.schema?.plugin_settings.fields.key.type).toBe("string");
    expect(plugin.schema?.plugin_settings.fields.enabled.defaultValue).toBe(true);
  });

  test("factory function pattern works with options", () => {
    const myPlugin = (options: { prefix: string }) =>
      definePlugin({
        id: `${options.prefix}-plugin`,
        types: ["context"],
        version: "1.0.0",
        contextProvider: {
          load: async () => `context for ${options.prefix}`,
        },
      } satisfies AtlasContextPlugin);

    const instance = myPlugin({ prefix: "sales" });
    expect(instance.id).toBe("sales-plugin");
  });

  test("initialize receives AtlasPluginContext", () => {
    // Verify the type signature allows ctx parameter
    const plugin = definePlugin({
      id: "ctx-test",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      async initialize(ctx) {
        // ctx should be AtlasPluginContext
        ctx.logger.info("initializing");
        const conns = ctx.connections.list();
        expect(conns).toBeDefined();
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.initialize).toBeDefined();
  });
});

describe("mutable hook return types", () => {
  test("beforeQuery handler can return QueryHookMutation", () => {
    const plugin = definePlugin({
      id: "rls",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
      hooks: {
        beforeQuery: [{
          handler: (ctx) => ({ sql: `${ctx.sql} WHERE tenant_id = 1` }),
        }],
      },
    } satisfies AtlasContextPlugin);

    expect(plugin.hooks?.beforeQuery).toHaveLength(1);
  });

  test("beforeQuery handler can return void (observation-only)", () => {
    const plugin = definePlugin({
      id: "observer",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
      hooks: {
        beforeQuery: [{
          handler: () => {},
        }],
      },
    } satisfies AtlasContextPlugin);

    expect(plugin.hooks?.beforeQuery).toHaveLength(1);
  });

  test("beforeExplore handler can return ExploreHookMutation", () => {
    const plugin = definePlugin({
      id: "explore-filter",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
      hooks: {
        beforeExplore: [{
          handler: (ctx) => ({ command: `${ctx.command} | head` }),
        }],
      },
    } satisfies AtlasContextPlugin);

    expect(plugin.hooks?.beforeExplore).toHaveLength(1);
  });

  test("beforeQuery handler with matcher and mutation", () => {
    const plugin = definePlugin({
      id: "conditional-rls",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
      hooks: {
        beforeQuery: [{
          matcher: (ctx) => ctx.sql.includes("orders"),
          handler: (ctx) => ({ sql: `${ctx.sql} WHERE tenant_id = 1` }),
        }],
      },
    } satisfies AtlasContextPlugin);

    expect(plugin.hooks?.beforeQuery?.[0].matcher).toBeDefined();
  });
});

describe("definePlugin validation", () => {
  test("throws on empty id", () => {
    expect(() => definePlugin({
      id: "",
      types: ["datasource"],
      version: "1.0.0",
      connection: { create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }), dbType: "postgres" },
    } as AtlasDatasourcePlugin)).toThrow("id must not be empty");
  });

  test("throws on empty version", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["datasource"],
      version: "",
      connection: { create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }), dbType: "postgres" },
    } as AtlasDatasourcePlugin)).toThrow("version must not be empty");
  });

  test("throws when datasource plugin missing connection", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["datasource"],
      version: "1.0.0",

    } as any)).toThrow('must have a "connection"');
  });

  test("throws when action plugin missing actions array", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["action"],
      version: "1.0.0",

    } as any)).toThrow('must have an "actions" array');
  });

  test("accepts interaction plugin without routes (optional)", () => {
    const plugin = definePlugin({
      id: "test-no-routes",
      types: ["interaction"],
      version: "1.0.0",
    } as AtlasInteractionPlugin);
    expect(plugin.id).toBe("test-no-routes");
  });

  test("throws when interaction plugin routes is not a function", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["interaction"],
      version: "1.0.0",
      routes: "not-a-function",

    } as any)).toThrow('"routes" must be a function when provided');
  });

  test("throws when context plugin missing contextProvider", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["context"],
      version: "1.0.0",

    } as any)).toThrow('must have a "contextProvider"');
  });
});

// ---------------------------------------------------------------------------
// createPlugin (typed config factory)
// ---------------------------------------------------------------------------

describe("createPlugin", () => {
  test("creates a plugin factory that validates config via Zod", () => {
    const myPlugin = createPlugin({
      configSchema: z.object({
        projectId: z.string(),
        dataset: z.string(),
      }),
      create: (config) => ({
        id: "bigquery",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "bigquery" as const,
        },
      }),
    });

    const instance = myPlugin({ projectId: "my-proj", dataset: "analytics" });
    expect(instance.id).toBe("bigquery");
    expect(instance.config).toEqual({ projectId: "my-proj", dataset: "analytics" });
    expect(instance.types).toEqual(["datasource"]);
  });

  test("throws when config is invalid according to schema", () => {
    const myPlugin = createPlugin({
      configSchema: z.object({
        projectId: z.string(),
        dataset: z.string(),
      }),
      create: (config) => ({
        id: "bigquery",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "bigquery" as const,
        },
      }),
    });

    // Missing required field — error is wrapped with context

    expect(() => myPlugin({ projectId: "x" } as any)).toThrow("Plugin config validation failed");
  });

  test("validates plugin shape after creation", () => {
    const badPlugin = createPlugin({
      configSchema: z.object({ key: z.string() }),
      create: (config) => ({
        id: "",  // empty id should fail
        types: ["context"] as const,
        version: "1.0.0",
        config,
        contextProvider: { load: async () => "" },
      }),
    });

    expect(() => badPlugin({ key: "value" })).toThrow("id must not be empty");
  });

  test("works with context plugin type", () => {
    const envPlugin = createPlugin({
      configSchema: z.object({ prefix: z.string().default("prod") }),
      create: (config) => ({
        id: "env-context",
        types: ["context"] as const,
        version: "2.0.0",
        config,
        contextProvider: {
          load: async () => `Environment: ${config.prefix}`,
        },
      }),
    });

    const instance = envPlugin({ prefix: "staging" });
    expect(instance.id).toBe("env-context");
    expect(instance.config).toEqual({ prefix: "staging" });
  });

  test("config is stored on the plugin object", () => {
    const myPlugin = createPlugin({
      configSchema: z.object({ apiKey: z.string() }),
      create: (config) => ({
        id: "api-plugin",
        types: ["action"] as const,
        version: "1.0.0",
        config,
        actions: [],
      }),
    });

    const instance = myPlugin({ apiKey: "secret-123" });
    expect(instance.config).toEqual({ apiKey: "secret-123" });
  });

  test("schema defaults are applied", () => {
    const myPlugin = createPlugin({
      configSchema: z.object({
        host: z.string().default("localhost"),
        port: z.number().default(5432),
      }),
      create: (config) => ({
        id: "db-plugin",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "postgres" as const,
        },
      }),
    });


    const instance = myPlugin({} as any);
    expect(instance.config).toEqual({ host: "localhost", port: 5432 });
  });

  test("works with custom (non-Zod) configSchema", () => {
    const customSchema = {
      parse(input: unknown): { endpoint: string } {
        const obj = input as Record<string, unknown>;
        if (typeof obj.endpoint !== "string") {
          throw new Error("endpoint must be a string");
        }
        return { endpoint: obj.endpoint };
      },
    };

    const myPlugin = createPlugin({
      configSchema: customSchema,
      create: (config) => ({
        id: "custom-validator",
        types: ["context"] as const,
        version: "1.0.0",
        config,
        contextProvider: { load: async () => config.endpoint },
      }),
    });

    const instance = myPlugin({ endpoint: "https://api.example.com" });
    expect(instance.config).toEqual({ endpoint: "https://api.example.com" });

    // Custom validation error propagates with wrapper
    expect(() => myPlugin({ endpoint: 42 } as never)).toThrow("Plugin config validation failed");
    expect(() => myPlugin({ endpoint: 42 } as never)).toThrow("endpoint must be a string");
  });

  test("works with interaction plugin type", () => {
    const webhookPlugin = createPlugin({
      configSchema: z.object({ path: z.string(), secret: z.string() }),
      create: (config) => ({
        id: "webhook",
        types: ["interaction"] as const,
        version: "1.0.0",
        config,
        routes: () => {},
      }),
    });

    const instance = webhookPlugin({ path: "/hooks", secret: "s3cret" });
    expect(instance.id).toBe("webhook");
    expect(instance.config).toEqual({ path: "/hooks", secret: "s3cret" });
    expect(typeof instance.routes).toBe("function");
  });

  test("wraps create() errors with context", () => {
    const myPlugin = createPlugin({
      configSchema: z.object({ key: z.string() }),
      create: () => {
        throw new Error("connection refused");
      },
    });

    expect(() => myPlugin({ key: "value" })).toThrow("Plugin create() failed: connection refused");
  });
});

// ---------------------------------------------------------------------------
// definePlugin with config field (backward compat + new pattern)
// ---------------------------------------------------------------------------

describe("definePlugin with config field", () => {
  test("accepts plugins with a config field", () => {
    const plugin = definePlugin({
      id: "with-config",
      types: ["datasource"],
      version: "1.0.0",
      config: { projectId: "x", dataset: "y" },
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
    } satisfies AtlasDatasourcePlugin<{ projectId: string; dataset: string }>);

    expect(plugin.config).toEqual({ projectId: "x", dataset: "y" });
  });

  test("plugins without config still work (backward compat)", () => {
    const plugin = definePlugin({
      id: "no-config",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "data" },
    } satisfies AtlasContextPlugin);

    // config is optional and not set — verify via type-safe check
    expect("config" in plugin).toBe(false);
    expect(plugin.id).toBe("no-config");
  });
});

// ---------------------------------------------------------------------------
// Datasource plugin with entities and dialect (#167)
// ---------------------------------------------------------------------------

describe("datasource plugin entities and dialect", () => {
  test("accepts static entities array", () => {
    const plugin = definePlugin({
      id: "bq-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "bigquery" as const,
      },
      entities: [
        { name: "orders", yaml: "table: orders\ndimensions:\n  id:\n    type: integer" },
      ],
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.entities).toHaveLength(1);
  });

  test("accepts entity factory function", () => {
    const plugin = definePlugin({
      id: "bq-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "bigquery" as const,
      },
      entities: async () => [
        { name: "orders", yaml: "table: orders\ndimensions:\n  id:\n    type: integer" },
      ],
    } satisfies AtlasDatasourcePlugin);

    expect(typeof plugin.entities).toBe("function");
  });

  test("accepts dialect string", () => {
    const plugin = definePlugin({
      id: "bq-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "bigquery" as const,
      },
      dialect: "Use SAFE_DIVIDE instead of / for BigQuery.",
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.dialect).toBe("Use SAFE_DIVIDE instead of / for BigQuery.");
  });

  test("accepts connection.validate function", async () => {
    const plugin = definePlugin({
      id: "soql-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "salesforce" as const,
        validate: (query: string) => {
          if (/\b(DELETE|INSERT)\b/i.test(query)) {
            return { valid: false, reason: "Only SELECT queries allowed" };
          }
          return { valid: true };
        },
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.connection.validate).toBeDefined();
    expect(await plugin.connection.validate!("SELECT Id FROM Account")).toEqual({ valid: true });
    expect(await plugin.connection.validate!("DELETE FROM Account")).toEqual({ valid: false, reason: "Only SELECT queries allowed" });
  });

  test("accepts async connection.validate function", async () => {
    const plugin = definePlugin({
      id: "async-soql-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "salesforce" as const,
        validate: async (query: string) => {
          // Simulate async validation (e.g. external schema lookup)
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (/\b(DELETE|INSERT)\b/i.test(query)) {
            return { valid: false, reason: "Async: only SELECT allowed" };
          }
          return { valid: true };
        },
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.connection.validate).toBeDefined();
    expect(await plugin.connection.validate!("SELECT Id FROM Account")).toEqual({ valid: true });
    expect(await plugin.connection.validate!("DELETE FROM Account")).toEqual({ valid: false, reason: "Async: only SELECT allowed" });
  });

  test("createPlugin accepts async connection.validate", async () => {
    const sfPlugin = createPlugin({
      configSchema: z.object({ instanceUrl: z.string() }),
      create: (config) => ({
        id: "sf-async",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "salesforce" as const,
          validate: async (q: string) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return /^SELECT\b/i.test(q)
              ? { valid: true }
              : { valid: false, reason: "Must start with SELECT" };
          },
        },
      }),
    });

    const instance = sfPlugin({ instanceUrl: "https://example.my.salesforce.com" });
    expect(instance.connection.validate).toBeDefined();
    expect(await instance.connection.validate!("SELECT Id FROM Account")).toEqual({ valid: true });
    expect(await instance.connection.validate!("DESCRIBE Account")).toEqual({ valid: false, reason: "Must start with SELECT" });
  });

  test("connection.validate is optional (backward compat)", () => {
    const plugin: AtlasDatasourcePlugin = definePlugin({
      id: "plain-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
    });

    expect(plugin.connection.validate).toBeUndefined();
  });

  test("throws when connection.validate is not a function", () => {
    expect(() => definePlugin({
      id: "bad-validate",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        validate: "not-a-function",
      },

    } as any)).toThrow('connection "validate" must be a function');
  });

  test("createPlugin works with connection.validate", async () => {
    const sfPlugin = createPlugin({
      configSchema: z.object({ instanceUrl: z.string() }),
      create: (config) => ({
        id: "sf",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "salesforce" as const,
          validate: (q: string) => (/^SELECT\b/i.test(q) ? { valid: true } : { valid: false, reason: "Must start with SELECT" }),
        },
      }),
    });

    const instance = sfPlugin({ instanceUrl: "https://example.my.salesforce.com" });
    expect(instance.connection.validate).toBeDefined();
    expect(await instance.connection.validate!("SELECT Id FROM Account")).toEqual({ valid: true });
    expect(await instance.connection.validate!("DESCRIBE Account")).toEqual({ valid: false, reason: "Must start with SELECT" });
  });

  test("accepts parserDialect string", () => {
    const plugin = definePlugin({
      id: "snowflake-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "snowflake" as const,
        parserDialect: "Snowflake",
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.connection.parserDialect).toBe("Snowflake");
  });

  test("accepts forbiddenPatterns array", () => {
    const plugin = definePlugin({
      id: "strict-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        forbiddenPatterns: [/\bCOPY\b/i, /\bEXPLAIN\b/i],
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.connection.forbiddenPatterns).toHaveLength(2);
  });

  test("parserDialect and forbiddenPatterns are optional (backward compat)", () => {
    const plugin: AtlasDatasourcePlugin = definePlugin({
      id: "plain-ds2",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
    });

    expect(plugin.connection.parserDialect).toBeUndefined();
    expect(plugin.connection.forbiddenPatterns).toBeUndefined();
  });

  test("throws when parserDialect is empty string", () => {
    expect(() => definePlugin({
      id: "bad-dialect",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        parserDialect: "",
      },

    } as any)).toThrow('"parserDialect" must be a non-empty string');
  });

  test("throws when parserDialect is whitespace-only", () => {
    expect(() => definePlugin({
      id: "bad-dialect",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        parserDialect: "   ",
      },

    } as any)).toThrow('"parserDialect" must be a non-empty string');
  });

  test("throws when parserDialect is not a string", () => {
    expect(() => definePlugin({
      id: "bad-dialect",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        parserDialect: 42,
      },

    } as any)).toThrow('"parserDialect" must be a non-empty string');
  });

  test("throws when forbiddenPatterns is not an array", () => {
    expect(() => definePlugin({
      id: "bad-patterns",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        forbiddenPatterns: "not-an-array",
      },

    } as any)).toThrow('"forbiddenPatterns" must be an array of RegExp');
  });

  test("throws when forbiddenPatterns contains non-RegExp", () => {
    expect(() => definePlugin({
      id: "bad-patterns",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        forbiddenPatterns: [/\bCOPY\b/i, "not-a-regex"],
      },

    } as any)).toThrow('"forbiddenPatterns" entries must each be a RegExp');
  });

  test("throws when forbiddenPatterns contains duck-typed RegExp-like object", () => {
    expect(() => definePlugin({
      id: "bad-patterns",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        forbiddenPatterns: [{ test: () => true, exec: () => null }],
      },

    } as any)).toThrow('"forbiddenPatterns" entries must each be a RegExp');
  });

  test("accepts empty forbiddenPatterns array", () => {
    const plugin = definePlugin({
      id: "empty-patterns",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        forbiddenPatterns: [],
      },
    } satisfies AtlasDatasourcePlugin);

    expect(plugin.connection.forbiddenPatterns).toHaveLength(0);
  });

  test("createPlugin works with parserDialect and forbiddenPatterns", () => {
    const sfPlugin = createPlugin({
      configSchema: z.object({ account: z.string() }),
      create: (config) => ({
        id: "snowflake",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "snowflake" as const,
          parserDialect: "Snowflake",
          forbiddenPatterns: [/\bCOPY\s+INTO\b/i],
        },
      }),
    });

    const instance = sfPlugin({ account: "xy12345" });
    expect(instance.connection.parserDialect).toBe("Snowflake");
    expect(instance.connection.forbiddenPatterns).toHaveLength(1);
  });

  test("entities and dialect are optional (backward compat)", () => {
    const plugin: AtlasDatasourcePlugin = definePlugin({
      id: "plain-ds",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
    });

    expect(plugin.entities).toBeUndefined();
    expect(plugin.dialect).toBeUndefined();
  });

  test("throws when entities is not array or function", () => {
    expect(() => definePlugin({
      id: "bad-entities",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      entities: "not-valid" as never,
    })).toThrow('"entities" must be an array or a function');
  });

  test("throws when dialect is empty string", () => {
    expect(() => definePlugin({
      id: "bad-dialect",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      dialect: "",
    })).toThrow('"dialect" must be a non-empty string');
  });

  test("throws when dialect is whitespace-only", () => {
    expect(() => definePlugin({
      id: "bad-dialect",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      dialect: "   ",
    })).toThrow('"dialect" must be a non-empty string');
  });

  test("throws when entity element is missing name", () => {
    expect(() => definePlugin({
      id: "bad-entity",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      entities: [{ yaml: "table: orders" } as never],
    })).toThrow('Each entity in "entities" must have string "name" and "yaml" fields');
  });

  test("throws when entity element is missing yaml", () => {
    expect(() => definePlugin({
      id: "bad-entity",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      entities: [{ name: "orders" } as never],
    })).toThrow('Each entity in "entities" must have string "name" and "yaml" fields');
  });

  test("throws when entity element has non-string name", () => {
    expect(() => definePlugin({
      id: "bad-entity",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      entities: [{ name: 123, yaml: "table: orders" } as never],
    })).toThrow('Each entity in "entities" must have string "name" and "yaml" fields');
  });

  test("throws when entity element has non-string yaml", () => {
    expect(() => definePlugin({
      id: "bad-entity",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      entities: [{ name: "orders", yaml: 42 } as never],
    })).toThrow('Each entity in "entities" must have string "name" and "yaml" fields');
  });

  test("throws when entity element is null", () => {
    expect(() => definePlugin({
      id: "bad-entity",
      types: ["datasource"],
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
      },
      entities: [null as never],
    })).toThrow('Each entity in "entities" must have string "name" and "yaml" fields');
  });

  test("createPlugin works with entities and dialect", () => {
    const bqPlugin = createPlugin({
      configSchema: z.object({ projectId: z.string() }),
      create: (config) => ({
        id: "bq",
        types: ["datasource"] as const,
        version: "1.0.0",
        config,
        connection: {
          create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
          dbType: "bigquery" as const,
        },
        entities: [{ name: "events", yaml: "table: events" }],
        dialect: "Use SAFE_DIVIDE for division.",
      }),
    });

    const instance = bqPlugin({ projectId: "my-proj" });
    expect(instance.entities).toHaveLength(1);
    expect(instance.dialect).toBe("Use SAFE_DIVIDE for division.");
  });
});

// ---------------------------------------------------------------------------
// Sandbox plugin (#192)
// ---------------------------------------------------------------------------

describe("sandbox plugin", () => {
  test("definePlugin accepts sandbox plugin with priority", () => {
    const plugin = definePlugin({
      id: "my-sandbox",
      types: ["sandbox"] as const,
      version: "1.0.0",
      sandbox: {
        create: () => ({
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
        priority: 80,
      },
    });

    expect((plugin as AtlasSandboxPlugin).sandbox.priority).toBe(80);
  });

  test("definePlugin accepts sandbox plugin without priority (optional)", () => {
    const plugin = definePlugin({
      id: "no-priority",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: () => ({
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
      },
    } satisfies AtlasSandboxPlugin);

    expect((plugin as AtlasSandboxPlugin).sandbox.priority).toBeUndefined();
  });

  test("definePlugin accepts sandbox plugin with security metadata", () => {
    const plugin = definePlugin({
      id: "secure-sandbox",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: () => ({
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
        priority: 90,
      },
      security: {
        networkIsolation: true,
        filesystemIsolation: true,
        unprivilegedExecution: true,
        description: "Runs in a Firecracker VM",
      },
    } satisfies AtlasSandboxPlugin);

    expect(plugin.security?.networkIsolation).toBe(true);
    expect(plugin.security?.description).toContain("Firecracker");
  });

  test("definePlugin accepts sandbox plugin with close method", () => {
    const plugin = definePlugin({
      id: "closeable-sandbox",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: () => ({
          exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
          close: async () => {},
        }),
      },
    } satisfies AtlasSandboxPlugin);

    expect(plugin.id).toBe("closeable-sandbox");
  });

  test("definePlugin accepts sandbox plugin with async create", () => {
    const plugin = definePlugin({
      id: "async-sandbox",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: async (_root: string) => ({
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
      },
    } satisfies AtlasSandboxPlugin);

    expect(typeof plugin.sandbox.create).toBe("function");
  });
});

describe("sandbox plugin validation", () => {
  test("throws when sandbox plugin missing sandbox property", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["sandbox"],
      version: "1.0.0",

    } as any)).toThrow('must have a "sandbox"');
  });

  test("throws when sandbox.create is not a function", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: { create: "not-a-function" },

    } as any)).toThrow('must have a "create()" factory function');
  });

  test("throws when priority is not a number", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: () => ({ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
        priority: "high",
      },

    } as any)).toThrow('"priority" must be a number');
  });

  test("throws when priority is NaN", () => {
    expect(() => definePlugin({
      id: "test",
      types: ["sandbox"],
      version: "1.0.0",
      sandbox: {
        create: () => ({ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
        priority: NaN,
      },

    } as any)).toThrow('"priority" must be a number');
  });
});

describe("createPlugin with sandbox type", () => {
  test("creates a sandbox plugin factory", () => {
    const mySandbox = createPlugin({
      configSchema: z.object({ timeout: z.number().default(10) }),
      create: (config) => ({
        id: "custom-sandbox",
        types: ["sandbox"] as const,
        version: "1.0.0",
        config,
        sandbox: {
          create: () => ({
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          }),
          priority: 65,
        },
      }),
    });

    const instance = mySandbox({ timeout: 30 });
    expect(instance.id).toBe("custom-sandbox");
    expect(instance.types).toEqual(["sandbox"]);
    expect(instance.config).toEqual({ timeout: 30 });
    expect(instance.sandbox.priority).toBe(65);
  });

  test("applies config defaults for sandbox plugin", () => {
    const mySandbox = createPlugin({
      configSchema: z.object({ timeout: z.number().default(10) }),
      create: (config) => ({
        id: "defaulted-sandbox",
        types: ["sandbox"] as const,
        version: "1.0.0",
        config,
        sandbox: {
          create: () => ({
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          }),
        },
      }),
    });


    const instance = mySandbox({} as any);
    expect(instance.config).toEqual({ timeout: 10 });
  });
});
