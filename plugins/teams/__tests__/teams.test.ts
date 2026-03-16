/**
 * Tests for the Microsoft Teams Interaction Plugin.
 *
 * Tests the plugin shape, config validation, lifecycle, route behavior,
 * message parsing (@mention stripping), Adaptive Card formatting, and
 * auth validation.
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
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { definePlugin, isInteractionPlugin } from "@useatlas/plugin-sdk";
import { teamsPlugin, buildTeamsPlugin } from "../src/index";
import type { TeamsPluginConfig, TeamsQueryResult } from "../src/index";
import { stripBotMention } from "../src/routes";
import type { TeamsActivity } from "../src/routes";
import {
  formatQueryResponse,
  formatErrorResponse,
  cardAttachment,
} from "../src/format";
import { verifyBotToken, resetJWKSCache } from "../src/verify";
import { resetTokenCache, isValidServiceUrl } from "../src/teams-client";

// ---------------------------------------------------------------------------
// Global fetch mock — intercepts Azure AD and Bot Connector calls
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

/** RSA key pair for signing test JWTs. Generated once per test suite. */
let testKeyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let testJWK: JWK;

async function setupTestKeys() {
  testKeyPair = await generateKeyPair("RS256");
  testJWK = await exportJWK(testKeyPair.publicKey);
  testJWK.kid = "test-key-id";
  testJWK.use = "sig";
  testJWK.alg = "RS256";
}

