/**
 * #4187 — the Python tool now routes through the SAME backend-selection policy
 * as explore, so it honors the operator's `sandbox.priority` (and, transitively,
 * `ATLAS_SANDBOX_PRIORITY`, which `config.ts` folds into that field).
 *
 * Before #4187 `getPythonBackend` was a hand-rolled `sidecar > vercel > nsjail`
 * chain with ZERO references to `sandbox.priority` — so a SaaS deploy that pins
 * `["vercel-sandbox"]` (deny-all, no fallback) could have Python silently run on
 * a configured sidecar instead, the exact posture bug this issue closes. These
 * tests lock:
 *   1. a single-backend pin fails CLOSED when the pinned backend is unavailable,
 *      never falling through to a configured-but-unpinned sidecar; and
 *   2. the pin actually routes Python to the pinned backend (positive control).
 */
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { _setConfigForTest, _resetConfig, type ResolvedConfig } from "@atlas/api/lib/config";

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  getRequestContext: () => undefined,
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
  withEffectSpan: <T>(_n: string, _a: unknown, e: T) => e,
}));

// Count sidecar dispatches so a pin that excludes the sidecar can prove Python
// never touched it. Mock every export the import graph could reach.
let sidecarExecCalls = 0;
mock.module("@atlas/api/lib/tools/python-sidecar", () => ({
  executePythonViaSidecar: async () => {
    sidecarExecCalls += 1;
    return { success: true, output: "[sidecar]" };
  },
  executePythonViaSidecarStream: async () => {
    sidecarExecCalls += 1;
    return { success: true, output: "[sidecar]" };
  },
}));

// The AST import guard shells out to python3; stub Bun.spawn to return a clean
// parse so validation never blocks these selection-focused tests.
const savedSpawn = Bun.spawn;
function stubImportGuard() {
  Bun.spawn = ((...args: unknown[]) => {
    const cmd = args[0] as string[];
    if (cmd[0] === "python3") {
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"imports":[],"calls":[]}'));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }
    // Any other spawn (e.g. nsjail) — return an empty success.
    return {
      stdin: { write: () => {}, end: () => {} },
      stdout: new ReadableStream({ start: (c) => c.close() }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn;
}

const { executePython } = await import("@atlas/api/lib/tools/python");

async function runPython(): Promise<{ success: boolean; error?: string; output?: string }> {
  const result = await executePython.execute!(
    { code: "result = 1", explanation: "test", data: undefined },
    {} as never,
  );
  return result as { success: boolean; error?: string; output?: string };
}

describe("executePython honors sandbox.priority (#4187)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sidecarExecCalls = 0;
    _resetConfig();
    stubImportGuard();
    // A sidecar IS configured — a correct pin must ignore it.
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
    _resetConfig();
    Bun.spawn = savedSpawn;
  });

  it("fails CLOSED on a ['vercel-sandbox'] pin when Vercel is unavailable — never falls through to the sidecar", async () => {
    _setConfigForTest({
      sandbox: { priority: ["vercel-sandbox"] },
      deployMode: "saas",
    } as unknown as ResolvedConfig);
    // No Vercel credentials → the pinned backend cannot be constructed.

    const result = await runPython();

    expect(result.success).toBe(false);
    expect(result.error).toContain("All backends in sandbox.priority");
    expect(result.error).toContain("vercel-sandbox");
    // The posture fix: the configured sidecar was NOT used despite being available.
    expect(sidecarExecCalls).toBe(0);
  });

  it("routes Python to the pinned sidecar when the operator pins ['sidecar'] (positive control)", async () => {
    _setConfigForTest({
      sandbox: { priority: ["sidecar"] },
      deployMode: "self-hosted",
    } as unknown as ResolvedConfig);

    const result = await runPython();

    expect(result.success).toBe(true);
    expect(result.output).toBe("[sidecar]");
    expect(sidecarExecCalls).toBe(1);
  });

  it("REFUSES (never runs unsandboxed) when no isolation backend is available", async () => {
    // No config pin, no sidecar, no Vercel, no nsjail (PATH cleared so
    // findNsjailBinary is deterministically null regardless of host) — the
    // default chain exhausts and Python must refuse, unlike explore's just-bash.
    _resetConfig();
    delete process.env.ATLAS_SANDBOX_URL;
    process.env.PATH = "";
    delete process.env.ATLAS_NSJAIL_PATH;

    const result = await runPython();

    expect(result.success).toBe(false);
    expect(result.error).toContain("requires a sandbox");
    expect(sidecarExecCalls).toBe(0);
  });

  it("hard-fails when ATLAS_SANDBOX=nsjail but the nsjail binary is absent", async () => {
    // This path was previously untestable (python-nsjail.test.ts:504-509 gave up
    // because fs was globally mocked present); the #4187 decoupling makes it
    // deterministic. PATH="" ⇒ findNsjailBinary() === null ⇒ the explicit-nsjail
    // hard-fail step surfaces as an error, never a downgrade to the sidecar.
    _resetConfig();
    process.env.ATLAS_SANDBOX = "nsjail";
    process.env.PATH = "";
    delete process.env.ATLAS_NSJAIL_PATH;

    const result = await runPython();

    expect(result.success).toBe(false);
    expect(result.error).toContain("ATLAS_SANDBOX=nsjail");
    expect(result.error).toContain("could not be initialized");
    // Even with a sidecar configured, an explicit-nsjail pin never falls through.
    expect(sidecarExecCalls).toBe(0);
  });
});
