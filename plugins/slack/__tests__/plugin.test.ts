/**
 * Tests for the Slack Interaction Plugin.
 *
 * Tests the plugin shape, config validation, lifecycle, and route behavior.
 * Routes are tested by mounting the plugin on a test Hono app and making
 * requests against it.
 */

import {
  describe,
  test,
  expect,
  mock,
  beforeEach,
  afterEach,
  type Mock,
} from "bun:test";
import crypto from "crypto";
import { Hono } from "hono";
import { definePlugin, isInteractionPlugin } from "@useatlas/plugin-sdk";
import { slackPlugin, buildSlackPlugin } from "../src/index";
import type { SlackPluginConfig, SlackQueryResult, ConversationCallbacks, ActionCallbacks } from "../src/index";

// ---------------------------------------------------------------------------
// Global fetch mock — intercepts Slack API calls
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockSlackFetch(): typeof globalThis.fetch {
  const mockFn = mock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Slack API calls — return success responses
    if (url.includes("slack.com/api/chat.postMessage")) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, ts: "1234567890.123456", channel: "C456" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    if (url.includes("slack.com/api/chat.update")) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    if (url.includes("slack.com/api/chat.postEphemeral")) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    if (url.includes("slack.com/api/oauth.v2.access")) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, team: { id: "T999" }, access_token: "xoxb-new-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    // Slack response_url hooks
    if (url.includes("hooks.slack.com")) {
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    // Fallback — call the original fetch for non-Slack URLs
    return originalFetch(input, undefined);
  }) as unknown as typeof globalThis.fetch;
  return mockFn;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "test_secret_for_tests";

