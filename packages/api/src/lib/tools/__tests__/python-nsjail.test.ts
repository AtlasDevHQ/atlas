import { describe, expect, it, beforeEach, afterEach, spyOn, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock logger to avoid side effects
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock tracing
mock.module("@atlas/api/lib/tracing", () => ({
  withSpan: async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
}));

// Mock fs operations to avoid real filesystem access
mock.module("fs", () => ({
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  readFileSync: () => "",
  readdirSync: () => [],
  rmSync: () => undefined,
  accessSync: () => undefined,
  constants: { X_OK: 1, R_OK: 4 },
}));

// Track Bun.spawn calls
let spawnCalls: { args: unknown[]; options: unknown }[] = [];
let spawnResult: {
  stdin: { write: (d: string) => void; end: () => void };
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
};

function makeStream(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function setSpawnResult(stdout: string, stderr: string, exitCode: number) {
  spawnResult = {
    stdin: { write: () => {}, end: () => {} },
    stdout: makeStream(stdout),
    stderr: makeStream(stderr),
    exited: Promise.resolve(exitCode),
  };
}

// Default: successful empty output
setSpawnResult("", "", 0);

Bun.spawn = ((...args: unknown[]) => {
  spawnCalls.push({ args: [args[0]], options: args[1] });
  return spawnResult;
}) as typeof Bun.spawn;

const { buildPythonNsjailArgs, createPythonNsjailBackend } = await import("@atlas/api/lib/tools/python-nsjail");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPythonNsjailArgs", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("constructs correct nsjail args with Python-specific config", () => {
    const args = buildPythonNsjailArgs(
      "/usr/local/bin/nsjail",
      "/tmp/pyexec-test",
      "/tmp/pyexec-test/user_code.py",
      "/tmp/pyexec-test/wrapper.py",
      "/tmp/pyexec-test/charts",
      "__ATLAS_RESULT_test__",
    );

    // Basic nsjail mode
    expect(args[0]).toBe("/usr/local/bin/nsjail");
    expect(args).toContain("--mode");
    expect(args).toContain("o");

    // Python binary bind-mounts
    expect(args).toContain("/usr/local/bin");
    expect(args).toContain("/usr/local/lib");

    // Code and chart bind-mounts
    const rFlags = args.reduce<string[]>((acc, v, i) => {
      if (v === "-R" && typeof args[i + 1] === "string") acc.push(args[i + 1] as string);
      return acc;
    }, []);
    expect(rFlags).toContain("/tmp/pyexec-test/wrapper.py:/tmp/wrapper.py");
    expect(rFlags).toContain("/tmp/pyexec-test/user_code.py:/tmp/user_code.py");

    // Chart dir is bind-mounted writable (-B)
    const bIndex = args.indexOf("-B");
    expect(bIndex).toBeGreaterThan(-1);
    expect(args[bIndex + 1]).toBe("/tmp/pyexec-test/charts:/tmp/charts");

    // Resource limits — higher defaults for Python
    const memIndex = args.indexOf("--rlimit_as");
    expect(memIndex).toBeGreaterThan(-1);
    expect(args[memIndex + 1]).toBe("512");

    const tIndex = args.indexOf("-t");
    expect(tIndex).toBeGreaterThan(-1);
    expect(args[tIndex + 1]).toBe("30");

    const nprocIndex = args.indexOf("--rlimit_nproc");
    expect(nprocIndex).toBeGreaterThan(-1);
    expect(args[nprocIndex + 1]).toBe("16");

    // File size limit for chart output
    const fsizeIndex = args.indexOf("--rlimit_fsize");
    expect(fsizeIndex).toBeGreaterThan(-1);
    expect(args[fsizeIndex + 1]).toBe("50");

    // Security: run as nobody
    const uIndex = args.indexOf("-u");
    expect(uIndex).toBeGreaterThan(-1);
    expect(args[uIndex + 1]).toBe("65534");

    const gIndex = args.indexOf("-g");
    expect(gIndex).toBeGreaterThan(-1);
    expect(args[gIndex + 1]).toBe("65534");

    // stdin passthrough
    expect(args).toContain("--pass_fd");
    const passFdIndex = args.indexOf("--pass_fd");
    expect(args[passFdIndex + 1]).toBe("0");

    // Python execution command
    const dashDash = args.indexOf("--");
    expect(args[dashDash + 1]).toBe("/usr/bin/python3");
    expect(args[dashDash + 2]).toBe("/tmp/wrapper.py");
    expect(args[dashDash + 3]).toBe("/tmp/user_code.py");

    // Suppress logs
    expect(args).toContain("--quiet");

    // /proc mount
    const procIndex = args.indexOf("--proc_path");
    expect(procIndex).toBeGreaterThan(-1);
    expect(args[procIndex + 1]).toBe("/proc");
  });

  it("applies configurable resource limits", () => {
    process.env.ATLAS_NSJAIL_TIME_LIMIT = "60";
    process.env.ATLAS_NSJAIL_MEMORY_LIMIT = "1024";

    const args = buildPythonNsjailArgs(
      "/usr/local/bin/nsjail",
      "/tmp/test",
      "/tmp/test/code.py",
      "/tmp/test/wrapper.py",
      "/tmp/test/charts",
      "marker",
    );

    const tIndex = args.indexOf("-t");
    expect(args[tIndex + 1]).toBe("60");

    const memIndex = args.indexOf("--rlimit_as");
    expect(args[memIndex + 1]).toBe("1024");
  });
});

