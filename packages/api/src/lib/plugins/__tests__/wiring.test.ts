import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PluginRegistry } from "../registry";
import type { PluginLike, PluginContextLike } from "../registry";
import { wireDatasourcePlugins, wireActionPlugins, wireInteractionPlugins, wireContextPlugins } from "../wiring";

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [] },
  tools: { register: () => {} },
  logger: {},
  config: {},
};

// --- Mock ConnectionRegistry ---

function makeMockConnectionRegistry() {
  return {
    registered: [] as { id: string; conn: unknown; dbType: string; description?: string; validate?: unknown; meta?: unknown }[],
    registerDirect(id: string, conn: unknown, dbType: string, description?: string, validate?: unknown, meta?: unknown) {
      this.registered.push({ id, conn, dbType, description, validate, meta });
    },
  };
}

// --- Mock ToolRegistry ---

function makeMockToolRegistry() {
  return {
    registered: [] as { name: string }[],
    register(entry: { name: string }) {
      this.registered.push(entry);
    },
  };
}

// --- Helpers ---

function makeDatasourcePlugin(
  id: string,
  opts?: {
    unhealthy?: boolean;
    entities?: unknown[] | (() => unknown);
    dialect?: string;
  },
): PluginLike {
  const conn = {
    query: async () => ({ columns: [], rows: [] }),
    close: async () => {},
  };
  return {
    id,
    type: "datasource",
    version: "1.0.0",
    connection: {
      create: () => conn,
      dbType: "postgres",
    },
    ...(opts?.entities !== undefined ? { entities: opts.entities } : {}),
    ...(opts?.dialect !== undefined ? { dialect: opts.dialect } : {}),
    ...(opts?.unhealthy
      ? { initialize: async () => { throw new Error("fail"); } }
      : {}),
  };
}

function makeActionPlugin(id: string, opts?: { unhealthy?: boolean }): PluginLike {
  return {
    id,
    type: "action",
    version: "1.0.0",
    actions: [
      {
        name: `${id}-action`,
        description: "Test action",
        tool: {},
        actionType: "test:do",
        reversible: false,
        defaultApproval: "manual",
        requiredCredentials: [],
      },
    ],
    ...(opts?.unhealthy
      ? { initialize: async () => { throw new Error("fail"); } }
      : {}),
  };
}

function makeInteractionPlugin(id: string, routesFn: (app: unknown) => void, opts?: { unhealthy?: boolean }): PluginLike {
  return {
    id,
    type: "interaction",
    version: "1.0.0",
    routes: routesFn,
    ...(opts?.unhealthy
      ? { initialize: async () => { throw new Error("fail"); } }
      : {}),
  };
}

