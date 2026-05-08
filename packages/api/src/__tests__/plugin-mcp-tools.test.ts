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

import { describe, expect, it, beforeEach } from "bun:test";
import { z } from "zod/v4";
import {
  PluginMcpToolRegistry,
  wireMcpToolPlugins,
  registerPluginMcpTools,
  type AtlasMcpToolLike,
  type McpServerLike,
  type McpCallToolResult,
} from "@atlas/api/lib/plugins/mcp-tools";
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
      connections: { get: () => ({}), list: () => [] },
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
      connections: { get: () => ({}), list: () => [] },
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
      connections: { get: () => ({}), list: () => [] },
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
      connections: { get: () => ({}), list: () => [] },
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
      connections: { get: () => ({}), list: () => [] },
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
});
