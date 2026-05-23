import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import crypto from "crypto";
import { definePlugin, isActionPlugin } from "@useatlas/plugin-sdk";
import { webhookActionPlugin, hmacSign, executeWebhookPost } from "../src/index";

const VALID_CONFIG = {
  url: "https://hooks.example.com/atlas",
  signing_secret: "test-secret-xyz",
} as const;

const originalFetch = globalThis.fetch;

let capturedFetchUrl = "";
let capturedFetchInit: RequestInit | undefined;
let fetchCallCount = 0;

function installFetchMock(response: { status: number; body?: unknown }) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = typeof input === "string" ? input : (input as Request).url;
    capturedFetchInit = init;
    fetchCallCount++;
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  capturedFetchUrl = "";
  capturedFetchInit = undefined;
  fetchCallCount = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("webhookActionPlugin — shape", () => {
  test("createPlugin() produces a valid AtlasActionPlugin", () => {
    const plugin = webhookActionPlugin(VALID_CONFIG);
    expect(plugin.id).toBe("webhook-action");
    expect(plugin.types).toEqual(["action"]);
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.name).toBe("Webhook Action");
    expect(plugin.actions).toHaveLength(1);
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = webhookActionPlugin(VALID_CONFIG);
    expect(definePlugin(plugin)).toBe(plugin);
  });

  test("isActionPlugin type guard returns true", () => {
    expect(isActionPlugin(webhookActionPlugin(VALID_CONFIG))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("webhookActionPlugin — config validation", () => {
  test("rejects empty signing_secret", () => {
    expect(() =>
      webhookActionPlugin({ url: "https://h.example.com", signing_secret: "" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects non-https url", () => {
    expect(() =>
      webhookActionPlugin({ url: "http://h.example.com", signing_secret: "x" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects malformed url", () => {
    expect(() =>
      webhookActionPlugin({ url: "not-a-url", signing_secret: "x" }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects invalid retry_policy", () => {
    expect(() =>
      webhookActionPlugin({
        url: "https://h.example.com",
        signing_secret: "x",
        retry_policy: "bogus" as never,
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("accepts minimal valid config", () => {
    expect(() => webhookActionPlugin(VALID_CONFIG)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Action metadata
// ---------------------------------------------------------------------------

describe("webhookActionPlugin — action metadata", () => {
  test("action has correct name and type", () => {
    const plugin = webhookActionPlugin(VALID_CONFIG);
    expect(plugin.actions[0].name).toBe("postWebhook");
    expect(plugin.actions[0].actionType).toBe("webhook:post");
    expect(plugin.actions[0].reversible).toBe(false);
    expect(plugin.actions[0].defaultApproval).toBe("admin-only");
    expect(plugin.actions[0].requiredCredentials).toEqual(["signing_secret"]);
  });
});

// ---------------------------------------------------------------------------
// HMAC signature
// ---------------------------------------------------------------------------

describe("hmacSign", () => {
  test("produces hex HMAC-SHA256 of body under secret", () => {
    const sig = hmacSign("secret-key", '{"hello":"world"}');
    const expected = crypto
      .createHmac("sha256", "secret-key")
      .update('{"hello":"world"}')
      .digest("hex");
    expect(sig).toBe(expected);
  });

  test("identical input produces identical signature (determinism)", () => {
    const a = hmacSign("k", "body");
    const b = hmacSign("k", "body");
    expect(a).toBe(b);
  });

  test("different secrets produce different signatures (key sensitivity)", () => {
    expect(hmacSign("k1", "body")).not.toBe(hmacSign("k2", "body"));
  });

  test("returns 64 hex chars (sha256 → 32 bytes → 64 hex)", () => {
    const sig = hmacSign("k", "body");
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// POST execution
// ---------------------------------------------------------------------------

describe("executeWebhookPost", () => {
  test("POSTs to the configured URL with signature header", async () => {
    installFetchMock({ status: 200 });
    const result = await executeWebhookPost(VALID_CONFIG, {
      payload: { event: "atlas.report", n: 42 },
    });
    expect(capturedFetchUrl).toBe("https://hooks.example.com/atlas");
    expect(capturedFetchInit?.method).toBe("POST");
    expect(result.status).toBe(200);

    const headers = capturedFetchInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const expectedSig = hmacSign(
      VALID_CONFIG.signing_secret,
      JSON.stringify({ event: "atlas.report", n: 42 }),
    );
    expect(headers["X-Atlas-Signature"]).toBe(expectedSig);
    expect(result.signature).toBe(expectedSig);
  });

  test("4xx surfaces immediately without retry", async () => {
    installFetchMock({ status: 422 });
    await expect(
      executeWebhookPost(VALID_CONFIG, { payload: {} }),
    ).rejects.toThrow(/HTTP 422/);
    expect(fetchCallCount).toBe(1);
  });

  test("retry_policy: none — does not retry on 5xx", async () => {
    installFetchMock({ status: 503 });
    await expect(
      executeWebhookPost({ ...VALID_CONFIG, retry_policy: "none" }, { payload: {} }),
    ).rejects.toThrow();
    expect(fetchCallCount).toBe(1);
  });

  test("payload is JSON-stringified before signing", async () => {
    installFetchMock({ status: 200 });
    const payload = { a: 1, b: [2, 3] };
    await executeWebhookPost(VALID_CONFIG, { payload });
    expect(capturedFetchInit?.body).toBe(JSON.stringify(payload));
  });
});

// ---------------------------------------------------------------------------
// AI SDK tool execution
// ---------------------------------------------------------------------------

describe("webhookActionPlugin — tool execution", () => {
  test("postWebhook tool POSTs payload and returns status + signature", async () => {
    installFetchMock({ status: 200 });
    const plugin = webhookActionPlugin(VALID_CONFIG);
    const aiTool = plugin.actions[0].tool as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    const result = (await aiTool.execute(
      { payload: { atlas: "test" } },
      { toolCallId: "test-call", messages: [], abortSignal: undefined as unknown as AbortSignal },
    )) as { status: number; signature: string };

    expect(result.status).toBe(200);
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedFetchUrl).toBe("https://hooks.example.com/atlas");
  });
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

describe("webhookActionPlugin — initialize", () => {
  test("logs initialization message without leaking secret", async () => {
    const plugin = webhookActionPlugin(VALID_CONFIG);
    const logged: string[] = [];
    const mockCtx = {
      db: null,
      connections: { get: () => ({}), list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: string) => logged.push(msg),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    };
    await plugin.initialize!(mockCtx as never);
    expect(logged.some((m) => m.includes("Webhook action plugin initialized"))).toBe(true);
    expect(logged.every((m) => !m.includes("test-secret-xyz"))).toBe(true);
  });
});
