/**
 * createDatasourcePlugin — the datasource assembly factory (#4192).
 *
 * Pins the assembly contract the six datasource plugins used to hand-roll:
 * the static-vs-adapter-only mode branch, the `createFromConfig`
 * strict-parse → build → attach-introspection wrapper (ADR-0013 per-workspace
 * connections; ADR-0017 / #3667 introspection as a capability of the BUILT
 * connection), the standard initialize logging, the adapter-only + measured
 * SELECT-1 health check, and static-connection caching + teardown.
 *
 * This test retires the four near-identical
 * `plugins/{clickhouse,snowflake,bigquery,duckdb}/__tests__/built-connection-introspection.test.ts`
 * copies: the harness they duplicated (createFromConfig returns the
 * attachIntrospection-bound connection, forwarding the parsed + raw configs)
 * is pinned once here, at the factory seam. The Elasticsearch and Salesforce
 * copies remain in their plugins — they pin plugin-specific tenant-credential
 * routing, not the shared assembly.
 */

import { describe, test, expect, mock } from "bun:test";
import { z } from "zod";
import { createDatasourcePlugin } from "../helpers";
import type { PluginDBConnection, PluginQueryResult } from "../types";
import { createMockContext } from "../testing";

const EMPTY_RESULT: PluginQueryResult = { columns: [], rows: [] };

/** A minimal connection whose query/close are inspectable mocks. */
function makeConn(overrides?: Partial<PluginDBConnection>): PluginDBConnection & {
  query: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
} {
  return {
    query: mock(async () => EMPTY_RESULT),
    close: mock(async () => {}),
    ...overrides,
  } as PluginDBConnection & { query: ReturnType<typeof mock>; close: ReturnType<typeof mock> };
}

const ConnectionSchema = z.object({
  url: z
    .string()
    .min(1)
    .refine((u) => u.startsWith("test://"), "URL must start with test://"),
  database: z.string().optional(),
});
const ConfigSchema = ConnectionSchema.partial();
type TestConfig = z.infer<typeof ConfigSchema>;
type TestRuntimeConfig = z.infer<typeof ConnectionSchema>;

/** Blueprint with spies on every seam; per-test option overrides. */
function makeFactory(
  overrides?: Partial<Parameters<typeof createDatasourcePlugin<TestConfig, TestRuntimeConfig>>[0]>,
) {
  const built = makeConn();
  const buildConnection = mock((_parsed: TestRuntimeConfig) => built);
  const listObjects = mock(async () => []);
  const profile = mock(async () => ({ profiles: [], errors: [] }));
  const attachIntrospection = mock(
    (
      builtConn: PluginDBConnection,
      _ctx: { parsed: TestRuntimeConfig; runtimeConfig: Readonly<Record<string, unknown>> },
    ) => ({
      ...builtConn,
      listObjects,
      profile,
    }),
  );
  const factory = createDatasourcePlugin<TestConfig, TestRuntimeConfig>({
    id: "test-datasource",
    name: "Test DataSource",
    dbType: "testdb",
    parserDialect: "PostgresQL",
    forbiddenPatterns: [/\bDANGER\b/i],
    dialect: "Test dialect notes.",
    configSchema: ConfigSchema,
    connectionConfigSchema: ConnectionSchema,
    describeStaticTarget: (c) => `host-of(${c.url})`,
    buildConnection,
    attachIntrospection,
    ...overrides,
  });
  return { factory, built, buildConnection, attachIntrospection, listObjects, profile };
}

// ---------------------------------------------------------------------------
// Config validation + plugin shape
// ---------------------------------------------------------------------------

