/**
 * Tests for the Effect Layer-based test utilities.
 *
 * Validates that TestAppLayer, TestAdminLayer, TestPlatformLayer,
 * runTest, and buildTestLayer work correctly.
 */
import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import {
  TestAdminLayer,
  TestPlatformLayer,
  runTest,
  buildTestLayer,
  ConnectionRegistry,
  RequestContext,
  AuthContext,
} from "../layers";

// ── TestAppLayer ───────────────────────────────────────────────────

describe("TestAppLayer", () => {
  test("provides ConnectionRegistry with defaults", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        return {
          list: registry.list(),
          has: registry.has("default"),
          dbType: registry.getDBType("default"),
        };
      }),
    );

    expect(result.list).toEqual(["default"]);
    expect(result.has).toBe(true);
    expect(result.dbType).toBe("postgres");
  });

  test("provides RequestContext with test defaults", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx;
      }),
    );

    expect(result.requestId).toBe("test-request-id");
    expect(typeof result.startTime).toBe("number");
  });

  test("provides AuthContext in none mode", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        return auth;
      }),
    );

    expect(result.mode).toBe("none");
    expect(result.user).toBeUndefined();
    expect(result.orgId).toBeUndefined();
  });

  test("connection query returns empty result", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        const conn = registry.getDefault();
        return yield* Effect.promise(() => conn.query("SELECT 1"));
      }),
    );

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});

// ── TestAdminLayer ─────────────────────────────────────────────────

describe("TestAdminLayer", () => {
  test("provides admin auth context", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        return auth;
      }).pipe(Effect.provide(TestAdminLayer)),
    );

    expect(result.mode).toBe("managed");
    expect(result.user?.role).toBe("admin");
    expect(result.orgId).toBe("test-org");
  });

  test("has admin requestId", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const req = yield* RequestContext;
        return req.requestId;
      }).pipe(Effect.provide(TestAdminLayer)),
    );

    expect(result).toBe("test-admin-request");
  });
});

// ── TestPlatformLayer ──────────────────────────────────────────────

describe("TestPlatformLayer", () => {
  test("provides platform_admin auth context", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        return auth;
      }).pipe(Effect.provide(TestPlatformLayer)),
    );

    expect(result.mode).toBe("managed");
    expect(result.user?.role).toBe("platform_admin");
    expect(result.orgId).toBe("test-org");
  });
});

// ── runTest ────────────────────────────────────────────────────────

describe("runTest", () => {
  test("uses TestAppLayer by default", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const req = yield* RequestContext;
        return req.requestId;
      }),
    );

    expect(result).toBe("test-request-id");
  });

  test("accepts custom layer", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        return auth.orgId;
      }),
      TestAdminLayer,
    );

    expect(result).toBe("test-org");
  });
});

// ── buildTestLayer ─────────────────────────────────────────────────

describe("buildTestLayer", () => {
  test("overrides connection behavior", async () => {
    const layer = buildTestLayer({
      connection: {
        list: () => ["pg", "mysql"],
        getDBType: () => "mysql",
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        return { list: registry.list(), dbType: registry.getDBType("mysql") };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.list).toEqual(["pg", "mysql"]);
    expect(result.dbType).toBe("mysql");
  });

  test("overrides auth context", async () => {
    const layer = buildTestLayer({
      auth: { mode: "byot", orgId: "custom-org" },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        return { mode: auth.mode, orgId: auth.orgId };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.mode).toBe("byot");
    expect(result.orgId).toBe("custom-org");
  });

  test("overrides request context", async () => {
    const layer = buildTestLayer({
      request: { requestId: "custom-req" },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const req = yield* RequestContext;
        return req.requestId;
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("custom-req");
  });

  test("defaults when no overrides provided", async () => {
    const layer = buildTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const req = yield* RequestContext;
        const auth = yield* AuthContext;
        const conn = yield* ConnectionRegistry;
        return {
          requestId: req.requestId,
          authMode: auth.mode,
          connections: conn.list(),
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.requestId).toBe("test-request-id");
    expect(result.authMode).toBe("none");
    expect(result.connections).toEqual(["default"]);
  });

  test("partial connection override preserves non-overridden defaults", async () => {
    const layer = buildTestLayer({
      connection: { list: () => ["custom"] },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        const conn = registry.getDefault();
        const qr = yield* Effect.promise(() => conn.query("SELECT 1"));
        return {
          list: registry.list(),
          has: registry.has("default"),
          rows: qr.rows,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.list).toEqual(["custom"]);
    expect(result.has).toBe(true); // non-overridden default preserved
    expect(result.rows).toEqual([]); // default mock query still works
  });
});

// ── PluginRegistry ─────────────────────────────────────────────────

describe("PluginRegistry re-export", () => {
  test("createPluginTestLayer provides working service", async () => {
    const { createPluginTestLayer, PluginRegistry } = await import("../layers");

    const layer = createPluginTestLayer({
      getAll: () => [],
      describe: () => [],
      get size() { return 0; },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        return { all: registry.getAll(), size: registry.size };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.all).toEqual([]);
    expect(result.size).toBe(0);
  });

  test("proxy throws for un-stubbed plugin methods", async () => {
    const { createPluginTestLayer, PluginRegistry } = await import("../layers");

    const layer = createPluginTestLayer({
      getAll: () => [],
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        registry.get("nonexistent"); // not provided — should throw
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });
});

// ── Proxy fail-fast behavior ───────────────────────────────────────

describe("Proxy stub fail-fast", () => {
  test("createTestLayer (low-level) throws on un-provided methods", async () => {
    const { createTestLayer } = await import("@atlas/api/lib/effect/services");
    const { ConnectionRegistry } = await import("../layers");

    // Only provide list — all other methods use Proxy and should throw
    const layer = createTestLayer({ list: () => ["test"] });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* ConnectionRegistry;
        registry.getDBType("test"); // not provided — proxy should throw
      }).pipe(Effect.provide(layer)),
    );

    expect(exit._tag).toBe("Failure");
  });
});
