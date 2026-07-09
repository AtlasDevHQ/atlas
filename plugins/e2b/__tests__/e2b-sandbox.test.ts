import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Mock e2b SDK — must come before importing the plugin
// ---------------------------------------------------------------------------

const mockKill = mock(() => Promise.resolve());
const mockRun = mock(() =>
  Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 }),
);
const mockWriteFiles = mock(() => Promise.resolve());
const mockCreate = mock(() =>
  Promise.resolve({
    commands: { run: mockRun },
    files: { write: mockWriteFiles },
    kill: mockKill,
  }),
);

void mock.module("e2b", () => ({
  Sandbox: { create: mockCreate },
}));

// ---------------------------------------------------------------------------
// Imports (after mock)
// ---------------------------------------------------------------------------

import { definePlugin, isSandboxPlugin } from "@useatlas/plugin-sdk";
import { e2bSandboxPlugin, buildE2BSandboxPlugin } from "../src/index";

// Zod defaults make timeoutSec required in the output type but optional at
// runtime. Tests that rely on defaults use `as any`.

// Create an isolated temp directory for tests (avoids permission errors in /tmp)
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2b-sandbox-test-"));
afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("valid config accepted", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.id).toBe("e2b-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
    expect(plugin.config?.timeoutSec).toBe(30);
  });

  test("empty apiKey rejected", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => e2bSandboxPlugin({ apiKey: "" } as any)).toThrow();
  });

  test("custom template accepted", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k", template: "my-tmpl" } as any);
    expect(plugin.config?.template).toBe("my-tmpl");
  });

  test("custom timeout accepted", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k", timeoutSec: 60 } as any);
    expect(plugin.config?.timeoutSec).toBe(60);
  });

  test("rejects negative timeout", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => e2bSandboxPlugin({ apiKey: "k", timeoutSec: -1 } as any)).toThrow();
  });

  test("rejects zero timeout", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => e2bSandboxPlugin({ apiKey: "k", timeoutSec: 0 } as any)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("factory returns valid plugin", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(plugin.id).toBe("e2b-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("E2B Sandbox");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildE2BSandboxPlugin({
      apiKey: "k",
      timeoutSec: 30,
    });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isSandboxPlugin passes", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("priority is 90", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(plugin.sandbox.priority).toBe(90);
  });

  test("sandbox.create is a function", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(typeof plugin.sandbox.create).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Security metadata
// ---------------------------------------------------------------------------

describe("security metadata", () => {
  test("networkIsolation true", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(plugin.security?.networkIsolation).toBe(true);
  });

  test("filesystemIsolation true", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("unprivilegedExecution true", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(plugin.security?.unprivilegedExecution).toBe(true);
  });

  test("description contains E2B", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    expect(plugin.security?.description).toContain("E2B");
  });
});

// ---------------------------------------------------------------------------
// sandbox.create / exec
// ---------------------------------------------------------------------------

describe("sandbox.create / exec", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockRun.mockClear();
    mockWriteFiles.mockClear();
    mockKill.mockClear();
  });

  test("creates sandbox and uploads files", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    // Empty test dir — collectSemanticFiles finds no files, which is fine for testing the create flow
    const backend = await plugin.sandbox.create(testDir);
    expect(mockCreate).toHaveBeenCalled();
    expect(typeof backend.exec).toBe("function");
    expect(typeof backend.close).toBe("function");
  });

  test("exec delegates to commands.run", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(testDir);
    const result = await backend.exec("ls -la");
    expect(mockRun).toHaveBeenCalledWith("ls -la", {
      cwd: "/home/user/semantic",
      timeout: 30,
    });
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("exec handles errors gracefully", async () => {
    mockRun.mockImplementationOnce(() =>
      Promise.reject(new Error("command timed out")),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(testDir);
    const result = await backend.exec("sleep 999");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("command timed out");
  });

  test("close calls kill", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(testDir);
    await backend.close!();
    expect(mockKill).toHaveBeenCalled();
  });

  test("creates sandbox with template when configured", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key", template: "custom-tmpl" } as any);
    await plugin.sandbox.create(testDir);
    expect(mockCreate).toHaveBeenCalledWith({ apiKey: "test-key", template: "custom-tmpl" });
  });

  test("creates sandbox without template when not configured", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    await plugin.sandbox.create(testDir);
    expect(mockCreate).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  test("does not mutate process.env.E2B_API_KEY", async () => {
    const before = process.env.E2B_API_KEY;
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    await plugin.sandbox.create(testDir);
    expect(process.env.E2B_API_KEY).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockKill.mockClear();
  });

  test("returns healthy when sandbox creates and kills successfully", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "test-key" } as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(mockCreate).toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalled();
  });

  test("returns unhealthy when sandbox creation fails", async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.reject(new Error("API key invalid")),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "bad-key" } as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("API key invalid");
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs plugin readiness", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = e2bSandboxPlugin({ apiKey: "k" } as any);
    const logged: { level: string; msg: string }[] = [];
    const ctx = {
      db: null,
      connections: {
        get: () => {
          throw new Error("not implemented");
        },
        list: () => [],
        tables: () => [],
      },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) => {
          logged.push({ level: "info", msg: String(args[0]) });
        },
        warn: (...args: unknown[]) => {
          logged.push({ level: "warn", msg: String(args[0]) });
        },
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(ctx);
    const infoMsg = logged.find(
      (m) => m.level === "info" && m.msg.includes("E2B"),
    );
    expect(infoMsg).toBeDefined();
  });
});
