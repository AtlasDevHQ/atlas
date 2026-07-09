/**
 * Plugin MCP tool extension point (#2078).
 *
 * Covers the host-side registry + wiring for `AtlasPlugin.mcpTools()`:
 * - Local tools register under the `<plugin-id>.<name>` namespace.
 * - Namespace collisions (same plugin re-registers the same name) reject.
 * - Bad inputs (missing handler, non-Zod schema, dotted local name) reject.
 * - The MCP-server registration path (registerPluginMcpTools) wraps every
 *   dispatch in input validation, an `internal_error` envelope on throws,
 *   `withRequestContext` so audit_log / OTel pick up the actor, and a
 *   `traceMcpToolCall` span — same coverage as native tools.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { z } from "zod/v4";

// Stub the rate-limit middleware so we can drive (a) ok, (b) denied
// envelope, and (c) limiter throws — the three branches of the
// `clientId`-set dispatch path. mock.module replaces ALL named exports
// from the module per CLAUDE.md so partial-mock leakage doesn't break
// other tests in the same isolated subprocess.
const rateLimitState: {
  outcome:
    | { kind: "ok" }
    | { kind: "denied"; envelope: { code: string; message: string; retry_after?: number } }
    | { kind: "throw"; error: Error };
  calls: Array<{ orgId: string; clientId: string; userId: string; toolName: string }>;
} = {
  outcome: { kind: "ok" },
  calls: [],
};
void mock.module("@atlas/api/lib/rate-limit/middleware", () => ({
  enforceClientRateLimit: mock(async (input: { orgId: string; clientId: string; userId: string; toolName: string }) => {
    rateLimitState.calls.push(input);
    const o = rateLimitState.outcome;
    if (o.kind === "throw") throw o.error;
    return o;
  }),
}));
import {
  PluginMcpToolRegistry,
  wireMcpToolPlugins,
  registerPluginMcpTools,
  mcpToolMutates,
  type AtlasMcpToolLike,
  type McpServerLike,
  type McpCallToolResult,
  type McpToolContextShape,
} from "@atlas/api/lib/plugins/mcp-tools";

type McpLogger = McpToolContextShape["logger"];
import { PluginRegistry, type PluginLike } from "@atlas/api/lib/plugins/registry";

interface FakeRegisteredTool {
  config: { description?: string; inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<McpCallToolResult>;
}

class FakeMcpServer implements McpServerLike {
  registered = new Map<string, FakeRegisteredTool>();
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: unknown; outputSchema?: unknown; title?: string },
    handler: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
  ): unknown {
    this.registered.set(name, { config, handler });
    return undefined;
  }
}

function makeTool(
  overrides: Partial<AtlasMcpToolLike> = {},
): AtlasMcpToolLike {
  return {
    name: "doStuff",
    description: "Test tool",
    inputSchema: z.object({ value: z.string() }),
    handler: async () => ({ ok: true }),
    ...overrides,
  };
}

function makePlugin(
  id: string,
  tools: readonly AtlasMcpToolLike[],
  opts?: { healthy?: boolean },
): PluginLike {
  return {
    id,
    types: ["context"],
    version: "1.0.0",
    contextProvider: { load: async () => "" },
    mcpTools: () => tools,
    ...(opts?.healthy === false ? { initialize: async () => { throw new Error("boom"); } } : {}),
  } as PluginLike;
}

describe("PluginMcpToolRegistry", () => {
  let registry: PluginMcpToolRegistry;
  beforeEach(() => {
    registry = new PluginMcpToolRegistry();
  });

  it("namespaces tools as <plugin-id>.<name>", () => {
    const entry = registry.register("runbooks", makeTool({ name: "search" }));
    expect(entry.qualifiedName).toBe("runbooks.search");
    expect(entry.localName).toBe("search");
    expect(entry.pluginId).toBe("runbooks");
    expect(registry.get("runbooks.search")).toBe(entry);
    expect(registry.size).toBe(1);
  });

  it("rejects a second registration with the same qualified name", () => {
    registry.register("runbooks", makeTool({ name: "search" }));
    expect(() =>
      registry.register("runbooks", makeTool({ name: "search" })),
    ).toThrow(/already registered/);
  });

  it("allows the same local name across different plugins", () => {
    registry.register("runbooks", makeTool({ name: "search" }));
    registry.register("docs", makeTool({ name: "search" }));
    expect(registry.size).toBe(2);
    expect(registry.get("runbooks.search")?.qualifiedName).toBe("runbooks.search");
    expect(registry.get("docs.search")?.qualifiedName).toBe("docs.search");
  });

  it("rejects local names containing dots (would ambiguously namespace)", () => {
    expect(() =>
      registry.register("runbooks", makeTool({ name: "search.list" })),
    ).toThrow(/letters, digits, _, -; no dots/);
  });

  it("rejects empty / whitespace-only descriptions", () => {
    expect(() =>
      registry.register("runbooks", makeTool({ description: "   " })),
    ).toThrow(/description/);
  });

  it("rejects schemas that do not expose safeParse", () => {
    expect(() =>
      registry.register(
        "runbooks",
        makeTool({ inputSchema: { parse: () => null } as never }),
      ),
    ).toThrow(/safeParse/);
  });

  it("rejects schemas missing _def (would break tools/list JSON Schema derivation)", () => {
    // A `{ parse, safeParse }` impostor that *would* validate inputs
    // but lacks `_def` — the MCP SDK introspects `_def` to derive the
    // JSON Schema shipped in `tools/list`, so accepting this would fail
    // at the wire far from the authoring site.
    const impostor = {
      parse: (x: unknown) => x,
      safeParse: (x: unknown) => ({ success: true as const, data: x }),
    };
    expect(() =>
      registry.register("runbooks", makeTool({ inputSchema: impostor as never })),
    ).toThrow(/_def/);
  });

  it("rejects non-function handlers", () => {
    expect(() =>
      registry.register(
        "runbooks",
        makeTool({ handler: undefined as never }),
      ),
    ).toThrow(/handler/);
  });

  it("freeze() blocks further registrations", () => {
    registry.register("runbooks", makeTool());
    registry.freeze();
    expect(() => registry.register("docs", makeTool())).toThrow(/frozen/);
  });

  it("rejects invalid plugin ids", () => {
    expect(() => registry.register("", makeTool())).toThrow(/Invalid plugin id/);
    expect(() => registry.register("has space", makeTool())).toThrow(
      /Invalid plugin id/,
    );
  });
});

describe("wireMcpToolPlugins", () => {
  it("collects tools from healthy plugins only", async () => {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.register(makePlugin("runbooks", [makeTool({ name: "search" })]));
    pluginRegistry.register(makePlugin("docs", [makeTool({ name: "list" })]));
    await pluginRegistry.initializeAll({
      db: null,
      connections: { get: () => ({}), list: () => [], tables: () => [] },
      tools: { register: () => {} },
      logger: {},
      config: {},
    });

    const registry = new PluginMcpToolRegistry();
    const result = wireMcpToolPlugins(pluginRegistry, registry);
    expect(result.failed).toEqual([]);
    expect(result.wired.map((w) => w.qualifiedName).sort()).toEqual([
      "docs.list",
      "runbooks.search",
    ]);
    expect(registry.size).toBe(2);
  });

  it("skips plugins without an mcpTools method", async () => {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.register({
      id: "noop",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
    } as PluginLike);
    await pluginRegistry.initializeAll({
      db: null,
      connections: { get: () => ({}), list: () => [], tables: () => [] },
      tools: { register: () => {} },
      logger: {},
      config: {},
    });

    const registry = new PluginMcpToolRegistry();
    const result = wireMcpToolPlugins(pluginRegistry, registry);
    expect(result.wired).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("collects per-tool failures without aborting other plugins", async () => {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.register(
      makePlugin("bad", [makeTool({ name: "search.list" })]),
    );
    pluginRegistry.register(makePlugin("good", [makeTool({ name: "ok" })]));
    await pluginRegistry.initializeAll({
      db: null,
      connections: { get: () => ({}), list: () => [], tables: () => [] },
      tools: { register: () => {} },
      logger: {},
      config: {},
    });

    const registry = new PluginMcpToolRegistry();
    const result = wireMcpToolPlugins(pluginRegistry, registry);
    expect(result.wired.map((w) => w.qualifiedName)).toEqual(["good.ok"]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].pluginId).toBe("bad");
  });

  it("captures throws from mcpTools() factory", async () => {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.register({
      id: "throws",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
      mcpTools: () => {
        throw new Error("factory failure");
      },
    } as PluginLike);
    await pluginRegistry.initializeAll({
      db: null,
      connections: { get: () => ({}), list: () => [], tables: () => [] },
      tools: { register: () => {} },
      logger: {},
      config: {},
    });

    const registry = new PluginMcpToolRegistry();
    const result = wireMcpToolPlugins(pluginRegistry, registry);
    expect(result.failed).toEqual([
      { pluginId: "throws", error: "factory failure" },
    ]);
    expect(registry.size).toBe(0);
  });

  it("captures non-array returns from mcpTools()", async () => {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.register({
      id: "weird",
      types: ["context"],
      version: "1.0.0",
      contextProvider: { load: async () => "" },
      mcpTools: () => ({} as unknown as readonly AtlasMcpToolLike[]),
    } as PluginLike);
    await pluginRegistry.initializeAll({
      db: null,
      connections: { get: () => ({}), list: () => [], tables: () => [] },
      tools: { register: () => {} },
      logger: {},
      config: {},
    });

    const registry = new PluginMcpToolRegistry();
    const result = wireMcpToolPlugins(pluginRegistry, registry);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toMatch(/non-array/);
  });
});

describe("registerPluginMcpTools (MCP server registration)", () => {
  let registry: PluginMcpToolRegistry;
  let server: FakeMcpServer;

  beforeEach(() => {
    registry = new PluginMcpToolRegistry();
    server = new FakeMcpServer();
    // Reset module-level rate-limit mock state so a later test
    // doesn't inherit `kind: "throw"` from an earlier `describe`.
    rateLimitState.outcome = { kind: "ok" };
    rateLimitState.calls = [];
  });

  function actor() {
    return {
      id: "user-1",
      label: "user-1",
      mode: "simple-key" as const,
      activeOrganizationId: "org-1",
    };
  }

  it("registers each plugin tool with the MCP server under its qualified name", async () => {
    registry.register("runbooks", makeTool({ name: "search" }));
    registry.register("docs", makeTool({ name: "list" }));
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
    });
    expect([...server.registered.keys()].sort()).toEqual([
      "docs.list",
      "runbooks.search",
    ]);
  });

  it("validates input via inputSchema before invoking handler", async () => {
    let called = false;
    registry.register(
      "runbooks",
      makeTool({
        name: "search",
        inputSchema: z.object({ query: z.string().min(1) }),
        handler: async () => {
          called = true;
          return { ok: true };
        },
      }),
    );
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
    });

    const handler = server.registered.get("runbooks.search")!.handler;
    const result = await handler({ query: "" });
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe("validation_failed");
    expect(body.message).toMatch(/query/);
  });

  it("wraps handler throws in an internal_error envelope with request_id", async () => {
    registry.register(
      "runbooks",
      makeTool({
        name: "search",
        inputSchema: z.object({ q: z.string() }),
        handler: async () => {
          throw new Error("backend exploded");
        },
      }),
    );
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
    });

    const handler = server.registered.get("runbooks.search")!.handler;
    const result = await handler({ q: "x" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe("internal_error");
    expect(body.message).toBe("backend exploded");
    expect(body.request_id).toMatch(/^mcp-plugin-/);
  });

  it("returns the handler result as JSON content on success", async () => {
    registry.register(
      "runbooks",
      makeTool({
        name: "search",
        inputSchema: z.object({ q: z.string() }),
        handler: async ({ q }) => ({ matches: [q] }),
      }),
    );
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
    });

    const handler = server.registered.get("runbooks.search")!.handler;
    const result = await handler({ q: "alpha" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ matches: ["alpha"] });
  });

  describe("rate-limit gate (#2071)", () => {
    beforeEach(() => {
      rateLimitState.outcome = { kind: "ok" };
      rateLimitState.calls = [];
    });

    it("skips the limiter entirely when clientId is undefined (stdio MCP exempt)", async () => {
      registry.register(
        "runbooks",
        makeTool({
          name: "search",
          inputSchema: z.object({}),
          handler: async () => ({ ok: true }),
        }),
      );
      registerPluginMcpTools(server, {
        registry,
        actor: actor(),
        transport: "stdio",
        workspaceId: "org-1",
        deployMode: "self-hosted",
      });
      const handler = server.registered.get("runbooks.search")!.handler;
      await handler({});
      expect(rateLimitState.calls).toEqual([]);
    });

    it("denied bucket short-circuits with the limiter's rate_limited envelope", async () => {
      let handlerCalled = false;
      registry.register(
        "runbooks",
        makeTool({
          name: "search",
          inputSchema: z.object({}),
          handler: async () => {
            handlerCalled = true;
            return { ok: true };
          },
        }),
      );
      rateLimitState.outcome = {
        kind: "denied",
        envelope: {
          code: "rate_limited",
          message: "Client claude-desktop QPM limit reached (60/min)",
          retry_after: 30,
        },
      };
      registerPluginMcpTools(server, {
        registry,
        actor: actor(),
        transport: "stdio",
        workspaceId: "org-1",
        deployMode: "self-hosted",
        clientId: "claude-desktop",
      });
      const handler = server.registered.get("runbooks.search")!.handler;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(handlerCalled).toBe(false);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("rate_limited");
      expect(body.retry_after).toBe(30);
      // Limiter received the qualified tool name so abuse rows can scope by tool.
      expect(rateLimitState.calls[0].toolName).toBe("runbooks.search");
      expect(rateLimitState.calls[0].clientId).toBe("claude-desktop");
    });

    it("limiter throws → internal_error envelope with request_id (rather than fail-closed silently)", async () => {
      let handlerCalled = false;
      registry.register(
        "runbooks",
        makeTool({
          name: "search",
          inputSchema: z.object({}),
          handler: async () => {
            handlerCalled = true;
            return { ok: true };
          },
        }),
      );
      rateLimitState.outcome = { kind: "throw", error: new Error("loader rejected") };
      registerPluginMcpTools(server, {
        registry,
        actor: actor(),
        transport: "stdio",
        workspaceId: "org-1",
        deployMode: "self-hosted",
        clientId: "claude-desktop",
      });
      const handler = server.registered.get("runbooks.search")!.handler;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(handlerCalled).toBe(false);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe("internal_error");
      expect(body.message).toBe("loader rejected");
      expect(body.request_id).toMatch(/^mcp-plugin-/);
    });
  });

  it("propagates the mcp actor into RequestContext for audit + OTel", async () => {
    let observed: { actor?: unknown; requestId?: string } = {};
    registry.register(
      "runbooks",
      makeTool({
        name: "search",
        inputSchema: z.object({}),
        handler: async (_args, ctx) => {
          // Read request context from the inside of the dispatch — the
          // wrapper must have set actor.kind = "mcp" + toolName so
          // logQueryAudit picks them up.
          const { getRequestContext } = await import("@atlas/api/lib/logger");
          const reqCtx = getRequestContext();
          observed = {
            actor: reqCtx?.actor,
            requestId: reqCtx?.requestId,
          };
          return {
            ctx: {
              workspaceId: ctx.workspaceId,
              userId: ctx.userId,
              pluginId: ctx.pluginId,
            },
          };
        },
      }),
    );
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
      clientId: "claude-desktop",
    });

    const handler = server.registered.get("runbooks.search")!.handler;
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);
    expect(body.ctx).toEqual({
      workspaceId: "org-1",
      userId: "user-1",
      pluginId: "runbooks",
    });
    expect(observed.actor).toEqual({
      kind: "mcp",
      clientId: "claude-desktop",
      toolName: "runbooks.search",
    });
    expect(observed.requestId).toMatch(/^mcp-plugin-/);
  });

  describe("McpToolContext.audit()", () => {
    it("emits a structured pino event on success and does not throw", async () => {
      const logged: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
      registry.register(
        "runbooks",
        makeTool({
          name: "search",
          inputSchema: z.object({}),
          handler: async (_args, ctx) => {
            ctx.audit({
              event: "runbooks.search",
              success: true,
              durationMs: 42,
              metadata: { hits: 3 },
            });
            return { ok: true };
          },
        }),
      );
      registerPluginMcpTools(server, {
        registry,
        actor: actor(),
        transport: "stdio",
        workspaceId: "org-1",
        deployMode: "self-hosted",
        loggerFor: () => ({
          info: ((obj: Record<string, unknown> | string, msg?: string) => {
            if (typeof obj === "string") logged.push({ level: "info", obj: {}, msg: obj });
            else logged.push({ level: "info", obj, msg: msg ?? "" });
          }) as McpLogger["info"],
          warn: ((obj: Record<string, unknown> | string, msg?: string) => {
            if (typeof obj === "string") logged.push({ level: "warn", obj: {}, msg: obj });
            else logged.push({ level: "warn", obj, msg: msg ?? "" });
          }) as McpLogger["warn"],
          error: (() => {}) as McpLogger["error"],
          debug: (() => {}) as McpLogger["debug"],
        }),
      });
      const handler = server.registered.get("runbooks.search")!.handler;
      const result = await handler({});
      expect(result.isError).toBeUndefined();
      const audit = logged.find((l) => l.msg === "plugin_audit:runbooks.search");
      expect(audit, "audit() should have emitted a `plugin_audit:<event>` log").toBeDefined();
      expect(audit!.level).toBe("info");
      expect(audit!.obj.success).toBe(true);
      expect(audit!.obj.durationMs).toBe(42);
      expect(audit!.obj.metadata).toEqual({ hits: 3 });
    });

    it("swallows logger throws without propagating to the handler return", async () => {
      registry.register(
        "runbooks",
        makeTool({
          name: "search",
          inputSchema: z.object({}),
          handler: async (_args, ctx) => {
            // Trigger the catch path inside audit() by providing a logger
            // whose info() throws. The handler's return value must still
            // surface as the dispatch result — audit must never propagate.
            ctx.audit({ event: "x", success: true });
            return { ok: true };
          },
        }),
      );
      registerPluginMcpTools(server, {
        registry,
        actor: actor(),
        transport: "stdio",
        workspaceId: "org-1",
        deployMode: "self-hosted",
        loggerFor: () => ({
          info: (() => {
            throw new Error("logger sink down");
          }) as McpLogger["info"],
          warn: (() => {
            throw new Error("logger sink down");
          }) as McpLogger["warn"],
          error: (() => {}) as McpLogger["error"],
          debug: (() => {}) as McpLogger["debug"],
        }),
      });
      const handler = server.registered.get("runbooks.search")!.handler;
      const result = await handler({});
      // audit() throwing would be caught by the dispatch handler-throw
      // branch and surface as `internal_error`. Asserting success means
      // audit() really did swallow.
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    });
  });

  describe("traceWrap", () => {
    it("wraps the handler invocation (not just precedes it) so OTel spans cover handler latency", async () => {
      const order: string[] = [];
      registry.register(
        "runbooks",
        makeTool({
          name: "search",
          inputSchema: z.object({}),
          handler: async () => {
            order.push("handler");
            return { ok: true };
          },
        }),
      );
      registerPluginMcpTools(server, {
        registry,
        actor: actor(),
        transport: "stdio",
        workspaceId: "org-1",
        deployMode: "self-hosted",
        traceWrap: async (spanCtx, fn) => {
          order.push(`trace-start:${spanCtx.toolName}`);
          const result = await fn();
          order.push(`trace-end:${spanCtx.toolName}`);
          return result;
        },
      });
      const handler = server.registered.get("runbooks.search")!.handler;
      const result = await handler({});
      // The trace must START before the handler runs and END after — a
      // regression that called fn() outside the wrap (e.g., started the
      // span but awaited the handler outside it) would lose handler
      // latency and exception propagation in OTel spans.
      expect(order).toEqual([
        "trace-start:runbooks.search",
        "handler",
        "trace-end:runbooks.search",
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    });
  });
});

// ---------------------------------------------------------------------------
// #3520 — mcp:write gate for mutating plugin-contributed MCP tools.
// ---------------------------------------------------------------------------

describe("mcpToolMutates (annotation → mutation signal)", () => {
  it("is read-only (false) with no annotations — opt-in gate", () => {
    expect(mcpToolMutates(undefined)).toBe(false);
    expect(mcpToolMutates({})).toBe(false);
  });
  it("readOnlyHint:true wins even alongside destructiveHint:true", () => {
    expect(mcpToolMutates({ readOnlyHint: true, destructiveHint: true })).toBe(false);
  });
  it("mutates when readOnlyHint:false or destructiveHint:true", () => {
    expect(mcpToolMutates({ readOnlyHint: false })).toBe(true);
    expect(mcpToolMutates({ destructiveHint: true })).toBe(true);
  });
});

describe("registerPluginMcpTools — mcp:write gate for mutating plugin tools (#3520)", () => {
  let registry: PluginMcpToolRegistry;
  let server: FakeMcpServer;

  beforeEach(() => {
    registry = new PluginMcpToolRegistry();
    server = new FakeMcpServer();
    rateLimitState.outcome = { kind: "ok" };
    rateLimitState.calls = [];
  });

  function actor() {
    return { id: "user-1", label: "user-1", mode: "simple-key" as const, activeOrganizationId: "org-1" };
  }

  /** A mutating tool (explicitly not read-only). */
  function mutatingTool(over: Partial<AtlasMcpToolLike> = {}): AtlasMcpToolLike {
    return makeTool({ name: "createThing", annotations: { readOnlyHint: false }, ...over });
  }

  function hostedOpts(scopes: readonly string[]) {
    return {
      registry,
      actor: actor(),
      transport: "sse" as const,
      workspaceId: "org-1",
      deployMode: "saas" as const,
      clientId: "claude-desktop",
      scopes,
    };
  }

  it("registry carries the annotation through to the registered tool", () => {
    const entry = registry.register("infra", mutatingTool());
    expect(entry.annotations).toEqual({ readOnlyHint: false });
  });

  it("denies a mutating tool when a hosted mcp:read-only token lacks mcp:write", async () => {
    registry.register("infra", mutatingTool());
    registerPluginMcpTools(server, hostedOpts(["mcp:read"]));
    const handler = server.registered.get("infra.createThing")!.handler;
    const res = await handler({ value: "x" });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text);
    expect(env.code).toBe("forbidden");
    expect(env.message).toContain("mcp:write");
    expect(env.request_id).toMatch(/^mcp-plugin-/);
    // The gate runs BEFORE the rate-limit gate — a forbidden call must not
    // consume the client's rate budget.
    expect(rateLimitState.calls).toHaveLength(0);
  });

  it("allows a mutating tool when the hosted token carries mcp:write", async () => {
    let called = false;
    registry.register(
      "infra",
      mutatingTool({ handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(server, hostedOpts(["mcp:read", "mcp:write"]));
    const handler = server.registered.get("infra.createThing")!.handler;
    const res = await handler({ value: "x" });
    expect(res.isError).toBeFalsy();
    expect(called).toBe(true);
  });

  it("leaves a read-only plugin tool unaffected for a mcp:read-only client", async () => {
    registry.register("infra", makeTool({ name: "listThings", annotations: { readOnlyHint: true } }));
    registerPluginMcpTools(server, hostedOpts(["mcp:read"]));
    const handler = server.registered.get("infra.listThings")!.handler;
    const res = await handler({ value: "x" });
    expect(res.isError).toBeFalsy();
  });

  it("leaves an un-annotated plugin tool unaffected (opt-in gate)", async () => {
    registry.register("infra", makeTool({ name: "legacy" }));
    registerPluginMcpTools(server, hostedOpts(["mcp:read"]));
    const handler = server.registered.get("infra.legacy")!.handler;
    const res = await handler({ value: "x" });
    expect(res.isError).toBeFalsy();
  });

  it("treats destructiveHint:true as mutating (denied without mcp:write)", async () => {
    registry.register("infra", makeTool({ name: "deleteThing", annotations: { destructiveHint: true } }));
    registerPluginMcpTools(server, hostedOpts(["mcp:read"]));
    const handler = server.registered.get("infra.deleteThing")!.handler;
    const res = await handler({ value: "x" });
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
  });

  it("exempts stdio (no clientId) even for a mutating tool", async () => {
    let called = false;
    registry.register(
      "infra",
      mutatingTool({ handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
      // no clientId, no scopes — stdio
    });
    const handler = server.registered.get("infra.createThing")!.handler;
    const res = await handler({ value: "x" });
    expect(res.isError).toBeFalsy();
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #4355 — fail closed when the ADR-0016 dispatch-gate runner is unwired.
// Production (packages/mcp/src/plugin-tools.ts) always injects
// `runMcpDispatchGate`, which runs gates 1 (action-policy), 3 (RBAC minRole)
// and 4 (approval). When that runner is ABSENT (a mis-wired injector, or a
// caller that never wired it), those gates cannot run — so the fallback must
// DENY any tool that declares governance they would enforce: an elevated
// `minRole` (above member), `destructive`, or a non-default `actionCategory`
// (datasource/policy). Member-level, non-destructive, default-category tools
// keep flowing through the inline gate-2 (mcp:write) check, so read-only
// member tools are unaffected.
// ---------------------------------------------------------------------------
describe("registerPluginMcpTools — fail-closed when dispatch-gate runner is unwired (#4355)", () => {
  let registry: PluginMcpToolRegistry;
  let server: FakeMcpServer;

  beforeEach(() => {
    registry = new PluginMcpToolRegistry();
    server = new FakeMcpServer();
    rateLimitState.outcome = { kind: "ok" };
    rateLimitState.calls = [];
  });

  function actor() {
    return { id: "user-1", label: "user-1", mode: "simple-key" as const, activeOrganizationId: "org-1" };
  }

  /** Hosted opts WITHOUT a `runDispatchGate` injector — exercises the fallback. */
  function noRunnerOpts(over: Record<string, unknown> = {}) {
    return {
      registry,
      actor: actor(),
      transport: "sse" as const,
      workspaceId: "org-1",
      deployMode: "saas" as const,
      clientId: "claude-desktop",
      scopes: ["mcp:read", "mcp:write"],
      ...over,
    };
  }

  it("denies an admin-role tool when no gate runner is wired (RBAC gate can't run)", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({ name: "adminOp", minRole: "admin", handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.adminOp")!.handler({ value: "x" });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0].text);
    expect(env.code).toBe("forbidden");
    // The denial carries request_id for log correlation (distinguishes it from
    // the gate-2 mcp:write denial, which has none).
    expect(env.request_id).toMatch(/^mcp-plugin-/);
    expect(called).toBe(false);
    // Fail-closed denial runs BEFORE the rate limiter — no quota consumed.
    expect(rateLimitState.calls).toHaveLength(0);
  });

  it("denies an owner-role tool when no gate runner is wired", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({ name: "ownerOp", minRole: "owner", handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.ownerOp")!.handler({ value: "x" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
    expect(called).toBe(false);
  });

  it("denies a governed-category (datasource/policy) tool when no gate runner is wired (gate 1 can't run)", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({
        name: "policyOp",
        actionCategory: "policy",
        handler: async () => { called = true; return { ok: true }; },
      }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.policyOp")!.handler({ value: "x" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
    expect(called).toBe(false);
  });

  it("leaves a default 'integration'-category member tool unaffected (residual gate-1 limitation is documented)", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({
        name: "integrationOp",
        actionCategory: "integration",
        handler: async () => { called = true; return { ok: true }; },
      }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.integrationOp")!.handler({ value: "x" });
    expect(res.isError).toBeFalsy();
    expect(called).toBe(true);
  });

  it("denies a destructive tool when no gate runner is wired (approval gate can't run)", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({ name: "wipe", destructive: true, handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.wipe")!.handler({ value: "x" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
    expect(called).toBe(false);
  });

  it("denies an elevated tool even on stdio (no clientId) — isolation is not a substitute for RBAC", async () => {
    registry.register("infra", makeTool({ name: "adminOp", minRole: "admin" }));
    registerPluginMcpTools(server, {
      registry,
      actor: actor(),
      transport: "stdio",
      workspaceId: "org-1",
      deployMode: "self-hosted",
    });
    const res = await server.registered.get("infra.adminOp")!.handler({ value: "x" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
  });

  it("leaves a member-level, read-only tool unaffected (still runs under gate 2)", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({
        name: "read",
        minRole: "member",
        annotations: { readOnlyHint: true },
        handler: async () => { called = true; return { ok: true }; },
      }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.read")!.handler({ value: "x" });
    expect(res.isError).toBeFalsy();
    expect(called).toBe(true);
  });

  it("an un-declared tool (no minRole, non-destructive) still proceeds — no over-broad denial", async () => {
    let called = false;
    registry.register(
      "infra",
      makeTool({ name: "legacy", handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(server, noRunnerOpts());
    const res = await server.registered.get("infra.legacy")!.handler({ value: "x" });
    expect(res.isError).toBeFalsy();
    expect(called).toBe(true);
  });

  it("with a runner wired, an admin tool is governed by the runner, not the fallback deny", async () => {
    let called = false;
    let gateSaw = false;
    registry.register(
      "infra",
      makeTool({ name: "adminOp", minRole: "admin", handler: async () => { called = true; return { ok: true }; } }),
    );
    registerPluginMcpTools(
      server,
      noRunnerOpts({ runDispatchGate: async () => { gateSaw = true; return null; } }),
    );
    const res = await server.registered.get("infra.adminOp")!.handler({ value: "x" });
    expect(gateSaw).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #3571 — ADR-0016 gates 1/3/4 for plugin MCP tools
// ---------------------------------------------------------------------------

describe("registerPluginMcpTools — ADR-0016 gates 1/3/4 (#3571)", () => {
  let registry: PluginMcpToolRegistry;
  let server: FakeMcpServer;

  // Gate-call capture. Each test injects this as `runDispatchGate`.
  interface GateCall {
    ctx: { orgId?: string; requesterId?: string };
    reqs: {
      toolName: string;
      actionCategory?: string;
      minRole?: string;
      destructive?: { resource: string; description: string };
    };
  }
  let gateCalls: GateCall[] = [];
  let gateReturn: McpCallToolResult | null = null;

  function makeGateRunner() {
    return async (ctx: GateCall["ctx"], reqs: GateCall["reqs"]): Promise<McpCallToolResult | null> => {
      gateCalls.push({ ctx, reqs });
      return gateReturn;
    };
  }

  function testActor() {
    return { id: "user-1", label: "user@example.com", mode: "simple-key" as const, activeOrganizationId: "org-1" };
  }

  function baseOpts() {
    return {
      registry,
      actor: testActor(),
      transport: "stdio" as const,
      workspaceId: "org-1",
      deployMode: "self-hosted" as const,
      runDispatchGate: makeGateRunner(),
    };
  }

  beforeEach(() => {
    registry = new PluginMcpToolRegistry();
    server = new FakeMcpServer();
    gateCalls = [];
    gateReturn = null;
    rateLimitState.outcome = { kind: "ok" };
    rateLimitState.calls = [];
  });

  it("gate 1 (action-policy): blocking the 'integration' category blocks an integration plugin tool", async () => {
    // The gate runner returns a forbidden block; assert the handler short-circuits.
    gateReturn = {
      content: [{ type: "text", text: JSON.stringify({ code: "forbidden", message: "integration category disabled" }) }],
      isError: true,
    };
    let handlerCalled = false;
    registry.register("myPlugin", makeTool({
      name: "syncContacts",
      annotations: { readOnlyHint: false },
      handler: async () => { handlerCalled = true; return { ok: true }; },
    }));
    registerPluginMcpTools(server, baseOpts());
    const handler = server.registered.get("myPlugin.syncContacts")!.handler;
    const res = await handler({});
    // The gate blocked — handler body must NOT run.
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
    expect(handlerCalled).toBe(false);
    // Gate was called with actionCategory defaulting to 'integration'.
    expect(gateCalls[0]?.reqs.actionCategory).toBe("integration");
  });

  it("gate 1: a tool declaring actionCategory 'datasource' passes that category to the gate runner", async () => {
    registry.register("myPlugin", makeTool({
      name: "createConn",
      actionCategory: "datasource",
      annotations: { readOnlyHint: false },
    }));
    registerPluginMcpTools(server, baseOpts());
    const handler = server.registered.get("myPlugin.createConn")!.handler;
    await handler({});
    expect(gateCalls[0]?.reqs.actionCategory).toBe("datasource");
  });

  it("gate 3 (RBAC): a minRole:'admin' plugin tool passes minRole to the gate runner", async () => {
    // Gate returns forbidden (simulating a member actor failing gate 3).
    gateReturn = {
      content: [{ type: "text", text: JSON.stringify({ code: "forbidden", message: "requires admin role" }) }],
      isError: true,
    };
    let handlerCalled = false;
    registry.register("myPlugin", makeTool({
      name: "adminAction",
      minRole: "admin",
      annotations: { readOnlyHint: false },
      handler: async () => { handlerCalled = true; return { ok: true }; },
    }));
    registerPluginMcpTools(server, baseOpts());
    const handler = server.registered.get("myPlugin.adminAction")!.handler;
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
    expect(handlerCalled).toBe(false);
    expect(gateCalls[0]?.reqs.minRole).toBe("admin");
  });

  it("gate 3: un-marked tools default to minRole 'member' in the gate call", async () => {
    registry.register("myPlugin", makeTool({ name: "lookup" }));
    registerPluginMcpTools(server, baseOpts());
    const handler = server.registered.get("myPlugin.lookup")!.handler;
    await handler({});
    expect(gateCalls[0]?.reqs.minRole).toBe("member");
  });

  it("gate 4 (approval): a destructive:true plugin tool passes a destructive descriptor to the gate runner", async () => {
    // Gate returns an approval-required body.
    gateReturn = {
      content: [{ type: "text", text: JSON.stringify({
        approval_required: true,
        approval_request_id: "req_plugin_1",
        matched_rules: ["MCP destructive"],
        message: "needs approval",
      }) }],
    };
    let handlerCalled = false;
    registry.register("myPlugin", makeTool({
      name: "wipeData",
      destructive: true,
      annotations: { readOnlyHint: false },
      handler: async () => { handlerCalled = true; return { ok: true }; },
    }));
    registerPluginMcpTools(server, baseOpts());
    const handler = server.registered.get("myPlugin.wipeData")!.handler;
    const res = await handler({});
    // approval_required is NOT an error response.
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.approval_required).toBe(true);
    expect(body.approval_request_id).toBe("req_plugin_1");
    expect(handlerCalled).toBe(false);
    // The gate was called with destructive set.
    expect(gateCalls[0]?.reqs.destructive).toBeDefined();
    expect(gateCalls[0]?.reqs.destructive?.resource).toContain("myPlugin.wipeData");
  });

  it("non-destructive tools have no 'destructive' field in the gate call", async () => {
    registry.register("myPlugin", makeTool({ name: "readData" }));
    registerPluginMcpTools(server, baseOpts());
    const handler = server.registered.get("myPlugin.readData")!.handler;
    await handler({});
    expect(gateCalls[0]?.reqs.destructive).toBeUndefined();
  });

  it("when no runDispatchGate is injected, falls back to inline gate-2 check (backward-compat)", async () => {
    // Without runDispatchGate, the inline mcp:write check still fires.
    registry.register("infra", makeTool({
      name: "createThing",
      annotations: { readOnlyHint: false },
    }));
    registerPluginMcpTools(server, {
      registry,
      actor: testActor(),
      transport: "sse",
      workspaceId: "org-1",
      deployMode: "saas",
      clientId: "claude-desktop",
      scopes: ["mcp:read"], // no mcp:write
      // no runDispatchGate
    });
    const handler = server.registered.get("infra.createThing")!.handler;
    const res = await handler({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden");
    // No gate calls (we didn't inject a gate runner).
    expect(gateCalls).toHaveLength(0);
  });
});