const defaultQueryResult: SlackQueryResult = {
  answer: "42 active users",
  sql: ["SELECT COUNT(*) FROM users WHERE active = true"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
  steps: 3,
  usage: { totalTokens: 150 },
};

function makeSignature(body: string, timestamp?: string): {
  signature: string;
  timestamp: string;
} {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sigBasestring = `v0:${ts}:${body}`;
  const sig =
    "v0=" +
    crypto.createHmac("sha256", SIGNING_SECRET).update(sigBasestring).digest("hex");
  return { signature: sig, timestamp: ts };
}

function createMockConfig(overrides?: Partial<SlackPluginConfig>): SlackPluginConfig {
  return {
    signingSecret: SIGNING_SECRET,
    botToken: "xoxb-test-token",
    executeQuery: mock(() => Promise.resolve(defaultQueryResult)) as SlackPluginConfig["executeQuery"],
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
        info: (...args: unknown[]) => logged.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? "")),
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
 * Create a Hono app with the plugin's routes mounted for testing.
 */
function createTestApp(config: SlackPluginConfig): Hono {
  const plugin = buildSlackPlugin(config);
  const app = new Hono();
  const { ctx } = createMockCtx();

  // Simulate the host calling initialize + routes
  // We need to call initialize synchronously for the test setup,
  // but initialize is async. We'll call routes() directly since
  // routes uses the config callbacks directly.
  plugin.routes!(app);
  return app;
}

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("slackPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasInteractionPlugin", () => {
    const plugin = slackPlugin(createMockConfig());
    expect(plugin.id).toBe("slack-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Slack Bot");
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = slackPlugin(createMockConfig());
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isInteractionPlugin type guard returns true", () => {
    const plugin = slackPlugin(createMockConfig());
    expect(isInteractionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const config = createMockConfig();
    const plugin = slackPlugin(config);
    expect(plugin.config?.signingSecret).toBe(SIGNING_SECRET);
    expect(plugin.config?.botToken).toBe("xoxb-test-token");
  });

  test("routes is defined (unlike MCP)", () => {
    const plugin = slackPlugin(createMockConfig());
    expect(typeof plugin.routes).toBe("function");
  });

  test("schema declares slack_installations and slack_threads tables", () => {
    const plugin = slackPlugin(createMockConfig());
    expect(plugin.schema).toBeDefined();
    expect(plugin.schema!.slack_installations).toBeDefined();
    expect(plugin.schema!.slack_installations.fields.team_id.required).toBe(true);
    expect(plugin.schema!.slack_installations.fields.team_id.unique).toBe(true);
    expect(plugin.schema!.slack_threads).toBeDefined();
    expect(plugin.schema!.slack_threads.fields.conversation_id.required).toBe(true);
  });

  test("buildSlackPlugin is available for direct use", () => {
    const plugin = buildSlackPlugin(createMockConfig());
    expect(plugin.id).toBe("slack-interaction");
    expect(plugin.types).toEqual(["interaction"]);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("slackPlugin — config validation", () => {
  test("accepts botToken mode", () => {
    expect(() =>
      slackPlugin({
        signingSecret: "secret",
        botToken: "xoxb-token",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("accepts OAuth mode (clientId + clientSecret)", () => {
    expect(() =>
      slackPlugin({
        signingSecret: "secret",
        clientId: "id",
        clientSecret: "secret",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("rejects empty signingSecret", () => {
    expect(() =>
      slackPlugin({
        signingSecret: "",
        botToken: "xoxb-token",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects when neither botToken nor OAuth creds provided", () => {
    expect(() =>
      slackPlugin({
        signingSecret: "secret",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects when only clientId without clientSecret", () => {
    expect(() =>
      slackPlugin({
        signingSecret: "secret",
        clientId: "id",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects non-function executeQuery", () => {
    expect(() =>
      slackPlugin({
        signingSecret: "secret",
        botToken: "xoxb-token",
        executeQuery: "not-a-function" as unknown as SlackPluginConfig["executeQuery"],
      }),
    ).toThrow("Plugin config validation failed");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("slackPlugin — lifecycle", () => {
  test("initializes successfully", async () => {
    const plugin = slackPlugin(createMockConfig());
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("initialized"))).toBe(true);
  });

  test("double initialize throws", async () => {
    const plugin = slackPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await expect(plugin.initialize!(ctx as never)).rejects.toThrow("already initialized");
  });

  test("healthCheck returns unhealthy before init", async () => {
    const plugin = slackPlugin(createMockConfig());
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("healthCheck returns healthy after init", async () => {
    const plugin = slackPlugin(createMockConfig());
    const { ctx } = createMockCtx();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    ) as unknown as typeof globalThis.fetch;

    try {
      await plugin.initialize!(ctx as never);
      const result = await plugin.healthCheck!();
      expect(result.healthy).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("healthCheck returns unhealthy after teardown", async () => {
    const plugin = slackPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("teardown is safe to call without initialization", async () => {
    const plugin = slackPlugin(createMockConfig());
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("teardown is safe to call twice", async () => {
    const plugin = slackPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("full lifecycle: init → health → teardown", async () => {
    const plugin = slackPlugin(createMockConfig());
    const { ctx } = createMockCtx();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    ) as unknown as typeof globalThis.fetch;

    try {
      const before = await plugin.healthCheck!();
      expect(before.healthy).toBe(false);

      await plugin.initialize!(ctx as never);
      const during = await plugin.healthCheck!();
      expect(during.healthy).toBe(true);

      await plugin.teardown!();
      const after = await plugin.healthCheck!();
      expect(after.healthy).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("initialize logs single-workspace mode", async () => {
    const plugin = slackPlugin(createMockConfig({ botToken: "xoxb-test" }));
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("single-workspace"))).toBe(true);
  });

  test("initialize logs multi-workspace mode", async () => {
    const plugin = slackPlugin(createMockConfig({
      botToken: undefined,
      clientId: "id",
      clientSecret: "secret",
    }));
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("multi-workspace"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route tests: POST /commands
// ---------------------------------------------------------------------------

describe("routes — POST /commands", () => {
  let mockExecuteQuery: Mock<(q: string, opts?: unknown) => Promise<SlackQueryResult>>;
  let fetchMock: typeof globalThis.fetch;

  beforeEach(() => {
    mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    fetchMock = mockSlackFetch();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("acks a slash command with 200 and in_channel response", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
    const { signature, timestamp } = makeSignature(body);

    const resp = await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.response_type).toBe("in_channel");
    expect(json.text).toContain("Processing");
  });

  test("returns usage hint for empty text", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=";
    const { signature, timestamp } = makeSignature(body);

    const resp = await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Usage");
  });

  test("rejects unsigned requests with 401", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const body = "token=xxx&text=hello";

    const resp = await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    });

    expect(resp.status).toBe(401);
  });

  test("calls executeQuery for valid command", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
    const { signature, timestamp } = makeSignature(body);

    await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecuteQuery).toHaveBeenCalledWith("how many users");
  });
});

// ---------------------------------------------------------------------------
// Route tests: POST /events
// ---------------------------------------------------------------------------

describe("routes — POST /events", () => {
  let mockExecuteQuery: Mock<(q: string, opts?: unknown) => Promise<SlackQueryResult>>;

  beforeEach(() => {
    mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    globalThis.fetch = mockSlackFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("responds to url_verification challenge", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const payload = JSON.stringify({
      type: "url_verification",
      challenge: "test_challenge_string",
    });
    const { signature, timestamp } = makeSignature(payload);

    const resp = await app.request("/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: payload,
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.challenge).toBe("test_challenge_string");
  });

  test("ignores bot messages", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const payload = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        bot_id: "B123",
        text: "I am a bot",
        channel: "C456",
        thread_ts: "1234567890.000001",
      },
    });
    const { signature, timestamp } = makeSignature(payload);

    const resp = await app.request("/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: payload,
    });

    expect(resp.status).toBe(200);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("rejects invalid signatures for event callbacks", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const payload = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        text: "follow-up question",
        channel: "C456",
        thread_ts: "1234567890.000001",
      },
    });

    const resp = await app.request("/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: payload,
    });

    expect(resp.status).toBe(401);
  });

  test("rejects url_verification with invalid signature", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const payload = JSON.stringify({
      type: "url_verification",
      challenge: "should_not_echo",
    });

    const resp = await app.request("/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": "v0=bad_signature",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: payload,
    });

    expect(resp.status).toBe(401);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe("Invalid signature");
  });

  test("processes thread follow-up events", async () => {
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));
    const payload = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        text: "what about last quarter?",
        channel: "C456",
        thread_ts: "1234567890.000001",
      },
    });
    const { signature, timestamp } = makeSignature(payload);

    const resp = await app.request("/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: payload,
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecuteQuery).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route tests: Rate limiting
// ---------------------------------------------------------------------------

describe("routes — rate limiting", () => {
  beforeEach(() => {
    globalThis.fetch = mockSlackFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns rate limit message for slash commands", async () => {
    const mockCheckRateLimit = mock(() => ({ allowed: false, retryAfterMs: 30000 }));
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));

    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      checkRateLimit: mockCheckRateLimit,
    }));

    const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
    const { signature, timestamp } = makeSignature(body);

    const resp = await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    // Rate limited — agent should NOT have been called
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("returns rate limit message for thread follow-ups", async () => {
    const mockCheckRateLimit = mock(() => ({ allowed: false, retryAfterMs: 30000 }));
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));

    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      checkRateLimit: mockCheckRateLimit,
    }));

    const payload = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: {
        type: "message",
        text: "what about last quarter?",
        channel: "C456",
        thread_ts: "1234567890.000001",
      },
    });
    const { signature, timestamp } = makeSignature(payload);

    const resp = await app.request("/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: payload,
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route tests: Conversations
// ---------------------------------------------------------------------------

describe("routes — conversation persistence", () => {
  beforeEach(() => {
    globalThis.fetch = mockSlackFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("creates conversation for slash commands when callbacks provided", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const mockCreate = mock(() => Promise.resolve({ id: "conv-123" })) as Mock<ConversationCallbacks["create"]>;
    const mockAddMessage = mock(() => {}) as Mock<ConversationCallbacks["addMessage"]>;
    const mockGet = mock(() => Promise.resolve(null)) as Mock<ConversationCallbacks["get"]>;
    const mockGenerateTitle = mock((q: string) => q.slice(0, 80));

    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      conversations: {
        create: mockCreate,
        addMessage: mockAddMessage,
        get: mockGet,
        generateTitle: mockGenerateTitle,
      },
    }));

    const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
    const { signature, timestamp } = makeSignature(body);

    await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "slack" }),
    );
    // User + assistant messages
    expect(mockAddMessage).toHaveBeenCalledTimes(2);
  });

  test("works without conversation callbacks (no persistence)", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));

    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      // No conversations callback
    }));

    const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
    const { signature, timestamp } = makeSignature(body);

    const resp = await app.request("/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body,
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    // Should still work — just no persistence
    expect(mockExecuteQuery).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route tests: POST /interactions
// ---------------------------------------------------------------------------

describe("routes — POST /interactions", () => {
  beforeEach(() => {
    globalThis.fetch = mockSlackFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeInteractionPayload(actionId: string, action_id: string) {
    return JSON.stringify({
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "U789" },
      actions: [{ action_id, value: actionId }],
      response_url: "https://hooks.slack.com/actions/test",
    });
  }

  test("approves an action when approve button is clicked", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const mockApprove = mock(() =>
      Promise.resolve({ status: "executed" }),
    ) as Mock<ActionCallbacks["approve"]>;
    const mockDeny = mock(() => Promise.resolve({})) as Mock<ActionCallbacks["deny"]>;
    const mockGetAction = mock(() =>
      Promise.resolve({ id: "act-001", action_type: "notification", target: "#revenue", summary: "Send notification" }),
    ) as Mock<ActionCallbacks["get"]>;

    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      actions: { approve: mockApprove, deny: mockDeny, get: mockGetAction },
    }));

    const payload = makeInteractionPayload("act-001", "atlas_action_approve");
    const formBody = `payload=${encodeURIComponent(payload)}`;
    const { signature, timestamp } = makeSignature(formBody);

    const resp = await app.request("/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: formBody,
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockGetAction).toHaveBeenCalledWith("act-001");
    expect(mockApprove).toHaveBeenCalledWith("act-001", "slack:U789");
  });

  test("denies an action when deny button is clicked", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const mockApprove = mock(() => Promise.resolve({ status: "executed" })) as Mock<ActionCallbacks["approve"]>;
    const mockDeny = mock(() =>
      Promise.resolve({ id: "act-001", status: "denied" }),
    ) as Mock<ActionCallbacks["deny"]>;
    const mockGetAction = mock(() =>
      Promise.resolve({ id: "act-001", action_type: "notification", target: "#revenue", summary: "Send notification" }),
    ) as Mock<ActionCallbacks["get"]>;

    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      actions: { approve: mockApprove, deny: mockDeny, get: mockGetAction },
    }));

    const payload = makeInteractionPayload("act-001", "atlas_action_deny");
    const formBody = `payload=${encodeURIComponent(payload)}`;
    const { signature, timestamp } = makeSignature(formBody);

    const resp = await app.request("/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: formBody,
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockGetAction).toHaveBeenCalledWith("act-001");
    expect(mockDeny).toHaveBeenCalledWith("act-001", "slack:U789");
  });

  test("rejects unsigned interaction requests with 401", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));

    const payload = makeInteractionPayload("act-001", "atlas_action_approve");
    const formBody = `payload=${encodeURIComponent(payload)}`;

    const resp = await app.request("/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=invalid",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: formBody,
    });

    expect(resp.status).toBe(401);
  });

  test("returns 400 when payload is missing", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({ executeQuery: mockExecuteQuery }));

    const formBody = "no_payload_here=true";
    const { signature, timestamp } = makeSignature(formBody);

    const resp = await app.request("/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: formBody,
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe("Missing payload");
  });

  test("works without actions callbacks (ack only)", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      // No actions callback
    }));

    const payload = makeInteractionPayload("act-001", "atlas_action_approve");
    const formBody = `payload=${encodeURIComponent(payload)}`;
    const { signature, timestamp } = makeSignature(formBody);

    const resp = await app.request("/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: formBody,
    });

    // Should ack without error
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Route tests: OAuth
// ---------------------------------------------------------------------------

