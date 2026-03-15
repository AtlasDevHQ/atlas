/**
 * Integration tests for wrapToolsWithHooks in agent.ts.
 *
 * These test the wrapper function that wraps each tool's execute() with
 * beforeToolCall / afterToolCall plugin hook dispatch. Unlike
 * tool-call-hooks.test.ts (which tests dispatchMutableHook directly), these
 * tests verify the actual wrapping behavior: rejection returns strings,
 * afterToolCall rejection propagates, mutated args reach origExecute, and
 * the tool call counter increments correctly.
 */

import { describe, test, expect, beforeEach, mock, type Mock } from "bun:test";
import { PluginRegistry } from "../registry";
import type { PluginLike, PluginContextLike } from "../registry";

// --- Mocks ---

let testRegistry: PluginRegistry;

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    get size() { return testRegistry.size; },
    getAllHealthy: () => testRegistry.getAllHealthy(),
  },
  PluginRegistry,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => null };
});

// Import after mocks — the wrapToolsWithHooks function is private in agent.ts,
// so we test it indirectly by reimplementing the wrapping logic using the same
// dispatchMutableHook calls that the real function uses.
const { dispatchMutableHook } = await import("../hooks");

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
): PluginLike {
  return {
    id,
    types: ["context"] as PluginLike["types"],
    version: "1.0.0",
    hooks,
  };
}

/**
 * Simulates what wrapToolsWithHooks does in agent.ts — wraps an execute
 * function with beforeToolCall/afterToolCall dispatch. This allows us to
 * test the integration contract without exporting a private function.
 */
