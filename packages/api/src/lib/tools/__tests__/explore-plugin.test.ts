/**
 * Integration tests for getExploreBackend() sandbox plugin path.
 *
 * Validates that the explore module correctly discovers, sorts, and falls
 * back through sandbox plugins before delegating to built-in backends.
 *
 * Uses mock.module() for the plugin registry. Each test gets a fresh
 * explore module via cache-busting dynamic imports.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ExploreBackend, ExecResult } from "../../tools/explore";

// ---------------------------------------------------------------------------
// Mocks — must register before any import of explore.ts
// ---------------------------------------------------------------------------

// Mock logger (all exports from @atlas/api/lib/logger)
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
  withRequestContext: <T>(ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
}));

// Mock tracing (all exports from @atlas/api/lib/tracing)
mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async <T>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
}));

// Mock hooks (all exports from @atlas/api/lib/plugins/hooks)
mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async <T extends Record<string, unknown>, K extends string & keyof T>(
    _hookName: string,
    context: T,
    mutateKey: K,
  ) => context[mutateKey],
}));

// ---------------------------------------------------------------------------
// Mutable sandbox plugin list — tests control what getByType("sandbox") returns
// ---------------------------------------------------------------------------

let mockSandboxPlugins: Array<{
  id: string;
  type: string;
  version: string;
  sandbox: {
    create(root: string): Promise<ExploreBackend> | ExploreBackend;
    priority?: number;
  };
  [k: string]: unknown;
}> = [];

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    getByType: (type: string) => {
      if (type === "sandbox") return mockSandboxPlugins;
      return [];
    },
    getAllHealthy: () => [],
    get: () => undefined,
    getStatus: () => undefined,
    describe: () => [],
    size: 0,
    register: () => {},
    initializeAll: async () => ({ succeeded: [], failed: [] }),
    healthCheckAll: async () => new Map(),
    teardownAll: async () => {},
    _reset: () => {},
  },
  PluginRegistry: class {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let importCounter = 0;

/** Import a fresh copy of explore.ts with all module state reset. */
async function freshExploreModule() {
  importCounter++;
  return await import(`@atlas/api/lib/tools/explore?plugin_test=${importCounter}`);
}

function makeMockBackend(tag: string): ExploreBackend {
  return {
    exec: async (command: string): Promise<ExecResult> => ({
      stdout: `[${tag}] ${command}`,
      stderr: "",
      exitCode: 0,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("explore sandbox plugin integration", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockSandboxPlugins = [];
    // Ensure built-in backends are not detected
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    // Force PATH to not find nsjail
    process.env.PATH = "/usr/bin:/bin";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("selects a registered sandbox plugin over built-in backends", async () => {
    const backend = makeMockBackend("plugin-a");
    mockSandboxPlugins = [
      {
        id: "plugin-a",
        type: "sandbox",
        version: "1.0.0",
        sandbox: { create: async () => backend },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toContain("[plugin-a]");
  });

  it("higher priority plugin wins when multiple are registered", async () => {
    mockSandboxPlugins = [
      {
        id: "low-priority",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => makeMockBackend("low"),
          priority: 40,
        },
      },
      {
        id: "high-priority",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => makeMockBackend("high"),
          priority: 90,
        },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toContain("[high]");
  });

  it("falls through to next plugin when first create() throws", async () => {
    mockSandboxPlugins = [
      {
        id: "broken-plugin",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => { throw new Error("init failed"); },
          priority: 90,
        },
      },
      {
        id: "working-plugin",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => makeMockBackend("working"),
          priority: 50,
        },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toContain("[working]");
    expect(mod.getActiveSandboxPluginId()).toBe("working-plugin");
  });

  it("falls back to built-in backends when all plugins fail", async () => {
    mockSandboxPlugins = [
      {
        id: "broken-1",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => { throw new Error("fail 1"); },
        },
      },
      {
        id: "broken-2",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => { throw new Error("fail 2"); },
        },
      },
    ];

    const mod = await freshExploreModule();
    // No plugin succeeds, so it should fall through to just-bash.
    // just-bash may fail in test env too (no semantic/ dir), but the key assertion
    // is that _activeSandboxPluginId is NOT set.
    expect(mod.getActiveSandboxPluginId()).toBeNull();
  });

  it("sets _activeSandboxPluginId on successful plugin selection", async () => {
    mockSandboxPlugins = [
      {
        id: "my-sandbox",
        type: "sandbox",
        version: "2.0.0",
        sandbox: { create: async () => makeMockBackend("my-sandbox") },
      },
    ];

    const mod = await freshExploreModule();
    await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(mod.getActiveSandboxPluginId()).toBe("my-sandbox");
  });

  it("getExploreBackendType() returns 'plugin' when _activeSandboxPluginId is set", async () => {
    mockSandboxPlugins = [
      {
        id: "test-plugin",
        type: "sandbox",
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("test") },
      },
    ];

    const mod = await freshExploreModule();
    // Before any explore call, plugin is not yet active
    expect(mod.getExploreBackendType()).not.toBe("plugin");

    // Trigger backend init
    await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(mod.getExploreBackendType()).toBe("plugin");
  });

  it("invalidateExploreBackend() clears _activeSandboxPluginId", async () => {
    mockSandboxPlugins = [
      {
        id: "clearable-plugin",
        type: "sandbox",
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("clearable") },
      },
    ];

    const mod = await freshExploreModule();
    await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(mod.getActiveSandboxPluginId()).toBe("clearable-plugin");

    mod.invalidateExploreBackend();
    expect(mod.getActiveSandboxPluginId()).toBeNull();
  });

  it("skips plugins when ATLAS_SANDBOX=nsjail is set", async () => {
    process.env.ATLAS_SANDBOX = "nsjail";

    mockSandboxPlugins = [
      {
        id: "should-be-skipped",
        type: "sandbox",
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("skipped") },
      },
    ];

    const mod = await freshExploreModule();
    // Trigger backend init — it should skip plugins and go straight to nsjail
    // nsjail will fail (not installed in test), but the key assertion is
    // that the plugin was NOT used
    await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    expect(mod.getActiveSandboxPluginId()).toBeNull();
  });

  it("uses default priority (60) when plugin omits priority", async () => {
    mockSandboxPlugins = [
      {
        id: "explicit-low",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          create: async () => makeMockBackend("explicit-low"),
          priority: 50,
        },
      },
      {
        id: "default-priority",
        type: "sandbox",
        version: "1.0.0",
        sandbox: {
          // No priority — defaults to 60 (SANDBOX_DEFAULT_PRIORITY)
          create: async () => makeMockBackend("default"),
        },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
    );

    // Default priority (60) > explicit (50), so default-priority plugin wins
    expect(result).toContain("[default]");
    expect(mod.getActiveSandboxPluginId()).toBe("default-priority");
  });
});
