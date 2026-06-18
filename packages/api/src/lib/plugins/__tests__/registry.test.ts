import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Capture spans recorded by the registry (#1979) without spinning up an
// in-memory exporter. Must be registered before importing PluginRegistry
// so the module picks up the mocked withSpan.
const spanCalls: { name: string; attributes: Record<string, unknown> }[] = [];

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (
    name: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) => {
    spanCalls.push({ name, attributes });
    return fn();
  },
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

const { PluginRegistry, getPluginHealthCacheTtlMs } = await import("../registry");
type PluginRegistryT = InstanceType<typeof PluginRegistry>;
import type { PluginLike, PluginContextLike } from "../registry";

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [], tables: () => [] },
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

describe("PluginRegistry", () => {
  let registry: PluginRegistryT;

  beforeEach(() => {
    registry = new PluginRegistry();
    spanCalls.length = 0;
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
        connections: { get: () => ({}), list: () => [], tables: () => [] },
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

    // #3681 — a plugin whose boot-time schema migration failed is marked
    // unhealthy BEFORE init; initializeAll must skip it (its tables were
    // never created) rather than run initialize() against missing tables.
    test("skips a plugin already marked unhealthy and keeps it unhealthy", async () => {
      const badInit = mock(() => Promise.resolve());
      const goodInit = mock(() => Promise.resolve());
      registry.register(makePlugin({ id: "bad", initialize: badInit }));
      registry.register(makePlugin({ id: "good", initialize: goodInit }));

      // Simulate a failed schema migration on "bad".
      expect(registry.markUnhealthy("bad", "schema migration failed")).toBe(true);

      const result = await registry.initializeAll(minimalCtx);

      expect(badInit).not.toHaveBeenCalled();
      expect(goodInit).toHaveBeenCalledTimes(1);
      expect(result.failed).toContain("bad");
      expect(result.succeeded).toEqual(["good"]);
      expect(registry.getStatus("bad")).toBe("unhealthy");
      expect(registry.getStatus("good")).toBe("healthy");
    });
  });

  // --- markUnhealthy ---

  describe("markUnhealthy", () => {
    test("flips a registered plugin to unhealthy", () => {
      registry.register(makePlugin({ id: "p" }));
      expect(registry.getStatus("p")).toBe("registered");
      expect(registry.markUnhealthy("p")).toBe(true);
      expect(registry.getStatus("p")).toBe("unhealthy");
    });

    test("returns false for an unknown plugin id", () => {
      expect(registry.markUnhealthy("nope")).toBe(false);
    });
  });

  // --- markUnhealthy stickiness against the health loop (#3681) ---

  describe("markUnhealthy + healthCheckAll (sticky)", () => {
    // The headline #3681 guarantee: a plugin disabled by a failed boot-time
    // schema migration must stay unhealthy. If healthCheckAll re-probed it and
    // its healthCheck() only validated an external upstream (not its missing
    // tables), the next 60s tick would flip it back to "healthy", re-surface it
    // via getByType, and let it dispatch against relations that never existed.
    test("healthCheckAll never re-probes or promotes a migration-failed plugin", async () => {
      const probe = mock(async () => ({ healthy: true, latencyMs: 1 }));
      registry.register(makePlugin({ id: "broken", healthCheck: probe }));
      await registry.initializeAll(minimalCtx);

      registry.markUnhealthy("broken", "schema migration failed: boom");
      expect(registry.getStatus("broken")).toBe("unhealthy");

      const results = await registry.healthCheckAll();

      // The probe is skipped entirely, and the plugin stays unhealthy with the
      // migration reason — it does NOT flip to the probe's healthy result.
      expect(probe).not.toHaveBeenCalled();
      const entry = results.get("broken");
      expect(entry?.healthy).toBe(false);
      expect(entry?.status).toBe("unhealthy");
      expect(entry?.message).toBe("schema migration failed: boom");
      expect(registry.getStatus("broken")).toBe("unhealthy");

      // Stays unhealthy across repeated ticks and is never surfaced for dispatch.
      await registry.healthCheckAll();
      expect(probe).not.toHaveBeenCalled();
      expect(registry.getByType("datasource")).toEqual([]);
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

  // --- healthCheckAllCached (#3201) ---

  describe("healthCheckAllCached", () => {
    // Build a plugin whose healthCheck increments a shared counter so tests
    // can assert how many times the upstream probe actually ran.
    function countingPlugin(
      counter: { calls: number },
      result: () => Promise<{ healthy: boolean; message?: string }> = async () => ({
        healthy: true,
      }),
    ): PluginLike {
      return makePlugin({
        healthCheck: async () => {
          counter.calls++;
          return result();
        },
      });
    }

    test("repeated calls within the TTL probe upstream at most once", async () => {
      const counter = { calls: 0 };
      registry.register(countingPlugin(counter));
      await registry.initializeAll(minimalCtx);

      // Large TTL — the second sequential call must hit the cache.
      const a = await registry.healthCheckAllCached(60_000);
      const b = await registry.healthCheckAllCached(60_000);

      expect(counter.calls).toBe(1);
      expect(b.get("test-plugin")?.healthy).toBe(true);
      // Same snapshot object returned from the cache.
      expect(b).toBe(a);
    });

    test("re-probes once the TTL has elapsed", async () => {
      const counter = { calls: 0 };
      registry.register(countingPlugin(counter));
      await registry.initializeAll(minimalCtx);

      // ttl=0 → every sequential call is considered stale and re-probes.
      await registry.healthCheckAllCached(0);
      await registry.healthCheckAllCached(0);

      expect(counter.calls).toBe(2);
    });

    test("coalesces concurrent callers onto a single in-flight probe", async () => {
      const counter = { calls: 0 };
      registry.register(
        countingPlugin(
          counter,
          () =>
            // Defer resolution a tick so both callers observe the in-flight probe.
            new Promise((resolve) =>
              setTimeout(() => resolve({ healthy: true }), 5),
            ),
        ),
      );
      await registry.initializeAll(minimalCtx);

      const [a, b] = await Promise.all([
        registry.healthCheckAllCached(60_000),
        registry.healthCheckAllCached(60_000),
      ]);

      expect(counter.calls).toBe(1);
      expect(a).toBe(b);
    });

    test("caches an unhealthy result verbatim — the cache never masks it", async () => {
      const counter = { calls: 0 };
      registry.register(
        countingPlugin(counter, async () => ({
          healthy: false,
          message: "upstream down",
        })),
      );
      await registry.initializeAll(minimalCtx);

      const first = await registry.healthCheckAllCached(60_000);
      const second = await registry.healthCheckAllCached(60_000);

      expect(counter.calls).toBe(1);
      for (const snapshot of [first, second]) {
        const entry = snapshot.get("test-plugin");
        expect(entry?.healthy).toBe(false);
        expect(entry?.status).toBe("unhealthy");
        expect(entry?.message).toBe("upstream down");
      }
    });

    test("does not cache a rejected probe — the next call re-probes", async () => {
      const counter = { calls: 0 };
      registry.register(countingPlugin(counter)); // always healthy
      await registry.initializeAll(minimalCtx);

      // healthCheckAll catches per-plugin failures, so it never rejects from a
      // plugin probe. The rejection path is a registry-level failure (module
      // load, iterator bug). Force it to reject once, then delegate to the
      // real implementation.
      const realHealthCheckAll = registry.healthCheckAll.bind(registry);
      let threw = false;
      registry.healthCheckAll = async () => {
        if (!threw) {
          threw = true;
          throw new Error("registry-level failure");
        }
        return realHealthCheckAll();
      };

      await expect(registry.healthCheckAllCached(60_000)).rejects.toThrow(
        "registry-level failure",
      );
      // Rejection was not cached: the retry probes live and resolves healthy.
      const retry = await registry.healthCheckAllCached(60_000);
      expect(retry.get("test-plugin")?.healthy).toBe(true);
      expect(counter.calls).toBe(1); // probe ran once, on the successful retry
    });

    test("_reset clears the cached snapshot", async () => {
      const counter = { calls: 0 };
      registry.register(countingPlugin(counter));
      await registry.initializeAll(minimalCtx);

      await registry.healthCheckAllCached(60_000);
      expect(counter.calls).toBe(1);

      registry._reset();
      // After reset there are no plugins; re-register and probe again.
      registry.register(countingPlugin(counter));
      await registry.initializeAll(minimalCtx);
      await registry.healthCheckAllCached(60_000);

      // A fresh probe ran post-reset (cache did not survive the reset).
      expect(counter.calls).toBe(2);
    });
  });

  // --- getPluginHealthCacheTtlMs (#3201) ---

  describe("getPluginHealthCacheTtlMs", () => {
    const ENV = "ATLAS_HEALTH_PLUGIN_CACHE_TTL_MS";
    const orig = process.env[ENV];

    afterEach(() => {
      if (orig === undefined) delete process.env[ENV];
      else process.env[ENV] = orig;
    });

    test("defaults to 15000ms when unset", () => {
      delete process.env[ENV];
      expect(getPluginHealthCacheTtlMs()).toBe(15_000);
    });

    test("honours a valid override", () => {
      process.env[ENV] = "30000";
      expect(getPluginHealthCacheTtlMs()).toBe(30_000);
    });

    test("allows 0 to disable caching", () => {
      process.env[ENV] = "0";
      expect(getPluginHealthCacheTtlMs()).toBe(0);
    });

    test("falls back to the default on a non-numeric value", () => {
      process.env[ENV] = "not-a-number";
      expect(getPluginHealthCacheTtlMs()).toBe(15_000);
    });

    test("falls back to the default on a negative value", () => {
      process.env[ENV] = "-1";
      expect(getPluginHealthCacheTtlMs()).toBe(15_000);
    });
  });

  // --- teardownAll ---

  describe("refresh (#3704 — operator-credential rebuild seam)", () => {
    test("tears down then re-initializes a single plugin, reusing the init context", async () => {
      const calls: string[] = [];
      let initCtx: PluginContextLike | null = null;
      registry.register(
        makePlugin({
          id: "chat-interaction",
          initialize: async (ctx) => {
            calls.push("init");
            initCtx = ctx;
          },
          teardown: async () => {
            calls.push("teardown");
          },
        }),
      );
      await registry.initializeAll(minimalCtx);
      expect(calls).toEqual(["init"]);

      const result = await registry.refresh("chat-interaction");

      expect(result.ok).toBe(true);
      // teardown then a fresh init — the rebuild order.
      expect(calls).toEqual(["init", "teardown", "init"]);
      expect(registry.getStatus("chat-interaction")).toBe("healthy");
      // The re-init received a (logger-wrapped) context derived from the
      // captured one — db/connections/config are the same references.
      expect(initCtx).not.toBeNull();
      expect((initCtx as unknown as PluginContextLike).config).toBe(minimalCtx.config);
    });

    test("returns ok:false (does not throw) for an unregistered plugin", async () => {
      await registry.initializeAll(minimalCtx);
      const result = await registry.refresh("nope");
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("not registered"),
      });
    });

    test("returns ok:false when plugins were never initialized", async () => {
      registry.register(makePlugin({ id: "chat-interaction", initialize: async () => {} }));
      const result = await registry.refresh("chat-interaction");
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("not been initialized"),
      });
    });

    test("a failing re-init marks the plugin unhealthy and reports the reason", async () => {
      let first = true;
      registry.register(
        makePlugin({
          id: "chat-interaction",
          initialize: async () => {
            if (first) {
              first = false;
              return;
            }
            throw new Error("decrypt failed: auth tag mismatch");
          },
          teardown: async () => {},
        }),
      );
      await registry.initializeAll(minimalCtx);

      const result = await registry.refresh("chat-interaction");

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("auth tag mismatch"),
      });
      expect(registry.getStatus("chat-interaction")).toBe("unhealthy");
    });

    test("a teardown failure is non-fatal — re-init still runs", async () => {
      const calls: string[] = [];
      registry.register(
        makePlugin({
          id: "chat-interaction",
          initialize: async () => {
            calls.push("init");
          },
          teardown: async () => {
            calls.push("teardown");
            throw new Error("teardown boom");
          },
        }),
      );
      await registry.initializeAll(minimalCtx);

      const result = await registry.refresh("chat-interaction");

      expect(result.ok).toBe(true);
      expect(calls).toEqual(["init", "teardown", "init"]);
    });

    test("a successful refresh invalidates the cached /health snapshot", async () => {
      const counter = { calls: 0 };
      registry.register(
        makePlugin({
          id: "chat-interaction",
          initialize: async () => {},
          healthCheck: async () => {
            counter.calls++;
            return { healthy: true };
          },
        }),
      );
      await registry.initializeAll(minimalCtx);

      // Prime the cache and confirm it holds within the TTL.
      await registry.healthCheckAllCached(60_000);
      await registry.healthCheckAllCached(60_000);
      expect(counter.calls).toBe(1);

      const result = await registry.refresh("chat-interaction");
      expect(result.ok).toBe(true);

      // The refresh cleared the snapshot, so the next cached call re-probes
      // the rebuilt plugin even though the TTL has not elapsed.
      await registry.healthCheckAllCached(60_000);
      expect(counter.calls).toBe(2);
    });

    test("a failed refresh also invalidates the snapshot (no stale 'healthy')", async () => {
      let first = true;
      const counter = { calls: 0 };
      registry.register(
        makePlugin({
          id: "chat-interaction",
          initialize: async () => {
            if (first) {
              first = false;
              return;
            }
            throw new Error("decrypt failed during rebuild");
          },
          healthCheck: async () => {
            counter.calls++;
            return { healthy: true };
          },
        }),
      );
      await registry.initializeAll(minimalCtx);

      await registry.healthCheckAllCached(60_000);
      expect(counter.calls).toBe(1);

      const result = await registry.refresh("chat-interaction");
      expect(result.ok).toBe(false);

      // Even though the rebuild failed, a stale snapshot must not keep
      // reporting the now-dead plugin as healthy — the next call re-probes.
      await registry.healthCheckAllCached(60_000);
      expect(counter.calls).toBe(2);
    });
  });

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
      registry.register(makePlugin({ id: "ds1", types: ["datasource"] }));
      registry.register(makePlugin({ id: "ctx1", types: ["context"] }));
      registry.register(
        makePlugin({
          id: "ds2",
          types: ["datasource"],
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
      registry.register(makePlugin({ id: "ds1", types: ["datasource"] }));
      await registry.initializeAll(minimalCtx);

      expect(registry.getByType("action")).toEqual([]);
    });
  });

  // --- getAll ---

  describe("getAll", () => {
    test("returns all plugins regardless of status", async () => {
      registry.register(makePlugin({ id: "healthy1", types: ["datasource"] }));
      registry.register(makePlugin({
        id: "unhealthy1",
        types: ["context"],
        initialize: async () => { throw new Error("fail"); },
      }));
      registry.register(makePlugin({ id: "healthy2", types: ["action"] }));
      await registry.initializeAll(minimalCtx);

      const all = registry.getAll();
      expect(all.map((p) => p.id)).toEqual(["healthy1", "unhealthy1", "healthy2"]);
      expect(all).toHaveLength(3);
    });

    test("returns plugins in registration order", () => {
      registry.register(makePlugin({ id: "c" }));
      registry.register(makePlugin({ id: "a" }));
      registry.register(makePlugin({ id: "b" }));

      expect(registry.getAll().map((p) => p.id)).toEqual(["c", "a", "b"]);
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

  // --- OTel span coverage (#1979) ---

  describe("OTel span coverage", () => {
    test("initializeAll wraps each initialize() in atlas.plugin.init", async () => {
      registry.register(makePlugin({ id: "p1", initialize: async () => {} }));
      registry.register(makePlugin({ id: "p2", initialize: async () => {} }));
      // Plugin without initialize() should not produce a span.
      registry.register(makePlugin({ id: "p3" }));

      await registry.initializeAll(minimalCtx);

      const initSpans = spanCalls.filter((s) => s.name === "atlas.plugin.init");
      expect(initSpans).toHaveLength(2);
      expect(initSpans.map((s) => s.attributes["atlas.plugin_id"])).toEqual(["p1", "p2"]);
    });

    test("teardownAll wraps each teardown() in atlas.plugin.teardown", async () => {
      registry.register(makePlugin({ id: "p1", teardown: async () => {} }));
      registry.register(makePlugin({ id: "p2", teardown: async () => {} }));
      // Plugin without teardown() should not produce a span.
      registry.register(makePlugin({ id: "p3" }));

      await registry.teardownAll();

      const teardownSpans = spanCalls.filter((s) => s.name === "atlas.plugin.teardown");
      expect(teardownSpans).toHaveLength(2);
      // LIFO order — p2 then p1.
      expect(teardownSpans.map((s) => s.attributes["atlas.plugin_id"])).toEqual(["p2", "p1"]);
    });

    test("healthCheckAll emits a single atlas.plugin.healthCheckAll span covering all probes", async () => {
      registry.register(makePlugin({ id: "p1", healthCheck: async () => ({ healthy: true }) }));
      registry.register(makePlugin({ id: "p2", healthCheck: async () => ({ healthy: false }) }));

      await registry.healthCheckAll();

      const healthSpans = spanCalls.filter((s) => s.name === "atlas.plugin.healthCheckAll");
      expect(healthSpans).toHaveLength(1);
      expect(healthSpans[0].attributes["atlas.plugin_count"]).toBe(2);
    });

    test("register() is intentionally NOT span-wrapped (sub-ms array push)", () => {
      // Pinning the registry comment: a drive-by adding a span around
      // register() would dwarf its own measurement and clutter every plugin
      // boot trace. This test fails fast if that asymmetry is broken.
      registry.register(makePlugin({ id: "p1" }));
      registry.register(makePlugin({ id: "p2" }));
      registry.register(makePlugin({ id: "p3" }));
      expect(spanCalls).toHaveLength(0);
    });
  });
});
