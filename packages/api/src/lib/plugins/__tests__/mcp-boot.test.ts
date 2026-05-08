/**
 * Tests for `bootPluginsForMcp` (#2078) — the idempotent plugin
 * lifecycle helper that runs at MCP server boot.
 *
 * The helper has two callers in production:
 *   - stdio MCP (`bin/serve.ts`) — separate process, plugin singleton
 *     starts empty, helper must register + initialize + wire.
 *   - SSE / hosted MCP (in-process with Hono) — plugin singleton
 *     already populated by `server.ts`, helper must no-op.
 *
 * A regression that drops the `plugins.size === 0` guard would re-
 * register plugins (which throws "already registered" per-plugin and
 * silently leaves them out of `tools/list`). A regression that drops
 * the `plugins.isInitialized` guard would re-run plugin `initialize()`
 * — for plugins that allocate DB pools or open external sessions, that
 * means leaked resources or "already initialized" throws. A regression
 * that drops the `pluginMcpToolRegistry.size === 0` guard would
 * re-wire and hit the registry's namespace-collision rule, surfacing
 * as a broken boot for every plugin tool.
 *
 * These tests pin the idempotency contract for all three guards.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { plugins } from "../registry";
import { pluginMcpToolRegistry } from "../mcp-tools";

// Stub config so the helper sees a known plugin list.
let configPlugins: unknown[] = [];
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ plugins: configPlugins }),
}));

const { bootPluginsForMcp } = await import("../mcp-boot");

function makePlugin(id: string, opts?: { mcpTools?: () => readonly unknown[] }) {
  return {
    id,
    types: ["context"] as const,
    version: "1.0.0",
    contextProvider: { load: async () => "" },
    ...(opts?.mcpTools ? { mcpTools: opts.mcpTools } : {}),
  };
}

beforeEach(() => {
  plugins._reset();
  pluginMcpToolRegistry._reset();
  configPlugins = [];
});

describe("bootPluginsForMcp", () => {
  it("is a no-op when config has no plugins", async () => {
    configPlugins = [];
    const result = await bootPluginsForMcp();
    expect(result.registered).toBe(0);
    expect(result.toolCount).toBe(0);
    expect(plugins.isInitialized).toBe(false);
  });

  it("registers, initializes, and wires plugins from a populated config (stdio path)", async () => {
    let initCalls = 0;
    const tool = {
      name: "ping",
      description: "test",
      inputSchema: {
        parse: (x: unknown) => x,
        safeParse: (x: unknown) => ({ success: true as const, data: x }),
        _def: {},
      },
      handler: async () => ({ ok: true }),
    };
    configPlugins = [
      {
        ...makePlugin("acme", { mcpTools: () => [tool] }),
        async initialize() {
          initCalls += 1;
        },
      },
    ];
    const result = await bootPluginsForMcp();
    expect(result.registered).toBe(1);
    expect(result.toolCount).toBe(1);
    expect(initCalls).toBe(1);
    expect(plugins.isInitialized).toBe(true);
    expect(pluginMcpToolRegistry.get("acme.ping")?.qualifiedName).toBe("acme.ping");
  });

  it("is idempotent on a second call (in-process SSE/hosted path — plugins already initialized)", async () => {
    let initCalls = 0;
    configPlugins = [
      {
        ...makePlugin("acme"),
        async initialize() {
          initCalls += 1;
        },
      },
    ];
    await bootPluginsForMcp();
    expect(initCalls).toBe(1);
    expect(plugins.isInitialized).toBe(true);

    // Second call must not re-register, must not re-initialize, must
    // not re-wire — calling initializeAll twice would throw, calling
    // register twice would throw with "already registered." Either
    // failure mode regressing the guard would surface here.
    await bootPluginsForMcp();
    expect(initCalls).toBe(1);
    expect(plugins.size).toBe(1);
  });

  it("does not re-wire when plugin tool registry already populated (SSE path where Hono wired tools first)", async () => {
    // Simulate Hono server having already wired plugins + their MCP
    // tools — the registry is non-empty and the plugins are
    // initialized. `bootPluginsForMcp` must skip wiring.
    plugins.register(
      makePlugin("acme", {
        mcpTools: () => [
          {
            name: "ping",
            description: "test",
            inputSchema: {
              parse: (x: unknown) => x,
              safeParse: (x: unknown) => ({ success: true as const, data: x }),
              _def: {},
            },
            handler: async () => ({ ok: true }),
          },
        ],
      }) as Parameters<typeof plugins.register>[0],
    );
    await plugins.initializeAll({
      db: null,
      connections: { get: () => ({}), list: () => [] },
      tools: { register: () => {} },
      logger: {},
      config: {},
    });
    pluginMcpToolRegistry.register("acme", {
      name: "ping",
      description: "test",
      inputSchema: {
        parse: (x: unknown) => x,
        safeParse: (x: unknown) => ({ success: true as const, data: x }),
        _def: {},
      },
      handler: async () => ({ ok: true }),
    });
    expect(pluginMcpToolRegistry.size).toBe(1);

    const result = await bootPluginsForMcp();
    // Helper saw isInitialized + non-empty registry → skipped re-wire.
    // Re-wiring would throw "already registered" via the namespace
    // collision guard inside register().
    expect(result.toolCount).toBe(1);
    expect(pluginMcpToolRegistry.size).toBe(1);
  });

  it("logs (does not abort) when individual plugins fail to register", async () => {
    // Two plugins with the same id — the second should fail to
    // register but not abort the boot.
    configPlugins = [makePlugin("dup"), makePlugin("dup")];
    const result = await bootPluginsForMcp();
    expect(result.registered).toBe(1);
    expect(plugins.size).toBe(1);
  });
});
