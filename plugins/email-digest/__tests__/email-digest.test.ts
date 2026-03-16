/**
 * Tests for the Email Digest Interaction Plugin.
 *
 * Tests plugin shape, config validation, lifecycle, subscription CRUD routes,
 * digest generation with partial failure handling, template rendering,
 * email sending, and from-address parsing.
 */

import {
  describe,
  test,
  expect,
  mock,
  afterEach,
  type Mock,
} from "bun:test";
import { Hono } from "hono";
import { definePlugin, isInteractionPlugin } from "@useatlas/plugin-sdk";
import {
  emailDigestPlugin,
  buildEmailDigestPlugin,
  parseFromAddress,
  sendEmail,
} from "../src/index";
import type { EmailDigestPluginConfig, MetricResult } from "../src/config";
import { generateDigest } from "../src/digest";
import type { DigestSubscription } from "../src/digest";
import { renderDigestEmail } from "../src/templates";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultMetricResult: MetricResult = {
  name: "active_users",
  value: 1247,
  previousValue: 1100,
  columns: ["count"],
  rows: [{ count: 1247 }],
};

function createMockConfig(
  overrides?: Partial<EmailDigestPluginConfig>,
): EmailDigestPluginConfig {
  return {
    from: "Atlas <digest@test.com>",
    transport: "sendgrid",
    apiKey: "sg-test-key-123",
    executeMetric: mock(() =>
      Promise.resolve(defaultMetricResult),
    ) as EmailDigestPluginConfig["executeMetric"],
    ...overrides,
  };
}

// In-memory DB mock for subscription CRUD
function createMockDb() {
  const rows: Record<string, unknown>[] = [];
  const executeCalls: { sql: string; params: unknown[] }[] = [];

  return {
    db: {
      query: mock(async (_sql: string, params?: unknown[]) => {
        const sql = _sql.trim();
        if (sql.startsWith("SELECT 1")) {
          return { rows: [{ "1": 1 }] };
        }
        if (sql.startsWith("SELECT")) {
          if (params && params.length === 2) {
            return {
              rows: rows.filter(
                (r) => r.id === params[0] && r.user_id === params[1],
              ),
            };
          }
          const userId = params?.[0];
          return {
            rows: rows.filter((r) => r.user_id === userId),
          };
        }
        return { rows: [] };
      }),
      execute: mock(async (_sql: string, params?: unknown[]) => {
        const sql = _sql.trim();
        executeCalls.push({ sql, params: params ?? [] });
        if (sql.startsWith("INSERT")) {
          rows.push({
            id: params?.[0],
            user_id: params?.[1],
            email: params?.[2],
            metrics: params?.[3],
            frequency: params?.[4],
            delivery_hour: params?.[5],
            timezone: params?.[6],
            enabled: params?.[7],
            created_at: params?.[8],
            updated_at: params?.[9],
          });
        } else if (sql.startsWith("DELETE")) {
          const idx = rows.findIndex((r) => r.id === params?.[0]);
          if (idx !== -1) rows.splice(idx, 1);
        }
      }),
    },
    rows,
    executeCalls,
  };
}

function createMockCtx(db?: ReturnType<typeof createMockDb>["db"]) {
  const logged: string[] = [];
  return {
    ctx: {
      db: db ?? null,
      connections: { get: () => ({}), list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (...args: unknown[]) =>
          logged.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? "")),
        warn: (...args: unknown[]) =>
          logged.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? "")),
        error: () => {},
        debug: () => {},
      },
      config: {},
    },
    logged,
  };
}

function createTestApp(config: EmailDigestPluginConfig, db?: ReturnType<typeof createMockDb>["db"]): Hono {
  const plugin = buildEmailDigestPlugin(config);
  const mockCtx = createMockCtx(db);
  plugin.initialize!(mockCtx.ctx as never);
  const app = new Hono();
  plugin.routes!(app);
  return app;
}

