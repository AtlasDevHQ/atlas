import { describe, test, expect, mock, beforeEach } from "bun:test";
import { definePlugin, isSandboxPlugin } from "@useatlas/plugin-sdk";
import {
  nsjailSandboxPlugin,
  buildNsjailSandboxPlugin,
  findNsjailBinary,
} from "../index";
import type { AtlasSandboxPlugin } from "@useatlas/plugin-sdk";

// Zod defaults make timeLimitSec/memoryLimitMb required in the output type
// but optional at runtime. Tests that rely on defaults use `as any`.

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("accepts empty config (uses defaults)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.id).toBe("nsjail-sandbox");
    expect(plugin.type).toBe("sandbox");
    expect(plugin.config?.timeLimitSec).toBe(10);
    expect(plugin.config?.memoryLimitMb).toBe(256);
  });

  test("accepts custom time and memory limits", () => {
    const plugin = nsjailSandboxPlugin({
      timeLimitSec: 30,
      memoryLimitMb: 512,
    });
    expect(plugin.config?.timeLimitSec).toBe(30);
    expect(plugin.config?.memoryLimitMb).toBe(512);
  });

  test("accepts explicit nsjailPath", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({ nsjailPath: "/usr/local/bin/nsjail" } as any);
    expect(plugin.config?.nsjailPath).toBe("/usr/local/bin/nsjail");
  });

  test("rejects negative time limit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => nsjailSandboxPlugin({ timeLimitSec: -1 } as any)).toThrow();
  });

  test("rejects zero memory limit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => nsjailSandboxPlugin({ memoryLimitMb: 0 } as any)).toThrow();
  });

  test("rejects non-integer time limit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => nsjailSandboxPlugin({ timeLimitSec: 1.5 } as any)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("createPlugin factory returns a valid plugin", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.id).toBe("nsjail-sandbox");
    expect(plugin.type).toBe("sandbox");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("nsjail Sandbox");
  });

  test("definePlugin accepts the built plugin", () => {
    const plugin = buildNsjailSandboxPlugin({
      timeLimitSec: 10,
      memoryLimitMb: 256,
    });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isSandboxPlugin type guard passes", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("sandbox.priority is 75", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.sandbox.priority).toBe(75);
  });

  test("sandbox.create is a function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(typeof plugin.sandbox.create).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Security metadata
// ---------------------------------------------------------------------------

describe("security metadata", () => {
  test("declares network isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.security?.networkIsolation).toBe(true);
  });

  test("declares filesystem isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("declares unprivileged execution", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.security?.unprivilegedExecution).toBe(true);
  });

  test("provides human-readable description", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(plugin.security?.description).toContain("Linux namespace");
    expect(plugin.security?.description).toContain("nobody");
  });
});

// ---------------------------------------------------------------------------
// findNsjailBinary
// ---------------------------------------------------------------------------

describe("findNsjailBinary", () => {
  test("returns null when no explicit path and nsjail is not on PATH", () => {
    const result = findNsjailBinary("/nonexistent/path/to/nsjail");
    expect(result).toBeNull();
  });

  test("returns null for nonexistent explicit path", () => {
    const result = findNsjailBinary("/nonexistent/nsjail");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backend creation (mock — nsjail binary likely not available in CI)
// ---------------------------------------------------------------------------

describe("sandbox.create", () => {
  test("throws when nsjail binary not found", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({ nsjailPath: "/nonexistent/nsjail" } as any);
    expect(() => plugin.sandbox.create("/tmp")).toThrow("nsjail binary not found");
  });

  test("throws when semantic root is not readable", () => {
    // Only runs if nsjail is actually available
    const nsjailPath = findNsjailBinary();
    if (!nsjailPath) return; // Skip if nsjail is not installed

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({} as any);
    expect(() => plugin.sandbox.create("/nonexistent/semantic")).toThrow(
      "Semantic layer directory not readable",
    );
  });
});

// ---------------------------------------------------------------------------
// Health check (non-nsjail environments)
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  test("returns unhealthy when nsjail is not available", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({ nsjailPath: "/nonexistent/nsjail" } as any);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("nsjail binary not found");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs nsjail binary status", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = nsjailSandboxPlugin({ nsjailPath: "/nonexistent/nsjail" } as any);
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
    const warnMsg = logged.find((m) => m.level === "warn" && m.msg.includes("not found"));
    expect(warnMsg).toBeDefined();
  });
});
