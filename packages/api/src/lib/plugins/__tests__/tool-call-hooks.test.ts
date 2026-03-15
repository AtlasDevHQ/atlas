/**
 * Tests for beforeToolCall / afterToolCall plugin hooks.
 *
 * Exercises dispatch via dispatchMutableHook for the new tool call hook names,
 * verifying: args mutation, result mutation, rejection (throw), multi-plugin
 * chaining, and observation-only (void return) pass-through.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PluginRegistry } from "../registry";
import type { PluginLike, PluginContextLike } from "../registry";
import { dispatchHook, dispatchMutableHook } from "../hooks";

const minimalCtx: PluginContextLike = {
  db: null,
  connections: { get: () => ({}), list: () => [] },
  tools: { register: () => {} },
  logger: {},
  config: {},
};

function makeHookPlugin(
  id: string,
  hooks: Record<string, Array<{ matcher?: (ctx: unknown) => boolean; handler: (ctx: unknown) => unknown }>>,
  opts?: { unhealthy?: boolean },
): PluginLike {
  return {
    id,
    types: ["context"] as PluginLike["types"],
    version: "1.0.0",
    hooks,
    ...(opts?.unhealthy
      ? { initialize: async () => { throw new Error("fail"); } }
      : {}),
  };
}

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
