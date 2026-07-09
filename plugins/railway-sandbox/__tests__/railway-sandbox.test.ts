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
// Native sandbox.files API (railway >= 3.3.0) — the upload path writes each
// semantic file binary-safe via files.write and mkdir's the semantic root.
const mockWrite = mock((_path?: string, _content?: unknown) =>
  Promise.resolve(),
);
const mockMkdir = mock((_path?: string) => Promise.resolve());

const mockSandboxInstance = {
  exec: mockExec,
  destroy: mockDestroy,
  files: { write: mockWrite, mkdir: mockMkdir },
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
} from "../src/index";

function resetMocks() {
  mockCreate.mockClear();
  mockExec.mockClear();
  mockDestroy.mockClear();
  mockWrite.mockClear();
  mockMkdir.mockClear();
  mockCreate.mockImplementation(() => Promise.resolve(mockSandboxInstance));
  mockExec.mockImplementation(() =>
    Promise.resolve({ stdout: "railway-ok\n", stderr: "", exitCode: 0 }),
  );
  mockDestroy.mockImplementation(() => Promise.resolve());
  mockWrite.mockImplementation(() => Promise.resolve());
  mockMkdir.mockImplementation(() => Promise.resolve());
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.id).toBe("railway-sandbox");
    expect(plugin.types).toEqual(["sandbox"]);
  });

  test("accepts explicit token and environmentId", () => {
    const plugin = railwaySandboxPlugin({
      token: "rw_tok",
      environmentId: "env_abc",
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(plugin.config?.token).toBe("rw_tok");
    expect(plugin.config?.environmentId).toBe("env_abc");
  });

  test("applies idleTimeoutMinutes and timeoutSec defaults", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.config?.idleTimeoutMinutes).toBe(10);
    expect(plugin.config?.timeoutSec).toBe(30);
  });

  test("rejects idleTimeoutMinutes outside 1-120", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => railwaySandboxPlugin({ idleTimeoutMinutes: 0 } as any)).toThrow();
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => railwaySandboxPlugin({ idleTimeoutMinutes: 121 } as any)).toThrow();
  });

  test("rejects empty token", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => railwaySandboxPlugin({ token: "" } as any)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("sandbox.priority is 80", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.security?.networkIsolation).toBe(false);
  });

  test("declares filesystem isolation", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("description documents the egress caveat", () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    const opts = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.token).toBe("rw_test");
    expect(opts.environmentId).toBe("env_test");
  });

  test("omits token/environmentId when not configured (SDK env fallback)", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    const opts = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect("token" in opts).toBe(false);
    expect("environmentId" in opts).toBe(false);
  });

  test("uploads the semantic tree via files.mkdir + files.write (no shell)", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    // Record the interleaving of mkdir/write so we can assert ordering, not
    // just membership — the semantic root must be mkdir'd BEFORE any write so
    // the explore cwd exists even if files.write's auto-parent behavior changes.
    const order: string[] = [];
    mockMkdir.mockImplementation((p?: string) => {
      order.push(`mkdir:${p}`);
      return Promise.resolve();
    });
    mockWrite.mockImplementation((p?: string) => {
      order.push(`write:${p}`);
      return Promise.resolve();
    });
    await withSemanticDir(async (dir) => {
      await plugin.sandbox.create(dir);
    });
    // The semantic root is mkdir'd up front, before the first file write.
    expect(mockMkdir).toHaveBeenCalledWith("/atlas/semantic");
    const mkdirIdx = order.indexOf("mkdir:/atlas/semantic");
    const firstWriteIdx = order.findIndex((o) => o.startsWith("write:"));
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(firstWriteIdx).toBeGreaterThan(mkdirIdx);
    // Every collected file is written — exactly the two-file fixture, no drops.
    const writePaths = mockWrite.mock.calls.map((c) => String(c[0]));
    expect(writePaths.length).toBe(2);
    expect(writePaths).toContain("/atlas/semantic/glossary.yml");
    expect(writePaths).toContain("/atlas/semantic/entities/users.yml");
    const usersCall = mockWrite.mock.calls.find(
      (c) => c[0] === "/atlas/semantic/entities/users.yml",
    );
    expect(usersCall).toBeDefined();
    expect(Buffer.isBuffer(usersCall![1])).toBe(true);
    expect((usersCall![1] as Buffer).equals(Buffer.from("table: users\n"))).toBe(true);
    // The upload no longer touches the shell — no base64-over-exec.
    const execCmds = mockExec.mock.calls.map((c) => String(c[0]));
    expect(execCmds.some((c) => c.includes("base64"))).toBe(false);
  });

  test("writes binary-safe content unchanged (no base64 round-trip)", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const tmpDir = `/tmp/railway-sandbox-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { mkdirSync, writeFileSync, rmSync } = await import("fs");
    mkdirSync(`${tmpDir}/entities`, { recursive: true });
    // Bytes that are not valid UTF-8 — a base64-over-exec path could mangle these.
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x0a]);
    writeFileSync(`${tmpDir}/entities/blob.bin`, binary);
    writeFileSync(`${tmpDir}/glossary.yml`, "terms: []\n");
    try {
      await plugin.sandbox.create(tmpDir);
      const blobCall = mockWrite.mock.calls.find((c) =>
        String(c[0]).endsWith("blob.bin"),
      );
      expect(blobCall).toBeDefined();
      expect(Buffer.isBuffer(blobCall![1])).toBe(true);
      expect((blobCall![1] as Buffer).equals(binary)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws a clear error (and destroys the sandbox) when the files API is missing", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    // Simulate an older SDK whose Sandbox instance has no `files` surface.
    mockCreate.mockImplementation(() =>
      Promise.resolve({
        exec: mockExec,
        destroy: mockDestroy,
      } as unknown as typeof mockSandboxInstance),
    );
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(/railway >= 3\.3\.0/);
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  test("throws when no semantic files found — without creating a sandbox", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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

  test("skips symlinks targeting a prefix-collision sibling of the semantic root", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const base = `/tmp/railway-sandbox-prefix-${Date.now()}`;
    const { mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("fs");
    // `${base}/semantic_evil` shares the `${base}/semantic` string prefix —
    // a bare startsWith() containment check would accept it
    mkdirSync(`${base}/semantic`, { recursive: true });
    mkdirSync(`${base}/semantic_evil`, { recursive: true });
    writeFileSync(`${base}/semantic/real.yml`, "table: real\n");
    writeFileSync(`${base}/semantic_evil/secret.yml`, "secret: yes\n");
    symlinkSync(`${base}/semantic_evil/secret.yml`, `${base}/semantic/leak.yml`);
    try {
      await plugin.sandbox.create(`${base}/semantic`);
      const writePaths = mockWrite.mock.calls.map((c) => String(c[0]));
      const writeContents = mockWrite.mock.calls.map((c) =>
        Buffer.isBuffer(c[1]) ? (c[1] as Buffer).toString() : String(c[1]),
      );
      expect(writePaths.some((p) => p.endsWith("real.yml"))).toBe(true);
      expect(writePaths.some((p) => p.endsWith("leak.yml"))).toBe(false);
      expect(writeContents.some((c) => c.includes("secret: yes"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("destroys the sandbox when the upload fails", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    mockWrite.mockImplementation(() =>
      Promise.reject(new Error("disk full")),
    );
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(
        /Failed to upload semantic files/,
      );
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  test("destroys the sandbox when mkdir (not write) fails", async () => {
    // mkdir shares the upload guard with write — a mkdir rejection must take
    // the same Failed-to-upload → destroy path, proving mkdir is inside the
    // guarded block.
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    mockMkdir.mockImplementation(() =>
      Promise.reject(new Error("permission denied")),
    );
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(
        /Failed to upload semantic files/,
      );
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  test("redacts sensitive detail from an upload-failure message", async () => {
    // A files.write rejection whose message carries a credential must be
    // scrubbed before it reaches the caller (CLAUDE.md: no secrets in responses).
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    mockWrite.mockImplementation(() =>
      Promise.reject(new Error("upload rejected: token=rw_supersecret_abc123")),
    );
    await withSemanticDir(async (dir) => {
      let err: Error | null = null;
      try {
        await plugin.sandbox.create(dir);
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain("details in server logs");
      expect(err!.message).not.toContain("rw_supersecret_abc123");
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  test("create failure surfaces the per-environment sandbox cap", async () => {
    mockCreate.mockImplementation(() =>
      Promise.reject(new Error("sandbox limit reached for environment")),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      await expect(plugin.sandbox.create(dir)).rejects.toThrow(/sandbox cap/);
    });
  });

  test("create failure without cap shape gives generic actionable error", async () => {
    mockCreate.mockImplementation(() =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    await withSemanticDir(async (dir) => {
      const backend = await plugin.sandbox.create(dir);
      await backend.close!();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });

  test("close swallows (but logs) destroy failures", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const logged: { level: string; msg: string }[] = [];
    await plugin.initialize!(makeCtx(logged));
    expect(logged.find((m) => m.level === "info" && m.msg.includes("env fallback"))).toBeDefined();
    expect(logged.find((m) => m.level === "warn" && m.msg.includes("egress"))).toBeDefined();
  });

  test("logs explicit-token auth mode when token is set", async () => {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("quota exceeded");
  });

  test("returns unhealthy when the test command fails", async () => {
    mockExec.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "error", exitCode: 1 }),
    );
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = railwaySandboxPlugin({} as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("exit 1");
    expect(mockDestroy).toHaveBeenCalled();
  });
});
