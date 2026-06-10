import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the railway SDK BEFORE importing the plugin (mock.module is hoisted)
// ---------------------------------------------------------------------------

const mockExec = mock((_command?: string, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    stdout: "railway-ok\n",
    stderr: "",
    exitCode: 0,
  }),
);
const mockDestroy = mock(() => Promise.resolve());

const mockSandboxInstance = {
  exec: mockExec,
  destroy: mockDestroy,
};

const mockCreate = mock((_opts?: Record<string, unknown>) =>
  Promise.resolve(mockSandboxInstance),
);

mock.module("railway", () => ({
  Sandbox: { create: mockCreate },
}));

// Import plugin AFTER mocking
import { definePlugin, isSandboxPlugin } from "@useatlas/plugin-sdk";
import {
  railwaySandboxPlugin,
  buildRailwaySandboxPlugin,
  buildUploadBatches,
} from "../src/index";

function resetMocks() {
  mockCreate.mockClear();
  mockExec.mockClear();
  mockDestroy.mockClear();
  mockCreate.mockImplementation(() => Promise.resolve(mockSandboxInstance));
  mockExec.mockImplementation(() =>
    Promise.resolve({ stdout: "railway-ok\n", stderr: "", exitCode: 0 }),
  );
  mockDestroy.mockImplementation(() => Promise.resolve());
}