function createMockLogger() {
  const messages: string[] = [];
  return {
    logger: {
      info: (...args: unknown[]) => messages.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? "")),
      warn: (...args: unknown[]) => messages.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? "")),
      error: (...args: unknown[]) => messages.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? "")),
      debug: () => {},
    },
    messages,
  };
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("emailDigestPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasInteractionPlugin", () => {
    const plugin = emailDigestPlugin(createMockConfig());
    expect(plugin.id).toBe("email-digest-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Email Digest");
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isInteractionPlugin type guard returns true", () => {
    const plugin = emailDigestPlugin(createMockConfig());
    expect(isInteractionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const config = createMockConfig();
    const plugin = emailDigestPlugin(config);
    expect(plugin.config?.from).toBe("Atlas <digest@test.com>");
    expect(plugin.config?.transport).toBe("sendgrid");
  });

  test("routes is defined", () => {
    const plugin = emailDigestPlugin(createMockConfig());
    expect(typeof plugin.routes).toBe("function");
  });

  test("schema is defined with digest_subscriptions table", () => {
    const plugin = emailDigestPlugin(createMockConfig());
    expect(plugin.schema).toBeDefined();
    expect(plugin.schema!.digest_subscriptions).toBeDefined();
    expect(plugin.schema!.digest_subscriptions.fields.user_id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("emailDigestPlugin — config validation", () => {
  test("accepts valid sendgrid config", () => {
    expect(() =>
      emailDigestPlugin({
        from: "Atlas <a@b.com>",
        transport: "sendgrid",
        apiKey: "sg-123",
        executeMetric: mock(() => Promise.resolve(defaultMetricResult)),
      }),
    ).not.toThrow();
  });

  test("rejects empty from address", () => {
    expect(() =>
      emailDigestPlugin({
        from: "",
        transport: "sendgrid",
        apiKey: "key",
        executeMetric: mock(() => Promise.resolve(defaultMetricResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects missing apiKey", () => {
    expect(() =>
      emailDigestPlugin({
        from: "a@b.com",
        transport: "sendgrid",
        executeMetric: mock(() => Promise.resolve(defaultMetricResult)),
      } as unknown as EmailDigestPluginConfig),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects non-function executeMetric", () => {
    expect(() =>
      emailDigestPlugin({
        from: "a@b.com",
        transport: "sendgrid",
        apiKey: "key",
        executeMetric: "not-a-function" as unknown as EmailDigestPluginConfig["executeMetric"],
      }),
    ).toThrow("Plugin config validation failed");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("emailDigestPlugin — lifecycle", () => {
  test("initializes successfully", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const { db } = createMockDb();
    const { ctx, logged } = createMockCtx(db);

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("initialized"))).toBe(true);
  });

  test("double initialize throws", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const { db } = createMockDb();
    const { ctx } = createMockCtx(db);

    await plugin.initialize!(ctx as never);
    await expect(plugin.initialize!(ctx as never)).rejects.toThrow("already initialized");
  });

  test("healthCheck returns unhealthy before init", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("healthCheck returns unhealthy without db", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("database");
  });

  test("healthCheck returns healthy with db and table", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const { db } = createMockDb();
    const { ctx } = createMockCtx(db);

    await plugin.initialize!(ctx as never);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  test("teardown is safe to call without initialization", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("healthCheck returns unhealthy after teardown", async () => {
    const plugin = emailDigestPlugin(createMockConfig());
    const { db } = createMockDb();
    const { ctx } = createMockCtx(db);

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("initialize propagates table creation failure", async () => {
    const failingDb = {
      query: mock(async () => ({ rows: [] })),
      execute: mock(async () => {
        throw new Error("permission denied for schema public");
      }),
    };
    const plugin = emailDigestPlugin(createMockConfig());
    const { ctx } = createMockCtx(failingDb);

    await expect(plugin.initialize!(ctx as never)).rejects.toThrow("permission denied");
  });
});

// ---------------------------------------------------------------------------
// parseFromAddress
// ---------------------------------------------------------------------------

describe("parseFromAddress", () => {
  test("parses display-name format", () => {
    const result = parseFromAddress("Atlas <digest@myco.com>");
    expect(result.name).toBe("Atlas");
    expect(result.email).toBe("digest@myco.com");
  });

  test("parses display-name with spaces", () => {
    const result = parseFromAddress("Atlas Reports <reports@myco.com>");
    expect(result.name).toBe("Atlas Reports");
    expect(result.email).toBe("reports@myco.com");
  });

  test("handles bare email address", () => {
    const result = parseFromAddress("digest@myco.com");
    expect(result.email).toBe("digest@myco.com");
    expect(result.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------

describe("sendEmail", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends via SendGrid with correct payload shape", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response("", { status: 202 })),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const config = createMockConfig();
    const { logger } = createMockLogger();

    const result = await sendEmail(config, "user@test.com", "Test Subject", "<h1>Hi</h1>", "Hi", logger);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(opts.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sg-test-key-123",
    });

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    // from should be parsed from display-name format
    expect(body.from).toEqual({ name: "Atlas", email: "digest@test.com" });
    expect(body.subject).toBe("Test Subject");
  });

  test("returns false on SendGrid error response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response('{"error":"invalid"}', { status: 403 })),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const config = createMockConfig();
    const { logger, messages } = createMockLogger();

    const result = await sendEmail(config, "user@test.com", "Sub", "<p>Hi</p>", "Hi", logger);

    expect(result).toBe(false);
    expect(messages.some((m) => m.includes("SendGrid delivery failed"))).toBe(true);
  });

  test("returns false on network error", async () => {
    const mockFetch = mock(() =>
      Promise.reject(new Error("Network error")),
    );
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const config = createMockConfig();
    const { logger, messages } = createMockLogger();

    const result = await sendEmail(config, "user@test.com", "Sub", "<p>Hi</p>", "Hi", logger);

    expect(result).toBe(false);
    expect(messages.some((m) => m.includes("Email delivery error"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subscription CRUD routes
// ---------------------------------------------------------------------------

describe("routes — subscription CRUD", () => {
  test("POST /digest/subscriptions creates a subscription", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-User-Id": "user-1",
      },
      body: JSON.stringify({
        metrics: ["active_users", "revenue"],
        frequency: "daily",
        deliveryHour: 9,
        email: "user@test.com",
      }),
    });

    expect(resp.status).toBe(201);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.frequency).toBe("daily");
    expect(json.deliveryHour).toBe(9);
    expect(json.email).toBe("user@test.com");
    expect((json.metrics as string[]).length).toBe(2);
    expect(json.enabled).toBe(true);
    expect(typeof json.id).toBe("string");
  });

  test("POST rejects empty metrics array", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Atlas-User-Id": "user-1",
      },
      body: JSON.stringify({
        metrics: [],
        frequency: "daily",
        deliveryHour: 9,
        email: "user@test.com",
      }),
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("metrics");
  });

  test("POST rejects invalid frequency", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ metrics: ["m"], frequency: "monthly", deliveryHour: 9, email: "u@t.com" }),
    });

    expect(resp.status).toBe(400);
  });

  test("POST rejects invalid deliveryHour", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ metrics: ["m"], frequency: "daily", deliveryHour: 25, email: "u@t.com" }),
    });

    expect(resp.status).toBe(400);
  });

  test("POST rejects missing email", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ metrics: ["m"], frequency: "daily", deliveryHour: 9 }),
    });

    expect(resp.status).toBe(400);
  });

  test("POST rejects invalid JSON body", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: "not json",
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("Invalid JSON");
  });

  test("GET /digest/subscriptions lists user subscriptions", async () => {
    const { db, rows } = createMockDb();
    rows.push({
      id: "sub-1",
      user_id: "user-1",
      email: "user@test.com",
      metrics: JSON.stringify(["active_users"]),
      frequency: "daily",
      delivery_hour: 9,
      timezone: "UTC",
      enabled: true,
      created_at: "2026-03-16T00:00:00Z",
      updated_at: "2026-03-16T00:00:00Z",
    });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "GET",
      headers: { "X-Atlas-User-Id": "user-1" },
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { subscriptions: Record<string, unknown>[] };
    expect(json.subscriptions.length).toBe(1);
    expect(json.subscriptions[0].id).toBe("sub-1");
    expect((json.subscriptions[0].metrics as string[]).length).toBe(1);
    expect(json.subscriptions[0].enabled).toBe(true);
  });

  test("GET handles malformed metrics JSON gracefully", async () => {
    const { db, rows } = createMockDb();
    rows.push({
      id: "sub-bad",
      user_id: "user-1",
      email: "user@test.com",
      metrics: "not-valid-json",
      frequency: "daily",
      delivery_hour: 9,
      timezone: "UTC",
      enabled: true,
    });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "GET",
      headers: { "X-Atlas-User-Id": "user-1" },
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { subscriptions: Record<string, unknown>[] };
    expect((json.subscriptions[0].metrics as string[]).length).toBe(0);
  });

  test("DELETE /digest/subscriptions/:id removes subscription", async () => {
    const { db, rows } = createMockDb();
    rows.push({
      id: "sub-del",
      user_id: "user-1",
      email: "user@test.com",
      metrics: "[]",
      frequency: "daily",
      delivery_hour: 9,
      timezone: "UTC",
      enabled: true,
    });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-del", {
      method: "DELETE",
      headers: { "X-Atlas-User-Id": "user-1" },
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.deleted).toBe(true);
  });

  test("DELETE returns 404 for non-existent subscription", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/nonexistent", {
      method: "DELETE",
      headers: { "X-Atlas-User-Id": "user-1" },
    });

    expect(resp.status).toBe(404);
  });

  test("returns 503 when internal DB is not available", async () => {
    const app = createTestApp(createMockConfig());

    const resp = await app.request("/digest/subscriptions", {
      method: "GET",
      headers: { "X-Atlas-User-Id": "user-1" },
    });

    expect(resp.status).toBe(503);
  });

  test("returns 401 when user ID header is missing", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions", {
      method: "GET",
    });

    expect(resp.status).toBe(401);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("x-atlas-user-id");
  });
});

