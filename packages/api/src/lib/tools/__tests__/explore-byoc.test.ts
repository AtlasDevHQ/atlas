/**
 * Tests for BYOC backend selection in the explore tool (#3370).
 *
 * When a request carries an org whose workspace override selects a BYOC
 * provider's backend id, the explore tool must consult the BYOC runtime
 * BEFORE the operator-configured chain:
 *
 *   • engaged   → the org-credential backend runs the command
 *   • null      → the override falls through to the operator chain
 *   • throws    → explore fails closed (no silent operator fallback)
 *
 * Credential edits invalidate the org's cached backends via
 * `invalidateOrgExploreBackends` (and close the evicted backend).
 *
 * Follows the mock.module idiom of explore-workspace-override.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ExploreBackend, ExecResult } from "../../tools/explore";

// ---------------------------------------------------------------------------
// Mocks — must register before any import of explore.ts
// ---------------------------------------------------------------------------

let mockRequestContext:
  | { user?: { activeOrganizationId?: string }; atlasMode?: string }
  | undefined;

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
  withRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => mockRequestContext,
  redactPaths: [],
}));

const realSemanticSync = await import("@atlas/api/lib/semantic/sync");
mock.module("@atlas/api/lib/semantic/sync", () => ({
  ...realSemanticSync,
  ensureOrgModeSemanticRoot: async () => realSemanticSync.getSemanticRoot(),
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async <T,>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
  withEffectSpan: <T,>(_n: string, _a: unknown, e: T) => e,
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
    getByType: (type: string) => (type === "sandbox" ? mockSandboxPlugins : []),
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

// --- BYOC runtime mock — per-test behavior, all exports mocked ---

type ByocResult =
  | { kind: "backend"; create: () => ExploreBackend }
  | { kind: "null" }
  | { kind: "throw"; message: string };

let mockByocResult: ByocResult = { kind: "null" };
let byocCalls: Array<{ orgId: string; backendId: string }> = [];

mock.module("@atlas/api/lib/sandbox/runtime", () => ({
  sandboxProviderForBackendId: () => null,
  missingCredentialFields: () => [],
  isProviderRuntimeAvailable: async () => false,
  getProviderRuntimeAvailability: async () => ({
    vercel: true,
    e2b: false,
    daytona: false,
    railway: false,
  }),
  _resetRuntimeAvailabilityCacheForTest: () => {},
  tryCreateByocBackend: async (orgId: string, backendId: string) => {
    byocCalls.push({ orgId, backendId });
    switch (mockByocResult.kind) {
      case "backend":
        return mockByocResult.create();
      case "null":
        return null;
      case "throw":
        throw new Error(mockByocResult.message);
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let importCounter = 0;

async function freshExploreModule() {
  importCounter++;
  return await import(`@atlas/api/lib/tools/explore?byoc_test=${importCounter}`);
}

function makeMockBackend(tag: string, onClose?: () => void): ExploreBackend {
  return {
    exec: async (command: string): Promise<ExecResult> => ({
      stdout: `[${tag}] ${command}`,
      stderr: "",
      exitCode: 0,
    }),
    close: async () => {
      onClose?.();
    },
  };
}

const toolOpts = {
  toolCallId: "test",
  messages: [],
  abortSignal: new AbortController().signal,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("explore BYOC backend selection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockSettings.clear();
    mockSandboxPlugins = [];
    mockRequestContext = undefined;
    mockByocResult = { kind: "null" };
    byocCalls = [];
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

  it("uses the BYOC backend when the org's stored credentials engage", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "backend", create: () => makeMockBackend("byoc-e2b") };
    // A registered operator plugin with the same id must NOT win over BYOC
    mockSandboxPlugins = [
      {
        id: "e2b-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("operator-e2b"), priority: 50 },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute({ command: "ls" }, toolOpts);

    expect(result).toContain("[byoc-e2b]");
    expect(byocCalls).toEqual([{ orgId: "org-1", backendId: "e2b-sandbox" }]);
  });

  it("falls through to the operator chain when BYOC is not engaged", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "null" }; // no stored creds / runtime unavailable
    mockSandboxPlugins = [
      {
        id: "e2b-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("operator-e2b"), priority: 50 },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute({ command: "ls" }, toolOpts);

    expect(result).toContain("[operator-e2b]");
    expect(byocCalls.length).toBe(1);
  });

  it("fails closed when the engaged BYOC backend cannot be built", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "throw", message: "your e2b sandbox failed to start" };
    // Operator plugin available — it must NOT be used as a silent fallback
    mockSandboxPlugins = [
      {
        id: "e2b-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("operator-e2b"), priority: 50 },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute({ command: "ls" }, toolOpts);

    expect(result).toContain("Explore tool is unavailable");
    expect(result).toContain("e2b sandbox failed to start");
    expect(result).not.toContain("[operator-e2b]");
  });

  it("does not consult BYOC without an org context", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = undefined; // self-hosted, no org
    mockSandboxPlugins = [
      {
        id: "e2b-sandbox",
        types: ["sandbox"],
        version: "1.0.0",
        sandbox: { create: async () => makeMockBackend("operator-e2b"), priority: 50 },
      },
    ];

    const mod = await freshExploreModule();
    const result = await mod.explore.execute({ command: "ls" }, toolOpts);

    expect(result).toContain("[operator-e2b]");
    expect(byocCalls).toEqual([]);
  });

  it("invalidateOrgExploreBackends drops the cached backend and closes it", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };

    let closed = 0;
    let created = 0;
    mockByocResult = {
      kind: "backend",
      create: () => {
        created++;
        return makeMockBackend(`byoc-${created}`, () => {
          closed++;
        });
      },
    };

    const mod = await freshExploreModule();

    // First call creates and caches
    expect(await mod.explore.execute({ command: "ls" }, toolOpts)).toContain("[byoc-1]");
    // Second call hits the cache — no new backend
    expect(await mod.explore.execute({ command: "ls" }, toolOpts)).toContain("[byoc-1]");
    expect(created).toBe(1);

    // Credential edit: invalidate this org → old backend closed, next call rebuilds
    mod.invalidateOrgExploreBackends("org-1");
    expect(await mod.explore.execute({ command: "ls" }, toolOpts)).toContain("[byoc-2]");
    expect(created).toBe(2);
    // close() is fire-and-forget — give the microtask queue a tick
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });

  it("invalidating a different org leaves the cached backend in place", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };

    let created = 0;
    mockByocResult = {
      kind: "backend",
      create: () => {
        created++;
        return makeMockBackend(`byoc-${created}`);
      },
    };

    const mod = await freshExploreModule();
    expect(await mod.explore.execute({ command: "ls" }, toolOpts)).toContain("[byoc-1]");

    mod.invalidateOrgExploreBackends("org-other");
    expect(await mod.explore.execute({ command: "ls" }, toolOpts)).toContain("[byoc-1]");
    expect(created).toBe(1);
  });
});
