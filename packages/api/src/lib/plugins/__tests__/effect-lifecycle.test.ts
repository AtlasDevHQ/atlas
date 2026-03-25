import { describe, test, expect } from "bun:test";
import { Effect, Layer, Exit } from "effect";
import {
  PluginRegistry,
  makePluginRegistryLive,
  makeWiredPluginRegistryLive,
  createPluginTestLayer,
  createTestLayer,
  type PluginWiringConfig,
} from "@atlas/api/lib/effect/services";
import { PluginRegistry as PluginRegistryClass } from "@atlas/api/lib/plugins/registry";
import type {
  PluginLike,
  PluginContextLike,
} from "@atlas/api/lib/plugins/registry";

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
    types: ["datasource"],
    version: "1.0.0",
    ...overrides,
  };
}

describe("PluginRegistry Effect Service", () => {
  // ── makePluginRegistryLive ───────────────────────────────────────

  describe("makePluginRegistryLive", () => {
    test("creates service with register and get", async () => {
      const layer = makePluginRegistryLive(() => new PluginRegistryClass());

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.register(makePlugin({ id: "test-1" }));
          return registry.get("test-1");
        }).pipe(Effect.provide(layer)),
      );

      expect(result?.id).toBe("test-1");
    });

    test("delegates initializeAll to underlying impl", async () => {
      const layer = makePluginRegistryLive(() => new PluginRegistryClass());

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.register(makePlugin({ id: "good" }));
          registry.register(
            makePlugin({
              id: "bad",
              initialize: async () => {
                throw new Error("fail");
              },
            }),
          );
          return yield* Effect.promise(() =>
            registry.initializeAll(minimalCtx),
          );
        }).pipe(Effect.provide(layer)),
      );

      expect(result.succeeded).toEqual(["good"]);
      expect(result.failed).toEqual(["bad"]);
    });

    test("teardown runs via Effect.addFinalizer on scope close", async () => {
      const teardownOrder: string[] = [];
      const impl = new PluginRegistryClass();
      impl.register(
        makePlugin({
          id: "first",
          teardown: async () => {
            teardownOrder.push("first");
          },
        }),
      );
      impl.register(
        makePlugin({
          id: "second",
          teardown: async () => {
            teardownOrder.push("second");
          },
        }),
      );

      const layer = makePluginRegistryLive(() => impl);

      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          expect(registry.size).toBe(2);
        }).pipe(Effect.provide(layer)),
      );

      // addFinalizer triggers teardownAll on scope close; teardownAll iterates LIFO internally
      expect(teardownOrder).toEqual(["second", "first"]);
    });

    test("exposes size as a property", async () => {
      const layer = makePluginRegistryLive(() => new PluginRegistryClass());

      const size = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.register(makePlugin({ id: "a" }));
          registry.register(makePlugin({ id: "b" }));
          return registry.size;
        }).pipe(Effect.provide(layer)),
      );

      expect(size).toBe(2);
    });

    test("delegates enable/disable/isEnabled correctly", async () => {
      const layer = makePluginRegistryLive(() => new PluginRegistryClass());

      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.register(makePlugin({ id: "toggle" }));
          yield* Effect.promise(() => registry.initializeAll(minimalCtx));

          expect(registry.isEnabled("toggle")).toBe(true);
          registry.disable("toggle");
          expect(registry.isEnabled("toggle")).toBe(false);
          registry.enable("toggle");
          expect(registry.isEnabled("toggle")).toBe(true);
        }).pipe(Effect.provide(layer)),
      );
    });

    test("delegates getByType and getAllHealthy", async () => {
      const layer = makePluginRegistryLive(() => new PluginRegistryClass());

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.register(makePlugin({ id: "ds", types: ["datasource"] }));
          registry.register(makePlugin({ id: "ctx", types: ["context"] }));
          yield* Effect.promise(() => registry.initializeAll(minimalCtx));
          return {
            datasources: registry.getByType("datasource").map((p) => p.id),
            healthy: registry.getAllHealthy().map((p) => p.id),
          };
        }).pipe(Effect.provide(layer)),
      );

      expect(result.datasources).toEqual(["ds"]);
      expect(result.healthy).toEqual(["ds", "ctx"]);
    });

    test("delegates describe with name fallback", async () => {
      const layer = makePluginRegistryLive(() => new PluginRegistryClass());

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.register(
            makePlugin({ id: "with-name", name: "My Plugin" }),
          );
          registry.register(makePlugin({ id: "no-name" }));
          return registry.describe();
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("My Plugin");
      expect(result[1].name).toBe("no-name");
    });
  });

  // ── makeWiredPluginRegistryLive ──────────────────────────────────

  describe("makeWiredPluginRegistryLive", () => {
    test("requires ConnectionRegistry and initializes plugins", async () => {
      const config: PluginWiringConfig = {
        plugins: [makePlugin({ id: "wired-test" })],
        context: minimalCtx,
      };

      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      // Provide the ConnectionRegistry dependency via test layer
      const connLayer = createTestLayer({
        list: () => [],
        registerDirect: () => {},
      });
      const fullLayer = Layer.provide(pluginLayer, connLayer);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          return registry.describe();
        }).pipe(Effect.provide(fullLayer)),
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("wired-test");
      expect(result[0].status).toBe("healthy");
    });

    test("runs schema migrations before initialization", async () => {
      const order: string[] = [];

      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "migrated",
            initialize: async () => {
              order.push("init");
            },
          }),
        ],
        context: minimalCtx,
        runMigrations: async () => {
          order.push("migrate");
        },
      };

      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      const connLayer = createTestLayer({
        list: () => [],
        registerDirect: () => {},
      });
      const fullLayer = Layer.provide(pluginLayer, connLayer);

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(fullLayer)),
      );

      expect(order).toEqual(["migrate", "init"]);
    });

    test("teardown runs via finalizer for wired layer", async () => {
      const teardownOrder: string[] = [];

      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "a",
            teardown: async () => {
              teardownOrder.push("a");
            },
          }),
          makePlugin({
            id: "b",
            teardown: async () => {
              teardownOrder.push("b");
            },
          }),
        ],
        context: minimalCtx,
      };

      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      const connLayer = createTestLayer({
        list: () => [],
        registerDirect: () => {},
      });
      const fullLayer = Layer.provide(pluginLayer, connLayer);

      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          expect(registry.size).toBe(2);
        }).pipe(Effect.provide(fullLayer)),
      );

      // LIFO teardown via addFinalizer → teardownAll (reverse order internally)
      expect(teardownOrder).toEqual(["b", "a"]);
    });

    test("continues when some plugins fail to initialize", async () => {
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({ id: "good" }),
          makePlugin({
            id: "bad",
            initialize: async () => {
              throw new Error("init boom");
            },
          }),
          makePlugin({ id: "also-good" }),
        ],
        context: minimalCtx,
      };

      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      const connLayer = createTestLayer({
        list: () => [],
        registerDirect: () => {},
      });
      const fullLayer = Layer.provide(pluginLayer, connLayer);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          return {
            descriptions: registry.describe(),
            healthy: registry.getAllHealthy().map((p) => p.id),
          };
        }).pipe(Effect.provide(fullLayer)),
      );

      // Layer constructed successfully despite partial failure
      expect(result.descriptions).toHaveLength(3);
      expect(result.healthy).toEqual(["good", "also-good"]);
      expect(
        result.descriptions.find((d) => d.id === "bad")?.status,
      ).toBe("unhealthy");
    });
  });

  // ── createPluginTestLayer ────────────────────────────────────────

  describe("createPluginTestLayer", () => {
    test("provides stubbed methods", async () => {
      const testLayer = createPluginTestLayer({
        getAll: () => [makePlugin({ id: "stub-1" })],
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          return registry.getAll();
        }).pipe(Effect.provide(testLayer)),
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("stub-1");
    });

    test("throws descriptive error on unimplemented methods", async () => {
      const testLayer = createPluginTestLayer({});

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          registry.get("anything");
        }).pipe(Effect.provide(testLayer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    });

    test("supports size property in partial", async () => {
      const testLayer = createPluginTestLayer({
        size: 42,
      } as Partial<import("@atlas/api/lib/effect/services").PluginRegistryShape>);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          return registry.size;
        }).pipe(Effect.provide(testLayer)),
      );

      expect(result).toBe(42);
    });
  });
});
