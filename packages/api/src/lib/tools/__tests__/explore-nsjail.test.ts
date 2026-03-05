import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track Bun.spawn calls
let spawnCalls: { args: unknown[]; options: unknown }[] = [];
let spawnResult: {
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

// Track callback invocations
let invalidateCalled = false;
let markFailedCalled = false;
const callbacks = {
  onInfrastructureError: () => {
    invalidateCalled = true;
  },
  onNsjailFailed: () => {
    markFailedCalled = true;
  },
};

import { isNsjailAvailable, createNsjailBackend, testNsjailCapabilities } from "@atlas/api/lib/tools/explore-nsjail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEMANTIC_ROOT = "/tmp/test-semantic";

function mockAccessSync(paths: Set<string>) {
  return spyOn(fs, "accessSync").mockImplementation((p: fs.PathLike) => {
    if (!paths.has(String(p))) {
      throw new Error(`ENOENT: ${p}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isNsjailAvailable", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns true when ATLAS_NSJAIL_PATH points to executable", () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(new Set(["/usr/local/bin/nsjail"]));
    expect(isNsjailAvailable()).toBe(true);
    spy.mockRestore();
  });

  it("returns false when ATLAS_NSJAIL_PATH points to missing binary", () => {
    process.env.ATLAS_NSJAIL_PATH = "/nonexistent/nsjail";
    const spy = mockAccessSync(new Set());
    expect(isNsjailAvailable()).toBe(false);
    spy.mockRestore();
  });

  it("searches PATH when ATLAS_NSJAIL_PATH is not set", () => {
    delete process.env.ATLAS_NSJAIL_PATH;
    process.env.PATH = "/usr/bin:/usr/local/bin";
    const spy = mockAccessSync(new Set(["/usr/local/bin/nsjail"]));
    expect(isNsjailAvailable()).toBe(true);
    spy.mockRestore();
  });

  it("returns false when nsjail not on PATH", () => {
    delete process.env.ATLAS_NSJAIL_PATH;
    process.env.PATH = "/usr/bin:/bin";
    const spy = mockAccessSync(new Set());
    expect(isNsjailAvailable()).toBe(false);
    spy.mockRestore();
  });
});

describe("createNsjailBackend", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when nsjail binary is not found", async () => {
    delete process.env.ATLAS_NSJAIL_PATH;
    process.env.PATH = "";
    const spy = mockAccessSync(new Set());

    await expect(createNsjailBackend(SEMANTIC_ROOT, callbacks)).rejects.toThrow(
      "nsjail binary not found",
    );
    spy.mockRestore();
  });

  it("throws when semantic root is not readable", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    // nsjail exists but semantic root doesn't
    const spy = mockAccessSync(new Set(["/usr/local/bin/nsjail"]));

    await expect(createNsjailBackend("/nonexistent/semantic", callbacks)).rejects.toThrow(
      "Semantic layer directory not readable",
    );
    spy.mockRestore();
  });
});

describe("exec", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    spawnCalls = [];
    invalidateCalled = false;
    markFailedCalled = false;
    setSpawnResult("", "", 0);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("constructs correct nsjail args", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    setSpawnResult("file1.yml\nfile2.yml\n", "", 0);
    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    const result = await backend.exec("ls");

    expect(result.stdout).toBe("file1.yml\nfile2.yml\n");
    expect(result.exitCode).toBe(0);

    // Verify spawn was called with nsjail args
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args[0] as string[];
    expect(args[0]).toBe("/usr/local/bin/nsjail");
    expect(args).toContain("--mode");
    expect(args).toContain("o");
    // Network namespace is on by default in current nsjail (no explicit flag needed)
    expect(args).not.toContain("--clone_newnet");
    expect(args).toContain("--quiet");
    expect(args).toContain("--cwd");
    expect(args).toContain("/semantic");

    // Verify semantic root is bind-mounted read-only
    const rIndex = args.indexOf("-R");
    expect(rIndex).toBeGreaterThan(-1);
    expect(args[rIndex + 1]).toBe(`${SEMANTIC_ROOT}:/semantic`);

    // Verify command is passed via bash -c
    const dashDash = args.indexOf("--");
    expect(args[dashDash + 1]).toBe("/bin/bash");
    expect(args[dashDash + 2]).toBe("-c");
    expect(args[dashDash + 3]).toBe("ls");

    // Verify default resource limits (no env overrides set)
    const tIndex = args.indexOf("-t");
    expect(tIndex).toBeGreaterThan(-1);
    expect(args[tIndex + 1]).toBe("10");

    const memIndex = args.indexOf("--rlimit_as");
    expect(memIndex).toBeGreaterThan(-1);
    expect(args[memIndex + 1]).toBe("256");

    // Verify security-critical args
    const uIndex = args.indexOf("-u");
    expect(uIndex).toBeGreaterThan(-1);
    expect(args[uIndex + 1]).toBe("65534");

    const gIndex = args.indexOf("-g");
    expect(gIndex).toBeGreaterThan(-1);
    expect(args[gIndex + 1]).toBe("65534");

    expect(args).toContain("--rlimit_fsize");
    expect(args).toContain("--rlimit_nproc");
    expect(args).toContain("--rlimit_nofile");

    // Verify /proc mount (--proc_path /proc)
    const procIndex = args.indexOf("--proc_path");
    expect(procIndex).toBeGreaterThan(-1);
    expect(args[procIndex + 1]).toBe("/proc");

    spy.mockRestore();
  });

  it("passes no secrets in env", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    process.env.ATLAS_DATASOURCE_URL = "postgresql://secret@host/db";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    await backend.exec("echo test");

    const spawnOptions = spawnCalls[0].options as { env: Record<string, string> };
    expect(spawnOptions.env).toEqual({
      PATH: "/bin:/usr/bin",
      HOME: "/tmp",
      LANG: "C.UTF-8",
    });

    // Verify secrets are NOT in env
    expect(spawnOptions.env).not.toHaveProperty("ATLAS_DATASOURCE_URL");
    expect(spawnOptions.env).not.toHaveProperty("ANTHROPIC_API_KEY");

    spy.mockRestore();
  });

  it("applies configurable resource limits", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    process.env.ATLAS_NSJAIL_TIME_LIMIT = "30";
    process.env.ATLAS_NSJAIL_MEMORY_LIMIT = "512";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    await backend.exec("cat file.yml");

    const args = spawnCalls[0].args[0] as string[];
    // Time limit
    const tIndex = args.indexOf("-t");
    expect(args[tIndex + 1]).toBe("30");
    // Memory limit
    const memIndex = args.indexOf("--rlimit_as");
    expect(args[memIndex + 1]).toBe("512");

    spy.mockRestore();
  });

  it("returns stderr and non-zero exit code", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    setSpawnResult("", "ls: cannot access '/foo': No such file\n", 1);
    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    const result = await backend.exec("ls /foo");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");

    spy.mockRestore();
  });

  it("calls invalidateExploreBackend on infrastructure error", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    // Make Bun.spawn throw
    const savedSpawn = Bun.spawn;
    Bun.spawn = (() => {
      throw new Error("spawn failed");
    }) as typeof Bun.spawn;

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    await expect(backend.exec("ls")).rejects.toThrow(
      "nsjail infrastructure error",
    );
    expect(invalidateCalled).toBe(true);

    // Restore
    Bun.spawn = savedSpawn;
    spy.mockRestore();
  });

  it("falls back to default time limit for NaN ATLAS_NSJAIL_TIME_LIMIT", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    process.env.ATLAS_NSJAIL_TIME_LIMIT = "not-a-number";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    await backend.exec("ls");

    const args = spawnCalls[0].args[0] as string[];
    const tIndex = args.indexOf("-t");
    expect(args[tIndex + 1]).toBe("10"); // default

    warnSpy.mockRestore();
    spy.mockRestore();
  });

  it("falls back to default time limit for negative ATLAS_NSJAIL_TIME_LIMIT", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    process.env.ATLAS_NSJAIL_TIME_LIMIT = "-5";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    await backend.exec("ls");

    const args = spawnCalls[0].args[0] as string[];
    const tIndex = args.indexOf("-t");
    expect(args[tIndex + 1]).toBe("10"); // default

    warnSpy.mockRestore();
    spy.mockRestore();
  });

  it("falls back to default memory limit for zero ATLAS_NSJAIL_MEMORY_LIMIT", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    process.env.ATLAS_NSJAIL_MEMORY_LIMIT = "0";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    await backend.exec("ls");

    const args = spawnCalls[0].args[0] as string[];
    const memIndex = args.indexOf("--rlimit_as");
    expect(args[memIndex + 1]).toBe("256"); // default

    warnSpy.mockRestore();
    spy.mockRestore();
  });

  it("calls markNsjailFailed on nsjail exit code 109", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    setSpawnResult("", "nsjail setup failure", 109);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    const result = await backend.exec("ls");

    expect(result.exitCode).toBe(109);
    expect(markFailedCalled).toBe(true);

    errorSpy.mockRestore();
    spy.mockRestore();
  });

  it("logs warning when child killed by signal (exit > 128)", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    // Exit code 137 = 128 + 9 (SIGKILL)
    setSpawnResult("", "", 137);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const backend = await createNsjailBackend(SEMANTIC_ROOT, callbacks);
    const result = await backend.exec("sleep 999");

    expect(result.exitCode).toBe(137);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("signal 9");

    warnSpy.mockRestore();
    spy.mockRestore();
  });
});

describe("testNsjailCapabilities", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    spawnCalls = [];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns ok when jail succeeds", async () => {
    process.env.ATLAS_NSJAIL_PATH = "/usr/local/bin/nsjail";
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    setSpawnResult("nsjail-ok\n", "", 0);
    const result = await testNsjailCapabilities("/usr/local/bin/nsjail", SEMANTIC_ROOT);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify it spawned nsjail with echo command
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args[0] as string[];
    expect(args[0]).toBe("/usr/local/bin/nsjail");
    // Network namespace is on by default in current nsjail (no explicit flag needed)
    expect(args).not.toContain("--clone_newnet");
    const dashDash = args.indexOf("--");
    expect(args[dashDash + 3]).toBe("echo nsjail-ok");

    spy.mockRestore();
  });

  it("returns error when jail fails (exit 109)", async () => {
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    setSpawnResult("", "namespace setup failed", 109);
    const result = await testNsjailCapabilities("/usr/local/bin/nsjail", SEMANTIC_ROOT);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("109");
    expect(result.error).toContain("namespace setup failed");

    spy.mockRestore();
  });

  it("returns error when spawn throws", async () => {
    const savedSpawn = Bun.spawn;
    Bun.spawn = (() => {
      throw new Error("spawn failed: permission denied");
    }) as typeof Bun.spawn;

    const result = await testNsjailCapabilities("/usr/local/bin/nsjail", SEMANTIC_ROOT);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("spawn failed");

    Bun.spawn = savedSpawn;
  });

  it("returns error when stdout does not contain marker", async () => {
    const spy = mockAccessSync(
      new Set(["/usr/local/bin/nsjail", SEMANTIC_ROOT]),
    );

    setSpawnResult("some other output", "", 0);
    const result = await testNsjailCapabilities("/usr/local/bin/nsjail", SEMANTIC_ROOT);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 0");

    spy.mockRestore();
  });
});

// Cleanup: restore original Bun.spawn after all tests
afterEach(() => {
  // The module-level Bun.spawn mock is intentionally kept for the test suite.
  // Individual tests that replace Bun.spawn restore it in their own cleanup.
});