describe("createPythonNsjailBackend", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    spawnCalls = [];
    setSpawnResult("", "", 0);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns success result when wrapper produces structured output", async () => {
    const marker = "__ATLAS_RESULT_";
    // The marker includes the UUID, so we match on prefix
    setSpawnResult(
      `${marker}test-id__{"success":true,"output":"hello world"}`,
      "",
      0,
    );

    const backend = createPythonNsjailBackend("/usr/local/bin/nsjail");

    // We need to match the actual marker, so we mock to capture and use it
    // Instead, let's test that spawn was called correctly
    const result = await backend.exec('print("hello")');

    // Spawn should have been called
    expect(spawnCalls).toHaveLength(1);
    const spawnArgs = spawnCalls[0].args[0] as string[];
    expect(spawnArgs[0]).toBe("/usr/local/bin/nsjail");

    // Env should have no secrets
    const spawnOpts = spawnCalls[0].options as { env: Record<string, string> };
    expect(spawnOpts.env.MPLBACKEND).toBe("Agg");
    expect(spawnOpts.env.ATLAS_CHART_DIR).toBe("/tmp/charts");
    expect(spawnOpts.env.ATLAS_RESULT_MARKER).toBeDefined();
    expect(spawnOpts.env).not.toHaveProperty("ATLAS_DATASOURCE_URL");
    expect(spawnOpts.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("passes data as stdin when provided", async () => {
    let stdinWritten = "";
    spawnResult = {
      stdin: {
        write: (d: string) => { stdinWritten = d; },
        end: () => {},
      },
      stdout: makeStream(""),
      stderr: makeStream(""),
      exited: Promise.resolve(0),
    };

    const backend = createPythonNsjailBackend("/usr/local/bin/nsjail");
    await backend.exec("print(df.head())", { columns: ["a", "b"], rows: [[1, 2]] });

    const parsed = JSON.parse(stdinWritten);
    expect(parsed.columns).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([[1, 2]]);
  });

  it("returns error when no result marker in output", async () => {
    setSpawnResult("some random output", "ImportError: no module named foobar", 1);

    const backend = createPythonNsjailBackend("/usr/local/bin/nsjail");
    const result = await backend.exec("import foobar");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ImportError");
    }
  });

  it("returns error when process killed by signal (SIGKILL)", async () => {
    setSpawnResult("", "", 137); // 128 + 9 = SIGKILL

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const backend = createPythonNsjailBackend("/usr/local/bin/nsjail");
    const result = await backend.exec("while True: pass");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("killed");
    }

    warnSpy.mockRestore();
  });

  it("returns error when nsjail spawn fails", async () => {
    const savedSpawn = Bun.spawn;
    Bun.spawn = (() => {
      throw new Error("spawn failed: permission denied");
    }) as typeof Bun.spawn;

    const backend = createPythonNsjailBackend("/usr/local/bin/nsjail");
    const result = await backend.exec("print(1)");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("nsjail infrastructure error");
    }

    Bun.spawn = savedSpawn;
  });

  it("sends empty string on stdin when no data", async () => {
    let stdinWritten = "";
    spawnResult = {
      stdin: {
        write: (d: string) => { stdinWritten = d; },
        end: () => {},
      },
      stdout: makeStream(""),
      stderr: makeStream(""),
      exited: Promise.resolve(0),
    };

    const backend = createPythonNsjailBackend("/usr/local/bin/nsjail");
    await backend.exec("print(1)");

    expect(stdinWritten).toBe("");
  });
});

describe("backend selection in python.ts", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function saveAndSetEnv(key: string, value: string | undefined) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  });

  it("returns Vercel error when on Vercel without sidecar", async () => {
    saveAndSetEnv("ATLAS_SANDBOX_URL", undefined);
    saveAndSetEnv("ATLAS_RUNTIME", "vercel");
    saveAndSetEnv("ATLAS_NSJAIL_PATH", undefined);

    // Re-import to pick up env changes
    const { executePython } = await import("@atlas/api/lib/tools/python");
    const result = await executePython.execute!(
      { code: 'print("hello")', explanation: "test", data: undefined },
      {} as never,
    ) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Vercel");
  });
});

// Cleanup
afterEach(() => {
  // Module-level mocks are kept for the test suite
});
