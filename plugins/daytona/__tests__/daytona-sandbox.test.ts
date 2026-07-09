import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { definePlugin, isSandboxPlugin } from "@useatlas/plugin-sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Create an isolated temp directory for tests (avoid /tmp permission errors)
// ---------------------------------------------------------------------------

const TEST_SEMANTIC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "daytona-test-"));
// Write a minimal semantic file so collectSemanticFiles has something to walk
fs.mkdirSync(path.join(TEST_SEMANTIC_ROOT, "entities"), { recursive: true });
fs.writeFileSync(
  path.join(TEST_SEMANTIC_ROOT, "entities", "test.yml"),
  "table: test\n",
);

afterAll(() => {
  fs.rmSync(TEST_SEMANTIC_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock @daytonaio/sdk BEFORE importing the plugin
// ---------------------------------------------------------------------------

const mockDelete = mock(() => Promise.resolve());
const mockExecuteCommand = mock(() =>
  Promise.resolve({ result: "ok", exitCode: 0 }),
);
const mockUploadFile = mock(() => Promise.resolve());
const mockCreate = mock(() =>
  Promise.resolve({
    process: { executeCommand: mockExecuteCommand },
    fs: { uploadFile: mockUploadFile },
  }),
);

const MockDaytona = mock(function () {
  return { create: mockCreate, delete: mockDelete };
});

void mock.module("@daytonaio/sdk", () => ({
  Daytona: MockDaytona,
}));
// Dual-package hazard (#3409): @daytonaio/sdk's exports map sends `import`
// to esm/index.js and `require` to cjs/index.js. The bare-specifier mock
// above registers against the import resolution, but the plugin loads the
// SDK with require() — when the real package is installed (it ships in the
// monorepo since #3409), that resolves the cjs file and BYPASSES the mock,
// silently turning these tests into live Daytona API calls. Mock the
// require resolution too. When the SDK isn't installed (standalone plugin
// checkout), the bare mock is a virtual module both loaders hit, and this
// second registration is unnecessary — hence the try/catch.
try {
  void mock.module(require.resolve("@daytonaio/sdk"), () => ({
    Daytona: MockDaytona,
  }));
} catch {
  // intentionally ignored: SDK not installed — the bare-specifier mock
  // above covers both import and require as a virtual module.
}

// Import AFTER mock is in place
const { daytonaSandboxPlugin, buildDaytonaSandboxPlugin } = await import(
  "../src/index"
);

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts valid config with apiKey", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.id).toBe("daytona-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
    expect(plugin.config?.timeoutSec).toBe(30);
  });

  test("rejects empty apiKey", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => daytonaSandboxPlugin({ apiKey: "" } as any)).toThrow();
  });

  test("accepts custom apiUrl", () => {
    const plugin = daytonaSandboxPlugin({
      apiKey: "test-key",
      apiUrl: "https://custom.daytona.io",
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(plugin.config?.apiUrl).toBe("https://custom.daytona.io");
  });

  test("accepts custom timeout", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key", timeoutSec: 60 } as any);
    expect(plugin.config?.timeoutSec).toBe(60);
  });

  test("rejects invalid URL", () => {
    expect(() =>
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      daytonaSandboxPlugin({ apiKey: "test-key", apiUrl: "not-a-url" } as any),
    ).toThrow();
  });

  test("rejects negative timeout", () => {
    expect(() =>
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      daytonaSandboxPlugin({ apiKey: "test-key", timeoutSec: -1 } as any),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.id).toBe("daytona-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Daytona Sandbox");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildDaytonaSandboxPlugin({
      apiKey: "test-key",
      timeoutSec: 30,
    });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isSandboxPlugin type guard passes", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("sandbox.priority is 85", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.sandbox.priority).toBe(85);
  });

  test("sandbox.create is a function", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(typeof plugin.sandbox.create).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Security metadata
// ---------------------------------------------------------------------------

describe("security metadata", () => {
  test("declares network isolation", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.security?.networkIsolation).toBe(true);
  });

  test("declares filesystem isolation", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("declares unprivileged execution", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.security?.unprivilegedExecution).toBe(true);
  });

  test("description contains Daytona", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    expect(plugin.security?.description).toContain("Daytona");
  });
});

// ---------------------------------------------------------------------------
// sandbox.create / exec / close
// ---------------------------------------------------------------------------

describe("sandbox.create / exec / close", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockDelete.mockClear();
    mockExecuteCommand.mockClear();
    mockUploadFile.mockClear();
    MockDaytona.mockClear();
  });

  test("creates a Daytona sandbox and uploads files", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(TEST_SEMANTIC_ROOT);
    expect(backend).toBeDefined();
    expect(typeof backend.exec).toBe("function");
    expect(typeof backend.close).toBe("function");
    expect(mockCreate).toHaveBeenCalled();
    expect(mockUploadFile).toHaveBeenCalled();
  });

  test("exec delegates to sandbox.process.executeCommand", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(TEST_SEMANTIC_ROOT);
    // Set mock after sandbox.create so the mkdir -p call during create doesn't consume it
    mockExecuteCommand.mockResolvedValueOnce({ result: "hello world", exitCode: 0 });
    const result = await backend.exec("echo hello world");
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("exec returns error on command failure", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(TEST_SEMANTIC_ROOT);
    // Override after sandbox.create consumed the default mock for its internal calls
    mockExecuteCommand.mockRejectedValueOnce(new Error("command timed out"));
    const result = await backend.exec("sleep 999");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("command timed out");
    expect(result.exitCode).toBe(1);
  });

  test("close calls daytona.delete", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(TEST_SEMANTIC_ROOT);
    await backend.close!();
    expect(mockDelete).toHaveBeenCalled();
  });

  test("close swallows errors", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const backend = await plugin.sandbox.create(TEST_SEMANTIC_ROOT);
    mockDelete.mockRejectedValueOnce(new Error("network error"));
    // Should not throw
    await backend.close!();
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockDelete.mockClear();
    mockExecuteCommand.mockClear();
    MockDaytona.mockClear();
  });

  test("returns healthy when sandbox echo succeeds", async () => {
    mockExecuteCommand.mockImplementation(() =>
      Promise.resolve({ result: "daytona-ok", exitCode: 0 }),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("returns unhealthy when sandbox creation fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("auth failed"));
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "bad-key" } as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("auth failed");
  });

  test("returns unhealthy when echo command fails", async () => {
    mockExecuteCommand.mockImplementation(() =>
      Promise.resolve({ result: "", exitCode: 1 }),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs plugin readiness", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = daytonaSandboxPlugin({ apiKey: "test-key" } as any);
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
      (m) => m.level === "info" && m.msg.includes("Daytona"),
    );
    expect(infoMsg).toBeDefined();
  });
});
