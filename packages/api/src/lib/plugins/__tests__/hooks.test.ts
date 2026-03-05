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
  opts?: { type?: string; unhealthy?: boolean },
): PluginLike {
  return {
    id,
    type: (opts?.type ?? "context") as PluginLike["type"],
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
      type: "context",
      version: "1.0.0",
    });
    await registry.initializeAll(minimalCtx);

    // Should not throw
    await dispatchHook("onRequest", { path: "/api/chat", method: "POST", headers: {} }, registry);
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

    await dispatchHook("onRequest", { path: "/api/chat", method: "POST", headers: {} }, registry);

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
