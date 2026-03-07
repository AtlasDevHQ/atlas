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
  SENSITIVE_PATTERNS: /NEVER_MATCH/,
}));

// --- @vercel/sandbox mock ---

type RunCommandParams = {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
};

let mockCreateCalls: unknown[] = [];
let mockRunCommandCalls: RunCommandParams[] = [];
let mockWriteFilesCalls: { path: string; content: Buffer }[][] = [];
let mockMkDirCalls: string[] = [];
let mockStopCalls = 0;

let mockRunCommandResult: {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
};

let mockPipResult: {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
};

let mockCreateShouldFail = false;
let mockCreateError = "Sandbox creation failed";
let mockImportShouldFail = false;
let mockRunCommandShouldFail = false;
let mockRunCommandError = "runCommand failed";
let mockWriteFilesShouldFail = false;
let mockMkDirShouldFail = false;

function resetMocks() {
  mockCreateCalls = [];
  mockRunCommandCalls = [];
  mockWriteFilesCalls = [];
  mockMkDirCalls = [];
  mockStopCalls = 0;
  mockCreateShouldFail = false;
  mockCreateError = "Sandbox creation failed";
  mockImportShouldFail = false;
  mockRunCommandShouldFail = false;
  mockRunCommandError = "runCommand failed";
  mockWriteFilesShouldFail = false;
  mockMkDirShouldFail = false;

  // Default: successful result with no output
  mockRunCommandResult = {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  };

  mockPipResult = {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  };
}

resetMocks();

mock.module("@vercel/sandbox", () => ({
  Sandbox: {
    create: async (opts: unknown) => {
      mockCreateCalls.push(opts);
      if (mockCreateShouldFail) throw new Error(mockCreateError);
      return {
        runCommand: async (params: RunCommandParams) => {
          // pip install calls
          if (params.cmd === "pip") {
            return mockPipResult;
          }
          mockRunCommandCalls.push(params);
          if (mockRunCommandShouldFail) throw new Error(mockRunCommandError);
          // Inject result marker into stdout if env has it
          const marker = params.env?.ATLAS_RESULT_MARKER;
          if (marker && mockRunCommandResult.exitCode === 0) {
            const originalStdout = await mockRunCommandResult.stdout();
            // If stdout already contains the marker, use it as-is
            if (originalStdout.includes(marker)) {
              return mockRunCommandResult;
            }
          }
          return mockRunCommandResult;
        },
        writeFiles: async (files: { path: string; content: Buffer }[]) => {
          mockWriteFilesCalls.push(files);
          if (mockWriteFilesShouldFail) throw new Error("writeFiles failed");
        },
        mkDir: async (dir: string) => {
          mockMkDirCalls.push(dir);
          if (mockMkDirShouldFail) throw new Error("mkDir failed");
        },
        stop: async () => {
          mockStopCalls++;
        },
      };
    },
  },
}));

