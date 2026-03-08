import { describe, test, expect } from "bun:test";
import {
  createMockContext,
  createMockConnection,
  createMockExploreBackend,
  createMockLogger,
} from "../testing";
import type { AtlasPluginContext } from "../types";

// ---------------------------------------------------------------------------
// createMockLogger
// ---------------------------------------------------------------------------

describe("createMockLogger", () => {
  test("captures info messages", () => {
    const { logger, logs } = createMockLogger();
    logger.info("hello");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({ level: "info", msg: "hello" });
  });

  test("captures warn messages", () => {
    const { logger, logs } = createMockLogger();
    logger.warn("warning");
    expect(logs[0]).toEqual({ level: "warn", msg: "warning" });
  });

  test("captures error messages", () => {
    const { logger, logs } = createMockLogger();
    logger.error("fail");
    expect(logs[0]).toEqual({ level: "error", msg: "fail" });
  });

  test("captures debug messages", () => {
    const { logger, logs } = createMockLogger();
    logger.debug("trace");
    expect(logs[0]).toEqual({ level: "debug", msg: "trace" });
  });

  test("captures object + message form", () => {
    const { logger, logs } = createMockLogger();
    logger.info({ key: "value" }, "structured");
    expect(logs[0]).toEqual({
      level: "info",
      obj: { key: "value" },
      msg: "structured",
    });
  });

  test("captures object-only form", () => {
    const { logger, logs } = createMockLogger();
    logger.info({ key: "value" });
    expect(logs[0]).toEqual({
      level: "info",
      obj: { key: "value" },
      msg: "",
    });
  });

  test("appends to provided array", () => {
    const shared: ReturnType<typeof createMockLogger>["logs"] = [];
    const { logger } = createMockLogger(shared);
    logger.info("a");
    logger.warn("b");
    expect(shared).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createMockConnection
// ---------------------------------------------------------------------------

describe("createMockConnection", () => {
  test("returns empty result by default", async () => {
    const conn = createMockConnection();
    const result = await conn.query("SELECT 1");
    expect(result).toEqual({ columns: [], rows: [] });
  });

  test("returns configured query result", async () => {
    const conn = createMockConnection({
      queryResult: {
        columns: ["id", "name"],
        rows: [{ id: 1, name: "test" }],
      },
    });
    const result = await conn.query("SELECT id, name FROM users");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([{ id: 1, name: "test" }]);
  });

  test("tracks query calls", async () => {
    const conn = createMockConnection();
    await conn.query("SELECT 1");
    await conn.query("SELECT 2", 5000);
    expect(conn.queryCalls).toEqual([
      { sql: "SELECT 1", timeoutMs: undefined },
      { sql: "SELECT 2", timeoutMs: 5000 },
    ]);
  });

  test("throws configured query error", async () => {
    const conn = createMockConnection({
      queryError: new Error("connection refused"),
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow("connection refused");
  });

  test("error resets after first throw", async () => {
    const conn = createMockConnection({
      queryError: new Error("one-shot"),
    });
    await expect(conn.query("SELECT 1")).rejects.toThrow("one-shot");
    // Second call succeeds with default result
    const result = await conn.query("SELECT 2");
    expect(result).toEqual({ columns: [], rows: [] });
  });

  test("mockQueryResult overrides result", async () => {
    const conn = createMockConnection();
    conn.mockQueryResult({ columns: ["x"], rows: [{ x: 42 }] });
    const result = await conn.query("SELECT x");
    expect(result.rows).toEqual([{ x: 42 }]);
  });

  test("mockQueryError overrides to error", async () => {
    const conn = createMockConnection();
    conn.mockQueryError(new Error("timeout"));
    await expect(conn.query("SELECT 1")).rejects.toThrow("timeout");
  });

  test("close() sets closed flag", async () => {
    const conn = createMockConnection();
    expect(conn.closed).toBe(false);
    await conn.close();
    expect(conn.closed).toBe(true);
  });

  test("satisfies PluginDBConnection interface", () => {
    const conn = createMockConnection();
    // Structural check — would fail at compile time if interface doesn't match
    const _db: import("../types").PluginDBConnection = conn;
    expect(_db).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createMockExploreBackend
// ---------------------------------------------------------------------------

describe("createMockExploreBackend", () => {
  test("returns empty result by default", async () => {
    const backend = createMockExploreBackend();
    const result = await backend.exec("ls");
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test("returns configured exec result", async () => {
    const backend = createMockExploreBackend({
      execResult: { stdout: "file1.yml\nfile2.yml", stderr: "", exitCode: 0 },
    });
    const result = await backend.exec("ls semantic/entities/");
    expect(result.stdout).toBe("file1.yml\nfile2.yml");
  });

  test("tracks exec calls", async () => {
    const backend = createMockExploreBackend();
    await backend.exec("ls");
    await backend.exec("cat foo.yml");
    expect(backend.execCalls).toEqual(["ls", "cat foo.yml"]);
  });

  test("throws configured exec error", async () => {
    const backend = createMockExploreBackend({
      execError: new Error("sandbox timeout"),
    });
    await expect(backend.exec("sleep 100")).rejects.toThrow("sandbox timeout");
  });

  test("error resets after first throw", async () => {
    const backend = createMockExploreBackend({
      execError: new Error("once"),
    });
    await expect(backend.exec("bad")).rejects.toThrow("once");
    const result = await backend.exec("good");
    expect(result.exitCode).toBe(0);
  });

  test("mockExecResult overrides result", async () => {
    const backend = createMockExploreBackend();
    backend.mockExecResult({
      stdout: "changed",
      stderr: "",
      exitCode: 0,
    });
    const result = await backend.exec("ls");
    expect(result.stdout).toBe("changed");
  });

  test("mockExecError overrides to error", async () => {
    const backend = createMockExploreBackend();
    backend.mockExecError(new Error("fail"));
    await expect(backend.exec("ls")).rejects.toThrow("fail");
  });

  test("close() sets closed flag", async () => {
    const backend = createMockExploreBackend();
    expect(backend.closed).toBe(false);
    await backend.close!();
    expect(backend.closed).toBe(true);
  });

  test("satisfies PluginExploreBackend interface", () => {
    const backend = createMockExploreBackend();
    const _be: import("../types").PluginExploreBackend = backend;
    expect(_be).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createMockContext
// ---------------------------------------------------------------------------

describe("createMockContext", () => {
  test("returns a valid AtlasPluginContext with defaults", () => {
    const { ctx } = createMockContext();
    expect(ctx.db).toBeNull();
    expect(ctx.connections.list()).toEqual([]);
    expect(ctx.config).toEqual({});
    expect(typeof ctx.logger.info).toBe("function");
    expect(typeof ctx.logger.warn).toBe("function");
    expect(typeof ctx.logger.error).toBe("function");
    expect(typeof ctx.logger.debug).toBe("function");
  });

  test("default connections.get() throws", () => {
    const { ctx } = createMockContext();
    expect(() => ctx.connections.get("default")).toThrow(
      "No connections registered in mock context",
    );
  });

  test("captures logs in returned array", () => {
    const { ctx, logs } = createMockContext();
    ctx.logger.info("hello");
    ctx.logger.warn("world");
    expect(logs).toHaveLength(2);
    expect(logs[0].msg).toBe("hello");
    expect(logs[1].msg).toBe("world");
  });

  test("tracks registered tools", () => {
    const { ctx, registeredTools } = createMockContext();
    const mockTool = { name: "myTool", description: "A tool", tool: {} as never };
    ctx.tools.register(mockTool);
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0].name).toBe("myTool");
  });

  test("overrides db", () => {
    const mockDb = {
      query: async () => ({ rows: [{ x: 1 }] }),
      execute: async () => {},
    };
    const { ctx } = createMockContext({ db: mockDb });
    expect(ctx.db).toBe(mockDb);
  });

  test("overrides db to null explicitly", () => {
    const { ctx } = createMockContext({ db: null });
    expect(ctx.db).toBeNull();
  });

  test("overrides connections", () => {
    const mockConn = createMockConnection({
      queryResult: { columns: ["id"], rows: [{ id: 1 }] },
    });
    const { ctx } = createMockContext({
      connections: {
        get: () => mockConn,
        list: () => ["default", "warehouse"],
      },
    });
    expect(ctx.connections.list()).toEqual(["default", "warehouse"]);
    expect(ctx.connections.get("default")).toBe(mockConn);
  });

  test("partial connections override merges with defaults", () => {
    const { ctx } = createMockContext({
      connections: { list: () => ["custom"] },
    });
    expect(ctx.connections.list()).toEqual(["custom"]);
    // get() still uses default (throws)
    expect(() => ctx.connections.get("x")).toThrow();
  });

  test("overrides tools", () => {
    const registered: unknown[] = [];
    const { ctx, registeredTools } = createMockContext({
      tools: { register: (t: unknown) => { registered.push(t); } },
    });
    ctx.tools.register({ name: "x", description: "x", tool: {} as never });
    expect(registered).toHaveLength(1);
    // The default registeredTools array is NOT populated when tools is overridden
    expect(registeredTools).toHaveLength(0);
  });

  test("overrides config", () => {
    const { ctx } = createMockContext({ config: { key: "value" } });
    expect(ctx.config).toEqual({ key: "value" });
  });

  test("overrides logger", () => {
    const customResult = createMockLogger();
    const { ctx, logs } = createMockContext({ logger: customResult.logger });
    ctx.logger.info("custom");
    // Logs go to the custom logger's array, not the default one
    expect(customResult.logs).toHaveLength(1);
    expect(customResult.logs[0].msg).toBe("custom");
    expect(logs).toHaveLength(0);
  });

  test("satisfies AtlasPluginContext interface", () => {
    const { ctx } = createMockContext();
    const _ctx: AtlasPluginContext = ctx;
    expect(_ctx).toBeDefined();
  });
});
