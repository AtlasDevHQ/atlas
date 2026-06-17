import { describe, test, expect } from "bun:test";
import { Effect, Layer, Exit, Cause } from "effect";
import {
  PluginRegistry,
  Migration,
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
import { ToolRegistry } from "@atlas/api/lib/tools/registry";
import {
  getPluginTools,
  getContextFragments,
  getDialectHints,
} from "@atlas/api/lib/plugins/tools";
import { getCache, _resetCache } from "@atlas/api/lib/cache/index";

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [], tables: () => [] },
  tools: { register: () => {} },
  logger: {},
  config: {},
};

// Extract the failure message from a failed Exit so assertions can pin the
// operator-facing remediation text (not just `isFailure`).
function failureMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "";
  const err = Cause.failureOption(exit.cause);
  if (err._tag === "Some" && err.value instanceof Error) return err.value.message;
  return Cause.pretty(exit.cause);
}

function makePlugin(overrides: Partial<PluginLike> = {}): PluginLike {
  return {
    id: "test-plugin",
    types: ["datasource"],
    version: "1.0.0",
    ...overrides,
  };
}

// #3743 — the wired layer now depends on ConnectionRegistry AND Migration.
const migrationOk = Layer.succeed(Migration, { migrated: true });
function wiredDeps() {
  return Layer.merge(
    createTestLayer({ list: () => [], registerDirect: () => {} }),
    migrationOk,
  );
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
      const fullLayer = Layer.provide(pluginLayer, wiredDeps());

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
      const fullLayer = Layer.provide(pluginLayer, wiredDeps());

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
      const fullLayer = Layer.provide(pluginLayer, wiredDeps());

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
      const fullLayer = Layer.provide(pluginLayer, wiredDeps());

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

    // ── #3743 — type-level Migration dependency ────────────────────

    test("requires Migration at the type level (#3741 structural fix)", () => {
      const config: PluginWiringConfig = {
        plugins: [makePlugin({ id: "needs-migration" })],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      const connOnly = createTestLayer({ list: () => [], registerDirect: () => {} });

      // Providing ONLY ConnectionRegistry leaves `Migration` unsatisfied, so the
      // result still carries `Migration` in its requirements (R) — it is NOT
      // `never`. The @ts-expect-error below is the compile-time assertion that
      // the Migration edge exists: if the edge is ever dropped, R becomes
      // `never`, this assignment type-checks, and the unused-directive turns into
      // a tsgo error. This is the structural guarantee from #3743 — plugin init
      // can no longer be expressed without a Migration dependency.
      // @ts-expect-error — Migration is unsatisfied here; R is `Migration`, not `never`.
      const incomplete: Layer.Layer<PluginRegistry, Error, never> =
        Layer.provide(pluginLayer, connOnly);
      expect(incomplete).toBeDefined();
    });

    // ── #3743 — fatal plugin schema-migration failure ──────────────

    test("schema migration failure is FATAL — fails the layer", async () => {
      const config: PluginWiringConfig = {
        plugins: [makePlugin({ id: "schema-plugin" })],
        context: minimalCtx,
        runMigrations: async () => {
          throw new Error("DDL boom");
        },
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, wiredDeps()))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      // The operator-facing message is preserved — a `catch: (err) => err`
      // regression or message reshaping must not pass unnoticed.
      expect(failureMessage(exit)).toContain("Plugin schema migrations failed");
      expect(failureMessage(exit)).toContain("DDL boom");
    });

    // ── #3741 — core-migration outcome gate ────────────────────────

    test("ABORTS plugin init when core migrations FAILED (error set)", async () => {
      let initialized = false;
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "reads-core-table",
            initialize: async () => {
              initialized = true;
            },
          }),
        ],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      // Migration ran but FAILED — half-migrated core schema.
      const migrationFailed = Layer.succeed(Migration, {
        migrated: false,
        error: "relation \"operator_integration_credentials\" does not exist",
      });
      const deps = Layer.merge(
        createTestLayer({ list: () => [], registerDirect: () => {} }),
        migrationFailed,
      );

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, deps))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureMessage(exit)).toContain("Core schema migrations failed");
      // Critically: the plugin's initialize() must NOT have run against the
      // half-migrated schema — this is the #3741 race made unrepresentable.
      expect(initialized).toBe(false);
    });

    test("PROCEEDS with plugin init when migrated:false has NO error (no-DB self-host)", async () => {
      let initialized = false;
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "no-db-plugin",
            initialize: async () => {
              initialized = true;
            },
          }),
        ],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      // No DATABASE_URL: migrations skipped, NO error — a legitimate boot.
      const migrationSkipped = Layer.succeed(Migration, { migrated: false });
      const deps = Layer.merge(
        createTestLayer({ list: () => [], registerDirect: () => {} }),
        migrationSkipped,
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, deps))),
      );

      expect(initialized).toBe(true);
    });

    // ── #3743 — aggregated registration diagnostics ────────────────

    test("aggregates ALL registration failures + actionable message", async () => {
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({ id: "ok-1" }),
          makePlugin({ id: "" }), // empty id → register() throws
          makePlugin({ id: "ok-1" }), // duplicate id → register() throws
        ],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, wiredDeps()))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const msg = failureMessage(exit);
      // Both bad IDs surfaced in one boot (count is 2), with remediation.
      expect(msg).toContain("2 plugin(s) failed to register");
      expect(msg).toContain("Fix your atlas.config.ts plugins array");
    });

    // ── #3743 — single-build memoization across consumers ──────────

    test("wired layer builds ONCE despite multiple consumers (initializeAll not doubled)", async () => {
      let initCount = 0;
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "counted",
            initialize: async () => {
              initCount += 1;
            },
          }),
        ],
        context: minimalCtx,
      };
      // Single shared reference, exactly as `buildAppLayer` holds
      // `pluginRegistryLayer` and feeds it to ConnectionsHydrate / AuthBootstrap /
      // PoolWarmup / PluginConfigGuard + the final mergeAll. Effect memoizes by
      // reference within one build, so `initializeAll` must run once — a stray
      // `Layer.fresh` or a second `makeWired...` call would double it and
      // `registry.initializeAll` throws "cannot be called twice" (loud backstop).
      const wired = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );
      const consumerA = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }),
      ).pipe(Layer.provide(wired));
      const consumerB = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }),
      ).pipe(Layer.provide(wired));
      const composed = Layer.mergeAll(consumerA, consumerB, wired).pipe(
        Layer.provide(wiredDeps()),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(composed)),
      );

      expect(initCount).toBe(1);
    });

    // ── #3743 — ported wiring side-effects ─────────────────────────

    test("publishes plugin tools + freezes the registry after wiring", async () => {
      const toolRegistry = new ToolRegistry();
      const ctx: PluginContextLike = {
        ...minimalCtx,
        tools: {
          register: (tool) =>
            toolRegistry.register(
              tool as Parameters<typeof toolRegistry.register>[0],
            ),
        },
      };
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "tooly",
            types: ["action"],
            initialize: async (c: PluginContextLike) => {
              c.tools.register({
                name: "pluginTool",
                description: "a plugin tool",
                tool: {} as never,
              } as never);
            },
          }),
        ],
        context: ctx,
        toolRegistry,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, wiredDeps()))),
      );

      // setPluginTools published the registry...
      expect(getPluginTools()?.get("pluginTool")).toBeDefined();
      // ...and freeze() ran (further registration throws).
      expect(() =>
        toolRegistry.register({
          name: "late",
          description: "x",
          tool: {} as never,
        } as never),
      ).toThrow(/frozen/);
    });

    test("publishes context fragments from context plugins", async () => {
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "ctx-plugin",
            types: ["context"],
            contextProvider: { load: async () => "FRAGMENT-3743" },
          } as Partial<PluginLike>),
        ],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, wiredDeps()))),
      );

      expect(getContextFragments()).toContain("FRAGMENT-3743");
    });

    test("registers a plugin-provided cache backend", async () => {
      _resetCache();
      const cacheStub = {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        flush: () => {},
        stats: () => ({ hits: 0, misses: 0, size: 0 }),
      };
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "cache-plugin",
            cacheBackend: cacheStub,
          } as Partial<PluginLike>),
        ],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, wiredDeps()))),
      );

      expect(getCache()).toBe(cacheStub as never);
      _resetCache();
    });

    test("publishes datasource dialect hints", async () => {
      const config: PluginWiringConfig = {
        plugins: [
          makePlugin({
            id: "ds-dialect",
            types: ["datasource"],
            connection: { dbType: "test-db", create: async () => ({}) },
            dialect: "spark-sql-3743",
          } as Partial<PluginLike>),
        ],
        context: minimalCtx,
      };
      const pluginLayer = makeWiredPluginRegistryLive(
        config,
        () => new PluginRegistryClass(),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* PluginRegistry;
        }).pipe(Effect.provide(Layer.provide(pluginLayer, wiredDeps()))),
      );

      expect(
        getDialectHints().some((h) => h.dialect === "spark-sql-3743"),
      ).toBe(true);
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
