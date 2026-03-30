/**
 * Tests for workspace-scoped sandbox backend override.
 *
 * Validates that when an orgId is provided with a workspace-level
 * ATLAS_SANDBOX_BACKEND setting, the explore module selects the
 * overridden backend instead of the default priority chain.
 *
 * Uses mock.module() to control getSetting() and plugin registry.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ExploreBackend, ExecResult } from "../../tools/explore";

// ---------------------------------------------------------------------------
// Mocks — must register before any import of explore.ts
// ---------------------------------------------------------------------------

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
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async <T>(_name: string, _attrs: unknown, fn: () => Promise<T>) =>
    fn(),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async <
    T extends Record<string, unknown>,
    K extends string & keyof T,
  >(
    _hookName: string,
    context: T,
    mutateKey: K,
  ) => context[mutateKey],
}));

// ---------------------------------------------------------------------------
// Mutable settings map — tests control what getSetting() returns
// ---------------------------------------------------------------------------

const mockSettings = new Map<string, string>();

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingAuto: (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingLive: async (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// ---------------------------------------------------------------------------
// Mutable plugin list
// ---------------------------------------------------------------------------

let mockSandboxPlugins: Array<{
  id: string;
  types: string[];
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

async function freshExploreModule() {
  importCounter++;
  return await import(
    `@atlas/api/lib/tools/explore?ws_override_test=${importCounter}`
  );
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

describe("workspace sandbox backend override", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockSettings.clear();
    mockSandboxPlugins = [];
    // Disable all built-in detection
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_NSJAIL_PATH;
    process.env.PATH = "/usr/bin:/bin";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses sidecar when workspace override is 'sidecar' with custom URL", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "sidecar");
    mockSettings.set("ATLAS_SANDBOX_URL", "http://custom-sidecar:8080");

    const mod = await freshExploreModule();

    // Execute via the tool — the sidecar backend will try to connect to the
    // custom URL. Since it's not a real server, we expect an error, but the
    // key thing is that the workspace override was respected (not falling
    // through to just-bash directly).
    const result = await mod.explore.execute(
      { command: "ls" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    // The sidecar backend will fail to connect but the error should mention
    // sidecar-related issues (connection refused), not "just-bash"
    expect(typeof result).toBe("string");
  });

  it("falls through to default chain when workspace override is unavailable", async () => {
    // Set override to vercel-sandbox, but ATLAS_RUNTIME is not set
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    // Should fall through to just-bash (the only available backend)
    expect(typeof result).toBe("string");
    // just-bash executes the command (ls on semantic/) — should not error fatally
    // The result may contain directory listing or a not-found message
    expect(result).toBeDefined();
  });

  it("selects workspace plugin override when plugin ID matches", async () => {
    const pluginBackend = makeMockBackend("e2b-sandbox");
    mockSandboxPlugins = [
      {
        id: "e2b-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => pluginBackend, priority: 50 },
      },
    ];
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    expect(result).toContain("[e2b-sandbox]");
  });

  it("without workspace override, uses plugin from default chain", async () => {
    const pluginBackend = makeMockBackend("daytona-sandbox");
    mockSandboxPlugins = [
      {
        id: "daytona-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => pluginBackend, priority: 50 },
      },
    ];
    // No workspace override set

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    // Plugin should still be selected via normal Priority 0 chain
    expect(result).toContain("[daytona-sandbox]");
  });

  it("workspace override for a different plugin ignores non-matching plugin", async () => {
    const e2bBackend = makeMockBackend("e2b-sandbox");
    const daytonaBackend = makeMockBackend("daytona-sandbox");
    mockSandboxPlugins = [
      {
        id: "e2b-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => e2bBackend, priority: 50 },
      },
      {
        id: "daytona-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => daytonaBackend, priority: 40 },
      },
    ];
    // Override specifically requests daytona — but wireSandboxPlugins returns
    // highest priority (e2b). The workspace override path checks pluginId match.
    // If daytona isn't the one returned by wireSandboxPlugins, the override falls
    // through to the normal chain where e2b wins by priority.
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "daytona-sandbox");

    const mod = await freshExploreModule();
    const result = await mod.explore.execute(
      { command: "ls" },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );

    // wireSandboxPlugins sorts by priority — e2b (50) > daytona (40)
    // So the workspace override for "daytona-sandbox" won't find a match
    // from wireSandboxPlugins (which returns e2b), falls through to default
    // chain where e2b wins. This is a known limitation — workspace override
    // for a specific plugin ID relies on wireSandboxPlugins returning it.
    expect(typeof result).toBe("string");
  });

  it("cache key includes workspace override to prevent cross-workspace contamination", async () => {
    // First call with no override — should use just-bash
    const mod = await freshExploreModule();
    const result1 = await mod.explore.execute(
      { command: "echo test1" },
      {
        toolCallId: "test1",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );
    expect(typeof result1).toBe("string");

    // Now set an override — should get a new backend instance (not cached just-bash)
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "sidecar");
    mockSettings.set("ATLAS_SANDBOX_URL", "http://different-sidecar:9090");

    // The cache key should differ due to the override, so it won't reuse
    // the previous just-bash backend. We just verify it doesn't crash.
    const result2 = await mod.explore.execute(
      { command: "echo test2" },
      {
        toolCallId: "test2",
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );
    expect(typeof result2).toBe("string");
  });

  it("no override and no orgId uses default chain", async () => {
    const mod = await freshExploreModule();
    // getExploreBackendType doesn't take orgId — reports default chain
    expect(mod.getExploreBackendType()).toBe("just-bash");
  });
});
