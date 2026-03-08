import { describe, test, expect, mock, beforeEach } from "bun:test";
import { definePlugin, isInteractionPlugin } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Mocks — must mock ALL named exports from each module
// ---------------------------------------------------------------------------

const mockConnect = mock(async () => {});
const mockClose = mock(async () => {});
const mockMcpServer = {
  connect: mockConnect,
  close: mockClose,
};

mock.module("@atlas/mcp/server", () => ({
  createAtlasMcpServer: mock(async () => mockMcpServer),
  // CreateMcpServerOptions is a type — no runtime export needed
}));

mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockStdioTransport {},
}));

const mockSseClose = mock(async () => {});
const mockSseServer = { hostname: "0.0.0.0", port: 8080 };

mock.module("@atlas/mcp/sse", () => ({
  startSseServer: mock(async () => ({
    server: mockSseServer,
    close: mockSseClose,
  })),
}));

// Import after mocks are set up
const { mcpPlugin, buildMcpPlugin } = await import("../src/index");

// ---------------------------------------------------------------------------
// Mock context helper
// ---------------------------------------------------------------------------

function createMockCtx() {
  const logged: string[] = [];
  return {
    ctx: {
      db: null,
      connections: { get: () => ({}), list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: string) => logged.push(msg),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    },
    logged,
  };
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("mcpPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasInteractionPlugin", () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    expect(plugin.id).toBe("mcp-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("MCP Server");
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isInteractionPlugin type guard returns true", () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    expect(isInteractionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    expect(plugin.config).toEqual({ transport: "stdio" });
  });

  test("routes is not defined for stdio transport", () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    expect(plugin.routes).toBeUndefined();
  });

  test("buildMcpPlugin is available for direct use", () => {
    const plugin = buildMcpPlugin({ transport: "stdio" });
    expect(plugin.id).toBe("mcp-interaction");
    expect(plugin.types).toEqual(["interaction"]);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("mcpPlugin — error paths", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("createAtlasMcpServer rejection leaves plugin unhealthy", async () => {
    const { createAtlasMcpServer } = await import("@atlas/mcp/server");
    const mockCreate = createAtlasMcpServer as ReturnType<typeof mock>;
    mockCreate.mockImplementationOnce(async () => {
      throw new Error("server creation failed");
    });

    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await expect(plugin.initialize!(ctx as never)).rejects.toThrow("server creation failed");

    const health = await plugin.healthCheck!();
    expect(health.healthy).toBe(false);
  });

  test("connect() failure leaves plugin unhealthy and cleans up server", async () => {
    mockConnect.mockImplementationOnce(async () => {
      throw new Error("connect failed");
    });

    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await expect(plugin.initialize!(ctx as never)).rejects.toThrow("connect failed");

    // Server should have been cleaned up via close()
    expect(mockClose).toHaveBeenCalledTimes(1);

    const health = await plugin.healthCheck!();
    expect(health.healthy).toBe(false);
  });

  test("server.close() throwing in teardown still resets state", async () => {
    mockClose.mockImplementationOnce(async () => {
      throw new Error("close exploded");
    });

    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await expect(plugin.teardown!()).rejects.toThrow("close exploded");

    // State should be reset despite close() throwing
    const health = await plugin.healthCheck!();
    expect(health.healthy).toBe(false);

    // Second teardown should be a no-op (state already cleared)
    await expect(plugin.teardown!()).resolves.toBeUndefined();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test("port: 0 is rejected by config validation", () => {
    expect(() => mcpPlugin({ transport: "sse", port: 0 })).toThrow(
      "Plugin config validation failed",
    );
  });

  test("double initialize throws without teardown", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await expect(plugin.initialize!(ctx as never)).rejects.toThrow(
      "already initialized",
    );
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("mcpPlugin — config validation", () => {
  test("defaults transport to stdio when omitted", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = mcpPlugin({} as any);
    expect(plugin.config?.transport).toBe("stdio");
  });

  test("accepts stdio transport", () => {
    expect(() => mcpPlugin({ transport: "stdio" })).not.toThrow();
  });

  test("accepts sse transport", () => {
    expect(() => mcpPlugin({ transport: "sse" })).not.toThrow();
  });

  test("rejects invalid transport", () => {
    expect(() =>
      mcpPlugin({ transport: "websocket" } as never),
    ).toThrow("Plugin config validation failed");
  });

  test("accepts optional port for SSE", () => {
    const plugin = mcpPlugin({ transport: "sse", port: 8080 });
    expect(plugin.config?.port).toBe(8080);
  });

  test("rejects non-integer port", () => {
    expect(() =>
      mcpPlugin({ transport: "sse", port: 3.14 }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects negative port", () => {
    expect(() =>
      mcpPlugin({ transport: "sse", port: -1 }),
    ).toThrow("Plugin config validation failed");
  });
});

// ---------------------------------------------------------------------------
// Initialize lifecycle
// ---------------------------------------------------------------------------

describe("mcpPlugin — initialize", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("initializes MCP server and connects stdio transport", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(logged.some((m) => m.includes("stdio"))).toBe(true);
  });

  test("passes skipConfig: true to createAtlasMcpServer", async () => {
    const { createAtlasMcpServer } = await import("@atlas/mcp/server");
    const mockFn = createAtlasMcpServer as ReturnType<typeof mock>;
    mockFn.mockClear();

    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);

    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn.mock.calls[0][0]).toEqual({ skipConfig: true });
  });

  test("initializes SSE transport and logs port", async () => {
    const plugin = mcpPlugin({ transport: "sse", port: 8080 });
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);

    expect(logged.some((m) => m.includes("SSE"))).toBe(true);
    expect(logged.some((m) => m.includes("8080"))).toBe(true);

    await plugin.teardown!();
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("mcpPlugin — healthCheck", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("returns unhealthy before initialization", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(false);
    expect(result.message).toContain("not initialized");
  });

  test("returns healthy after initialization", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(true);
  });

  test("returns unhealthy after teardown", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Teardown lifecycle
// ---------------------------------------------------------------------------

describe("mcpPlugin — teardown", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("closes the MCP server on teardown", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test("teardown is safe to call without initialization", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("teardown is safe to call twice", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    await plugin.teardown!();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle integration
// ---------------------------------------------------------------------------

describe("mcpPlugin — full lifecycle", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("start → health → stop lifecycle works", async () => {
    const plugin = mcpPlugin({ transport: "stdio" });
    const { ctx } = createMockCtx();

    // Before init — unhealthy
    const before = await plugin.healthCheck!();
    expect(before.healthy).toBe(false);

    // Initialize
    await plugin.initialize!(ctx as never);

    // After init — healthy
    const during = await plugin.healthCheck!();
    expect(during.healthy).toBe(true);

    // Teardown
    await plugin.teardown!();

    // After teardown — unhealthy
    const after = await plugin.healthCheck!();
    expect(after.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSE transport lifecycle
// ---------------------------------------------------------------------------

describe("mcpPlugin — SSE lifecycle", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockClose.mockClear();
    mockSseClose.mockClear();
  });

  test("SSE teardown closes the SSE handle", async () => {
    const plugin = mcpPlugin({ transport: "sse" });
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();

    // SSE handle manages per-session servers internally; plugin only closes the handle
    expect(mockSseClose).toHaveBeenCalledTimes(1);
  });

  test("SSE start → health → stop lifecycle works", async () => {
    const plugin = mcpPlugin({ transport: "sse" });
    const { ctx } = createMockCtx();

    const before = await plugin.healthCheck!();
    expect(before.healthy).toBe(false);

    await plugin.initialize!(ctx as never);
    const during = await plugin.healthCheck!();
    expect(during.healthy).toBe(true);

    await plugin.teardown!();
    const after = await plugin.healthCheck!();
    expect(after.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// atlas.config.ts registration (type-level verification)
// ---------------------------------------------------------------------------

describe("mcpPlugin — config registration", () => {
  test("plugin object has all fields required for config validation", () => {
    const plugin = mcpPlugin({ transport: "stdio" });

    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(plugin.types)).toBe(true);
    expect(plugin.types.every((t: string) => ["datasource", "context", "interaction", "action", "sandbox"].includes(t))).toBe(true);
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.trim().length).toBeGreaterThan(0);
  });
});