async function createTestToken(
  appId: string,
  overrides?: Record<string, unknown>,
): Promise<string> {
  return new SignJWT({
    aud: appId,
    iss: "https://api.botframework.com",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-id" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(testKeyPair.privateKey);
}

function mockTeamsFetch(): typeof globalThis.fetch {
  const mockFn = mock((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // OpenID metadata endpoints
    if (url.includes("login.botframework.com/v1/.well-known/openidconfiguration")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jwks_uri: "https://login.botframework.com/v1/.well-known/keys",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.includes("login.microsoftonline.com/common/v2.0/.well-known/openid-configuration")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jwks_uri:
              "https://login.microsoftonline.com/common/discovery/v2.0/keys",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // JWKS endpoints — return our test public key
    if (
      url.includes("login.botframework.com/v1/.well-known/keys") ||
      url.includes("login.microsoftonline.com/common/discovery/v2.0/keys")
    ) {
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [testJWK] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // Azure AD token endpoint
    if (url.includes("login.microsoftonline.com") && url.includes("oauth2/v2.0/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "mock-access-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // Bot Connector reply endpoint
    if (url.includes("/v3/conversations/") && url.includes("/activities/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "reply-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    // Fallback
    return originalFetch(input, init);
  }) as unknown as typeof globalThis.fetch;
  return mockFn;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_ID = "test-app-id-12345";
const APP_PASSWORD = "test-app-password";

const defaultQueryResult: TeamsQueryResult = {
  answer: "42 active users",
  sql: ["SELECT COUNT(*) FROM users WHERE active = true"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
  steps: 3,
  usage: { totalTokens: 150 },
};

function createMockConfig(
  overrides?: Partial<TeamsPluginConfig>,
): TeamsPluginConfig {
  return {
    appId: APP_ID,
    appPassword: APP_PASSWORD,
    executeQuery: mock(() =>
      Promise.resolve(defaultQueryResult),
    ) as TeamsPluginConfig["executeQuery"],
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

function createTestApp(config: TeamsPluginConfig): Hono {
  const plugin = buildTeamsPlugin(config);
  const app = new Hono();
  plugin.routes!(app);
  return app;
}

function makeMessageActivity(
  text: string,
  overrides?: Partial<TeamsActivity>,
): TeamsActivity {
  return {
    type: "message",
    id: "activity-1",
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    channelId: "msteams",
    from: { id: "user-1", name: "Test User", aadObjectId: "aad-user-1" },
    conversation: { id: "conv-1", tenantId: "tenant-1" },
    recipient: { id: "28:bot-app-id", name: "Atlas" },
    text,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await setupTestKeys();
  resetJWKSCache();
  resetTokenCache();
});

// ---------------------------------------------------------------------------
// Plugin shape validation
// ---------------------------------------------------------------------------

describe("teamsPlugin — shape validation", () => {
  test("createPlugin() produces a valid AtlasInteractionPlugin", () => {
    const plugin = teamsPlugin(createMockConfig());
    expect(plugin.id).toBe("teams-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Microsoft Teams Bot");
  });

  test("definePlugin() accepts the created plugin", () => {
    const plugin = teamsPlugin(createMockConfig());
    const validated = definePlugin(plugin);
    expect(validated).toBe(plugin);
  });

  test("isInteractionPlugin type guard returns true", () => {
    const plugin = teamsPlugin(createMockConfig());
    expect(isInteractionPlugin(plugin)).toBe(true);
  });

  test("config is stored on the plugin object", () => {
    const config = createMockConfig();
    const plugin = teamsPlugin(config);
    expect(plugin.config?.appId).toBe(APP_ID);
    expect(plugin.config?.appPassword).toBe(APP_PASSWORD);
  });

  test("routes is defined", () => {
    const plugin = teamsPlugin(createMockConfig());
    expect(typeof plugin.routes).toBe("function");
  });

  test("buildTeamsPlugin is available for direct use", () => {
    const plugin = buildTeamsPlugin(createMockConfig());
    expect(plugin.id).toBe("teams-interaction");
    expect(plugin.types).toEqual(["interaction"]);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("teamsPlugin — config validation", () => {
  test("accepts valid config", () => {
    expect(() =>
      teamsPlugin({
        appId: "app-id",
        appPassword: "app-password",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("accepts config with tenantId", () => {
    expect(() =>
      teamsPlugin({
        appId: "app-id",
        appPassword: "app-password",
        tenantId: "tenant-123",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).not.toThrow();
  });

  test("rejects empty appId", () => {
    expect(() =>
      teamsPlugin({
        appId: "",
        appPassword: "app-password",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects empty appPassword", () => {
    expect(() =>
      teamsPlugin({
        appId: "app-id",
        appPassword: "",
        executeQuery: mock(() => Promise.resolve(defaultQueryResult)),
      }),
    ).toThrow("Plugin config validation failed");
  });

  test("rejects non-function executeQuery", () => {
    expect(() =>
      teamsPlugin({
        appId: "app-id",
        appPassword: "app-password",
        executeQuery:
          "not-a-function" as unknown as TeamsPluginConfig["executeQuery"],
      }),
    ).toThrow("Plugin config validation failed");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("teamsPlugin — lifecycle", () => {
  test("initializes successfully", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const { ctx, logged } = createMockCtx();

    await plugin.initialize!(ctx as never);
    expect(logged.some((m) => m.includes("initialized"))).toBe(true);
  });

  test("double initialize throws", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await expect(plugin.initialize!(ctx as never)).rejects.toThrow(
      "already initialized",
    );
  });

  test("healthCheck returns unhealthy before init", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("healthCheck returns healthy after init", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  test("healthCheck returns unhealthy after teardown", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  test("teardown is safe to call without initialization", async () => {
    const plugin = teamsPlugin(createMockConfig());
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("teardown is safe to call twice", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    await plugin.initialize!(ctx as never);
    await plugin.teardown!();
    await expect(plugin.teardown!()).resolves.toBeUndefined();
  });

  test("full lifecycle: init → health → teardown", async () => {
    const plugin = teamsPlugin(createMockConfig());
    const { ctx } = createMockCtx();

    const before = await plugin.healthCheck!();
    expect(before.healthy).toBe(false);

    await plugin.initialize!(ctx as never);
    const during = await plugin.healthCheck!();
    expect(during.healthy).toBe(true);

    await plugin.teardown!();
    const after = await plugin.healthCheck!();
    expect(after.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Message parsing — @mention stripping
// ---------------------------------------------------------------------------

describe("stripBotMention", () => {
  test("strips bot @mention from message text", () => {
    const result = stripBotMention(
      "<at>Atlas</at> how many users do we have?",
      "28:bot-app-id",
      [
        {
          type: "mention",
          mentioned: { id: "28:bot-app-id", name: "Atlas" },
          text: "<at>Atlas</at>",
        },
      ],
    );
    expect(result).toBe("how many users do we have?");
  });

  test("preserves text when no mention entities", () => {
    const result = stripBotMention("how many users?", "28:bot-app-id");
    expect(result).toBe("how many users?");
  });

  test("preserves text when mention is for a different user", () => {
    const result = stripBotMention(
      "<at>Other User</at> how many users?",
      "28:bot-app-id",
      [
        {
          type: "mention",
          mentioned: { id: "28:other-user", name: "Other User" },
          text: "<at>Other User</at>",
        },
      ],
    );
    expect(result).toBe("<at>Other User</at> how many users?");
  });

  test("handles multiple mentions, only strips bot mention", () => {
    const result = stripBotMention(
      "<at>Atlas</at> <at>John</at> how many users?",
      "28:bot-app-id",
      [
        {
          type: "mention",
          mentioned: { id: "28:bot-app-id", name: "Atlas" },
          text: "<at>Atlas</at>",
        },
        {
          type: "mention",
          mentioned: { id: "user-john", name: "John" },
          text: "<at>John</at>",
        },
      ],
    );
    expect(result).toBe("<at>John</at> how many users?");
  });

  test("handles empty text", () => {
    const result = stripBotMention("", "28:bot-app-id");
    expect(result).toBe("");
  });

  test("trims whitespace after stripping mention", () => {
    const result = stripBotMention(
      "  <at>Atlas</at>   query here  ",
      "28:bot-app-id",
      [
        {
          type: "mention",
          mentioned: { id: "28:bot-app-id", name: "Atlas" },
          text: "<at>Atlas</at>",
        },
      ],
    );
    expect(result).toBe("query here");
  });

  test("handles entities with no text field", () => {
    const result = stripBotMention(
      "<at>Atlas</at> query",
      "28:bot-app-id",
      [
        {
          type: "mention",
          mentioned: { id: "28:bot-app-id", name: "Atlas" },
        },
      ],
    );
    expect(result).toBe("<at>Atlas</at> query");
  });
});

// ---------------------------------------------------------------------------
// Adaptive Card formatting
// ---------------------------------------------------------------------------

describe("formatQueryResponse", () => {
  test("creates valid Adaptive Card with answer", () => {
    const card = formatQueryResponse(defaultQueryResult);
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");
    expect(card.body.length).toBeGreaterThan(0);
    const answerBlock = card.body[0];
    expect(answerBlock.type).toBe("TextBlock");
    if (answerBlock.type === "TextBlock") {
      expect(answerBlock.text).toBe("42 active users");
    }
  });

  test("includes SQL section", () => {
    const card = formatQueryResponse(defaultQueryResult);
    const sqlBlocks = card.body.filter(
      (b) =>
        b.type === "TextBlock" &&
        (b.text === "**SQL**" || b.fontType === "Monospace"),
    );
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(1);
  });

  test("includes data table section", () => {
    const card = formatQueryResponse(defaultQueryResult);
    const dataBlocks = card.body.filter(
      (b) => b.type === "TextBlock" && b.text === "**Results**",
    );
    expect(dataBlocks.length).toBe(1);
  });

  test("includes metadata", () => {
    const card = formatQueryResponse(defaultQueryResult);
    const metaBlock = card.body.find(
      (b) =>
        b.type === "TextBlock" &&
        "isSubtle" in b &&
        b.isSubtle === true,
    );
    expect(metaBlock).toBeDefined();
    if (metaBlock?.type === "TextBlock") {
      expect(metaBlock.text).toContain("3 steps");
      expect(metaBlock.text).toContain("150 tokens");
    }
  });

  test("handles empty data", () => {
    const card = formatQueryResponse({
      ...defaultQueryResult,
      data: [],
      sql: [],
    });
    expect(card.body.length).toBeGreaterThan(0);
    // Should have answer + metadata at minimum
  });

  test("handles long answers by truncating", () => {
    const longAnswer = "x".repeat(3000);
    const card = formatQueryResponse({
      ...defaultQueryResult,
      answer: longAnswer,
    });
    const answerBlock = card.body[0];
    if (answerBlock.type === "TextBlock") {
      expect(answerBlock.text.length).toBeLessThanOrEqual(2000);
      expect(answerBlock.text.endsWith("...")).toBe(true);
    }
  });
});

describe("formatErrorResponse", () => {
  test("creates error Adaptive Card", () => {
    const card = formatErrorResponse("Something broke");
    expect(card.type).toBe("AdaptiveCard");
    expect(card.body.length).toBe(1);
    if (card.body[0].type === "TextBlock") {
      expect(card.body[0].text).toContain("Something broke");
    }
  });
});

describe("cardAttachment", () => {
  test("wraps card as Bot Framework attachment", () => {
    const card = formatQueryResponse(defaultQueryResult);
    const attachment = cardAttachment(card);
    expect(attachment.contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(attachment.content).toBe(card);
  });
});

// ---------------------------------------------------------------------------
// Route tests: POST /messages
// ---------------------------------------------------------------------------

describe("routes — POST /messages", () => {
  let mockExecuteQuery: Mock<(q: string) => Promise<TeamsQueryResult>>;
  let fetchMock: typeof globalThis.fetch;

  beforeEach(async () => {
    await setupTestKeys();
    resetJWKSCache();
    resetTokenCache();
    mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    fetchMock = mockTeamsFetch();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects requests without Authorization header", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );

    const resp = await app.request("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(401);
  });

  test("rejects requests with invalid token", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token",
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(401);
  });

  test("accepts valid Bot Framework token and processes message", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );
    const token = await createTestToken(APP_ID);

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.status).toBe("ok");

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecuteQuery).toHaveBeenCalledWith("how many users?");
  });

  test("strips @mention before querying", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );
    const token = await createTestToken(APP_ID);

    const activity = makeMessageActivity(
      "<at>Atlas</at> how many users?",
      {
        entities: [
          {
            type: "mention",
            mentioned: { id: "28:bot-app-id", name: "Atlas" },
            text: "<at>Atlas</at>",
          },
        ],
      },
    );

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecuteQuery).toHaveBeenCalledWith("how many users?");
  });

  test("acks conversationUpdate silently", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );
    const token = await createTestToken(APP_ID);

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...makeMessageActivity(""),
        type: "conversationUpdate",
      }),
    });

    expect(resp.status).toBe(200);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("ignores empty messages after mention stripping", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );
    const token = await createTestToken(APP_ID);

    const activity = makeMessageActivity("<at>Atlas</at>", {
      entities: [
        {
          type: "mention",
          mentioned: { id: "28:bot-app-id", name: "Atlas" },
          text: "<at>Atlas</at>",
        },
      ],
    });

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route tests: Rate limiting
// ---------------------------------------------------------------------------

describe("routes — rate limiting", () => {
  beforeEach(async () => {
    await setupTestKeys();
    resetJWKSCache();
    resetTokenCache();
    globalThis.fetch = mockTeamsFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rate-limited requests do not call executeQuery", async () => {
    const mockCheckRateLimit = mock(() => ({ allowed: false }));
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));

    const app = createTestApp(
      createMockConfig({
        executeQuery: mockExecuteQuery,
        checkRateLimit: mockCheckRateLimit,
      }),
    );
    const token = await createTestToken(APP_ID);

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config registration (type-level verification)
// ---------------------------------------------------------------------------

describe("teamsPlugin — config registration", () => {
  test("plugin object has all fields required for config validation", () => {
    const plugin = teamsPlugin(createMockConfig());

    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(plugin.types)).toBe(true);
    expect(
      plugin.types.every((t: string) =>
        ["datasource", "context", "interaction", "action", "sandbox"].includes(
          t,
        ),
      ),
    ).toBe(true);
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Service URL validation (SSRF prevention)
// ---------------------------------------------------------------------------

describe("isValidServiceUrl", () => {
  test("accepts known Bot Framework service URLs", () => {
    expect(isValidServiceUrl("https://smba.trafficmanager.net/teams/")).toBe(true);
    expect(isValidServiceUrl("https://smba.trafficmanager.net/emea/")).toBe(true);
    expect(isValidServiceUrl("https://webchat.botframework.com/")).toBe(true);
  });

  test("rejects non-HTTPS URLs", () => {
    expect(isValidServiceUrl("http://smba.trafficmanager.net/teams/")).toBe(false);
  });

  test("rejects arbitrary URLs", () => {
    expect(isValidServiceUrl("https://evil.example.com/")).toBe(false);
    expect(isValidServiceUrl("https://attacker.com/v3/conversations/")).toBe(false);
  });

  test("rejects empty and malformed URLs", () => {
    expect(isValidServiceUrl("")).toBe(false);
    expect(isValidServiceUrl("not-a-url")).toBe(false);
  });
});

describe("routes — serviceUrl validation", () => {
  beforeEach(async () => {
    await setupTestKeys();
    resetJWKSCache();
    resetTokenCache();
    globalThis.fetch = mockTeamsFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects activities with invalid serviceUrl", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(
      createMockConfig({ executeQuery: mockExecuteQuery }),
    );
    const token = await createTestToken(APP_ID);

    const activity = makeMessageActivity("how many users?", {
      serviceUrl: "https://evil.example.com/",
    });

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    });

    expect(resp.status).toBe(400);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tenant ID restriction
// ---------------------------------------------------------------------------

describe("routes — tenant restriction", () => {
  beforeEach(async () => {
    await setupTestKeys();
    resetJWKSCache();
    resetTokenCache();
    globalThis.fetch = mockTeamsFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects tokens missing tid claim when tenantId is configured", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(
      createMockConfig({
        executeQuery: mockExecuteQuery,
        tenantId: "expected-tenant-123",
      }),
    );
    // Token without tid claim
    const token = await createTestToken(APP_ID);

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(401);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("rejects tokens with wrong tid when tenantId is configured", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(
      createMockConfig({
        executeQuery: mockExecuteQuery,
        tenantId: "expected-tenant-123",
      }),
    );
    const token = await createTestToken(APP_ID, { tid: "wrong-tenant-456" });

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(401);
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("accepts tokens with correct tid when tenantId is configured", async () => {
    const mockExecuteQuery = mock(() => Promise.resolve(defaultQueryResult));
    const app = createTestApp(
      createMockConfig({
        executeQuery: mockExecuteQuery,
        tenantId: "correct-tenant-123",
      }),
    );
    const token = await createTestToken(APP_ID, { tid: "correct-tenant-123" });

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mockExecuteQuery).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Direct verifyBotToken unit tests
// ---------------------------------------------------------------------------

describe("verifyBotToken", () => {
  beforeEach(async () => {
    await setupTestKeys();
    resetJWKSCache();
    globalThis.fetch = mockTeamsFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects missing Authorization header", async () => {
    const result = await verifyBotToken(null, APP_ID);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Missing Authorization header");
    }
  });

  test("rejects non-Bearer auth scheme", async () => {
    const result = await verifyBotToken("Basic dXNlcjpwYXNz", APP_ID);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Invalid Authorization header format");
    }
  });

  test("rejects malformed Bearer token", async () => {
    const result = await verifyBotToken("Bearer not-a-jwt", APP_ID);
    expect(result.valid).toBe(false);
  });

  test("rejects token with wrong audience", async () => {
    const token = await createTestToken("wrong-app-id");
    const result = await verifyBotToken(`Bearer ${token}`, APP_ID);
    expect(result.valid).toBe(false);
  });

  test("rejects token with unrecognized issuer", async () => {
    const token = await createTestToken(APP_ID, {
      iss: "https://evil-issuer.com",
    });
    const result = await verifyBotToken(`Bearer ${token}`, APP_ID);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Unrecognized token issuer");
    }
  });

  test("rejects expired token", async () => {
    const token = await new SignJWT({
      aud: APP_ID,
      iss: "https://api.botframework.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-id" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(testKeyPair.privateKey);

    const result = await verifyBotToken(`Bearer ${token}`, APP_ID);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Token expired");
    }
  });

  test("accepts valid Bot Framework token", async () => {
    const token = await createTestToken(APP_ID);
    const result = await verifyBotToken(`Bearer ${token}`, APP_ID);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.aud).toBe(APP_ID);
      expect(result.claims.iss).toBe("https://api.botframework.com");
    }
  });

  test("accepts valid Azure AD token", async () => {
    const token = await createTestToken(APP_ID, {
      iss: "https://sts.windows.net/tenant-123/",
      tid: "tenant-123",
    });
    const result = await verifyBotToken(`Bearer ${token}`, APP_ID);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route edge cases
// ---------------------------------------------------------------------------

describe("routes — edge cases", () => {
  beforeEach(async () => {
    await setupTestKeys();
    resetJWKSCache();
    resetTokenCache();
    globalThis.fetch = mockTeamsFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 400 for invalid JSON body", async () => {
    const app = createTestApp(
      createMockConfig({ executeQuery: mock(() => Promise.resolve(defaultQueryResult)) }),
    );
    const token = await createTestToken(APP_ID);

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "this is not json",
    });

    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.error).toBe("Invalid JSON");
  });

  test("sends error card when executeQuery throws", async () => {
    const failingQuery = mock(() => Promise.reject(new Error("query failed")));
    const app = createTestApp(
      createMockConfig({ executeQuery: failingQuery }),
    );
    const token = await createTestToken(APP_ID);

    const resp = await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("how many users?")),
    });

    expect(resp.status).toBe(200);
    // Wait for async processing (error path sends error card)
    await new Promise((r) => setTimeout(r, 200));

    // Verify that the Bot Connector was called (error reply attempt)
    const fetchMock = globalThis.fetch as unknown as Mock<typeof fetch>;
    const connectorCalls = fetchMock.mock.calls.filter(
      (call) => {
        const url = typeof call[0] === "string" ? call[0] : "";
        return url.includes("/v3/conversations/");
      },
    );
    expect(connectorCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("uses scrubError callback when provided", async () => {
    const failingQuery = mock(() => Promise.reject(new Error("secret db error")));
    const scrubError = mock(() => "Something went wrong");
    const app = createTestApp(
      createMockConfig({ executeQuery: failingQuery, scrubError }),
    );
    const token = await createTestToken(APP_ID);

    await app.request("/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(makeMessageActivity("query")),
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(scrubError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Data table truncation
// ---------------------------------------------------------------------------

describe("formatQueryResponse — data truncation", () => {
  test("truncates large data tables with row count note", () => {
    const manyRows = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
    }));
    const card = formatQueryResponse({
      answer: "Here are the users",
      sql: ["SELECT * FROM users"],
      data: [{ columns: ["id", "name"], rows: manyRows }],
      steps: 2,
      usage: { totalTokens: 100 },
    });

    const tableBlock = card.body.find(
      (b) =>
        b.type === "TextBlock" &&
        "fontType" in b &&
        b.fontType === "Monospace" &&
        b.text.includes("id"),
    );
    expect(tableBlock).toBeDefined();
    if (tableBlock?.type === "TextBlock") {
      expect(tableBlock.text).toContain("Showing first 20 of 30 rows");
    }
  });
});