const { createPythonSandboxBackend } = await import("@atlas/api/lib/tools/python-sandbox");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPythonSandboxBackend", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("creates a sandbox with python3.13 runtime and deny-all network", async () => {
    // Set up a result marker-aware response
    mockRunCommandResult = {
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    };

    // Override to capture the marker dynamically
    const backend = createPythonSandboxBackend();

    // We need to intercept the actual call to get the marker
    const originalModule = await import("@vercel/sandbox");
    const origCreate = originalModule.Sandbox.create;

    let capturedMarker = "";
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async (opts: unknown) => {
          mockCreateCalls.push(opts);
          return {
            runCommand: async (params: RunCommandParams) => {
              if (params.cmd === "pip") return mockPipResult;
              mockRunCommandCalls.push(params);
              capturedMarker = params.env?.ATLAS_RESULT_MARKER ?? "";
              return {
                exitCode: 0,
                stdout: async () => `${capturedMarker}{"success":true,"output":"hello"}\n`,
                stderr: async () => "",
              };
            },
            writeFiles: async (files: { path: string; content: Buffer }[]) => {
              mockWriteFilesCalls.push(files);
            },
            mkDir: async (dir: string) => {
              mockMkDirCalls.push(dir);
            },
            stop: async () => { mockStopCalls++; },
          };
        },
      },
    }));

    // Re-import to pick up new mock
    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend2 = freshBackend();
    const result = await backend2.exec('print("hello")');

    expect(mockCreateCalls.length).toBeGreaterThanOrEqual(1);
    const createOpts = mockCreateCalls[0] as { runtime: string; networkPolicy: string };
    expect(createOpts.runtime).toBe("python3.13");
    expect(createOpts.networkPolicy).toBe("deny-all");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("hello");
    }
  });

  it("writes wrapper, user code, and data files to sandbox", async () => {
    let capturedMarker = "";
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async (opts: unknown) => {
          mockCreateCalls.push(opts);
          return {
            runCommand: async (params: RunCommandParams) => {
              if (params.cmd === "pip") return mockPipResult;
              mockRunCommandCalls.push(params);
              capturedMarker = params.env?.ATLAS_RESULT_MARKER ?? "";
              return {
                exitCode: 0,
                stdout: async () => `${capturedMarker}{"success":true}\n`,
                stderr: async () => "",
              };
            },
            writeFiles: async (files: { path: string; content: Buffer }[]) => {
              mockWriteFilesCalls.push(files);
            },
            mkDir: async (dir: string) => { mockMkDirCalls.push(dir); },
            stop: async () => { mockStopCalls++; },
          };
        },
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();

    const data = { columns: ["a", "b"], rows: [[1, 2], [3, 4]] };
    await backend.exec("print(df.head())", data);

    // Should have written 3 files: wrapper, code, data
    expect(mockWriteFilesCalls.length).toBe(1);
    const files = mockWriteFilesCalls[0];
    expect(files.length).toBe(3);

    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes("wrapper.py"))).toBe(true);
    expect(paths.some((p) => p.includes("user_code.py"))).toBe(true);
    expect(paths.some((p) => p.includes("data.json"))).toBe(true);

    // Verify data content
    const dataFile = files.find((f) => f.path.includes("data.json"))!;
    const parsed = JSON.parse(dataFile.content.toString());
    expect(parsed.columns).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([[1, 2], [3, 4]]);
  });

  it("omits data file when no data provided", async () => {
    let capturedMarker = "";
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async (opts: unknown) => {
          mockCreateCalls.push(opts);
          return {
            runCommand: async (params: RunCommandParams) => {
              if (params.cmd === "pip") return mockPipResult;
              mockRunCommandCalls.push(params);
              capturedMarker = params.env?.ATLAS_RESULT_MARKER ?? "";
              return {
                exitCode: 0,
                stdout: async () => `${capturedMarker}{"success":true}\n`,
                stderr: async () => "",
              };
            },
            writeFiles: async (files: { path: string; content: Buffer }[]) => {
              mockWriteFilesCalls.push(files);
            },
            mkDir: async (dir: string) => { mockMkDirCalls.push(dir); },
            stop: async () => { mockStopCalls++; },
          };
        },
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    await backend.exec("print(1)");

    // Should have written 2 files: wrapper, code (no data)
    expect(mockWriteFilesCalls.length).toBe(1);
    const files = mockWriteFilesCalls[0];
    expect(files.length).toBe(2);
    expect(files.some((f) => f.path.includes("data.json"))).toBe(false);
  });

  it("passes correct env vars to runCommand", async () => {
    let capturedMarker = "";
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async (opts: unknown) => {
          mockCreateCalls.push(opts);
          return {
            runCommand: async (params: RunCommandParams) => {
              if (params.cmd === "pip") return mockPipResult;
              mockRunCommandCalls.push(params);
              capturedMarker = params.env?.ATLAS_RESULT_MARKER ?? "";
              return {
                exitCode: 0,
                stdout: async () => `${capturedMarker}{"success":true}\n`,
                stderr: async () => "",
              };
            },
            writeFiles: async (files: { path: string; content: Buffer }[]) => {
              mockWriteFilesCalls.push(files);
            },
            mkDir: async (dir: string) => { mockMkDirCalls.push(dir); },
            stop: async () => { mockStopCalls++; },
          };
        },
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
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

  it("returns error when sandbox creation fails", async () => {
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async () => {
          throw new Error("quota exceeded");
        },
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("quota exceeded");
    }
  });

  it("returns error when writeFiles fails", async () => {
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async () => ({
          runCommand: async (params: RunCommandParams) => {
            if (params.cmd === "pip") return mockPipResult;
            return mockRunCommandResult;
          },
          writeFiles: async () => {
            throw new Error("disk full");
          },
          mkDir: async () => {},
          stop: async () => {},
        }),
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("disk full");
    }
  });

  it("returns error when runCommand fails", async () => {
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async () => ({
          runCommand: async (params: RunCommandParams) => {
            if (params.cmd === "pip") return mockPipResult;
            throw new Error("VM crashed");
          },
          writeFiles: async () => {},
          mkDir: async () => {},
          stop: async () => {},
        }),
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("VM crashed");
    }
  });

  it("handles SIGKILL exit code", async () => {
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async () => ({
          runCommand: async (params: RunCommandParams) => {
            if (params.cmd === "pip") return mockPipResult;
            return {
              exitCode: 137,
              stdout: async () => "",
              stderr: async () => "",
            };
          },
          writeFiles: async () => {},
          mkDir: async () => {},
          stop: async () => {},
        }),
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    const result = await backend.exec("while True: pass");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("killed");
    }
  });

  it("handles SIGSEGV exit code with stderr", async () => {
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async () => ({
          runCommand: async (params: RunCommandParams) => {
            if (params.cmd === "pip") return mockPipResult;
            return {
              exitCode: 139,
              stdout: async () => "",
              stderr: async () => "Segfault in numpy",
            };
          },
          writeFiles: async () => {},
          mkDir: async () => {},
          stop: async () => {},
        }),
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    const result = await backend.exec("bad code");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("SIGSEGV");
      expect(result.error).toContain("Segfault in numpy");
    }
  });

  it("returns stderr as error when no result marker and non-zero exit", async () => {
    mock.module("@vercel/sandbox", () => ({
      Sandbox: {
        create: async () => ({
          runCommand: async (params: RunCommandParams) => {
            if (params.cmd === "pip") return mockPipResult;
            return {
              exitCode: 1,
              stdout: async () => "some output",
              stderr: async () => "NameError: name 'foo' is not defined",
            };
          },
          writeFiles: async () => {},
          mkDir: async () => {},
          stop: async () => {},
        }),
      },
    }));

    const { createPythonSandboxBackend: freshBackend } = await import("@atlas/api/lib/tools/python-sandbox");
    const backend = freshBackend();
    const result = await backend.exec("print(foo)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("NameError");
    }
  });
});