async function withSemanticDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const tmpDir = `/tmp/railway-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { mkdirSync, writeFileSync, rmSync } = await import("fs");
  mkdirSync(`${tmpDir}/entities`, { recursive: true });
  writeFileSync(`${tmpDir}/glossary.yml`, "terms: []\n");
  writeFileSync(`${tmpDir}/entities/users.yml`, "table: users\n");
  try {
    return await fn(tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts empty config (env fallback)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.id).toBe("railway-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
  });

  test("accepts explicit token and environmentId", () => {
    const plugin = railwaySandboxPlugin({
      token: "rw_tok",
      environmentId: "env_abc",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(plugin.config?.token).toBe("rw_tok");
    expect(plugin.config?.environmentId).toBe("env_abc");
  });

  test("applies idleTimeoutMinutes and timeoutSec defaults", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.config?.idleTimeoutMinutes).toBe(10);
    expect(plugin.config?.timeoutSec).toBe(30);
  });

  test("rejects idleTimeoutMinutes outside 1-120", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => railwaySandboxPlugin({ idleTimeoutMinutes: 0 } as any)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => railwaySandboxPlugin({ idleTimeoutMinutes: 121 } as any)).toThrow();
  });

  test("rejects empty token", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => railwaySandboxPlugin({ token: "" } as any)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.id).toBe("railway-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Railway Sandbox");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildRailwaySandboxPlugin({
      idleTimeoutMinutes: 10,
      timeoutSec: 30,
    });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isSandboxPlugin type guard passes", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("sandbox.priority is 80", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.sandbox.priority).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Security metadata — Railway has no deny-all egress mode; the plugin must
// report that honestly (issue #3231 finding 1)
// ---------------------------------------------------------------------------

describe("security metadata", () => {
  test("declares networkIsolation FALSE (no deny-all egress mode)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.security?.networkIsolation).toBe(false);
  });

  test("declares filesystem isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("description documents the egress caveat", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.security?.description).toContain("egress");
    expect(plugin.security?.description).toContain("NOT blocked");
  });
});

// ---------------------------------------------------------------------------
// sandbox.create / upload / exec / close
// ---------------------------------------------------------------------------

describe("sandbox.create", () => {
  beforeEach(resetMocks);

  test("creates with ISOLATED network mode and idle backstop, never PRIVATE", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    expect(mockCreate).toHaveBeenCalled();
    const opts = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.networkIsolation).toBe("ISOLATED");
    expect(opts.idleTimeoutMinutes).toBe(10);
  });

  test("passes token and environmentId when configured", async () => {
    const plugin = railwaySandboxPlugin({
      token: "rw_test",
      environmentId: "env_test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    const opts = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.token).toBe("rw_test");
    expect(opts.environmentId).toBe("env_test");
  });

  test("omits token/environmentId when not configured (SDK env fallback)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    const opts = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect("token" in opts).toBe(false);
    expect("environmentId" in opts).toBe(false);
  });

  test("uploads the semantic tree via mkdir + base64 exec commands", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    const commands = mockExec.mock.calls.map((c) => String(c[0]));
    expect(commands[0]).toContain("mkdir -p");
    expect(commands[0]).toContain("'/atlas/semantic/entities'");
    const uploadCmd = commands.find((c) => c.includes("base64 -d"));
    expect(uploadCmd).toBeDefined();
    expect(uploadCmd).toContain("set -e");
    expect(uploadCmd).toContain("> '/atlas/semantic/entities/users.yml'");
    // payload is base64 of the file content
    expect(uploadCmd).toContain(Buffer.from("table: users\n").toString("base64"));
  });

  test("throws when no semantic files found — without creating a sandbox", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const tmpDir = `/tmp/railway-sandbox-empty-${Date.now()}`;
    const { mkdirSync, rmSync } = await import("fs");
    mkdirSync(tmpDir, { recursive: true });
    try {
      await expect(plugin.sandbox.create(tmpDir)).rejects.toThrow(
        "No semantic layer files found",
      );
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("destroys the sandbox when the upload fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    mockExec.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "disk full", exitCode: 1 }),
    );
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(
        /Failed to upload semantic files/,
      );
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  test("create failure surfaces the per-environment sandbox cap", async () => {
    mockCreate.mockImplementation(() =>
      Promise.reject(new Error("sandbox limit reached for environment")),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(/sandbox cap/);
    });
  });

  test("create failure without cap shape gives generic actionable error", async () => {
    mockCreate.mockImplementation(() =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(
        /Failed to create Railway sandbox: connect ECONNREFUSED/,
      );
    });
  });
});

describe("exec / close", () => {
  beforeEach(resetMocks);

  test("exec runs the command in a child shell under the semantic dir", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      mockExec.mockClear();
      const result = await backend.exec("ls entities/");
      expect(mockExec).toHaveBeenCalledTimes(1);
      const [cmd, opts] = mockExec.mock.calls[0] as [string, Record<string, unknown>];
      expect(cmd).toContain("cd '/atlas/semantic' && sh -c 'ls entities/'");
      expect(opts.timeoutSec).toBe(30);
      expect(result.stdout).toContain("railway-ok");
      expect(result.exitCode).toBe(0);
    });
  });

  test("exec shell-quotes commands containing single quotes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      mockExec.mockClear();
      await backend.exec("grep 'users' glossary.yml");
      const cmd = String(mockExec.mock.calls[0][0]);
      expect(cmd).toContain(`sh -c 'grep '\\''users'\\'' glossary.yml'`);
    });
  });

  test("exec surfaces timeout and truncation flags in stderr", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      mockExec.mockImplementation(() =>
        Promise.resolve({
          stdout: "partial",
          stderr: "",
          exitCode: 1,
          timedOut: true,
          truncated: true,
        }),
      );
      const result = await backend.exec("find . -name '*.yml'");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("timed out after 30s");
      expect(result.stderr).toContain("truncated");
    });
  });

  test("exec returns error result when the SDK throws", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      mockExec.mockImplementation(() =>
        Promise.reject(new Error("sandbox VM crashed")),
      );
      const result = await backend.exec("ls");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sandbox VM crashed");
      expect(result.stdout).toBe("");
      // Sandbox is NOT destroyed on exec error — close() owns the lifecycle
      expect(mockDestroy).not.toHaveBeenCalled();
    });
  });

  test("close destroys the sandbox", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      await backend.close!();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });

  test("close swallows (but logs) destroy failures", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      mockDestroy.mockImplementation(() =>
        Promise.reject(new Error("already destroyed")),
      );
      await backend.close!(); // must not throw
    });
  });
});

// ---------------------------------------------------------------------------
// Upload batching
// ---------------------------------------------------------------------------

describe("buildUploadBatches", () => {
  test("packs small files into one batch", () => {
    const files = [
      { path: "semantic/a.yml", content: Buffer.from("a") },
      { path: "semantic/b.yml", content: Buffer.from("b") },
    ];
    const batches = buildUploadBatches(files);
    expect(batches.length).toBe(1);
    expect(batches[0]).toStartWith("set -e\n");
    expect(batches[0]).toContain("'/atlas/semantic/a.yml'");
    expect(batches[0]).toContain("'/atlas/semantic/b.yml'");
  });

  test("splits when the batch size cap is exceeded", () => {
    // ~100KB raw → ~134KB base64 each (under the chunk cap); two files cannot
    // share one 180KB batch, so they land in two batches
    const big = Buffer.alloc(100_000, "x");
    const files = [
      { path: "semantic/a.yml", content: big },
      { path: "semantic/b.yml", content: big },
    ];
    const batches = buildUploadBatches(files);
    expect(batches.length).toBe(2);
  });

  test("chunks a single file whose base64 exceeds the cap across > and >> appends", () => {
    // 150KB raw → 200KB base64 → must split into 160KB + 40KB chunks; no
    // single command may exceed the batch cap
    const big = Buffer.alloc(150_000, "x");
    const batches = buildUploadBatches([{ path: "semantic/huge.yml", content: big }]);
    const lines = batches.flatMap((b) => b.split("\n")).filter((l) => l.includes("base64 -d"));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("base64 -d > '/atlas/semantic/huge.yml'");
    expect(lines[1]).toContain("base64 -d >> '/atlas/semantic/huge.yml'");
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(180_000 + 100);
    }
    // The chunks reassemble to the original content
    const b64 = lines
      .map((l) => /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(l)?.[1] ?? "")
      .join("");
    expect(Buffer.from(b64, "base64").equals(big)).toBe(true);
  });

  test("quotes paths containing single quotes", () => {
    const files = [{ path: "semantic/it's.yml", content: Buffer.from("x") }];
    const batches = buildUploadBatches(files);
    expect(batches[0]).toContain(`'/atlas/semantic/it'\\''s.yml'`);
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