// ---------------------------------------------------------------------------
// PUT route
// ---------------------------------------------------------------------------

describe("routes — PUT /digest/subscriptions/:id", () => {
  test("updates subscription fields", async () => {
    const { db, rows } = createMockDb();
    rows.push({
      id: "sub-up",
      user_id: "user-1",
      email: "user@test.com",
      metrics: '["m1"]',
      frequency: "daily",
      delivery_hour: 9,
      timezone: "UTC",
      enabled: true,
    });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-up", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ frequency: "weekly", deliveryHour: 8 }),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.updated).toBe(true);
  });

  test("returns 404 for another user's subscription", async () => {
    const { db, rows } = createMockDb();
    rows.push({ id: "sub-other", user_id: "user-2", email: "x@t.com", metrics: "[]", frequency: "daily", delivery_hour: 9, timezone: "UTC", enabled: true });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-other", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ frequency: "weekly" }),
    });

    expect(resp.status).toBe(404);
  });

  test("returns 400 for empty body (no fields to update)", async () => {
    const { db, rows } = createMockDb();
    rows.push({ id: "sub-x", user_id: "user-1", email: "x@t.com", metrics: "[]", frequency: "daily", delivery_hour: 9, timezone: "UTC", enabled: true });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-x", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({}),
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toContain("No fields");
  });

  test("returns 400 for invalid frequency", async () => {
    const { db, rows } = createMockDb();
    rows.push({ id: "sub-x", user_id: "user-1", email: "x@t.com", metrics: "[]", frequency: "daily", delivery_hour: 9, timezone: "UTC", enabled: true });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-x", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ frequency: "monthly" }),
    });

    expect(resp.status).toBe(400);
  });

  test("can toggle enabled to false", async () => {
    const { db, rows } = createMockDb();
    rows.push({ id: "sub-tog", user_id: "user-1", email: "x@t.com", metrics: "[]", frequency: "daily", delivery_hour: 9, timezone: "UTC", enabled: true });

    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-tog", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(resp.status).toBe(200);
  });

  test("validates timezone and email on update", async () => {
    const { db, rows } = createMockDb();
    rows.push({ id: "sub-v", user_id: "user-1", email: "x@t.com", metrics: "[]", frequency: "daily", delivery_hour: 9, timezone: "UTC", enabled: true });

    const app = createTestApp(createMockConfig(), db);

    const resp1 = await app.request("/digest/subscriptions/sub-v", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ timezone: "" }),
    });
    expect(resp1.status).toBe(400);

    const resp2 = await app.request("/digest/subscriptions/sub-v", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Atlas-User-Id": "user-1" },
      body: JSON.stringify({ email: "" }),
    });
    expect(resp2.status).toBe(400);
  });

  test("returns 401 without user ID header", async () => {
    const { db } = createMockDb();
    const app = createTestApp(createMockConfig(), db);

    const resp = await app.request("/digest/subscriptions/sub-x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frequency: "weekly" }),
    });

    expect(resp.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Digest generation
// ---------------------------------------------------------------------------

describe("generateDigest", () => {
  test("generates digest with multiple metrics", async () => {
    const subscription: DigestSubscription = {
      id: "sub-1", userId: "user-1", email: "user@test.com",
      metrics: ["active_users", "revenue"], frequency: "daily",
      deliveryHour: 9, timezone: "UTC", enabled: true,
    };

    const executeMetric = mock(async (name: string): Promise<MetricResult> => ({
      name, value: name === "active_users" ? 1247 : 52000,
    }));

    const digest = await generateDigest(subscription, executeMetric);

    expect(digest.metrics).toHaveLength(2);
    expect(digest.metrics[0].name).toBe("active_users");
    expect(digest.metrics[0].value).toBe(1247);
    expect(digest.metrics[1].name).toBe("revenue");
    expect(digest.metrics[1].value).toBe(52000);
    expect(executeMetric).toHaveBeenCalledTimes(2);
  });

  test("handles partial failure gracefully", async () => {
    const subscription: DigestSubscription = {
      id: "sub-1", userId: "user-1", email: "user@test.com",
      metrics: ["working_metric", "broken_metric", "another_working"],
      frequency: "weekly", deliveryHour: 8, timezone: "America/New_York", enabled: true,
    };

    const executeMetric = mock(async (name: string): Promise<MetricResult> => {
      if (name === "broken_metric") throw new Error("Connection timeout");
      return { name, value: 42 };
    });

    const digest = await generateDigest(subscription, executeMetric);

    expect(digest.metrics).toHaveLength(3);
    expect(digest.metrics[0].value).toBe(42);
    expect(digest.metrics[1].error).toBe("Connection timeout");
    expect(digest.metrics[1].value).toBeNull();
    expect(digest.metrics[2].value).toBe(42);
  });

  test("logs metric failures when logger is provided", async () => {
    const subscription: DigestSubscription = {
      id: "sub-1", userId: "user-1", email: "user@test.com",
      metrics: ["fail1"], frequency: "daily", deliveryHour: 9, timezone: "UTC", enabled: true,
    };

    const executeMetric = mock(async (): Promise<MetricResult> => {
      throw new Error("DB down");
    });

    const { logger, messages } = createMockLogger();
    await generateDigest(subscription, executeMetric, logger);

    expect(messages.some((m) => m.includes("Metric execution failed"))).toBe(true);
  });

  test("handles all metrics failing", async () => {
    const subscription: DigestSubscription = {
      id: "sub-1", userId: "user-1", email: "user@test.com",
      metrics: ["fail1", "fail2"], frequency: "daily", deliveryHour: 9, timezone: "UTC", enabled: true,
    };

    const executeMetric = mock(async (): Promise<MetricResult> => {
      throw new Error("DB down");
    });

    const digest = await generateDigest(subscription, executeMetric);
    expect(digest.metrics).toHaveLength(2);
    expect(digest.metrics.every((m) => m.error !== undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe("renderDigestEmail", () => {
  test("renders HTML with metric sections", () => {
    const metrics: MetricResult[] = [
      { name: "Active Users", value: 1247, previousValue: 1100 },
      { name: "Revenue", value: 52000, columns: ["product", "amount"], rows: [{ product: "Pro", amount: 52000 }] },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://app.test/unsub", "https://app.test/manage");

    expect(result.subject).toContain("Daily Digest");
    expect(result.html).toContain("Active Users");
    expect(result.html).toContain("1247");
    expect(result.html).toContain("Revenue");
    expect(result.html).toContain("52000");
    expect(result.html).toContain("&#9650;"); // up arrow
    expect(result.html).toContain("https://app.test/unsub");
    expect(result.html).toContain("https://app.test/manage");
  });

  test("renders down arrow for decreasing values", () => {
    const metrics: MetricResult[] = [
      { name: "Churn", value: 50, previousValue: 100 },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://a.test/u", "https://a.test/m");
    expect(result.html).toContain("&#9660;"); // down arrow
    expect(result.html).toContain("#ef4444"); // red color
  });

  test("renders no trend when previous value is zero", () => {
    const metrics: MetricResult[] = [
      { name: "New Metric", value: 100, previousValue: 0 },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://a.test/u", "https://a.test/m");
    expect(result.html).not.toContain("&#9650;");
    expect(result.html).not.toContain("&#9660;");
  });

  test("renders error placeholder for failed metrics", () => {
    const metrics: MetricResult[] = [
      { name: "Good Metric", value: 42 },
      { name: "Bad Metric", value: null, error: "Query timeout" },
    ];

    const result = renderDigestEmail(metrics, "weekly", "https://app.test/unsub", "https://app.test/manage");

    expect(result.subject).toContain("Weekly Digest");
    expect(result.html).toContain("Good Metric");
    expect(result.html).toContain("Bad Metric");
    expect(result.html).toContain("Query timeout");
  });

  test("renders plain text fallback", () => {
    const metrics: MetricResult[] = [
      { name: "Users", value: 100 },
      { name: "Errors", value: null, error: "Failed" },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://app.test/unsub", "https://app.test/manage");

    expect(result.text).toContain("[Users] 100");
    expect(result.text).toContain("[Errors] ERROR: Failed");
    expect(result.text).toContain("Unsubscribe: https://app.test/unsub");
  });

  test("renders data table within metric section", () => {
    const metrics: MetricResult[] = [
      {
        name: "Top Products", value: "3 products",
        columns: ["name", "sales"],
        rows: [{ name: "Widget A", sales: 100 }, { name: "Widget B", sales: 80 }, { name: "Widget C", sales: 60 }],
      },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://a.test/u", "https://a.test/m");

    expect(result.html).toContain("Widget A");
    expect(result.html).toContain("<table");
    expect(result.html).toContain("<th");
  });

  test("truncates large data tables", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const metrics: MetricResult[] = [
      { name: "Big Table", value: "30 rows", columns: ["id", "name"], rows },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://a.test/u", "https://a.test/m");
    expect(result.html).toContain("Showing first 25 of 30 rows");
  });

  test("handles empty metrics array", () => {
    const result = renderDigestEmail([], "daily", "https://a.test/u", "https://a.test/m");
    expect(result.subject).toContain("Daily Digest");
    expect(result.html).toContain("0 metrics");
  });

  test("escapes HTML in metric values", () => {
    const metrics: MetricResult[] = [
      { name: "Test <script>", value: '<img src=x onerror="alert(1)">' },
    ];

    const result = renderDigestEmail(metrics, "daily", "https://a.test/u", "https://a.test/m");

    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain('onerror="');
    expect(result.html).toContain("&lt;script&gt;");
  });
});