describe("wireDatasourcePlugins", () => {
  let registry: PluginRegistry;
  let connRegistry: ReturnType<typeof makeMockConnectionRegistry>;

  beforeEach(() => {
    registry = new PluginRegistry();
    connRegistry = makeMockConnectionRegistry();
  });

  test("registers in ConnectionRegistry", async () => {
    registry.register(makeDatasourcePlugin("my-ds"));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["my-ds"]);
    expect(result.failed).toEqual([]);
    expect(result.entityFailures).toEqual([]);
    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].id).toBe("my-ds");
    expect(connRegistry.registered[0].dbType).toBe("postgres");
  });

  test("passes connection.validate through to registerDirect", async () => {
    const validator = (q: string) => ({ valid: /^SELECT/i.test(q) });
    const plugin: PluginLike = {
      id: "validated-ds",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "postgres",
        validate: validator,
      },
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].validate).toBe(validator);
  });

  test("passes parserDialect and forbiddenPatterns through meta", async () => {
    const patterns = [/^\s*(KILL)\b/i];
    const plugin: PluginLike = {
      id: "meta-ds",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
        dbType: "clickhouse",
        parserDialect: "PostgresQL",
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
      parserDialect: "PostgresQL",
      forbiddenPatterns: patterns,
    });
  });

  test("passes undefined meta when no parserDialect or forbiddenPatterns", async () => {
    registry.register(makeDatasourcePlugin("plain-meta"));
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].meta).toBeUndefined();
  });

  test("passes undefined validate when not provided", async () => {
    registry.register(makeDatasourcePlugin("plain-ds"));
    await registry.initializeAll(minimalCtx);

    await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].validate).toBeUndefined();
  });

  test("skips unhealthy plugins", async () => {
    registry.register(makeDatasourcePlugin("healthy-ds"));
    registry.register(makeDatasourcePlugin("bad-ds", { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["healthy-ds"]);
    expect(result.failed).toEqual([]);
    expect(connRegistry.registered).toHaveLength(1);
    expect(connRegistry.registered[0].id).toBe("healthy-ds");
  });

  test("continues when one create() throws and returns failures", async () => {
    const failingPlugin: PluginLike = {
      id: "failing-ds",
      type: "datasource",
      version: "1.0.0",
      connection: {
        create: () => { throw new Error("conn failed"); },
        dbType: "postgres",
      },
    };
    registry.register(failingPlugin);
    registry.register(makeDatasourcePlugin("good-ds"));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["good-ds"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].pluginId).toBe("failing-ds");
    expect(connRegistry.registered).toHaveLength(1);
  });

  test("collects dialect hints from plugins", async () => {
    registry.register(makeDatasourcePlugin("bq", { dialect: "Use SAFE_DIVIDE for BigQuery." }));
    registry.register(makeDatasourcePlugin("plain"));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.dialectHints).toHaveLength(1);
    expect(result.dialectHints[0]).toEqual({ pluginId: "bq", dialect: "Use SAFE_DIVIDE for BigQuery." });
  });

  test("returns empty dialectHints when no plugins provide dialect", async () => {
    registry.register(makeDatasourcePlugin("plain"));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.dialectHints).toEqual([]);
  });

  test("resolves static entities array", async () => {
    const entities = [
      { name: "orders", yaml: "table: orders\ndimensions:\n  id:\n    type: integer" },
    ];
    registry.register(makeDatasourcePlugin("with-entities", { entities }));
    await registry.initializeAll(minimalCtx);

    // We can't easily mock the dynamic import, but we can verify the plugin
    // is wired and entities field is present on the plugin object
    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["with-entities"]);
    // Dialect hints should be empty
    expect(result.dialectHints).toEqual([]);
  });

  test("resolves entity factory function", async () => {
    const entityFactory = async () => [
      { name: "events", yaml: "table: events" },
    ];
    registry.register(makeDatasourcePlugin("factory-ds", { entities: entityFactory }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["factory-ds"]);
  });

  test("entity resolution failure does not prevent connection wiring but reports entityFailures", async () => {
    const badEntities = async () => { throw new Error("entity load failed"); };
    registry.register(makeDatasourcePlugin("bad-entities", { entities: badEntities as never }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    // Connection was still wired despite entity failure
    expect(result.wired).toEqual(["bad-entities"]);
    expect(result.failed).toEqual([]);
    // Entity failure is tracked separately
    expect(result.entityFailures).toHaveLength(1);
    expect(result.entityFailures[0].pluginId).toBe("bad-entities");
    expect(result.entityFailures[0].error).toBe("entity load failed");
  });

  test("non-array entity factory return reports entityFailure", async () => {
    const badFactory = async () => "not-an-array" as unknown;
    registry.register(makeDatasourcePlugin("bad-factory", { entities: badFactory as never }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["bad-factory"]);
    expect(result.failed).toEqual([]);
    expect(result.entityFailures).toHaveLength(1);
    expect(result.entityFailures[0].pluginId).toBe("bad-factory");
    expect(result.entityFailures[0].error).toContain("non-array");
  });

  test("empty entity array does not report failure", async () => {
    registry.register(makeDatasourcePlugin("empty-entities", { entities: [] }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["empty-entities"]);
    expect(result.failed).toEqual([]);
    expect(result.entityFailures).toEqual([]);
  });

  test("filters out invalid entity elements", async () => {
    const entities = [
      { name: "valid", yaml: "table: valid" },
      { name: 123, yaml: "bad" }, // invalid: name not a string
      null, // invalid: null
      { name: "also-valid", yaml: "table: also_valid" },
    ];
    registry.register(makeDatasourcePlugin("mixed-entities", { entities: entities as never }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    // Plugin wired, no entityFailures — invalid elements are just logged and filtered
    expect(result.wired).toEqual(["mixed-entities"]);
    expect(result.entityFailures).toEqual([]);
  });

  test("entityFailures is empty when entities resolve successfully", async () => {
    const entities = [{ name: "orders", yaml: "table: orders" }];
    registry.register(makeDatasourcePlugin("good-entities", { entities }));
    await registry.initializeAll(minimalCtx);

    const result = await wireDatasourcePlugins(
      registry,
      connRegistry as unknown as import("@atlas/api/lib/db/connection").ConnectionRegistry,
    );

    expect(result.wired).toEqual(["good-entities"]);
    expect(result.entityFailures).toEqual([]);
  });
});

describe("wireActionPlugins", () => {
  let registry: PluginRegistry;
  let toolRegistry: ReturnType<typeof makeMockToolRegistry>;

  beforeEach(() => {
    registry = new PluginRegistry();
    toolRegistry = makeMockToolRegistry();
  });

  test("registers tools", async () => {
    registry.register(makeActionPlugin("my-action"));
    await registry.initializeAll(minimalCtx);

    const result = await wireActionPlugins(
      registry,
      toolRegistry as unknown as import("@atlas/api/lib/tools/registry").ToolRegistry,
    );

    expect(result.wired).toEqual(["my-action-action"]);
    expect(result.failed).toEqual([]);
    expect(toolRegistry.registered).toHaveLength(1);
    expect(toolRegistry.registered[0].name).toBe("my-action-action");
  });

  test("skips unhealthy plugins", async () => {
    registry.register(makeActionPlugin("good"));
    registry.register(makeActionPlugin("bad", { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    const result = await wireActionPlugins(
      registry,
      toolRegistry as unknown as import("@atlas/api/lib/tools/registry").ToolRegistry,
    );

    expect(result.wired).toEqual(["good-action"]);
    expect(result.failed).toEqual([]);
    expect(toolRegistry.registered).toHaveLength(1);
    expect(toolRegistry.registered[0].name).toBe("good-action");
  });

  test("registers all actions from a multi-action plugin", async () => {
    const plugin: PluginLike = {
      id: "multi-action",
      type: "action",
      version: "1.0.0",
      actions: [
        { name: "action-a", description: "A", tool: {}, actionType: "t", reversible: false, defaultApproval: "manual", requiredCredentials: [] },
        { name: "action-b", description: "B", tool: {}, actionType: "t", reversible: false, defaultApproval: "manual", requiredCredentials: [] },
      ],
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    const result = await wireActionPlugins(
      registry,
      toolRegistry as unknown as import("@atlas/api/lib/tools/registry").ToolRegistry,
    );

    expect(result.wired).toEqual(["action-a", "action-b"]);
    expect(toolRegistry.registered).toHaveLength(2);
  });

  test("continues when one action registration fails", async () => {
    let registerCount = 0;
    const failingToolRegistry = {
      registered: [] as { name: string }[],
      register(entry: { name: string }) {
        registerCount++;
        if (registerCount === 1) throw new Error("frozen");
        this.registered.push(entry);
      },
    };

    const plugin: PluginLike = {
      id: "fail-action",
      type: "action",
      version: "1.0.0",
      actions: [
        { name: "fail-action", description: "Fails", tool: {}, actionType: "t", reversible: false, defaultApproval: "manual", requiredCredentials: [] },
        { name: "good-action", description: "Works", tool: {}, actionType: "t", reversible: false, defaultApproval: "manual", requiredCredentials: [] },
      ],
    };
    registry.register(plugin);
    await registry.initializeAll(minimalCtx);

    const result = await wireActionPlugins(
      registry,
      failingToolRegistry as unknown as import("@atlas/api/lib/tools/registry").ToolRegistry,
    );

    expect(result.wired).toEqual(["good-action"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].pluginId).toBe("fail-action");
  });
});

describe("wireInteractionPlugins", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("calls routes function with sub-app", async () => {
    const routesFn = mock(() => {});
    const fakeApp = { route: mock(() => {}) };

    registry.register(makeInteractionPlugin("my-int", routesFn));
    await registry.initializeAll(minimalCtx);

    const result = await wireInteractionPlugins(registry, fakeApp);

    expect(routesFn).toHaveBeenCalledTimes(1);
    // The plugin gets a Hono sub-app, not the raw app
    expect(fakeApp.route).toHaveBeenCalledTimes(1);
    expect(fakeApp.route).toHaveBeenCalledWith("/api/plugins/my-int", expect.anything());
    expect(result.wired).toEqual(["my-int"]);
    expect(result.failed).toEqual([]);
  });

  test("skips unhealthy plugins", async () => {
    const routesFn = mock(() => {});
    const fakeApp = { route: mock(() => {}) };

    registry.register(makeInteractionPlugin("good", routesFn));
    registry.register(makeInteractionPlugin("bad", () => {}, { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    const result = await wireInteractionPlugins(registry, fakeApp);

    expect(routesFn).toHaveBeenCalledTimes(1);
    expect(result.wired).toEqual(["good"]);
    expect(result.failed).toEqual([]);
  });

  test("route-less interaction plugin is silently skipped (no failure)", async () => {
    const fakeApp = { route: mock(() => {}) };
    const routelessPlugin: PluginLike = {
      id: "stdio-interaction",
      type: "interaction",
      version: "1.0.0",
      // No routes property — like MCP stdio transport
    };

    registry.register(routelessPlugin);
    await registry.initializeAll(minimalCtx);

    const result = await wireInteractionPlugins(registry, fakeApp);

    expect(fakeApp.route).not.toHaveBeenCalled();
    expect(result.wired).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// --- wireContextPlugins ---

function makeContextPlugin(id: string, loadFn: () => Promise<string>, opts?: { unhealthy?: boolean }): PluginLike {
  return {
    id,
    type: "context",
    version: "1.0.0",
    contextProvider: { load: loadFn },
    ...(opts?.unhealthy
      ? { initialize: async () => { throw new Error("fail"); } }
      : {}),
  };
}

describe("wireContextPlugins", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("collects fragments from context plugins", async () => {
    registry.register(makeContextPlugin("ctx1", async () => "Fragment A"));
    registry.register(makeContextPlugin("ctx2", async () => "Fragment B"));
    await registry.initializeAll(minimalCtx);

    const result = await wireContextPlugins(registry);

    expect(result.fragments).toEqual(["Fragment A", "Fragment B"]);
    expect(result.failed).toEqual([]);
  });

  test("skips unhealthy context plugins", async () => {
    registry.register(makeContextPlugin("good", async () => "Good fragment"));
    registry.register(makeContextPlugin("bad", async () => "Bad fragment", { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    const result = await wireContextPlugins(registry);

    expect(result.fragments).toEqual(["Good fragment"]);
    expect(result.failed).toEqual([]);
  });

  test("continues when load() throws and returns failures", async () => {
    registry.register(makeContextPlugin("good", async () => "OK"));
    registry.register(makeContextPlugin("failing", async () => { throw new Error("load failed"); }));
    await registry.initializeAll(minimalCtx);

    const result = await wireContextPlugins(registry);

    expect(result.fragments).toEqual(["OK"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].pluginId).toBe("failing");
    expect(result.failed[0].error).toBe("load failed");
  });

  test("filters empty/whitespace fragments", async () => {
    registry.register(makeContextPlugin("empty", async () => ""));
    registry.register(makeContextPlugin("whitespace", async () => "   "));
    registry.register(makeContextPlugin("real", async () => "Real content"));
    await registry.initializeAll(minimalCtx);

    const result = await wireContextPlugins(registry);

    expect(result.fragments).toEqual(["Real content"]);
  });

  test("skips context plugins without contextProvider", async () => {
    const noProvider: PluginLike = {
      id: "no-provider",
      type: "context",
      version: "1.0.0",
    };
    registry.register(noProvider);
    await registry.initializeAll(minimalCtx);

    const result = await wireContextPlugins(registry);

    expect(result.fragments).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
