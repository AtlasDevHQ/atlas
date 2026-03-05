import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PluginRegistry } from "../registry";
import type { PluginLike, PluginContextLike } from "../registry";

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [] },
  tools: { register: () => {} },
  logger: {},
  config: {},
};

function makePlugin(overrides: Partial<PluginLike> = {}): PluginLike {
  return {
    id: "test-plugin",
    type: "datasource",
    version: "1.0.0",
    ...overrides,
  };
}

describe("PluginRegistry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  // --- register ---

  describe("register", () => {
    test("stores plugin", () => {
      const plugin = makePlugin();
      registry.register(plugin);
      expect(registry.get("test-plugin")).toBe(plugin);
      expect(registry.size).toBe(1);
    });

    test("throws on empty id", () => {
      expect(() => registry.register(makePlugin({ id: "" }))).toThrow("must not be empty");
      expect(() => registry.register(makePlugin({ id: "  " }))).toThrow("must not be empty");
    });

    test("throws on duplicate id", () => {
      registry.register(makePlugin({ id: "a" }));
      expect(() => registry.register(makePlugin({ id: "a" }))).toThrow("already registered");
    });
  });

  // --- initializeAll ---

  describe("initializeAll", () => {
    test("marks healthy on success", async () => {
      const init = mock(() => Promise.resolve());
      registry.register(makePlugin({ initialize: init }));

      const result = await registry.initializeAll(minimalCtx);

      expect(result.succeeded).toEqual(["test-plugin"]);
      expect(result.failed).toEqual([]);
      expect(registry.getStatus("test-plugin")).toBe("healthy");
      expect(init).toHaveBeenCalledTimes(1);
    });

    test("marks healthy with no init method", async () => {
      registry.register(makePlugin());

      const result = await registry.initializeAll(minimalCtx);

      expect(result.succeeded).toEqual(["test-plugin"]);
      expect(registry.getStatus("test-plugin")).toBe("healthy");
    });

    test("passes context to initialize", async () => {
      let receivedCtx: PluginContextLike | undefined;
      registry.register(
        makePlugin({
          initialize: async (ctx: PluginContextLike) => {
            receivedCtx = ctx;
          },
        }),
      );

      const fakeCtx: PluginContextLike = {
        db: null,
        connections: { get: () => ({}), list: () => [] },
        tools: { register: () => {} },
        logger: {},
        config: { test: true },
      };

      await registry.initializeAll(fakeCtx);

      expect(receivedCtx).toBeDefined();
      expect((receivedCtx as PluginContextLike).config).toEqual({ test: true });
    });

    test("marks unhealthy on failure without crashing", async () => {
      registry.register(
        makePlugin({
          id: "good",
          initialize: async () => {},
        }),
      );
      registry.register(
        makePlugin({
          id: "bad",
          initialize: async () => {
            throw new Error("init boom");
          },
        }),
      );

      const result = await registry.initializeAll(minimalCtx);

      expect(result.succeeded).toEqual(["good"]);
      expect(result.failed).toEqual(["bad"]);
      expect(registry.getStatus("good")).toBe("healthy");
      expect(registry.getStatus("bad")).toBe("unhealthy");
    });

    test("creates scoped child logger when ctx.logger has child()", async () => {
      let receivedLogger: unknown;
      registry.register(
        makePlugin({
          initialize: async (ctx: PluginContextLike) => {
            receivedLogger = ctx.logger;
          },
        }),
      );

      const childLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      const parentLogger = {
        child: mock(() => childLogger),
      };

      await registry.initializeAll({
        ...minimalCtx,
        logger: parentLogger as unknown as Record<string, unknown>,
      });

      expect(parentLogger.child).toHaveBeenCalledWith({ pluginId: "test-plugin" });
      expect(receivedLogger).toBe(childLogger);
    });

    test("throws on double initialization", async () => {
      registry.register(makePlugin());
      await registry.initializeAll(minimalCtx);

      expect(() => registry.initializeAll(minimalCtx)).toThrow("already initialized");
    });
  });

  // --- healthCheckAll ---

  describe("healthCheckAll", () => {
    test("returns results", async () => {
      registry.register(
        makePlugin({
          healthCheck: async () => ({ healthy: true, latencyMs: 5 }),
        }),
      );
      await registry.initializeAll(minimalCtx);

      const results = await registry.healthCheckAll();
      const entry = results.get("test-plugin");
      expect(entry?.healthy).toBe(true);
      expect(entry?.latencyMs).toBe(5);
    });

    test("handles plugins without healthCheck", async () => {
      registry.register(makePlugin());
      await registry.initializeAll(minimalCtx);

      const results = await registry.healthCheckAll();
      const entry = results.get("test-plugin");
      expect(entry?.healthy).toBe(true);
      expect(entry?.status).toBe("healthy");
    });

    test("catches health check exceptions", async () => {
      registry.register(
        makePlugin({
          healthCheck: async () => {
            throw new Error("probe failed");
          },
        }),
      );
      await registry.initializeAll(minimalCtx);

      const results = await registry.healthCheckAll();
      const entry = results.get("test-plugin");
      expect(entry?.healthy).toBe(false);
      expect(entry?.message).toBe("probe failed");
    });

    test("updates status to unhealthy when probe returns false", async () => {
      registry.register(
        makePlugin({
          healthCheck: async () => ({ healthy: false, message: "degraded" }),
        }),
      );
      await registry.initializeAll(minimalCtx);
      expect(registry.getStatus("test-plugin")).toBe("healthy");

      const results = await registry.healthCheckAll();
      const entry = results.get("test-plugin");
      expect(entry?.healthy).toBe(false);
      expect(entry?.status).toBe("unhealthy");
      expect(registry.getStatus("test-plugin")).toBe("unhealthy");
    });

    test("updates status to unhealthy when probe throws", async () => {
      registry.register(
        makePlugin({
          healthCheck: async () => {
            throw new Error("probe failed");
          },
        }),
      );
      await registry.initializeAll(minimalCtx);

      await registry.healthCheckAll();
      expect(registry.getStatus("test-plugin")).toBe("unhealthy");
    });
  });

  // --- teardownAll ---

  describe("teardownAll", () => {
    test("calls in reverse order", async () => {
      const order: string[] = [];
      registry.register(
        makePlugin({
          id: "first",
          teardown: async () => { order.push("first"); },
        }),
      );
      registry.register(
        makePlugin({
          id: "second",
          teardown: async () => { order.push("second"); },
        }),
      );

      await registry.teardownAll();

      expect(order).toEqual(["second", "first"]);
    });

    test("continues on failure", async () => {
      const order: string[] = [];
      registry.register(
        makePlugin({
          id: "first",
          teardown: async () => { order.push("first"); },
        }),
      );
      registry.register(
        makePlugin({
          id: "failing",
          teardown: async () => {
            throw new Error("teardown boom");
          },
        }),
      );
      registry.register(
        makePlugin({
          id: "third",
          teardown: async () => { order.push("third"); },
        }),
      );

      await registry.teardownAll();

      // "failing" threw but "first" still ran
      expect(order).toEqual(["third", "first"]);
    });
  });

  // --- getByType ---

  describe("getByType", () => {
    test("filters by type and health status", async () => {
      registry.register(makePlugin({ id: "ds1", type: "datasource" }));
      registry.register(makePlugin({ id: "ctx1", type: "context" }));
      registry.register(
        makePlugin({
          id: "ds2",
          type: "datasource",
          initialize: async () => {
            throw new Error("fail");
          },
        }),
      );
      await registry.initializeAll(minimalCtx);

      const healthy = registry.getByType("datasource");
      expect(healthy.map((p) => p.id)).toEqual(["ds1"]);
    });

    test("returns empty array when no plugins of type", async () => {
      registry.register(makePlugin({ id: "ds1", type: "datasource" }));
      await registry.initializeAll(minimalCtx);

      expect(registry.getByType("action")).toEqual([]);
    });
  });

  // --- getStatus ---

  describe("getStatus", () => {
    test("returns undefined for unknown id", () => {
      expect(registry.getStatus("nonexistent")).toBeUndefined();
    });
  });

  // --- describe ---

  describe("describe", () => {
    test("returns metadata with name fallback to id", () => {
      registry.register(makePlugin({ id: "with-name", name: "My Plugin" }));
      registry.register(makePlugin({ id: "no-name" }));

      const descriptions = registry.describe();
      expect(descriptions).toHaveLength(2);
      expect(descriptions[0].name).toBe("My Plugin");
      expect(descriptions[1].name).toBe("no-name");
    });
  });

  // --- _reset ---

  describe("_reset", () => {
    test("clears all entries", () => {
      registry.register(makePlugin({ id: "a" }));
      registry.register(makePlugin({ id: "b" }));
      expect(registry.size).toBe(2);

      registry._reset();

      expect(registry.size).toBe(0);
      expect(registry.get("a")).toBeUndefined();
    });
  });
});
