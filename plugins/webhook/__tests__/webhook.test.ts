/**
 * Tests for the Webhook Interaction Plugin.
 *
 * Tests plugin shape, config validation, lifecycle, route behavior
 * (auth, sync/async modes, error cases), and integration payloads.
 */

import {
  describe,
  test,
  expect,
  mock,
  afterEach,
  type Mock,
} from "bun:test";
import crypto from "crypto";
import { Hono } from "hono";
import { definePlugin, isInteractionPlugin } from "@useatlas/plugin-sdk";
import { webhookPlugin, buildWebhookPlugin } from "../src/index";
import type { WebhookPluginConfig, WebhookQueryResult } from "../src/index";
import { createWebhookRoutes } from "../src/routes";
import { createChannelThrottle } from "../src/throttle";
import { createNonceCache } from "../src/replay";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = "wh-test-secret-123";

const defaultQueryResult: WebhookQueryResult = {
  answer: "42 active users",
  sql: ["SELECT COUNT(*) FROM users WHERE active = true"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
};

function createMockConfig(
  overrides?: Partial<WebhookPluginConfig>,
): WebhookPluginConfig {
  return {
    channels: [
      {
        channelId: "test-channel",
        authType: "api-key",
        secret: TEST_SECRET,
        responseFormat: "json",
      },
    ],
    executeQuery: mock(() =>
      Promise.resolve(defaultQueryResult),
    ) as WebhookPluginConfig["executeQuery"],
    ...overrides,
  };
}

function createMockCtx() {
  const logged: string[] = [];
  return {
    ctx: {
      db: null,
      connections: { get: () => ({}), list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) =>
          logged.push(
            typeof args[0] === "string" ? args[0] : String(args[1] ?? ""),
          ),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    },
    logged,
  };
}

/**
 * Builds an isolated Hono app with fresh throttle + nonce caches so tests
 * don't share state. Use this everywhere we exercise the route layer.
 */
function createTestApp(config: WebhookPluginConfig): Hono {
  const channelMap = new Map(config.channels.map((c) => [c.channelId, c]));
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const app = new Hono();
  app.route(
    "",
    createWebhookRoutes({
      channels: channelMap,
      log,
      executeQuery: config.executeQuery,
      replayMode: "strict",
      throttle: createChannelThrottle(),
      nonceCache: createNonceCache(),
    }),
  );
  return app;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hmacSign(secret: string, body: string, timestamp: number): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}:${body}`).digest("hex");
}

function hmacSignBodyOnly(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("webhookPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasInteractionPlugin", () => {
    const plugin = webhookPlugin(createMockConfig());
    expect(plugin.id).toBe("webhook-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Webhook");
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = webhookPlugin(createMockConfig());
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isInteractionPlugin type guard returns true", () => {
    const plugin = webhookPlugin(createMockConfig());
    expect(isInteractionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const config = createMockConfig();
    const plugin = webhookPlugin(config);
    expect(plugin.config?.channels).toHaveLength(1);
    expect(plugin.config?.channels[0].channelId).toBe("test-channel");
  });

  test("routes is defined", () => {
    const plugin = webhookPlugin(createMockConfig());
    expect(typeof plugin.routes).toBe("function");
  });

  test("buildWebhookPlugin is available for direct use", () => {
    const plugin = buildWebhookPlugin(createMockConfig());
    expect(plugin.id).toBe("webhook-interaction");
    expect(plugin.types).toEqual(["interaction"]);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("webhookPlugin — config validation", () => {
  test("accepts valid config with api-key auth", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          { channelId: "ch1", authType: "api-key", secret: "s", responseFormat: "json" },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("accepts valid config with hmac auth", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          { channelId: "ch1", authType: "hmac", secret: "s", responseFormat: "text" },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("accepts rateLimitRpm + concurrencyLimit overrides", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          {
            channelId: "ch1",
            authType: "api-key",
            secret: "s",
            responseFormat: "json",
            rateLimitRpm: 120,
            concurrencyLimit: 10,
          },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("rejects rateLimitRpm < 1", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          {
            channelId: "ch1",
            authType: "api-key",
            secret: "s",
            responseFormat: "json",
            rateLimitRpm: 0,
          },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty channels array", () => {
    expect(() =>
      webhookPlugin({
        channels: [],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty channelId", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          { channelId: "", authType: "api-key", secret: "s", responseFormat: "json" },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty secret", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          { channelId: "ch1", authType: "api-key", secret: "", responseFormat: "json" },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects non-function executeQuery", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          { channelId: "ch1", authType: "api-key", secret: "s", responseFormat: "json" },
        ],
        executeQuery: "not-a-function" as unknown as WebhookPluginConfig["executeQuery"],
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects duplicate channelIds", () => {
    expect(() =>
      webhookPlugin({
        channels: [
          { channelId: "same", authType: "api-key", secret: "s1", responseFormat: "json" },
          { channelId: "same", authType: "hmac", secret: "s2", responseFormat: "text" },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("buildWebhookPlugin rejects duplicate channelIds", () => {
    expect(() =>
      buildWebhookPlugin({
        channels: [
          { channelId: "dup", authType: "api-key", secret: "s1", responseFormat: "json" },
          { channelId: "dup", authType: "api-key", secret: "s2", responseFormat: "json" },
        ],
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow('Duplicate channelId "dup"');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("webhookPlugin — lifecycle", () => {
  test("initializes successfully", async () => {
    const plugin = webhookPlugin(createMockConfig());
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("initialized"))).toBe(true);
  });

  test("double initialize throws", async () => {
    const plugin = webhookPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await expect(plugin.initialize!(ctx as never)).rejects.toThrow(
      "already initialized",
    );
  });

  test("healthCheck returns unhealthy before init", async () => {
    const plugin = webhookPlugin(createMockConfig());
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("healthCheck returns healthy after init", async () => {
    const plugin = webhookPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  test("healthCheck returns unhealthy after teardown", async () => {
    const plugin = webhookPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("teardown is safe to call without initialization", async () => {
    const plugin = webhookPlugin(createMockConfig());
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("initialize logs channel count", async () => {
    const plugin = webhookPlugin(
      createMockConfig({
        channels: [
          { channelId: "a", authType: "api-key", secret: "s", responseFormat: "json" },
          { channelId: "b", authType: "hmac", secret: "s", responseFormat: "text" },
        ],
      }),
    );
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("2 channels"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route tests: API key auth
// ---------------------------------------------------------------------------

describe("routes — API key auth", () => {
  test("valid API key returns 200 with result", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "how many users?" }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
    const result = json.result as Record<string, unknown>;
    expect(result.answer).toBe("42 active users");
    expect(result.sql).toEqual(["SELECT COUNT(*) FROM users WHERE active = true"]);
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([{ count: 42 }]);
  });

  test("invalid API key returns 401", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": "wrong-key",
      },
      body: JSON.stringify({ query: "how many users?" }),
    });

    expect(resp.status).toBe(401);
  });

  test("missing API key header returns 401", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "how many users?" }),
    });

    expect(resp.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Route tests: HMAC auth (F-75 wire format)
// ---------------------------------------------------------------------------

describe("routes — HMAC auth", () => {
  const HMAC_SECRET = "hmac-test-secret";

  function createHmacApp(): Hono {
    return createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "hmac-channel",
            authType: "hmac",
            secret: HMAC_SECRET,
            responseFormat: "json",
          },
        ],
      }),
    );
  }

  test("valid HMAC signature with timestamp returns 200", async () => {
    const app = createHmacApp();
    const body = JSON.stringify({ query: "revenue last month?" });
    const ts = nowSeconds();
    const signature = hmacSign(HMAC_SECRET, body, ts);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": String(ts),
      },
      body,
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
  });

  test("missing timestamp returns 401 in strict mode", async () => {
    const app = createHmacApp();
    const body = JSON.stringify({ query: "revenue last month?" });
    const signature = hmacSign(HMAC_SECRET, body, nowSeconds());

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body,
    });

    expect(resp.status).toBe(401);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(String(json.error).toLowerCase()).toContain("timestamp");
  });

  test("invalid HMAC signature returns 401", async () => {
    const app = createHmacApp();
    const body = JSON.stringify({ query: "revenue last month?" });
    const ts = nowSeconds();

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "invalid-signature",
        "X-Webhook-Timestamp": String(ts),
      },
      body,
    });

    expect(resp.status).toBe(401);
  });

  test("missing HMAC signature returns 401", async () => {
    const app = createHmacApp();

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "revenue last month?" }),
    });

    expect(resp.status).toBe(401);
  });

  test("HMAC signature for different body is rejected", async () => {
    const app = createHmacApp();
    const bodyA = JSON.stringify({ query: "original query" });
    const bodyB = JSON.stringify({ query: "tampered query" });
    const ts = nowSeconds();
    const signatureForA = hmacSign(HMAC_SECRET, bodyA, ts);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signatureForA,
        "X-Webhook-Timestamp": String(ts),
      },
      body: bodyB,
    });

    expect(resp.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F-75 — Replay protection
// ---------------------------------------------------------------------------

describe("F-75 — replay protection", () => {
  const HMAC_SECRET = "hmac-test-secret";

  function makeApp(): Hono {
    return createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "hmac-channel",
            authType: "hmac",
            secret: HMAC_SECRET,
            responseFormat: "json",
          },
        ],
      }),
    );
  }

  test("rejects request whose timestamp is 301 seconds old", async () => {
    const app = makeApp();
    const ts = nowSeconds() - 301;
    const body = JSON.stringify({ query: "stale request" });
    const signature = hmacSign(HMAC_SECRET, body, ts);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": String(ts),
      },
      body,
    });

    expect(resp.status).toBe(401);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("window");
  });

  test("accepts request whose timestamp is 299 seconds old", async () => {
    const app = makeApp();
    const ts = nowSeconds() - 299;
    const body = JSON.stringify({ query: "still fresh" });
    const signature = hmacSign(HMAC_SECRET, body, ts);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": String(ts),
      },
      body,
    });

    expect(resp.status).toBe(200);
  });

  test("rejects future-dated timestamp outside window", async () => {
    const app = makeApp();
    const ts = nowSeconds() + 600;
    const body = JSON.stringify({ query: "future" });
    const signature = hmacSign(HMAC_SECRET, body, ts);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": String(ts),
      },
      body,
    });

    expect(resp.status).toBe(401);
  });

  test("rejects in-window replay of an already-seen signature", async () => {
    const app = makeApp();
    const ts = nowSeconds();
    const body = JSON.stringify({ query: "replay me" });
    const signature = hmacSign(HMAC_SECRET, body, ts);
    const headers = {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature,
      "X-Webhook-Timestamp": String(ts),
    };

    const first = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);

    const second = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers,
      body,
    });
    expect(second.status).toBe(401);
    const json = (await second.json()) as Record<string, unknown>;
    expect(String(json.error)).toContain("Duplicate");
  });

  test("legacy mode accepts body-only HMAC when timestamp is missing", async () => {
    const channelMap = new Map([
      [
        "hmac-channel",
        {
          channelId: "hmac-channel",
          authType: "hmac" as const,
          secret: HMAC_SECRET,
          responseFormat: "json" as const,
        },
      ],
    ]);
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const app = new Hono();
    app.route(
      "",
      createWebhookRoutes({
        channels: channelMap,
        log,
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
        replayMode: "legacy",
        throttle: createChannelThrottle(),
        nonceCache: createNonceCache(),
      }),
    );

    const body = JSON.stringify({ query: "legacy upstream" });
    const signature = hmacSignBodyOnly(HMAC_SECRET, body);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body,
    });

    expect(resp.status).toBe(200);
  });

  test("legacy mode still enforces timestamp window when one IS provided", async () => {
    const channelMap = new Map([
      [
        "hmac-channel",
        {
          channelId: "hmac-channel",
          authType: "hmac" as const,
          secret: HMAC_SECRET,
          responseFormat: "json" as const,
        },
      ],
    ]);
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const app = new Hono();
    app.route(
      "",
      createWebhookRoutes({
        channels: channelMap,
        log,
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
        replayMode: "legacy",
        throttle: createChannelThrottle(),
        nonceCache: createNonceCache(),
      }),
    );

    const ts = nowSeconds() - 600;
    const body = JSON.stringify({ query: "stale" });
    const signature = hmacSign(HMAC_SECRET, body, ts);

    const resp = await app.request("/webhook/hmac-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": String(ts),
      },
      body,
    });

    expect(resp.status).toBe(401);
  });

  test("api-key channel with requireTimestamp rejects missing header", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            requireTimestamp: true,
          },
        ],
      }),
    );

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "needs timestamp" }),
    });

    expect(resp.status).toBe(401);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(String(json.error).toLowerCase()).toContain("timestamp");
  });

  test("api-key channel with requireTimestamp rejects out-of-window header", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            requireTimestamp: true,
          },
        ],
      }),
    );

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
        "X-Webhook-Timestamp": String(nowSeconds() - 1000),
      },
      body: JSON.stringify({ query: "stale" }),
    });

    expect(resp.status).toBe(401);
  });

  test("api-key channel with requireTimestamp accepts in-window header", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            requireTimestamp: true,
          },
        ],
      }),
    );

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
        "X-Webhook-Timestamp": String(nowSeconds()),
      },
      body: JSON.stringify({ query: "fresh" }),
    });

    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// F-76 — Per-channel rate limit
// ---------------------------------------------------------------------------

describe("F-76 — per-channel rate limit", () => {
  test("rejects (N+1)th in-flight request with 429 when concurrencyLimit reached", async () => {
    const pending: Array<(value: WebhookQueryResult) => void> = [];
    const slowQuery = mock(
      () =>
        new Promise<WebhookQueryResult>((resolve) => {
          pending.push(resolve);
        }),
    ) as unknown as WebhookPluginConfig["executeQuery"];

    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            concurrencyLimit: 2,
            rateLimitRpm: 60,
          },
        ],
        executeQuery: slowQuery,
      }),
    );

    // Fire 2 requests that block (concurrencyLimit = 2) and 1 over the cap.
    const inFlight1 = app.request("/webhook/test-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET },
      body: JSON.stringify({ query: "slow 1" }),
    });
    const inFlight2 = app.request("/webhook/test-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET },
      body: JSON.stringify({ query: "slow 2" }),
    });
    // Yield the event loop so the in-flight requests reach executeQuery and
    // hold their concurrency slots before the 3rd request fires.
    await new Promise((r) => setTimeout(r, 10));

    const overflow = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET },
      body: JSON.stringify({ query: "overflow" }),
    });

    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("retry-after")).toBeTruthy();
    const json = (await overflow.json()) as Record<string, unknown>;
    expect(json.reason).toBe("concurrency");

    // Drain the in-flight requests so the test can finish.
    for (const resolve of pending) resolve(defaultQueryResult);
    await Promise.all([inFlight1, inFlight2]);
  });

  test("rejects rate-limited request when rateLimitRpm is reached", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            rateLimitRpm: 2,
            concurrencyLimit: 10,
          },
        ],
      }),
    );

    const fire = () =>
      app.request("/webhook/test-channel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET },
        body: JSON.stringify({ query: "ping" }),
      });

    expect((await fire()).status).toBe(200);
    expect((await fire()).status).toBe(200);
    const third = await fire();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    const json = (await third.json()) as Record<string, unknown>;
    expect(json.reason).toBe("rate");
  });

  test("default concurrencyLimit is 3 when channel does not specify it", async () => {
    const pending: Array<(value: WebhookQueryResult) => void> = [];
    const slowQuery = mock(
      () =>
        new Promise<WebhookQueryResult>((resolve) => {
          pending.push(resolve);
        }),
    ) as unknown as WebhookPluginConfig["executeQuery"];

    const app = createTestApp(
      createMockConfig({
        // Channel deliberately does NOT set concurrencyLimit / rateLimitRpm.
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
          },
        ],
        executeQuery: slowQuery,
      }),
    );
    const headers = { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET };

    // 3 in-flight allowed under the default ceiling.
    const a = app.request("/webhook/test-channel", { method: "POST", headers, body: JSON.stringify({ query: "1" }) });
    const b = app.request("/webhook/test-channel", { method: "POST", headers, body: JSON.stringify({ query: "2" }) });
    const c = app.request("/webhook/test-channel", { method: "POST", headers, body: JSON.stringify({ query: "3" }) });
    await new Promise((r) => setTimeout(r, 10));

    // 4th must 429 — proves the default cap is exactly 3, not higher.
    const overflow = await app.request("/webhook/test-channel", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "4" }),
    });
    expect(overflow.status).toBe(429);

    for (const resolve of pending) resolve(defaultQueryResult);
    await Promise.all([a, b, c]);
  });

  test("slot is released on validation failure (e.g. invalid JSON body)", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            concurrencyLimit: 1,
            rateLimitRpm: 60,
          },
        ],
      }),
    );

    // First request fails parsing — slot must be released before the second.
    const bad = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET },
      body: "not json",
    });
    expect(bad.status).toBe(400);

    const good = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET },
      body: JSON.stringify({ query: "after-bad" }),
    });
    expect(good.status).toBe(200);
  });

  test("slot is released on JSON null body (regression — used to TypeError after acquire)", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            concurrencyLimit: 1,
            rateLimitRpm: 60,
          },
        ],
      }),
    );
    const headers = { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET };

    const bad = await app.request("/webhook/test-channel", { method: "POST", headers, body: "null" });
    expect(bad.status).toBe(400);

    const good = await app.request("/webhook/test-channel", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "after-null" }),
    });
    expect(good.status).toBe(200);
  });

  test("slot is released when query field is missing", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            concurrencyLimit: 1,
            rateLimitRpm: 60,
          },
        ],
      }),
    );
    const headers = { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET };

    const bad = await app.request("/webhook/test-channel", {
      method: "POST",
      headers,
      body: JSON.stringify({ notQuery: "x" }),
    });
    expect(bad.status).toBe(400);

    const good = await app.request("/webhook/test-channel", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "after-missing-field" }),
    });
    expect(good.status).toBe(200);
  });

  test("slot is released when callback URL is rejected by SSRF guard", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "test-channel",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            concurrencyLimit: 1,
            rateLimitRpm: 60,
          },
        ],
      }),
    );
    const headers = { "Content-Type": "application/json", "X-Webhook-Secret": TEST_SECRET };

    const bad = await app.request("/webhook/test-channel", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "x", callbackUrl: "http://169.254.169.254/" }),
    });
    expect(bad.status).toBe(400);

    const good = await app.request("/webhook/test-channel", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "after-bad-callback" }),
    });
    expect(good.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Route tests: Request validation
// ---------------------------------------------------------------------------

describe("routes — request validation", () => {
  test("unknown channelId returns 404", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/nonexistent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "hello" }),
    });

    expect(resp.status).toBe(404);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe("Unknown channel");
  });

  test("missing query body returns 400", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({}),
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("Missing");
  });

  test("empty query string returns 400", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "  " }),
    });

    expect(resp.status).toBe(400);
  });

  test("invalid JSON body returns 400", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: "not json",
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("Invalid JSON");
  });
});

// ---------------------------------------------------------------------------
// Route tests: Query execution
// ---------------------------------------------------------------------------

describe("routes — query execution", () => {
  test("calls executeQuery with the provided query", async () => {
    const mockExecuteQuery = mock(() =>
      Promise.resolve(defaultQueryResult),
    ) as Mock<WebhookPluginConfig["executeQuery"]>;
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));

    await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "how many users?" }),
    });

    expect(mockExecuteQuery).toHaveBeenCalledWith("how many users?");
  });

  test("returns 500 when executeQuery throws", async () => {
    const failingQuery = mock(() =>
      Promise.reject(new Error("Agent error")),
    ) as Mock<WebhookPluginConfig["executeQuery"]>;
    const app = createTestApp(createMockConfig({ executeQuery: failingQuery }));

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "bad query" }),
    });

    expect(resp.status).toBe(500);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("execution failed");
  });

  test("text responseFormat returns plain answer", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "text-ch",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "text",
          },
        ],
      }),
    );

    const resp = await app.request("/webhook/text-ch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "how many users?" }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
    expect(json.result).toBe("42 active users");
  });
});

// ---------------------------------------------------------------------------
// Route tests: Async mode
// ---------------------------------------------------------------------------

describe("routes — async mode", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 202 with requestId when callbackUrl is in channel config", async () => {
    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "async-ch",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            callbackUrl: "https://example.com/callback",
          },
        ],
      }),
    );

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ) as unknown as typeof globalThis.fetch;

    const resp = await app.request("/webhook/async-ch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "how many users?" }),
    });

    expect(resp.status).toBe(202);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.accepted).toBe(true);
    expect(typeof json.requestId).toBe("string");
  });

  test("returns 202 when callbackUrl is in request body", async () => {
    const app = createTestApp(createMockConfig());

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ) as unknown as typeof globalThis.fetch;

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({
        query: "how many users?",
        callbackUrl: "https://example.com/callback",
      }),
    });

    expect(resp.status).toBe(202);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.accepted).toBe(true);
  });

  test("async mode delivers correct payload to callback URL", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "async-ch",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            callbackUrl: "https://example.com/callback",
          },
        ],
      }),
    );

    await app.request("/webhook/async-ch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "how many users?" }),
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalled();
    const [callUrl, callOpts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(callUrl).toBe("https://example.com/callback");
    expect(callOpts.method).toBe("POST");
    expect(callOpts.headers).toEqual({ "Content-Type": "application/json" });

    const delivered = JSON.parse(callOpts.body as string) as Record<string, unknown>;
    expect(typeof delivered.requestId).toBe("string");
    expect(delivered.success).toBe(true);
    const result = delivered.result as Record<string, unknown>;
    expect(result.answer).toBe("42 active users");
    expect(result.sql).toEqual(["SELECT COUNT(*) FROM users WHERE active = true"]);
    expect(result.columns).toEqual(["count"]);
  });

  test("async mode delivers error payload when executeQuery fails", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const failingQuery = mock(() =>
      Promise.reject(new Error("Agent crashed")),
    ) as Mock<WebhookPluginConfig["executeQuery"]>;

    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "async-ch",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            callbackUrl: "https://example.com/callback",
          },
        ],
        executeQuery: failingQuery,
      }),
    );

    const resp = await app.request("/webhook/async-ch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "bad query" }),
    });

    expect(resp.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalled();
    const [, callOpts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const delivered = JSON.parse(callOpts.body as string) as Record<string, unknown>;
    expect(delivered.success).toBe(false);
    expect(delivered.error).toContain("execution failed");
    expect(typeof delivered.requestId).toBe("string");
  });

  test("request-level callbackUrl overrides channel-level callbackUrl", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const app = createTestApp(
      createMockConfig({
        channels: [
          {
            channelId: "async-ch",
            authType: "api-key",
            secret: TEST_SECRET,
            responseFormat: "json",
            callbackUrl: "https://channel-level.com/callback",
          },
        ],
      }),
    );

    await app.request("/webhook/async-ch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({
        query: "how many users?",
        callbackUrl: "https://request-level.com/callback",
      }),
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalled();
    const [callUrl] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(callUrl).toBe("https://request-level.com/callback");
  });

  test("rejects internal/private callbackUrl (SSRF prevention)", async () => {
    const app = createTestApp(createMockConfig());

    const internalUrls = [
      "http://localhost:3001/admin",
      "http://127.0.0.1/secret",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/router",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.16.0.1/internal",
    ];

    for (const callbackUrl of internalUrls) {
      const resp = await app.request("/webhook/test-channel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": TEST_SECRET,
        },
        body: JSON.stringify({ query: "test", callbackUrl }),
      });

      expect(resp.status).toBe(400);
      const json = (await resp.json()) as Record<string, unknown>;
      expect(json.error).toContain("Invalid callback URL");
    }
  });

  test("rejects non-string callbackUrl in request body", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({ query: "test", callbackUrl: 12345 }),
    });

    // Non-string callbackUrl is ignored, falls through to sync mode
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Integration examples: Zapier / n8n payloads
// ---------------------------------------------------------------------------

describe("routes — integration payloads", () => {
  test("Zapier-style payload", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/webhook/test-channel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": TEST_SECRET,
      },
      body: JSON.stringify({
        query: "What is our MRR this month?",
        context: { source: "zapier", zap_id: "12345" },
      }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.success).toBe(true);
  });

  test("n8n-style payload with callback", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ) as unknown as typeof globalThis.fetch;

    try {
      const app = createTestApp(createMockConfig());

      const resp = await app.request("/webhook/test-channel", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": TEST_SECRET,
        },
        body: JSON.stringify({
          query: "Show me top 10 customers by revenue",
          callbackUrl: "https://n8n.example.com/webhook-response/abc123",
          context: { workflow: "revenue-report" },
        }),
      });

      expect(resp.status).toBe(202);
      const json = (await resp.json()) as Record<string, unknown>;
      expect(json.accepted).toBe(true);
      expect(typeof json.requestId).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
