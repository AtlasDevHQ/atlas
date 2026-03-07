import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
}));

mock.module("@atlas/api/lib/security", () => ({
  SENSITIVE_PATTERNS: /postgresql:\/\/|mysql:\/\/|sk-ant-/,
}));

// --- @vercel/sandbox mock infrastructure ---

type RunCommandParams = {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
};

interface MockSandboxOverrides {
  createError?: string;
  pipExitCode?: number;
  pipStderr?: string;
  pipThrows?: string;
  updateNetworkPolicyThrows?: string;
  mkDirThrows?: string;
  writeFilesThrows?: string;
  runCommandThrows?: string;
  runCommandResult?: {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  /** If true, dynamically inject the result marker into stdout */
  injectMarker?: boolean;
  /** Custom stdout builder given the marker */
  stdoutForMarker?: (marker: string) => string;
}

let mockCreateCalls: unknown[] = [];
let mockRunCommandCalls: RunCommandParams[] = [];
let mockWriteFilesCalls: { path: string; content: Buffer }[][] = [];
let mockMkDirCalls: string[] = [];
let mockStopCalls = 0;
let mockUpdateNetworkPolicyCalls: unknown[] = [];

function setupSandboxMock(overrides: MockSandboxOverrides = {}) {
  mockCreateCalls = [];
  mockRunCommandCalls = [];
  mockWriteFilesCalls = [];
  mockMkDirCalls = [];
  mockStopCalls = 0;
  mockUpdateNetworkPolicyCalls = [];

  mock.module("@vercel/sandbox", () => ({
    Sandbox: {
      create: async (opts: unknown) => {
        mockCreateCalls.push(opts);
        if (overrides.createError) throw new Error(overrides.createError);
        return {
          runCommand: async (params: RunCommandParams) => {
            if (params.cmd === "pip") {
              if (overrides.pipThrows) throw new Error(overrides.pipThrows);
              return {
                exitCode: overrides.pipExitCode ?? 0,
                stdout: async () => "",
                stderr: async () => overrides.pipStderr ?? "",
              };
            }
            mockRunCommandCalls.push(params);
            if (overrides.runCommandThrows) throw new Error(overrides.runCommandThrows);

            const marker = params.env?.ATLAS_RESULT_MARKER ?? "";
            if (overrides.stdoutForMarker) {
              return {
                exitCode: overrides.runCommandResult?.exitCode ?? 0,
                stdout: async () => overrides.stdoutForMarker!(marker),
                stderr: async () => overrides.runCommandResult?.stderr ?? "",
              };
            }
            if (overrides.injectMarker !== false && !overrides.runCommandResult) {
              return {
                exitCode: 0,
                stdout: async () => `${marker}{"success":true}\n`,
                stderr: async () => "",
              };
            }
            return {
              exitCode: overrides.runCommandResult?.exitCode ?? 0,
              stdout: async () => overrides.runCommandResult?.stdout ?? "",
              stderr: async () => overrides.runCommandResult?.stderr ?? "",
            };
          },
          writeFiles: async (files: { path: string; content: Buffer }[]) => {
            mockWriteFilesCalls.push(files);
            if (overrides.writeFilesThrows) throw new Error(overrides.writeFilesThrows);
          },
          mkDir: async (dir: string) => {
            mockMkDirCalls.push(dir);
            if (overrides.mkDirThrows) throw new Error(overrides.mkDirThrows);
          },
          updateNetworkPolicy: async (policy: unknown) => {
            mockUpdateNetworkPolicyCalls.push(policy);
            if (overrides.updateNetworkPolicyThrows) throw new Error(overrides.updateNetworkPolicyThrows);
          },
          stop: async () => { mockStopCalls++; },
        };
      },
    },
  }));
}

async function freshBackend() {
  const mod = await import("@atlas/api/lib/tools/python-sandbox");
  return mod.createPythonSandboxBackend();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPythonSandboxBackend", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setupSandboxMock();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("creates sandbox with python3.13 runtime, installs packages, then locks to deny-all", async () => {
    setupSandboxMock({
      stdoutForMarker: (m) => `${m}{"success":true,"output":"hello"}\n`,
    });

    const backend = await freshBackend();
    const result = await backend.exec('print("hello")');

    // Sandbox created with allow-all (for pip)
    expect(mockCreateCalls.length).toBe(1);
    const createOpts = mockCreateCalls[0] as { runtime: string; networkPolicy: string };
    expect(createOpts.runtime).toBe("python3.13");
    expect(createOpts.networkPolicy).toBe("allow-all");

    // Network locked down to deny-all after pip install
    expect(mockUpdateNetworkPolicyCalls).toEqual(["deny-all"]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("hello");
    }
  });

  it("writes wrapper, user code, and data files to sandbox", async () => {
    setupSandboxMock();
    const backend = await freshBackend();

    const data = { columns: ["a", "b"], rows: [[1, 2], [3, 4]] };
    await backend.exec("print(df.head())", data);

    expect(mockWriteFilesCalls.length).toBe(1);
    const files = mockWriteFilesCalls[0];
    expect(files.length).toBe(3);

    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes("wrapper.py"))).toBe(true);
    expect(paths.some((p) => p.includes("user_code.py"))).toBe(true);
    expect(paths.some((p) => p.includes("data.json"))).toBe(true);

    const dataFile = files.find((f) => f.path.includes("data.json"))!;
    const parsed = JSON.parse(dataFile.content.toString());
    expect(parsed.columns).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([[1, 2], [3, 4]]);
  });

  it("omits data file when no data provided", async () => {
    setupSandboxMock();
    const backend = await freshBackend();
    await backend.exec("print(1)");

    expect(mockWriteFilesCalls.length).toBe(1);
    const files = mockWriteFilesCalls[0];
    expect(files.length).toBe(2);
    expect(files.some((f) => f.path.includes("data.json"))).toBe(false);
  });

  it("passes correct env vars to runCommand with no secrets", async () => {
    setupSandboxMock();
    const backend = await freshBackend();
    await backend.exec("print(1)");

    expect(mockRunCommandCalls.length).toBe(1);
    const params = mockRunCommandCalls[0];

    expect(params.cmd).toBe("python3");
    expect(params.env?.MPLBACKEND).toBe("Agg");
    expect(params.env?.ATLAS_RESULT_MARKER).toBeDefined();
    expect(params.env?.ATLAS_CHART_DIR).toContain("charts");

    // No secrets
    expect(params.env).not.toHaveProperty("ATLAS_DATASOURCE_URL");
    expect(params.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(params.env).not.toHaveProperty("DATABASE_URL");
  });

  it("reuses sandbox across multiple exec calls", async () => {
    setupSandboxMock();
    const backend = await freshBackend();

    await backend.exec("print(1)");
    await backend.exec("print(2)");

    // Sandbox.create called only once
    expect(mockCreateCalls.length).toBe(1);
    // But runCommand called twice
    expect(mockRunCommandCalls.length).toBe(2);
  });

  it("invalidation stops old sandbox and creates fresh one on next call", async () => {
    // First call uses a sandbox that errors on runCommand
    setupSandboxMock({ runCommandThrows: "VM crashed" });
    const backend = await freshBackend();

    const result1 = await backend.exec("print(1)");
    expect(result1.success).toBe(false);

    // Invalidation should have stopped the old sandbox
    // Give the async stop a tick to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(mockStopCalls).toBeGreaterThanOrEqual(1);

    // Next call should create a fresh sandbox
    setupSandboxMock(); // Reset to working sandbox
    const result2 = await backend.exec("print(2)");
    expect(mockCreateCalls.length).toBe(1); // New sandbox created
  });

  it("returns error when sandbox creation fails", async () => {
    setupSandboxMock({ createError: "quota exceeded" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("quota exceeded");
    }
  });

  it("returns error when mkDir fails and invalidates sandbox", async () => {
    setupSandboxMock({ mkDirThrows: "permission denied" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("permission denied");
    }
  });

  it("returns error when writeFiles fails", async () => {
    setupSandboxMock({ writeFilesThrows: "disk full" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("disk full");
    }
  });

  it("returns error when runCommand fails", async () => {
    setupSandboxMock({ runCommandThrows: "VM crashed" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("VM crashed");
    }
  });

  it("returns error when updateNetworkPolicy fails and stops sandbox", async () => {
    setupSandboxMock({ updateNetworkPolicyThrows: "policy update failed" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("lock down sandbox network");
    }
    // Should have stopped the sandbox on failure
    expect(mockStopCalls).toBeGreaterThanOrEqual(1);
  });

  it("handles SIGKILL exit code", async () => {
    setupSandboxMock({
      injectMarker: false,
      runCommandResult: { exitCode: 137, stdout: "", stderr: "" },
    });
    const backend = await freshBackend();
    const result = await backend.exec("while True: pass");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("killed");
    }
  });

  it("handles SIGSEGV exit code with stderr", async () => {
    setupSandboxMock({
      injectMarker: false,
      runCommandResult: { exitCode: 139, stdout: "", stderr: "Segfault in numpy" },
    });
    const backend = await freshBackend();
    const result = await backend.exec("bad code");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("SIGSEGV");
      expect(result.error).toContain("Segfault in numpy");
    }
  });

  it("returns stderr as error when no result marker and non-zero exit", async () => {
    setupSandboxMock({
      injectMarker: false,
      runCommandResult: { exitCode: 1, stdout: "some output", stderr: "NameError: name 'foo' is not defined" },
    });
    const backend = await freshBackend();
    const result = await backend.exec("print(foo)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("NameError");
    }
  });

  it("rejects output exceeding 1 MB", async () => {
    const bigOutput = "x".repeat(1024 * 1024 + 1);
    setupSandboxMock({
      injectMarker: false,
      runCommandResult: { exitCode: 0, stdout: bigOutput, stderr: "" },
    });
    const backend = await freshBackend();
    const result = await backend.exec("print('a' * 10000000)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exceeded 1 MB");
    }
  });

  it("scrubs sensitive data from error messages", async () => {
    setupSandboxMock({ mkDirThrows: "Error connecting to postgresql://user:pass@host/db" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toContain("postgresql://");
      expect(result.error).toContain("details in server logs");
    }
  });

  it("continues without packages when pip install fails", async () => {
    setupSandboxMock({ pipExitCode: 1, pipStderr: "network error" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    // Should still succeed — pip failure is non-fatal
    expect(result.success).toBe(true);
  });

  it("continues without packages when pip install throws", async () => {
    setupSandboxMock({ pipThrows: "command not found" });
    const backend = await freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(true);
  });
});
