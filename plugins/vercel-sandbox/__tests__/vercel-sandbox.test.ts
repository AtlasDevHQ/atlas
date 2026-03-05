import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @vercel/sandbox BEFORE importing the plugin (mock.module is hoisted)
// ---------------------------------------------------------------------------

const mockRunCommand = mock((_opts?: Record<string, unknown>) =>
  Promise.resolve({
    stdout: () => Promise.resolve("vercel-ok\n"),
    stderr: () => Promise.resolve(""),
    exitCode: 0,
  }),
);
const mockStop = mock(() => Promise.resolve());
const mockMkDir = mock(() => Promise.resolve());
const mockWriteFiles = mock(() => Promise.resolve());

const mockSandboxInstance = {
  runCommand: mockRunCommand,
  stop: mockStop,
  mkDir: mockMkDir,
  writeFiles: mockWriteFiles,
};

const mockCreate = mock((_opts?: Record<string, unknown>) => Promise.resolve(mockSandboxInstance));

mock.module("@vercel/sandbox", () => ({
  Sandbox: { create: mockCreate },
}));

// Import plugin AFTER mocking
import { definePlugin, isSandboxPlugin } from "@useatlas/plugin-sdk";
import {
  vercelSandboxPlugin,
  buildVercelSandboxPlugin,
  sandboxErrorDetail,
  collectSemanticFiles,
} from "../index";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts empty config (auto-detected OIDC)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.id).toBe("vercel-sandbox");
    expect(plugin.type).toBe("sandbox");
  });

  test("rejects accessToken without teamId", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => vercelSandboxPlugin({ accessToken: "tok_123" } as any)).toThrow(
      /teamId is required/,
    );
  });

  test("accepts accessToken with teamId", () => {
    const plugin = vercelSandboxPlugin({
      accessToken: "tok_123",
      teamId: "team_abc",
    });
    expect(plugin.config?.accessToken).toBe("tok_123");
    expect(plugin.config?.teamId).toBe("team_abc");
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.id).toBe("vercel-sandbox");
    expect(plugin.type).toBe("sandbox");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Vercel Sandbox");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildVercelSandboxPlugin({});
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isSandboxPlugin type guard passes", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("sandbox.priority is 100", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.sandbox.priority).toBe(100);
  });

  test("sandbox.create is a function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(typeof plugin.sandbox.create).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Security metadata
// ---------------------------------------------------------------------------

describe("security metadata", () => {
  test("declares network isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.security?.networkIsolation).toBe(true);
  });

  test("declares filesystem isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("declares unprivileged execution as false", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.security?.unprivilegedExecution).toBe(false);
  });

  test("description mentions Firecracker", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    expect(plugin.security?.description).toContain("Firecracker");
  });
});

// ---------------------------------------------------------------------------
// sandbox.create / error handling
// ---------------------------------------------------------------------------

