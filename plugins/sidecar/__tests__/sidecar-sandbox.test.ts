import { describe, test, expect, mock, beforeEach } from "bun:test";
import { definePlugin, isSandboxPlugin } from "@useatlas/plugin-sdk";
import {
  sidecarSandboxPlugin,
  buildSidecarSandboxPlugin,
} from "../index";

// Zod defaults make timeoutMs required in the output type
// but optional at runtime. Tests that rely on defaults use `as any`.

const VALID_URL = "http://sandbox-sidecar:8080";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  test("valid URL accepted", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.id).toBe("sidecar-sandbox");
    expect(plugin.type).toBe("sandbox");
    expect(plugin.config?.url).toBe(VALID_URL);
  });

  test("invalid URL rejected", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => sidecarSandboxPlugin({ url: "not-a-url" } as any)).toThrow();
  });

  test("auth token optional", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.config?.authToken).toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withToken = sidecarSandboxPlugin({ url: VALID_URL, authToken: "secret" } as any);
    expect(withToken.config?.authToken).toBe("secret");
  });

  test("custom timeout accepted", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL, timeoutMs: 30000 } as any);
    expect(plugin.config?.timeoutMs).toBe(30000);
  });

  test("default timeout is 10000", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.config?.timeoutMs).toBe(10000);
  });

  test("rejects negative timeout", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => sidecarSandboxPlugin({ url: VALID_URL, timeoutMs: -1 } as any)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin shape", () => {
  test("factory returns valid plugin", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.id).toBe("sidecar-sandbox");
    expect(plugin.type).toBe("sandbox");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Sidecar Sandbox");
  });

  test("definePlugin accepts it", () => {
    const plugin = buildSidecarSandboxPlugin({
      url: VALID_URL,
      timeoutMs: 10000,
    });
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isSandboxPlugin passes", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(isSandboxPlugin(plugin)).toBe(true);
  });

  test("priority is 50", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.sandbox.priority).toBe(50);
  });

  test("sandbox.create is a function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(typeof plugin.sandbox.create).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Security metadata
// ---------------------------------------------------------------------------

describe("security metadata", () => {
  test("networkIsolation true", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.security?.networkIsolation).toBe(true);
  });

  test("filesystemIsolation true", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.security?.filesystemIsolation).toBe(true);
  });

  test("unprivilegedExecution true", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.security?.unprivilegedExecution).toBe(true);
  });

  test("description contains 'HTTP-isolated'", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    expect(plugin.security?.description).toContain("HTTP-isolated");
  });
});

// ---------------------------------------------------------------------------
// sandbox.create / exec
// ---------------------------------------------------------------------------

describe("sandbox.create / exec", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful exec returns parsed response", async () => {
    const mockResponse: Response = new Response(
      JSON.stringify({ stdout: "hello\n", stderr: "", exitCode: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");
    const result = await backend.exec("ls");

    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("connection refused throws", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch failed: ECONNREFUSED")),
    ) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");

    await expect(backend.exec("ls")).rejects.toThrow("Sidecar unreachable");
  });

  test("timeout returns exitCode 124", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("The operation timed out")),
    ) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");
    const result = await backend.exec("sleep 999");

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  test("HTTP 500 with exitCode JSON passes through", async () => {
    const body = JSON.stringify({ stdout: "", stderr: "command not found", exitCode: 127 });
    const mockResponse = new Response(body, { status: 500 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");
    const result = await backend.exec("bad-cmd");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("command not found");
  });

  test("HTTP 500 without exitCode returns generic error", async () => {
    const mockResponse = new Response("Internal Server Error", { status: 500 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");
    const result = await backend.exec("bad-cmd");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Sidecar error (HTTP 500)");
  });

  test("invalid response shape returns error", async () => {
    const mockResponse = new Response(
      JSON.stringify({ unexpected: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");
    const result = await backend.exec("ls");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unexpected response format");
  });

  test("sends auth token when configured", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockResponse = new Response(
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      capturedHeaders = { ...headers };
      return Promise.resolve(mockResponse);
    }) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL, authToken: "my-secret" } as any);
    const backend = await plugin.sandbox.create("/tmp/semantic");
    await backend.exec("ls");

    expect(capturedHeaders["Authorization"]).toBe("Bearer my-secret");
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("healthy response", async () => {
    const mockResponse = new Response("OK", { status: 200 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });

  test("unhealthy response", async () => {
    const mockResponse = new Response("Bad Gateway", { status: 502 });
    globalThis.fetch = mock(() => Promise.resolve(mockResponse)) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(false);
    expect(result.message).toContain("HTTP 502");
    expect(typeof result.latencyMs).toBe("number");
  });

  test("connection failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("fetch failed: ECONNREFUSED")),
    ) as unknown as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
    const result = await plugin.healthCheck!();

    expect(result.healthy).toBe(false);
    expect(result.message).toContain("ECONNREFUSED");
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("initialize", () => {
  test("logs sidecar URL", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = sidecarSandboxPlugin({ url: VALID_URL } as any);
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
    const infoMsg = logged.find((m) => m.level === "info" && m.msg.includes("sandbox-sidecar:8080"));
    expect(infoMsg).toBeDefined();
  });
});
