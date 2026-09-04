/**
 * Tests for `src/lib/plugins/hooks.ts` — `dispatchHook` (observation-only) and
 * `dispatchMutableHook` (mutation-capable) across every hook name the plugin
 * contract exposes.
 *
 * The beforeToolCall / afterToolCall sections were formerly
 * `tool-call-hooks.test.ts`: args mutation, result mutation, rejection
 * (throw), multi-plugin chaining, and observation-only (void return)
 * pass-through.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PluginRegistry } from "../registry";
import type { PluginLike, PluginContextLike } from "../registry";
import { dispatchHook, dispatchMutableHook } from "../hooks";

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [], tables: () => [] },
  tools: { register: () => {} },
  logger: {},
  config: {},
};

function makeHookPlugin(
  id: string,
  hooks: Record<string, Array<{ matcher?: (ctx: unknown) => boolean; handler: (ctx: unknown) => unknown }>>,
  opts?: { type?: string; unhealthy?: boolean },
): PluginLike {
  return {
    id,
    types: [opts?.type ?? "context"] as PluginLike["types"],
    version: "1.0.0",
    hooks,
    ...(opts?.unhealthy
      ? { initialize: async () => { throw new Error("fail"); } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// dispatchHook (observation-only, original behavior)
// ---------------------------------------------------------------------------

describe("dispatchHook", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("no-op when no plugins registered", async () => {
    // Should not throw
    await dispatchHook("beforeQuery", { sql: "SELECT 1" }, registry);
  });

  test("fires handler for matching hook", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("p1", {
      beforeQuery: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    await dispatchHook("beforeQuery", { sql: "SELECT 1" }, registry);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ sql: "SELECT 1" });
  });

  test("skips hook when matcher returns false", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("p1", {
      beforeQuery: [{ matcher: () => false, handler }],
    }));
    await registry.initializeAll(minimalCtx);

    await dispatchHook("beforeQuery", { sql: "SELECT 1" }, registry);

    expect(handler).not.toHaveBeenCalled();
  });

  test("fires handler when matcher returns true", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("p1", {
      beforeQuery: [{ matcher: () => true, handler }],
    }));
    await registry.initializeAll(minimalCtx);

    await dispatchHook("beforeQuery", { sql: "SELECT 1" }, registry);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("catches handler errors without crashing", async () => {
    const goodHandler = mock(() => {});
    registry.register(makeHookPlugin("p-bad", {
      beforeQuery: [{
        handler: () => { throw new Error("hook boom"); },
      }],
    }));
    registry.register(makeHookPlugin("p-good", {
      beforeQuery: [{ handler: goodHandler }],
    }));
    await registry.initializeAll(minimalCtx);

    // Should not throw
    await dispatchHook("beforeQuery", { sql: "SELECT 1" }, registry);

    // The good handler still ran
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  test("only healthy plugins have hooks dispatched", async () => {
    const goodHandler = mock(() => {});
    const badHandler = mock(() => {});

    registry.register(makeHookPlugin("healthy", {
      afterQuery: [{ handler: goodHandler }],
    }));
    registry.register(makeHookPlugin("unhealthy", {
      afterQuery: [{ handler: badHandler }],
    }, { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    await dispatchHook("afterQuery", { sql: "SELECT 1", result: { columns: [], rows: [] } }, registry);

    expect(goodHandler).toHaveBeenCalledTimes(1);
    expect(badHandler).not.toHaveBeenCalled();
  });

  test("multiple plugins, multiple hook entries", async () => {
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    const h3 = mock(() => {});

    registry.register(makeHookPlugin("p1", {
      beforeExplore: [{ handler: h1 }, { handler: h2 }],
    }));
    registry.register(makeHookPlugin("p2", {
      beforeExplore: [{ handler: h3 }],
    }));
    await registry.initializeAll(minimalCtx);

    await dispatchHook("beforeExplore", { command: "ls" }, registry);

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  test("plugins without hooks object are silently skipped", async () => {
    registry.register({
      id: "no-hooks",
      types: ["context"],
      version: "1.0.0",
    });
    await registry.initializeAll(minimalCtx);

    // Should not throw
    await dispatchHook("onRequest", { path: "/api/v1/chat", method: "POST", headers: {} }, registry);
  });

  test("plugins without the specific hook name are skipped", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("p1", {
      beforeQuery: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    // Dispatch a different hook — handler should NOT fire
    await dispatchHook("afterQuery", { sql: "SELECT 1" }, registry);

    expect(handler).not.toHaveBeenCalled();
  });

  test("hooks work across plugin types (cross-cutting)", async () => {
    const dsHandler = mock(() => {});
    const ctxHandler = mock(() => {});

    registry.register(makeHookPlugin("ds-plugin", {
      onRequest: [{ handler: dsHandler }],
    }, { type: "datasource" }));
    registry.register(makeHookPlugin("ctx-plugin", {
      onRequest: [{ handler: ctxHandler }],
    }, { type: "context" }));
    await registry.initializeAll(minimalCtx);

    await dispatchHook("onRequest", { path: "/api/v1/chat", method: "POST", headers: {} }, registry);

    expect(dsHandler).toHaveBeenCalledTimes(1);
    expect(ctxHandler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// dispatchMutableHook (mutation support)
// ---------------------------------------------------------------------------

describe("dispatchMutableHook", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("returns original value when no plugins registered", async () => {
    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );
    expect(result).toBe("SELECT 1");
  });

  test("returns original value when hook returns void (backward compat)", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("p1", {
      beforeQuery: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );

    expect(result).toBe("SELECT 1");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("hook returns { sql } → SQL is rewritten", async () => {
    registry.register(makeHookPlugin("rls", {
      beforeQuery: [{
        handler: (ctx: unknown) => {
          const { sql } = ctx as { sql: string };
          return { sql: `${sql} WHERE tenant_id = 42` };
        },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT * FROM orders", connectionId: "default" },
      "sql",
      registry,
    );

    expect(result).toBe("SELECT * FROM orders WHERE tenant_id = 42");
  });

  test("hook returns { command } → explore command is rewritten", async () => {
    registry.register(makeHookPlugin("filter", {
      beforeExplore: [{
        handler: () => ({ command: "ls entities/" }),
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeExplore",
      { command: "ls" },
      "command",
      registry,
    );

    expect(result).toBe("ls entities/");
  });

  test("hook throws → error propagates (reject use case)", async () => {
    registry.register(makeHookPlugin("deny", {
      beforeQuery: [{
        handler: () => { throw new Error("Access denied: restricted table"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    await expect(
      dispatchMutableHook(
        "beforeQuery",
        { sql: "SELECT * FROM secrets", connectionId: "default" },
        "sql",
        registry,
      ),
    ).rejects.toThrow("Access denied: restricted table");
  });

  test("multiple hooks chain — each sees previous mutation", async () => {
    const seenValues: string[] = [];

    registry.register(makeHookPlugin("hook-1", {
      beforeQuery: [{
        handler: (ctx: unknown) => {
          const { sql } = ctx as { sql: string };
          seenValues.push(sql);
          return { sql: `${sql} WHERE tenant_id = 1` };
        },
      }],
    }));
    registry.register(makeHookPlugin("hook-2", {
      beforeQuery: [{
        handler: (ctx: unknown) => {
          const { sql } = ctx as { sql: string };
          seenValues.push(sql);
          return { sql: `${sql} AND active = true` };
        },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT * FROM users", connectionId: "default" },
      "sql",
      registry,
    );

    expect(seenValues[0]).toBe("SELECT * FROM users");
    expect(seenValues[1]).toBe("SELECT * FROM users WHERE tenant_id = 1");
    expect(result).toBe("SELECT * FROM users WHERE tenant_id = 1 AND active = true");
  });

  test("mixed void and mutation hooks chain correctly", async () => {
    const observerSeen: string[] = [];

    // First hook: observes only
    registry.register(makeHookPlugin("observer", {
      beforeQuery: [{
        handler: (ctx: unknown) => {
          const { sql } = ctx as { sql: string };
          observerSeen.push(sql);
          // returns void — no mutation
        },
      }],
    }));
    // Second hook: mutates
    registry.register(makeHookPlugin("mutator", {
      beforeQuery: [{
        handler: () => ({ sql: "SELECT 1 FROM dual" }),
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT * FROM users", connectionId: "default" },
      "sql",
      registry,
    );

    expect(observerSeen[0]).toBe("SELECT * FROM users");
    expect(result).toBe("SELECT 1 FROM dual");
  });

  test("matcher filters apply to mutable hooks", async () => {
    registry.register(makeHookPlugin("selective", {
      beforeQuery: [{
        matcher: (ctx: unknown) => (ctx as { sql: string }).sql.includes("secrets"),
        handler: () => { throw new Error("Blocked"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    // Should NOT throw — matcher returns false
    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT * FROM users", connectionId: "default" },
      "sql",
      registry,
    );
    expect(result).toBe("SELECT * FROM users");

    // Should throw — matcher returns true
    await expect(
      dispatchMutableHook(
        "beforeQuery",
        { sql: "SELECT * FROM secrets", connectionId: "default" },
        "sql",
        registry,
      ),
    ).rejects.toThrow("Blocked");
  });

  test("unhealthy plugins are skipped in mutable hooks", async () => {
    registry.register(makeHookPlugin("unhealthy-mutator", {
      beforeQuery: [{
        handler: () => ({ sql: "REWRITTEN" }),
      }],
    }, { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );

    expect(result).toBe("SELECT 1");
  });

  test("afterQuery hooks remain void-only (dispatchHook ignores returns)", async () => {
    const handler = mock(() => ({ sql: "SHOULD BE IGNORED" }));
    registry.register(makeHookPlugin("p1", {
      afterQuery: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    // dispatchHook (void) just calls and ignores return
    await dispatchHook("afterQuery", {
      sql: "SELECT 1",
      connectionId: "default",
      result: { columns: ["a"], rows: [{ a: 1 }] },
      durationMs: 10,
    }, registry);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("throw from beforeExplore hook rejects the operation", async () => {
    registry.register(makeHookPlugin("deny-explore", {
      beforeExplore: [{
        handler: () => { throw new Error("Explore denied"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    await expect(
      dispatchMutableHook(
        "beforeExplore",
        { command: "cat /etc/passwd" },
        "command",
        registry,
      ),
    ).rejects.toThrow("Explore denied");
  });

  test("async handler rejection propagates", async () => {
    registry.register(makeHookPlugin("async-deny", {
      beforeQuery: [{
        handler: async () => { throw new Error("async denial"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    await expect(
      dispatchMutableHook(
        "beforeQuery",
        { sql: "SELECT 1", connectionId: "default" },
        "sql",
        registry,
      ),
    ).rejects.toThrow("async denial");
  });

  test("matcher error is caught and entry is skipped (not treated as rejection)", async () => {
    const mutatorHandler = mock(() => ({ sql: "SELECT 2" }));

    registry.register(makeHookPlugin("buggy-matcher", {
      beforeQuery: [{
        matcher: () => { throw new TypeError("Cannot read properties of undefined"); },
        handler: () => ({ sql: "SHOULD NOT RUN" }),
      }],
    }));
    registry.register(makeHookPlugin("good-plugin", {
      beforeQuery: [{ handler: mutatorHandler }],
    }));
    await registry.initializeAll(minimalCtx);

    // Should NOT throw — matcher crash is caught, not treated as rejection
    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );

    // The good plugin still ran and mutated
    expect(result).toBe("SELECT 2");
    expect(mutatorHandler).toHaveBeenCalledTimes(1);
  });

  test("handler returning wrong type is ignored", async () => {
    registry.register(makeHookPlugin("bad-type", {
      beforeQuery: [{
        handler: () => ({ sql: 42 }),
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );

    // Wrong type mutation is ignored, original passes through
    expect(result).toBe("SELECT 1");
  });

  test("handler returning object without mutateKey is ignored", async () => {
    registry.register(makeHookPlugin("wrong-key", {
      beforeQuery: [{
        handler: () => ({ typo: "SELECT 2" }),
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );

    expect(result).toBe("SELECT 1");
  });

  test("handler returning a primitive is ignored", async () => {
    registry.register(makeHookPlugin("primitive", {
      beforeQuery: [{
        handler: () => "rewritten SQL",
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeQuery",
      { sql: "SELECT 1", connectionId: "default" },
      "sql",
      registry,
    );

    expect(result).toBe("SELECT 1");
  });
});

// ---------------------------------------------------------------------------
// beforeToolCall
// ---------------------------------------------------------------------------

describe("beforeToolCall hooks", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("no-op when no plugins registered", async () => {
    const args = { sql: "SELECT 1", explanation: "test" };
    const result = await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "executeSQL", args, context: { toolCallCount: 1 } },
      "args",
      registry,
    );
    expect(result).toBe(args);
  });

  test("fires handler for beforeToolCall", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("p1", {
      beforeToolCall: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    const args = { sql: "SELECT 1" };
    await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "executeSQL", args, context: { toolCallCount: 1 } },
      "args",
      registry,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("returns original args when handler returns void", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("observer", {
      beforeToolCall: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    const args = { sql: "SELECT 1" };
    const result = await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "executeSQL", args, context: { toolCallCount: 1 } },
      "args",
      registry,
    );

    expect(result).toBe(args);
  });

  test("handler returns { args } → args are rewritten", async () => {
    registry.register(makeHookPlugin("rewriter", {
      beforeToolCall: [{
        handler: () => ({ args: { sql: "SELECT 1 FROM dual", explanation: "rewritten" } }),
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "executeSQL", args: { sql: "SELECT 1" } as Record<string, unknown>, context: { toolCallCount: 1 } },
      "args",
      registry,
    );

    expect(result).toEqual({ sql: "SELECT 1 FROM dual", explanation: "rewritten" });
  });

  test("handler throws → error propagates (rejection)", async () => {
    registry.register(makeHookPlugin("deny", {
      beforeToolCall: [{
        handler: () => { throw new Error("Access denied: restricted tool"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    await expect(
      dispatchMutableHook(
        "beforeToolCall",
        { toolName: "executeSQL", args: { sql: "SELECT 1" }, context: { toolCallCount: 1 } },
        "args",
        registry,
      ),
    ).rejects.toThrow("Access denied: restricted tool");
  });

  test("matcher filters apply to beforeToolCall", async () => {
    registry.register(makeHookPlugin("selective", {
      beforeToolCall: [{
        matcher: (ctx: unknown) => (ctx as { toolName: string }).toolName === "executeSQL",
        handler: () => { throw new Error("SQL blocked"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    // Should NOT throw — matcher returns false (different tool)
    const result = await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "explore", args: { command: "ls" }, context: { toolCallCount: 1 } },
      "args",
      registry,
    );
    expect(result).toEqual({ command: "ls" });

    // Should throw — matcher returns true
    await expect(
      dispatchMutableHook(
        "beforeToolCall",
        { toolName: "executeSQL", args: { sql: "SELECT 1" }, context: { toolCallCount: 1 } },
        "args",
        registry,
      ),
    ).rejects.toThrow("SQL blocked");
  });

  test("multiple hooks chain — each sees previous mutation", async () => {
    const seenArgs: Record<string, unknown>[] = [];

    registry.register(makeHookPlugin("hook-1", {
      beforeToolCall: [{
        handler: (ctx: unknown) => {
          const { args } = ctx as { args: Record<string, unknown> };
          seenArgs.push({ ...args });
          return { args: { ...args, injected: true } };
        },
      }],
    }));
    registry.register(makeHookPlugin("hook-2", {
      beforeToolCall: [{
        handler: (ctx: unknown) => {
          const { args } = ctx as { args: Record<string, unknown> };
          seenArgs.push({ ...args });
          return { args: { ...args, second: true } };
        },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "executeSQL", args: { sql: "SELECT 1" } as Record<string, unknown>, context: { toolCallCount: 1 } },
      "args",
      registry,
    );

    expect(seenArgs[0]).toEqual({ sql: "SELECT 1" });
    expect(seenArgs[1]).toEqual({ sql: "SELECT 1", injected: true });
    expect(result).toEqual({ sql: "SELECT 1", injected: true, second: true });
  });

  test("unhealthy plugins are skipped", async () => {
    registry.register(makeHookPlugin("unhealthy", {
      beforeToolCall: [{
        handler: () => { throw new Error("should not fire"); },
      }],
    }, { unhealthy: true }));
    await registry.initializeAll(minimalCtx);

    const args = { sql: "SELECT 1" };
    const result = await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "executeSQL", args, context: { toolCallCount: 1 } },
      "args",
      registry,
    );

    expect(result).toBe(args);
  });

  test("hook receives correct context fields", async () => {
    let receivedCtx: unknown;
    registry.register(makeHookPlugin("inspector", {
      beforeToolCall: [{
        handler: (ctx: unknown) => { receivedCtx = ctx; },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    await dispatchMutableHook(
      "beforeToolCall",
      {
        toolName: "executeSQL",
        args: { sql: "SELECT 1" },
        context: { userId: "user-123", conversationId: "conv-456", toolCallCount: 3 },
      },
      "args",
      registry,
    );

    const ctx = receivedCtx as Record<string, unknown>;
    expect(ctx.toolName).toBe("executeSQL");
    expect(ctx.args).toEqual({ sql: "SELECT 1" });
    expect(ctx.context).toEqual({ userId: "user-123", conversationId: "conv-456", toolCallCount: 3 });
  });
});

// ---------------------------------------------------------------------------
// afterToolCall
// ---------------------------------------------------------------------------

describe("afterToolCall hooks", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("no-op when no plugins registered", async () => {
    const result = { columns: ["id"], rows: [{ id: 1 }] };
    const final = await dispatchMutableHook(
      "afterToolCall",
      { toolName: "executeSQL", args: { sql: "SELECT 1" }, result, context: { toolCallCount: 1 } },
      "result",
      registry,
    );
    expect(final).toBe(result);
  });

  test("handler returns void → original result passes through", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("observer", {
      afterToolCall: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = { success: true, data: [1, 2, 3] };
    const final = await dispatchMutableHook(
      "afterToolCall",
      { toolName: "executeSQL", args: {}, result, context: { toolCallCount: 1 } },
      "result",
      registry,
    );

    expect(final).toBe(result);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("handler returns { result } → result is rewritten", async () => {
    registry.register(makeHookPlugin("redactor", {
      afterToolCall: [{
        handler: (ctx: unknown) => {
          const { result } = ctx as { result: { columns: string[]; rows: Record<string, unknown>[] } };
          return {
            result: {
              ...result,
              rows: result.rows.map((r) => ({ ...r, email: "***REDACTED***" })),
            },
          };
        },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const original = { columns: ["id", "email"], rows: [{ id: 1, email: "test@example.com" }] };
    const final = await dispatchMutableHook(
      "afterToolCall",
      { toolName: "executeSQL", args: {}, result: original, context: { toolCallCount: 1 } },
      "result",
      registry,
    );

    expect(final).toEqual({
      columns: ["id", "email"],
      rows: [{ id: 1, email: "***REDACTED***" }],
    });
  });

  test("matcher filters apply to afterToolCall", async () => {
    const handler = mock(() => ({ result: "modified" }));
    registry.register(makeHookPlugin("selective", {
      afterToolCall: [{
        matcher: (ctx: unknown) => (ctx as { toolName: string }).toolName === "executeSQL",
        handler,
      }],
    }));
    await registry.initializeAll(minimalCtx);

    // Should NOT fire — different tool
    await dispatchMutableHook(
      "afterToolCall",
      { toolName: "explore", args: {}, result: "original", context: { toolCallCount: 1 } },
      "result",
      registry,
    );
    expect(handler).not.toHaveBeenCalled();

    // Should fire — matches tool name
    const final = await dispatchMutableHook(
      "afterToolCall",
      { toolName: "executeSQL", args: {}, result: "original", context: { toolCallCount: 1 } },
      "result",
      registry,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(final).toBe("modified");
  });

  test("multiple hooks chain — each sees previous result mutation", async () => {
    const seenResults: unknown[] = [];

    registry.register(makeHookPlugin("hook-1", {
      afterToolCall: [{
        handler: (ctx: unknown) => {
          const { result } = ctx as { result: number };
          seenResults.push(result);
          return { result: result * 2 };
        },
      }],
    }));
    registry.register(makeHookPlugin("hook-2", {
      afterToolCall: [{
        handler: (ctx: unknown) => {
          const { result } = ctx as { result: number };
          seenResults.push(result);
          return { result: result + 1 };
        },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const final = await dispatchMutableHook(
      "afterToolCall",
      { toolName: "executeSQL", args: {}, result: 5, context: { toolCallCount: 1 } },
      "result",
      registry,
    );

    expect(seenResults[0]).toBe(5);
    expect(seenResults[1]).toBe(10);
    expect(final).toBe(11);
  });

  test("handler throws → error propagates", async () => {
    registry.register(makeHookPlugin("failing", {
      afterToolCall: [{
        handler: () => { throw new Error("post-processing failed"); },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    await expect(
      dispatchMutableHook(
        "afterToolCall",
        { toolName: "executeSQL", args: {}, result: "ok", context: { toolCallCount: 1 } },
        "result",
        registry,
      ),
    ).rejects.toThrow("post-processing failed");
  });

  test("hook receives correct context including result", async () => {
    let receivedCtx: unknown;
    registry.register(makeHookPlugin("inspector", {
      afterToolCall: [{
        handler: (ctx: unknown) => { receivedCtx = ctx; },
      }],
    }));
    await registry.initializeAll(minimalCtx);

    const result = { success: true, columns: ["a"], rows: [{ a: 1 }] };
    await dispatchMutableHook(
      "afterToolCall",
      {
        toolName: "executeSQL",
        args: { sql: "SELECT 1" },
        result,
        context: { userId: "u1", conversationId: "c1", toolCallCount: 2 },
      },
      "result",
      registry,
    );

    const ctx = receivedCtx as Record<string, unknown>;
    expect(ctx.toolName).toBe("executeSQL");
    expect(ctx.args).toEqual({ sql: "SELECT 1" });
    expect(ctx.result).toBe(result);
    expect(ctx.context).toEqual({ userId: "u1", conversationId: "c1", toolCallCount: 2 });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: both hooks work across plugin types
// ---------------------------------------------------------------------------

describe("beforeToolCall / afterToolCall cross-cutting", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  test("hooks fire across different plugin types", async () => {
    const dsHandler = mock(() => {});
    const ctxHandler = mock(() => {});

    registry.register(makeHookPlugin("ds-plugin", {
      beforeToolCall: [{ handler: dsHandler }],
    }));
    // Register second plugin manually with different type
    registry.register({
      id: "ctx-plugin",
      types: ["context"] as PluginLike["types"],
      version: "1.0.0",
      hooks: {
        beforeToolCall: [{ handler: ctxHandler }],
      },
    });
    await registry.initializeAll(minimalCtx);

    await dispatchMutableHook(
      "beforeToolCall",
      { toolName: "explore", args: { command: "ls" }, context: { toolCallCount: 1 } },
      "args",
      registry,
    );

    expect(dsHandler).toHaveBeenCalledTimes(1);
    expect(ctxHandler).toHaveBeenCalledTimes(1);
  });

  test("dispatchHook works for observation-only tool call hooks", async () => {
    const handler = mock(() => {});
    registry.register(makeHookPlugin("observer", {
      beforeToolCall: [{ handler }],
    }));
    await registry.initializeAll(minimalCtx);

    // dispatchHook (void) — handler fires but return is ignored
    await dispatchHook(
      "beforeToolCall",
      { toolName: "explore", args: { command: "ls" }, context: { toolCallCount: 1 } },
      registry,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