describe("sandbox.create / error handling", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockRunCommand.mockClear();
    mockStop.mockClear();
    mockMkDir.mockClear();
    mockWriteFiles.mockClear();
    // Restore default implementations
    mockCreate.mockImplementation(() => Promise.resolve(mockSandboxInstance));
    mockRunCommand.mockImplementation(() =>
      Promise.resolve({
        stdout: () => Promise.resolve("vercel-ok\n"),
        stderr: () => Promise.resolve(""),
        exitCode: 0,
      }),
    );
  });

  test("sandbox.create calls Sandbox.create", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    // Will fail on file collection (no real semantic dir), but Sandbox.create should be called
    try {
      await plugin.sandbox.create("/nonexistent/semantic");
    } catch {
      // Expected — no semantic files
    }
    expect(mockCreate).toHaveBeenCalled();
    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.runtime).toBe("node24");
    expect(callArgs.networkPolicy).toBe("deny-all");
  });

  test("sandbox.create passes accessToken and teamId when configured", async () => {
    const plugin = vercelSandboxPlugin({
      accessToken: "tok_test",
      teamId: "team_test",
    });
    try {
      await plugin.sandbox.create("/nonexistent/semantic");
    } catch {
      // Expected — no semantic files
    }
    expect(mockCreate).toHaveBeenCalled();
    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.accessToken).toBe("tok_test");
    expect(callArgs.teamId).toBe("team_test");
  });

  test("exec delegates to runCommand", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);

    // Create a temp dir with a file so collectSemanticFiles succeeds
    const tmpDir = `/tmp/vercel-sandbox-test-${Date.now()}`;
    const { mkdirSync, writeFileSync, rmSync } = await import("fs");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/test.yml`, "table: test\n");

    try {
      const backend = await plugin.sandbox.create(tmpDir);
      const result = await backend.exec("ls -la");
      expect(mockRunCommand).toHaveBeenCalled();
      const args = mockRunCommand.mock.calls[0][0] as Record<string, unknown>;
      expect(args.cmd).toBe("sh");
      expect(args.args).toEqual(["-c", "ls -la"]);
      expect(args.cwd).toBe("/vercel/sandbox/semantic");
      expect(result.stdout).toContain("vercel-ok");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("close calls stop", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);

    const tmpDir = `/tmp/vercel-sandbox-test-${Date.now()}`;
    const { mkdirSync, writeFileSync, rmSync } = await import("fs");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(`${tmpDir}/test.yml`, "table: test\n");

    try {
      const backend = await plugin.sandbox.create(tmpDir);
      await backend.close!();
      expect(mockStop).toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("sandbox.create throws when no semantic files found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);

    const tmpDir = `/tmp/vercel-sandbox-empty-${Date.now()}`;
    const { mkdirSync, rmSync } = await import("fs");
    mkdirSync(tmpDir, { recursive: true });

    try {
      await expect(plugin.sandbox.create(tmpDir)).rejects.toThrow(
        "No semantic layer files found",
      );
      // Sandbox should be stopped on error
      expect(mockStop).toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sandboxErrorDetail
// ---------------------------------------------------------------------------

describe("sandboxErrorDetail", () => {
  test("returns string for non-Error", () => {
    expect(sandboxErrorDetail("plain string")).toBe("plain string");
  });

  test("returns message for plain Error", () => {
    expect(sandboxErrorDetail(new Error("something went wrong"))).toBe(
      "something went wrong",
    );
  });

  test("appends json field when present", () => {
    const err = new Error("API error");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).json = { code: "QUOTA_EXCEEDED" };
    expect(sandboxErrorDetail(err)).toContain("QUOTA_EXCEEDED");
  });

  test("appends text field when present", () => {
    const err = new Error("API error");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).text = "Internal Server Error";
    expect(sandboxErrorDetail(err)).toContain("Internal Server Error");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs OIDC mode when no accessToken", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    const logged: { level: string; msg: string }[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push({ level: "info", msg: String(args[0]) }); },
        warn: (...args: unknown[]) => { logged.push({ level: "warn", msg: String(args[0]) }); },
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const infoMsg = logged.find((m) => m.level === "info" && m.msg.includes("OIDC"));
    expect(infoMsg).toBeDefined();
  });

  test("logs access token mode when accessToken is set", async () => {
    const plugin = vercelSandboxPlugin({
      accessToken: "tok_123",
      teamId: "team_abc",
    });
    const logged: { level: string; msg: string }[] = [];
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("not implemented"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => { logged.push({ level: "info", msg: String(args[0]) }); },
        warn: (...args: unknown[]) => { logged.push({ level: "warn", msg: String(args[0]) }); },
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const infoMsg = logged.find((m) => m.level === "info" && m.msg.includes("access token"));
    expect(infoMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockRunCommand.mockClear();
    mockStop.mockClear();
    mockCreate.mockImplementation(() => Promise.resolve(mockSandboxInstance));
    mockRunCommand.mockImplementation(() =>
      Promise.resolve({
        stdout: () => Promise.resolve("vercel-ok\n"),
        stderr: () => Promise.resolve(""),
        exitCode: 0,
      }),
    );
  });

  test("returns healthy when sandbox echo succeeds", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockCreate).toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
  });

  test("returns unhealthy when Sandbox.create fails", async () => {
    mockCreate.mockImplementation(() => Promise.reject(new Error("quota exceeded")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("quota exceeded");
  });

  test("returns unhealthy when test command fails", async () => {
    mockRunCommand.mockImplementation(() =>
      Promise.resolve({
        stdout: () => Promise.resolve(""),
        stderr: () => Promise.resolve("error"),
        exitCode: 1,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = vercelSandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("exit 1");
  });
});