describe("routes — OAuth", () => {
  beforeEach(() => {
    globalThis.fetch = mockSlackFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GET /install redirects to Slack OAuth URL when configured", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      botToken: undefined,
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
    }));

    const resp = await app.request("/install", {
      method: "GET",
      redirect: "manual",
    });

    expect(resp.status).toBe(302);
    const location = resp.headers.get("location");
    expect(location).toContain("slack.com/oauth/v2/authorize");
    expect(location).toContain("test_client_id");
  });

  test("GET /install returns 501 when OAuth not configured", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      // botToken mode, no clientId
    }));

    const resp = await app.request("/install", { method: "GET" });
    expect(resp.status).toBe(501);
  });

  test("GET /callback returns 501 when OAuth not configured", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
    }));

    const resp = await app.request("/callback?code=test", {
      method: "GET",
    });
    expect(resp.status).toBe(501);
  });

  test("GET /callback returns 400 for invalid state", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      botToken: undefined,
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
    }));

    const resp = await app.request(
      "/callback?code=test_code&state=bogus-state-value",
      { method: "GET" },
    );
    expect(resp.status).toBe(400);
  });

  test("GET /callback returns 400 when code is missing", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(createMockConfig({
      executeQuery: mockExecuteQuery,
      botToken: undefined,
      clientId: "test_client_id",
      clientSecret: "test_client_secret",
    }));

    // Get a valid state first
    const installResp = await app.request("/install", {
      method: "GET",
      redirect: "manual",
    });
    const location = installResp.headers.get("location") ?? "";
    const stateParam = new URL(location).searchParams.get("state");

    const resp = await app.request(
      `/callback?state=${stateParam}`,
      { method: "GET" },
    );
    expect(resp.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Config registration (type-level verification)
// ---------------------------------------------------------------------------

describe("slackPlugin — config registration", () => {
  test("plugin object has all fields required for config validation", () => {
    const plugin = slackPlugin(createMockConfig());

    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(plugin.types)).toBe(true);
    expect(plugin.types.every((t: string) => ["datasource", "context", "interaction", "action", "sandbox"].includes(t))).toBe(true);
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.trim().length).toBeGreaterThan(0);
  });
});