describe("config validation and shape", () => {
  test("factory validates config through the lenient schema", () => {
    const { factory } = makeFactory();
    expect(() => factory({ url: "not-a-test-url" })).toThrow(/Plugin config validation failed/);
  });

  test("empty config parses — adapter-only registration", () => {
    const { factory } = makeFactory();
    const plugin = factory({});
    expect(plugin.id).toBe("test-datasource");
    expect(plugin.types).toEqual(["datasource"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Test DataSource");
    expect(plugin.entities).toEqual([]);
    expect(plugin.dialect).toBe("Test dialect notes.");
  });

  test(".build assembles without config-schema validation (pre-validated config seam)", () => {
    const { factory } = makeFactory();
    // The lenient schema would reject this url; .build (the old buildXPlugin
    // seam) trusts the caller.
    const plugin = factory.build({ url: "not-a-test-url" });
    expect(plugin.id).toBe("test-datasource");
    // A truthy url still counts as static config for the mode branch.
    expect(plugin.connection.create).toBeDefined();
  });

  test("connection statics pass through (dbType, parserDialect, forbiddenPatterns)", () => {
    const { factory } = makeFactory();
    const plugin = factory({});
    expect(plugin.connection.dbType).toBe("testdb");
    expect(plugin.connection.parserDialect).toBe("PostgresQL");
    expect(plugin.connection.forbiddenPatterns).toHaveLength(1);
  });

  test("custom validate passes through (non-SQL datasources)", async () => {
    const { factory } = makeFactory({
      validate: (q: string) => ({ valid: q.startsWith("SELECT"), reason: "SOQL only" }),
    });
    const plugin = factory({});
    const result = await plugin.connection.validate!("DELETE FROM x");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("SOQL only");
  });

  test("version, logLabel, entities, getConfigSchema, hooks pass through", () => {
    const hooks = { beforeQuery: [{ handler: () => {} }] };
    const { factory } = makeFactory({
      version: "2.0.0",
      entities: [{ name: "e", yaml: "name: e" }],
      getConfigSchema: () => [{ key: "url", type: "string" as const }],
      hooks,
    });
    const plugin = factory({});
    expect(plugin.version).toBe("2.0.0");
    expect(plugin.entities).toEqual([{ name: "e", yaml: "name: e" }]);
    expect(plugin.getConfigSchema!()).toEqual([{ key: "url", type: "string" }]);
    expect(plugin.hooks).toBe(hooks);
  });
});

// ---------------------------------------------------------------------------
// Mode branch — static vs adapter-only
// ---------------------------------------------------------------------------

describe("mode branch", () => {
  test("adapter-only: no create(), createFromConfig available", () => {
    const { factory } = makeFactory();
    const plugin = factory({});
    expect(plugin.connection.create).toBeUndefined();
    expect(plugin.connection.createFromConfig).toBeDefined();
  });

  test("static: create() wired, built via buildConnection with the strict-parsed config", () => {
    const { factory, built, buildConnection } = makeFactory();
    const plugin = factory({ url: "test://host/db", database: "analytics" });
    expect(plugin.connection.create).toBeDefined();
    const conn = plugin.connection.create!();
    expect(conn).toBe(built);
    expect(buildConnection).toHaveBeenCalledTimes(1);
    expect(buildConnection.mock.calls[0][0]).toEqual({ url: "test://host/db", database: "analytics" });
  });

  test("default mode predicate keys on a non-empty url; hasStaticConfig overrides it", () => {
    const { factory } = makeFactory({
      hasStaticConfig: (c: TestConfig) => c.database === "static-marker",
    });
    expect(factory({ url: "test://host/db" }).connection.create).toBeUndefined();
    expect(factory({ database: "static-marker" }).connection.create).toBeDefined();
  });

  test("dialect function form receives the mode", () => {
    const { factory } = makeFactory({
      dialect: (hasStatic: boolean) => (hasStatic ? "static-guide" : "adapter-guide"),
    });
    expect(factory({ url: "test://h/d" }).dialect).toBe("static-guide");
    expect(factory({}).dialect).toBe("adapter-guide");
  });
});

// ---------------------------------------------------------------------------
// createFromConfig — strict parse → build → attach introspection (ADR-0013/0017)
// ---------------------------------------------------------------------------

describe("createFromConfig", () => {
  test("rejects a runtime config that fails the strict schema", () => {
    const { factory } = makeFactory();
    const plugin = factory({});
    expect(() => plugin.connection.createFromConfig!({})).toThrow();
  });

  test("returns the attachIntrospection-bound connection — introspection is a capability of the BUILT connection (#3667)", async () => {
    const { factory, built, attachIntrospection, listObjects, profile } = makeFactory();
    const plugin = factory({});
    const runtimeConfig = { url: "test://tenant/db", database: "tenant_db" };
    const conn = plugin.connection.createFromConfig!(runtimeConfig) as PluginDBConnection;
    // attachIntrospection received the built connection + parsed and RAW configs.
    expect(attachIntrospection).toHaveBeenCalledTimes(1);
    expect(attachIntrospection.mock.calls[0][0]).toBe(built);
    const ctx = attachIntrospection.mock.calls[0][1];
    expect(ctx.parsed).toEqual(runtimeConfig);
    // The RAW record rides through verbatim (BigQuery/ES profile with it).
    expect(ctx.runtimeConfig).toBe(runtimeConfig);
    // The returned connection IS the bound one — listObjects/profile attached.
    await (conn.listObjects as NonNullable<typeof conn.listObjects>)();
    expect(listObjects).toHaveBeenCalledTimes(1);
    await conn.profile!({});
    expect(profile).toHaveBeenCalledTimes(1);
  });

  test("normalizeRuntimeConfig reshapes before the strict parse; attachIntrospection still gets the raw record", () => {
    const { factory, attachIntrospection, buildConnection } = makeFactory({
      normalizeRuntimeConfig: (raw: Readonly<Record<string, unknown>>) => ({
        url: raw.connection_url,
      }),
    });
    const plugin = factory({});
    const raw = { connection_url: "test://snake/case" };
    plugin.connection.createFromConfig!(raw);
    expect(buildConnection.mock.calls[0][0]).toEqual({ url: "test://snake/case" });
    const ctx = attachIntrospection.mock.calls[0][1];
    expect(ctx.runtimeConfig).toBe(raw);
  });

  test("the static create() path does NOT attach introspection (boot-wired shape unchanged)", () => {
    const { factory, attachIntrospection } = makeFactory();
    const plugin = factory({ url: "test://host/db" });
    const conn = plugin.connection.create!() as PluginDBConnection;
    expect(attachIntrospection).not.toHaveBeenCalled();
    expect(conn.listObjects).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// initialize — mode logging + onInitialize + runtime logger
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("static mode logs '<label> datasource plugin initialized (<target>)'", async () => {
    const { factory } = makeFactory();
    const plugin = factory({ url: "test://host/db" });
    const { ctx, logs } = createMockContext();
    await plugin.initialize!(ctx);
    const msg = logs.find((l) => l.msg.includes("Test datasource plugin initialized"));
    expect(msg).toBeDefined();
    expect(msg!.msg).toContain("host-of(test://host/db)");
  });

  test("adapter-only mode logs the registered-as-adapter-only line", async () => {
    const { factory } = makeFactory();
    const plugin = factory({});
    const { ctx, logs } = createMockContext();
    await plugin.initialize!(ctx);
    expect(
      logs.some((l) =>
        l.msg.includes(
          "Test datasource plugin registered as adapter-only — per-workspace datasources via Admin → Connections",
        ),
      ),
    ).toBe(true);
  });

  test("logLabel overrides the derived brand", async () => {
    const { factory } = makeFactory({ logLabel: "CustomBrand" });
    const plugin = factory({});
    const { ctx, logs } = createMockContext();
    await plugin.initialize!(ctx);
    expect(logs.some((l) => l.msg.includes("CustomBrand datasource plugin registered as adapter-only"))).toBe(true);
  });

  test("onInitialize runs after the mode log, with ctx + runtime (mode + bound logger)", async () => {
    const seen: { hasStatic?: boolean; loggerBound?: boolean; order?: number } = {};
    const { factory } = makeFactory({
      onInitialize: (ctx, rt) => {
        seen.hasStatic = rt.hasStaticConfig;
        seen.loggerBound = rt.logger === ctx.logger;
        ctx.logger.info("onInitialize-extra");
      },
    });
    const plugin = factory({ url: "test://host/db" });
    const { ctx, logs } = createMockContext();
    await plugin.initialize!(ctx);
    expect(seen.hasStatic).toBe(true);
    expect(seen.loggerBound).toBe(true);
    const initIdx = logs.findIndex((l) => l.msg.includes("initialized"));
    const extraIdx = logs.findIndex((l) => l.msg.includes("onInitialize-extra"));
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(extraIdx).toBeGreaterThan(initIdx);
  });

  test("runtime.logger is a live accessor: undefined before initialize, bound after", async () => {
    let capturedLogger: (() => unknown) | undefined;
    const { factory } = makeFactory({
      hooks: (rt) => {
        capturedLogger = () => rt.logger;
        return {};
      },
    });
    const plugin = factory({});
    expect(capturedLogger!()).toBeUndefined();
    const { ctx } = createMockContext();
    await plugin.initialize!(ctx);
    expect(capturedLogger!()).toBe(ctx.logger);
  });
});

// ---------------------------------------------------------------------------
// healthCheck — adapter-only branch + measured default SELECT-1 probe
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("adapter-only reports healthy without probing", async () => {
    const { factory, buildConnection } = makeFactory();
    const plugin = factory({});
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("adapter-only");
    expect(buildConnection).not.toHaveBeenCalled();
  });

  test("static default probe runs SELECT 1 (5s timeout) on a fresh connection and closes it", async () => {
    const { factory, built } = makeFactory();
    const plugin = factory({ url: "test://host/db" });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(built.query).toHaveBeenCalledWith("SELECT 1", 5000);
    expect(built.close).toHaveBeenCalledTimes(1);
  });

  test("query failure → unhealthy with the error message, connection still closed, warn logged", async () => {
    const { factory, built } = makeFactory();
    built.query.mockImplementation(() => Promise.reject(new Error("Connection refused")));
    const plugin = factory({ url: "test://host/db" });
    const { ctx, logs } = createMockContext();
    await plugin.initialize!(ctx);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("Connection refused");
    expect(typeof result.latencyMs).toBe("number");
    expect(built.close).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("Connection refused"))).toBe(true);
  });

  test("connection construction failure → unhealthy, not a throw", async () => {
    const { factory } = makeFactory({
      buildConnection: () => {
        throw new Error("client init failed");
      },
    });
    const plugin = factory({ url: "test://host/db" });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("client init failed");
  });

  test("a throwing close() cannot mask the probe result (guarded finally)", async () => {
    const { factory, built } = makeFactory();
    built.close.mockImplementation(() => Promise.reject(new Error("drain failed")));
    const plugin = factory({ url: "test://host/db" });
    const { ctx, logs } = createMockContext();
    await plugin.initialize!(ctx);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("drain failed"))).toBe(true);
  });

  test("custom healthProbe replaces the default and is latency-stamped", async () => {
    const { factory, buildConnection } = makeFactory({
      healthProbe: async () => ({ healthy: false, message: "scrubbed message" }),
    });
    const plugin = factory({ url: "test://host/db" });
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toBe("scrubbed message");
    expect(typeof result.latencyMs).toBe("number");
    expect(buildConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Static-connection caching + teardown
// ---------------------------------------------------------------------------

describe("static connection caching", () => {
  test("uncached (default): every create() builds fresh", () => {
    const { factory, buildConnection } = makeFactory();
    const plugin = factory({ url: "test://host/db" });
    plugin.connection.create!();
    plugin.connection.create!();
    expect(buildConnection).toHaveBeenCalledTimes(2);
    // No cache → no factory-emitted teardown.
    expect(plugin.teardown).toBeUndefined();
  });

  test("cacheStaticConnection: create() shares one instance; teardown closes and resets it", async () => {
    const conns: ReturnType<typeof makeConn>[] = [];
    const { factory } = makeFactory({
      cacheStaticConnection: true,
      createStaticConnection: () => {
        const c = makeConn();
        conns.push(c);
        return c;
      },
    });
    const plugin = factory({ url: "test://host/db" });
    const a = plugin.connection.create!();
    const b = plugin.connection.create!();
    expect(a).toBe(b);
    expect(conns).toHaveLength(1);
    await plugin.teardown!();
    expect(conns[0].close).toHaveBeenCalledTimes(1);
    // Cache reset — next create builds a new one.
    plugin.connection.create!();
    expect(conns).toHaveLength(2);
  });

  test("teardown is a no-op when no connection was created, and never throws on a failing close", async () => {
    const conn = makeConn();
    conn.close.mockImplementation(() => Promise.reject(new Error("already logged out")));
    const { factory } = makeFactory({
      cacheStaticConnection: true,
      createStaticConnection: () => conn,
    });
    const plugin = factory({ url: "test://host/db" });
    await plugin.teardown!(); // nothing cached yet — no close
    expect(conn.close).not.toHaveBeenCalled();
    plugin.connection.create!();
    await plugin.teardown!(); // close rejects — swallowed with a warn
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test("extra teardown option runs after the cache close", async () => {
    const order: string[] = [];
    const conn = makeConn();
    conn.close.mockImplementation(async () => {
      order.push("close");
    });
    const { factory } = makeFactory({
      cacheStaticConnection: true,
      createStaticConnection: () => conn,
      teardown: () => {
        order.push("extra");
      },
    });
    const plugin = factory({ url: "test://host/db" });
    plugin.connection.create!();
    await plugin.teardown!();
    expect(order).toEqual(["close", "extra"]);
  });

  test("staticConnection() throws in adapter-only mode", () => {
    let staticConnection: (() => unknown) | undefined;
    const { factory } = makeFactory({
      hooks: (rt) => {
        staticConnection = () => rt.staticConnection();
        return {};
      },
    });
    factory({});
    expect(staticConnection!).toThrow(/adapter-only — no static datasource configured/);
  });

  test("two instances from one blueprint never share cache or logger", async () => {
    const conns: ReturnType<typeof makeConn>[] = [];
    const { factory } = makeFactory({
      cacheStaticConnection: true,
      createStaticConnection: () => {
        const c = makeConn();
        conns.push(c);
        return c;
      },
    });
    const p1 = factory({ url: "test://one/db" });
    const p2 = factory({ url: "test://two/db" });
    const c1 = p1.connection.create!();
    const c2 = p2.connection.create!();
    expect(c1).not.toBe(c2);
    const { ctx: ctx1 } = createMockContext();
    await p1.initialize!(ctx1);
    // p2 was never initialized — its teardown close-warn path must not see p1's logger.
    await p2.teardown!();
    expect(conns).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Type-level: createStaticConnection is mandatory when TConn narrows (#4278)
// ---------------------------------------------------------------------------

describe("static-connection requirement (type-level)", () => {
  interface NarrowConn extends PluginDBConnection {
    marker(): void;
  }
  const baseOptions = {
    id: "narrow",
    name: "Narrow DataSource",
    dbType: "testdb" as const,
    dialect: "x",
    configSchema: ConfigSchema,
    connectionConfigSchema: ConnectionSchema,
    describeStaticTarget: (c: TestConfig) => String(c.url),
    buildConnection: (_p: TestRuntimeConfig) => makeConn(),
    attachIntrospection: (built: PluginDBConnection) => built,
  };

  test("a narrowed TConn without createStaticConnection fails tsgo", () => {
    // The @ts-expect-error IS the assertion: narrowing TConn below
    // PluginDBConnection makes createStaticConnection required, so omitting it
    // must not compile. Regressing the requirement turns this into an
    // unused-directive type error under the `type` CI gate.
    // @ts-expect-error createStaticConnection required when TConn narrows (#4278)
    const bad = createDatasourcePlugin<TestConfig, TestRuntimeConfig, NarrowConn>(baseOptions);
    // Supplying it compiles.
    const good = createDatasourcePlugin<TestConfig, TestRuntimeConfig, NarrowConn>({
      ...baseOptions,
      createStaticConnection: () => ({ ...makeConn(), marker() {} }),
    });
    expect(typeof bad).toBe("function");
    expect(typeof good).toBe("function");
  });
});