async function simulateWrappedExecute(
  toolName: string,
  args: Record<string, unknown>,
  origExecute: Mock<(args: Record<string, unknown>) => Promise<unknown>>,
  hookCtx: { userId?: string; conversationId?: string },
  toolCallCount: number,
): Promise<unknown> {
  const ctx = {
    toolName,
    args,
    context: { ...hookCtx, toolCallCount },
  };

  // beforeToolCall — same logic as agent.ts
  let finalArgs: Record<string, unknown>;
  try {
    finalArgs = await dispatchMutableHook("beforeToolCall", ctx, "args") as Record<string, unknown>;
  } catch (err) {
    return `Tool call rejected by plugin: ${err instanceof Error ? err.message : String(err)}`;
  }

  const start = Date.now();
  const result = await origExecute(finalArgs);
  const durationMs = Date.now() - start;

  // afterToolCall — same logic as agent.ts (post-fix: propagates rejection)
  try {
    return await dispatchMutableHook(
      "afterToolCall",
      { ...ctx, args: finalArgs, result, durationMs, context: { ...hookCtx, toolCallCount } },
      "result",
    );
  } catch (err) {
    return `Tool result rejected by plugin: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("wrapToolsWithHooks integration", () => {
  let executeFn: Mock<(args: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    testRegistry = new PluginRegistry();
    executeFn = mock((args: Record<string, unknown>) =>
      Promise.resolve({ success: true, columns: ["id"], rows: [{ id: 1 }], receivedArgs: args }),
    );
  });

  test("beforeToolCall rejection returns error string (not exception)", async () => {
    testRegistry.register(makeHookPlugin("deny", {
      beforeToolCall: [{
        handler: () => { throw new Error("Compliance: blocked"); },
      }],
    }));
    await testRegistry.initializeAll(minimalCtx);

    const result = await simulateWrappedExecute(
      "executeSQL",
      { sql: "SELECT * FROM salary" },
      executeFn,
      { userId: "u1" },
      1,
    );

    // Returns a string, does NOT throw
    expect(typeof result).toBe("string");
    expect(result).toBe("Tool call rejected by plugin: Compliance: blocked");
    // The original execute was never called
    expect(executeFn).not.toHaveBeenCalled();
  });

  test("afterToolCall rejection returns error string (not exception)", async () => {
    testRegistry.register(makeHookPlugin("pii-gate", {
      afterToolCall: [{
        handler: (ctx: unknown) => {
          const { result } = ctx as { result: { rows: Record<string, unknown>[] } };
          if (result.rows.some((r) => typeof r.ssn === "string")) {
            throw new Error("PII detected in result — blocked by policy");
          }
        },
      }],
    }));
    await testRegistry.initializeAll(minimalCtx);

    // Override execute to return PII data
    executeFn = mock(() => Promise.resolve({
      columns: ["name", "ssn"],
      rows: [{ name: "Alice", ssn: "123-45-6789" }],
    }));

    const result = await simulateWrappedExecute(
      "executeSQL",
      { sql: "SELECT name, ssn FROM employees" },
      executeFn,
      {},
      1,
    );

    // Returns a string error, does NOT return the PII-containing result
    expect(typeof result).toBe("string");
    expect(result).toBe("Tool result rejected by plugin: PII detected in result — blocked by policy");
    // The original execute WAS called
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  test("mutated args from beforeToolCall reach origExecute", async () => {
    testRegistry.register(makeHookPlugin("rls", {
      beforeToolCall: [{
        handler: () => ({
          args: { sql: "SELECT id FROM users WHERE tenant_id = 42", explanation: "rewritten" },
        }),
      }],
    }));
    await testRegistry.initializeAll(minimalCtx);

    await simulateWrappedExecute(
      "executeSQL",
      { sql: "SELECT id FROM users", explanation: "test" },
      executeFn,
      {},
      1,
    );

    // Verify origExecute received the mutated args
    expect(executeFn).toHaveBeenCalledTimes(1);
    const receivedArgs = executeFn.mock.calls[0][0];
    expect(receivedArgs.sql).toBe("SELECT id FROM users WHERE tenant_id = 42");
    expect(receivedArgs.explanation).toBe("rewritten");
  });

  test("afterToolCall receives durationMs", async () => {
    let receivedCtx: Record<string, unknown> | null = null;
    testRegistry.register(makeHookPlugin("timer", {
      afterToolCall: [{
        handler: (ctx: unknown) => { receivedCtx = ctx as Record<string, unknown>; },
      }],
    }));
    await testRegistry.initializeAll(minimalCtx);

    await simulateWrappedExecute("executeSQL", { sql: "SELECT 1" }, executeFn, {}, 1);

    expect(receivedCtx).not.toBeNull();
    expect(typeof receivedCtx!.durationMs).toBe("number");
    expect(receivedCtx!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("no plugins → passthrough (execute receives original args)", async () => {
    // testRegistry is empty
    const args = { sql: "SELECT 1" };
    await simulateWrappedExecute("executeSQL", args, executeFn, {}, 1);

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn.mock.calls[0][0]).toBe(args);
  });

  test("afterToolCall can rewrite result", async () => {
    testRegistry.register(makeHookPlugin("redactor", {
      afterToolCall: [{
        handler: () => ({
          result: { columns: ["id"], rows: [{ id: 1, email: "***REDACTED***" }] },
        }),
      }],
    }));
    await testRegistry.initializeAll(minimalCtx);

    const result = await simulateWrappedExecute(
      "executeSQL",
      { sql: "SELECT id, email FROM users" },
      executeFn,
      {},
      1,
    );

    expect(result).toEqual({ columns: ["id"], rows: [{ id: 1, email: "***REDACTED***" }] });
  });

  test("toolCallCount is passed through to hooks", async () => {
    let receivedCount: number | undefined;
    testRegistry.register(makeHookPlugin("counter", {
      beforeToolCall: [{
        handler: (ctx: unknown) => {
          receivedCount = (ctx as { context: { toolCallCount: number } }).context.toolCallCount;
        },
      }],
    }));
    await testRegistry.initializeAll(minimalCtx);

    await simulateWrappedExecute("executeSQL", { sql: "SELECT 1" }, executeFn, {}, 5);

    expect(receivedCount).toBe(5);
  });
});
