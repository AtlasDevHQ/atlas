import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import type { RestDatasource } from "@atlas/api/lib/openapi/datasource";
import type { OperationGraph } from "@atlas/api/lib/openapi/types";

// ---------------------------------------------------------------------------
// python-rest-egress — end-to-end proof of the #2927 layer-0 boundary through
// the live executePython path (the seam network-allowlist.test.ts +
// python-sandbox.test.ts each prove in isolation: resolve datasource →
// derive allowlist from its baseUrl → that policy reaches the Vercel sandbox).
//
// Exercises the `createExecutePythonTool({ resolveRestDatasource })` test seam,
// which exists precisely for these assertions:
//   - the egress policy tracks the per-request datasource's baseUrl, NOT `code`
//     (a prompt cannot inject/widen it),
//   - tenant A's resolver cannot widen tenant B's policy,
//   - a resolve failure / no datasource fails closed to deny-all.
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  getRequestContext: () => undefined,
}));
mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

// --- sidecar backend mock: prove the Vercel-only egress path is bypassed when
// a sidecar is configured (it has no networkPolicy — the self-hosted asymmetry).
let mockSidecarExecCalls = 0;
mock.module("@atlas/api/lib/tools/python-sidecar", () => ({
  executePythonViaSidecar: async () => {
    mockSidecarExecCalls += 1;
    return { success: true };
  },
  executePythonViaSidecarStream: async () => {
    mockSidecarExecCalls += 1;
    return { success: true };
  },
}));

// --- @vercel/sandbox mock: capture the network policy the sandbox locks to ---
let mockUpdateNetworkPolicyCalls: unknown[] = [];

function setupSandboxMock() {
  mockUpdateNetworkPolicyCalls = [];
  mock.module("@vercel/sandbox", () => ({
    Sandbox: {
      create: async () => ({
        runCommand: async (_params: { cmd: string; env?: Record<string, string> }) => {
          // The wrapper writes its result to the sandbox FS, not stdout.
          return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
        },
        writeFiles: async () => {},
        mkDir: async () => {},
        updateNetworkPolicy: async (policy: unknown) => {
          mockUpdateNetworkPolicyCalls.push(policy);
        },
        // v2 FS surface: backend reads the structured result off the FS.
        fs: { readdir: async () => [] as string[] },
        readFileToBuffer: async () => Buffer.from('{"success":true}'),
        stop: async () => {},
      }),
    },
  }));
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
  resolveRestDatasource: () => Promise<RestDatasource | null>,
  code: string,
): Promise<{ success: boolean; error?: string }> {
  const { createExecutePythonTool } = await import("@atlas/api/lib/tools/python");
  const tool = createExecutePythonTool({ resolveRestDatasource });
  // The AI SDK tool exposes `.execute`; options are unused here (no streaming).
  // Its return type is a broad union (it can stream); narrow to the structured
  // PythonResult shape the non-streaming path actually returns.
  const result = await tool.execute!(
    { code, explanation: "test", data: undefined },
    { toolCallId: "t", messages: [] } as never,
  );
  return result as { success: boolean; error?: string };
}

const originalEnv = { ...process.env };

describe("executePython REST egress (#2927, layer 0)", () => {
  beforeEach(() => {
    // Force the Vercel backend: useVercelSandbox() && !useSidecar().
    process.env.ATLAS_RUNTIME = "vercel";
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TOKEN;
    setupSandboxMock();
    mockSidecarExecCalls = 0;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("bounds sandbox egress to the resolved datasource's host (server-derived from baseUrl)", async () => {
    const result = await runPython(
      async () => makeDatasource("twenty", "https://crm.tenant-a.example/rest"),
      "result = 1",
    );
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual([
      { allow: { "crm.tenant-a.example": [] } },
    ]);
  });

  it("SECURITY: a host named in the agent's `code` cannot widen the allowlist", async () => {
    // The code mentions attacker.example.com, but the policy is derived from
    // the resolved datasource's baseUrl only — never from `code`.
    const result = await runPython(
      async () => makeDatasource("twenty", "https://crm.tenant-a.example/rest"),
      "target = 'http://attacker.example.com/steal'",
    );
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual([
      { allow: { "crm.tenant-a.example": [] } },
    ]);
  });

  it("SECURITY (tenant isolation): tenant B's resolver yields tenant B's host, not tenant A's", async () => {
    const result = await runPython(
      async () => makeDatasource("twenty", "https://crm.tenant-b.example/rest"),
      "result = 1",
    );
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual([
      { allow: { "crm.tenant-b.example": [] } },
    ]);
    const [policy] = mockUpdateNetworkPolicyCalls as [{ allow: Record<string, unknown> }];
    expect(policy.allow).not.toHaveProperty("crm.tenant-a.example");
  });

  it("fails closed to deny-all when no datasource is resolved", async () => {
    const result = await runPython(async () => null, "result = 1");
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual(["deny-all"]);
  });

  it("fails closed to deny-all when the resolver throws (fail-soft)", async () => {
    const result = await runPython(async () => {
      throw new Error("DB unreachable");
    }, "result = 1");
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual(["deny-all"]);
  });

  it("fails closed to deny-all when the datasource base URL has no parseable host", async () => {
    const result = await runPython(
      async () => makeDatasource("twenty", "not-a-url"),
      "result = 1",
    );
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual(["deny-all"]);
  });

  it("SECURITY: fails closed to deny-all when the datasource base URL is a `*` wildcard host", async () => {
    // A configured (lower-trust, slice-2) base URL of `https://*/` parses but its
    // host is the match-all `*`. The wildcard guard collapses it to no host →
    // deny-all, rather than handing @vercel/sandbox an allow-all policy.
    const result = await runPython(
      async () => makeDatasource("twenty", "https://*/rest"),
      "result = 1",
    );
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual(["deny-all"]);
  });

  it("still narrows to the host for an http:// datasource (warn-not-drop — boundary stays fail-closed)", async () => {
    // Vercel's allowlist matches by SNI so http:// egress may not work, but we
    // apply the policy anyway (the host is still listed, never opened wider) and
    // only warn — dropping would risk breaking a host if the SNI caveat is
    // version-dependent. The policy must still be the host record, not deny-all.
    const result = await runPython(
      async () => makeDatasource("twenty", "http://crm.internal/rest"),
      "result = 1",
    );
    expect(result.success).toBe(true);
    expect(mockUpdateNetworkPolicyCalls).toEqual([{ allow: { "crm.internal": [] } }]);
  });

  it("SECURITY (self-hosted asymmetry): a configured sidecar bypasses the resolver and applies NO network policy", async () => {
    // When ATLAS_SANDBOX_URL is set, useSidecar() wins over the Vercel backend.
    // The resolver must NOT run (the guard is `useVercelSandbox() && !useSidecar()`)
    // and the sidecar — which has no networkPolicy equivalent — gets no narrowing.
    process.env.ATLAS_SANDBOX_URL = "http://sandbox-sidecar:8080";
    let resolverCalls = 0;
    const result = await runPython(async () => {
      resolverCalls += 1;
      return makeDatasource("twenty", "https://crm.tenant-a.example/rest");
    }, "result = 1");

    expect(result.success).toBe(true);
    expect(resolverCalls).toBe(0); // resolve skipped — never touched on the sidecar path
    expect(mockSidecarExecCalls).toBe(1); // request went to the sidecar
    expect(mockUpdateNetworkPolicyCalls).toEqual([]); // no policy applied to the sidecar
  });
});
