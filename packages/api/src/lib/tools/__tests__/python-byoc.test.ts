/**
 * Tests for BYOC backend selection in the Python tool (#3410).
 *
 * When a request carries an org whose workspace override selects a BYOC
 * provider's backend id AND that provider can run Python, the tool must
 * consult the BYOC runtime BEFORE the operator-configured chain:
 *
 *   • engaged   → the org-credential backend runs the code (even when a
 *                 sidecar is configured — the override outranks it, matching
 *                 explore's priority -1)
 *   • null      → the override falls through to the operator chain
 *   • throws    → the tool fails closed (no silent operator fallback)
 *
 * Unlike explore, Python backends are per-request: every call re-consults
 * the BYOC runtime (and therefore re-reads stored credentials), so
 * credential edits take effect on the next call with no drain step.
 *
 * Follows the mock.module idiom of explore-byoc.test.ts; the BYOC runtime
 * itself is unit-tested in lib/sandbox/__tests__/runtime.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { PythonBackend } from "../python";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import type { OperationGraph } from "@atlas/api/lib/openapi/types";

// ---------------------------------------------------------------------------
// Mocks — must register before any import of python.ts
// ---------------------------------------------------------------------------

let mockRequestContext:
  | { user?: { activeOrganizationId?: string } }
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

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async <T,>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn(),
  withEffectSpan: <T,>(_n: string, _a: unknown, e: T) => e,
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

// --- sidecar backend mock: the operator chain proxy (ATLAS_SANDBOX_URL) ---

let mockSidecarExecCalls = 0;
mock.module("@atlas/api/lib/tools/python-sidecar", () => ({
  executePythonViaSidecar: async () => {
    mockSidecarExecCalls += 1;
    return { success: true, output: "[sidecar]" };
  },
  executePythonViaSidecarStream: async () => {
    mockSidecarExecCalls += 1;
    return { success: true, output: "[sidecar]" };
  },
}));

// --- BYOC runtime mock — per-test behavior, all exports mocked ---

type ByocPythonResult =
  | { kind: "backend"; create: () => PythonBackend }
  | { kind: "null" }
  | { kind: "throw"; message: string };

let mockByocResult: ByocPythonResult = { kind: "null" };
let byocCalls: Array<{ orgId: string; backendId: string; options: { networkPolicy?: unknown } }> = [];

const PROVIDER_FOR_BACKEND: Record<string, string> = {
  "vercel-sandbox": "vercel",
  "e2b-sandbox": "e2b",
  "daytona-sandbox": "daytona",
  "railway-sandbox": "railway",
};

mock.module("@atlas/api/lib/sandbox/runtime", () => ({
  sandboxProviderForBackendId: (backendId: string) =>
    PROVIDER_FOR_BACKEND[backendId] ?? null,
  providerSupportsPython: (provider: string) => provider === "vercel",
  missingCredentialFields: () => [],
  _scrubCredentialValuesForTest: (text: string) => text,
  isProviderRuntimeAvailable: async () => false,
  getProviderRuntimeAvailability: async () => ({
    vercel: true,
    e2b: false,
    daytona: false,
    railway: false,
  }),
  _resetRuntimeAvailabilityCacheForTest: () => {},
  tryCreateByocBackend: async () => null,
  tryCreateByocPythonBackend: async (
    orgId: string,
    backendId: string,
    getOptions: () => Promise<{ networkPolicy?: unknown }> = async () => ({}),
  ) => {
    switch (mockByocResult.kind) {
      case "backend": {
        // Mirror the real contract: the options thunk runs only once engaged.
        const options = await getOptions();
        byocCalls.push({ orgId, backendId, options });
        return mockByocResult.create();
      }
      case "null":
        byocCalls.push({ orgId, backendId, options: {} });
        return null;
      case "throw":
        byocCalls.push({ orgId, backendId, options: {} });
        throw new Error(mockByocResult.message);
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeByocBackend(tag: string): PythonBackend {
  return {
    exec: async () => ({ success: true as const, output: `[${tag}]` }),
  };
}

function makeDatasource(id: string, baseUrl: string): RestDatasource {
  const graph: OperationGraph = {
    operations: new Map(),
    schemas: new Map(),
    security: new Map(),
    servers: [],
    info: { title: id, version: "1", openapiVersion: "3.1.0" },
  };
  return {
    id,
    displayName: id,
    graph,
    baseUrl,
    auth: { kind: "bearer", token: "tok" },
    representationMode: "operation-graph",
    writeAllowlist: new Set<string>(),
    sideEffectingOperations: new Set<string>(),
  };
}

async function runPython(
  resolveRestDatasource?: () => Promise<RestDatasource | null>,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const { createExecutePythonTool } = await import("@atlas/api/lib/tools/python");
  const tool = createExecutePythonTool(
    resolveRestDatasource ? { resolveRestDatasource } : {},
  );
  const result = await tool.execute!(
    { code: "print(1)", explanation: "test", data: undefined },
    { toolCallId: "t", messages: [] } as never,
  );
  return result as { success: boolean; output?: string; error?: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executePython BYOC backend selection (#3410)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockSettings.clear();
    mockRequestContext = undefined;
    mockByocResult = { kind: "null" };
    byocCalls = [];
    mockSidecarExecCalls = 0;
    // Operator chain = sidecar (so a BYOC win is unambiguous: the sidecar
    // would otherwise be priority 1 in getPythonBackend).
    process.env.ATLAS_SANDBOX_URL = "http://sidecar.test";
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TOKEN;
    delete process.env.ATLAS_SANDBOX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses the BYOC backend when the org's stored credentials engage — even over a configured sidecar", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "backend", create: () => makeByocBackend("byoc-vercel") };

    const result = await runPython();

    expect(result.success).toBe(true);
    expect(result.output).toBe("[byoc-vercel]");
    expect(mockSidecarExecCalls).toBe(0);
    expect(byocCalls.length).toBe(1);
    expect(byocCalls[0].orgId).toBe("org-1");
    expect(byocCalls[0].backendId).toBe("vercel-sandbox");
  });

  it("falls through to the operator chain when BYOC is not engaged", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "null" }; // no stored creds / runtime unavailable

    const result = await runPython();

    expect(result.success).toBe(true);
    expect(result.output).toBe("[sidecar]");
    expect(byocCalls.length).toBe(1);
  });

  it("fails closed when the engaged BYOC backend cannot be built", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "throw", message: "your vercel sandbox failed to start" };

    const result = await runPython();

    expect(result.success).toBe(false);
    expect(result.error).toContain("vercel sandbox failed to start");
    // Never silently run the org's Python on the operator chain
    expect(mockSidecarExecCalls).toBe(0);
  });

  it("does not consult BYOC without an org context", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = undefined; // self-hosted, no org

    const result = await runPython();

    expect(result.output).toBe("[sidecar]");
    expect(byocCalls).toEqual([]);
  });

  it("skips BYOC for python-incapable providers (selection covers explore only)", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    // Would engage if consulted — but the capability gate must short-circuit
    mockByocResult = { kind: "backend", create: () => makeByocBackend("byoc-e2b") };

    const result = await runPython();

    expect(result.output).toBe("[sidecar]");
    expect(byocCalls).toEqual([]);
  });

  it("normalizes legacy provider-key overrides before the BYOC lookup (#3375)", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel"); // legacy stored value
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "backend", create: () => makeByocBackend("byoc-vercel") };

    const result = await runPython();

    expect(result.output).toBe("[byoc-vercel]");
    expect(byocCalls[0].backendId).toBe("vercel-sandbox");
  });

  it("threads the per-request REST egress allowlist into the BYOC backend (#2927)", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "backend", create: () => makeByocBackend("byoc-vercel") };

    await runPython(async () => makeDatasource("crm", "https://api.example.com"));

    expect(byocCalls.length).toBe(1);
    const policy = byocCalls[0].options.networkPolicy;
    expect(policy).toBeDefined();
    expect(JSON.stringify(policy)).toContain("api.example.com");
  });

  it("leaves the BYOC sandbox at deny-all when the datasource resolve fails (fail-soft)", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "backend", create: () => makeByocBackend("byoc-vercel") };

    const result = await runPython(async () => {
      throw new Error("resolver down");
    });

    // Resolve failure narrows egress (deny-all), never breaks the call
    expect(result.output).toBe("[byoc-vercel]");
    expect(byocCalls[0].options.networkPolicy).toBeUndefined();
  });

  it("does not resolve the REST datasource when BYOC is not engaged and the operator chain is not Vercel", async () => {
    // The egress derivation rides behind the options thunk, which the BYOC
    // runtime only invokes once engaged — a selected-but-unusable override
    // must not pay the datasource resolve when the sidecar serves the call.
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    mockByocResult = { kind: "null" };
    let resolves = 0;

    const result = await runPython(async () => {
      resolves++;
      return null;
    });

    expect(result.output).toBe("[sidecar]");
    expect(resolves).toBe(0);
  });

  it("re-consults the BYOC runtime on every call — credential edits need no drain", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockRequestContext = { user: { activeOrganizationId: "org-1" } };
    let creations = 0;
    mockByocResult = {
      kind: "backend",
      create: () => {
        creations++;
        return makeByocBackend(`byoc-${creations}`);
      },
    };

    expect((await runPython()).output).toBe("[byoc-1]");
    expect((await runPython()).output).toBe("[byoc-2]");
    expect(creations).toBe(2);
  });
});