function makeCtx(logged: { level: string; msg: string }[]) {
  return {
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
}

describe("initialize", () => {
  test("logs env-fallback auth mode and the egress warning", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const logged: { level: string; msg: string }[] = [];
    await plugin.initialize!(makeCtx(logged));
    expect(logged.find((m) => m.level === "info" && m.msg.includes("env fallback"))).toBeDefined();
    expect(logged.find((m) => m.level === "warn" && m.msg.includes("egress"))).toBeDefined();
  });

  test("logs explicit-token auth mode when token is set", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({ token: "rw_tok", environmentId: "env_1" } as any);
    const logged: { level: string; msg: string }[] = [];
    await plugin.initialize!(makeCtx(logged));
    expect(logged.find((m) => m.level === "info" && m.msg.includes("explicit token"))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  beforeEach(resetMocks);

  test("returns healthy when sandbox echo succeeds, and destroys the sandbox", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockCreate).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();
    // Health-check sandboxes get the shortest idle backstop
    const opts = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.idleTimeoutMinutes).toBe(1);
    expect(opts.networkIsolation).toBe("ISOLATED");
  });

  test("returns unhealthy when Sandbox.create fails", async () => {
    mockCreate.mockImplementation(() => Promise.reject(new Error("quota exceeded")));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("quota exceeded");
  });

  test("returns unhealthy when the test command fails", async () => {
    mockExec.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "error", exitCode: 1 }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("exit 1");
    expect(mockDestroy).toHaveBeenCalled();
  });
});
