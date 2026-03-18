/**
 * E2E: Slack integration tests.
 *
 * Tests the full Slack surface: signature verification, slash commands,
 * thread follow-ups, action button interactions, OAuth flow, and error
 * scrubbing. Uses in-process Hono app.fetch() with mocked dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock, type Mock } from "bun:test";
import { makeSignature } from "../helpers/slack-helpers";
import { createRoutedMockServer, type MockServer } from "../helpers/mock-server";
import { createConnectionMock } from "../../packages/api/src/__mocks__/connection";

// --- Test constants ---

const SIGNING_SECRET = "test-signing-secret-for-e2e";
const BOT_TOKEN = "xoxb-test-bot-token";
const TEAM_ID = "T_TEST_TEAM";
const CHANNEL_ID = "C_TEST_CHANNEL";
const USER_ID = "U_TEST_USER";

// Set env before any module imports
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
process.env.SLACK_BOT_TOKEN = BOT_TOKEN;

// --- Mock Slack API server ---

let slackMock: MockServer;

function startSlackMock() {
  slackMock = createRoutedMockServer({
    "/api/chat.postMessage": async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ok: true, ts: "1234567890.123456", channel: body.channel }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
    "/api/chat.update": async () => {
      return new Response(
        JSON.stringify({ ok: true }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
    "/api/chat.postEphemeral": async () => {
      return new Response(
        JSON.stringify({ ok: true }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
    "/api/oauth.v2.access": async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-new-token",
          team: { id: "T_NEW_TEAM" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
}

// --- Mocks (must come before app import) ---

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
  resetStartupCache: mock(() => {}),
}));

mock.module("@atlas/api/lib/db/connection", () => {
  const mockDBConn = {
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  };
  return createConnectionMock({
    getDB: () => mockDBConn,
    connections: {
      get: () => mockDBConn,
      getDefault: () => mockDBConn,
      list: () => [],
      describe: () => [],
    },
    rewriteClickHouseUrl: (url: string) => url,
    parseSnowflakeURL: () => ({}),
  });
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  getInternalDB: () => { throw new Error("No internal DB"); },
  internalQuery: async () => [],
  internalExecute: () => {},
  closeInternalDB: async () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: async () => {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
  getAuthModeSource: () => null,
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "none",
      user: { id: "test-user", role: "analyst" },
    }),
  ),
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
  resetRateLimits: mock(() => {}),
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
  buildSystemParam: mock(() => ({})),
  applyCacheControl: mock(() => {}),
}));

const mockExecuteAgentQuery: Mock<(question: string, requestId?: string, options?: unknown) => Promise<{
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  pendingActions?: { id: string; type: string; target: string; summary: string }[];
}>> = mock(() =>
  Promise.resolve({
    answer: "There are 42 active users.",
    sql: ["SELECT count(*) FROM users WHERE active = true"],
    data: [{ columns: ["count"], rows: [{ count: 42 }] }],
    steps: 3,
    usage: { totalTokens: 1500 },
  }),
);

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: { name: "createJiraTicket", description: "Mock", tool: { type: "function" }, actionType: "jira:create", reversible: true, defaultApproval: "manual", requiredCredentials: ["JIRA_BASE_URL"] },
  sendEmailReport: { name: "sendEmailReport", description: "Mock", tool: { type: "function" }, actionType: "email:send", reversible: false, defaultApproval: "admin-only", requiredCredentials: ["RESEND_API_KEY"] },
}));

const mockGetAction: Mock<(actionId: string) => Promise<{
  id: string;
  action_type: string;
  target: string;
  summary: string;
  status: string;
} | null>> = mock(() => Promise.resolve(null));

const mockApproveAction: Mock<(actionId: string, approverId: string) => Promise<{
  id: string;
  status: string;
  error?: string | null;
} | null>> = mock(() => Promise.resolve(null));

const mockDenyAction: Mock<(actionId: string, denierId: string) => Promise<{
  id: string;
  status: string;
} | null>> = mock(() => Promise.resolve(null));

mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  handleAction: mock(() => Promise.resolve({ status: "pending_approval", actionId: "act-1" })),
  approveAction: mockApproveAction,
  denyAction: mockDenyAction,
  getAction: mockGetAction,
  listPendingActions: mock(() => Promise.resolve([])),
  registerActionExecutor: mock(() => {}),
  getActionExecutor: mock(() => undefined),
  getActionConfig: mock(() => ({ approval: "manual" as const })),
  buildActionRequest: mock(() => ({})),
  _resetActionStore: mock(() => {}),
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() =>
    Promise.resolve({
      ok: true as const,
      data: {
        id: "conv-1",
        title: "test",
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
        ],
      },
    }),
  ),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  starConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

const mockGetBotToken: Mock<() => Promise<string | null>> = mock(() =>
  Promise.resolve(BOT_TOKEN),
);
const mockSaveInstallation: Mock<() => Promise<void>> = mock(() =>
  Promise.resolve(),
);

mock.module("@atlas/api/lib/slack/store", () => ({
  getBotToken: mockGetBotToken,
  getInstallation: mock(() => Promise.resolve({ team_id: TEAM_ID, bot_token: BOT_TOKEN, installed_at: new Date().toISOString() })),
  saveInstallation: mockSaveInstallation,
  deleteInstallation: mock(() => Promise.resolve()),
}));

const mockGetConversationId: Mock<() => Promise<string | null>> = mock(() =>
  Promise.resolve(null),
);
const mockSetConversationId: Mock<() => Promise<void>> = mock(() =>
  Promise.resolve(),
);

mock.module("@atlas/api/lib/slack/threads", () => ({
  getConversationId: mockGetConversationId,
  setConversationId: mockSetConversationId,
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
  configFromEnv: () => ({}),
  loadConfig: async () => null,
  initializeConfig: async () => {},
  validateAndResolve: () => ({}),
  defineConfig: (c: unknown) => c,
  _resetConfig: () => {},
  validateToolConfig: async () => {},
  applyDatasources: async () => {},
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, payload: unknown) => payload,
}));

// Start mock server once — clear calls between tests instead of restarting
startSlackMock();

// Redirect Slack API calls to our mock server — override the fetch for Slack API domain
const originalFetch = globalThis.fetch;
const patchedFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://slack.com/api/")) {
    const path = new URL(url).pathname;
    const redirectUrl = `${slackMock.url}${path}`;
    // Re-create the request targeting local mock server
    const headers = init?.headers ?? (input instanceof Request ? Object.fromEntries(input.headers.entries()) : {});
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    return originalFetch(redirectUrl, { method: "POST", headers, body });
  }
  return originalFetch(input, init);
};
// Preserve preconnect if present on the original fetch
if ("preconnect" in originalFetch) {
  (patchedFetch as typeof globalThis.fetch).preconnect = (originalFetch as typeof globalThis.fetch).preconnect;
}
globalThis.fetch = patchedFetch as typeof globalThis.fetch;

// --- Import app after mocks and env setup ---

const { app } = await import("../../packages/api/src/api/index");

// --- Helpers ---

function makeSlackCommandBody(text: string): string {
  const params = new URLSearchParams({
    text,
    channel_id: CHANNEL_ID,
    user_id: USER_ID,
    team_id: TEAM_ID,
    response_url: `${slackMock.url}/response`,
    command: "/atlas",
  });
  return params.toString();
}

function makeSignedRequest(
  path: string,
  body: string,
  contentType = "application/x-www-form-urlencoded",
  overrides?: { signature?: string; timestamp?: string },
): Request {
  const { signature, timestamp } = overrides?.signature
    ? { signature: overrides.signature, timestamp: overrides.timestamp ?? String(Math.floor(Date.now() / 1000)) }
    : makeSignature(SIGNING_SECRET, body, overrides?.timestamp);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/** Poll until condition is met or timeout. */
async function waitFor(
  check: () => boolean,
  { timeout = 5000, interval = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!check()) throw new Error("waitFor timed out");
}

// --- Setup / Teardown ---

beforeEach(() => {
  // Clear call tracking (mock server stays alive)
  slackMock.calls.length = 0;
  slackMock.errors.length = 0;
  mockExecuteAgentQuery.mockClear();
  mockGetBotToken.mockClear();
  mockGetBotToken.mockResolvedValue(BOT_TOKEN);
  mockSaveInstallation.mockClear();
  mockGetConversationId.mockClear();
  mockGetConversationId.mockResolvedValue(null);
  mockSetConversationId.mockClear();
  mockGetAction.mockClear();
  mockApproveAction.mockClear();
  mockDenyAction.mockClear();
});

afterEach(() => {
  expect(slackMock.errors).toHaveLength(0);
});

afterAll(() => {
  try {
    if (slackMock) slackMock.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Tests ---

describe("E2E: Slack signature verification", () => {
  it("accepts requests with a valid HMAC-SHA256 signature", async () => {
    const body = makeSlackCommandBody("how many users?");
    const req = makeSignedRequest("/api/v1/slack/commands", body);
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    // Wait for async processing to complete so it doesn't leak into the next test
    await waitFor(() => slackMock.calls.some((c) => c.path === "/api/chat.update"));
  });

  it("rejects requests with an invalid signature", async () => {
    const body = makeSlackCommandBody("how many users?");
    const req = makeSignedRequest("/api/v1/slack/commands", body, "application/x-www-form-urlencoded", {
      signature: "v0=0000000000000000000000000000000000000000000000000000000000000000",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid signature");
  });

  it("rejects requests with a stale timestamp (>5 minutes)", async () => {
    const body = makeSlackCommandBody("how many users?");
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400); // 6+ minutes ago
    const req = makeSignedRequest("/api/v1/slack/commands", body, "application/x-www-form-urlencoded", {
      timestamp: staleTimestamp,
    });
    // The signature will be computed with the stale timestamp, so HMAC is valid but timestamp check should fail
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it("rejects all requests when SLACK_SIGNING_SECRET is not set", async () => {
    const orig = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    try {
      const body = makeSlackCommandBody("test");
      const req = makeSignedRequest("/api/v1/slack/commands", body);
      const res = await app.fetch(req);
      expect(res.status).toBe(401);
    } finally {
      process.env.SLACK_SIGNING_SECRET = orig;
    }
  });
});

describe("E2E: Slash command flow", () => {
  it("acks immediately with 200 and processes async", async () => {
    const body = makeSlackCommandBody("how many active users?");
    const req = makeSignedRequest("/api/v1/slack/commands", body);
    const res = await app.fetch(req);

    // Immediate ack
    expect(res.status).toBe(200);
    const json = (await res.json()) as { response_type: string; text: string };
    expect(json.response_type).toBe("in_channel");

    // Wait for async processing — poll for the expected mock server calls
    await waitFor(() => slackMock.calls.some((c) => c.path === "/api/chat.update"));

    // Verify mock Slack API received postMessage (thinking) + update (result)
    const postCalls = slackMock.calls.filter((c) => c.path === "/api/chat.postMessage");
    const updateCalls = slackMock.calls.filter((c) => c.path === "/api/chat.update");

    expect(postCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(1);

    // Verify the thinking message was posted
    const thinkingBody = JSON.parse(postCalls[0].body);
    expect(thinkingBody.channel).toBe(CHANNEL_ID);
    expect(thinkingBody.text).toContain("Thinking about");

    // Verify the update message contains the agent answer
    const updateBody = JSON.parse(updateCalls[0].body);
    expect(updateBody.text).toContain("42 active users");
  });

  it("returns usage hint when slash command has no text", async () => {
    const body = makeSlackCommandBody("");
    const req = makeSignedRequest("/api/v1/slack/commands", body);
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { response_type: string; text: string };
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("Usage:");
  });
});

describe("E2E: Thread follow-up", () => {
  it("processes event_callback with thread_ts and calls agent with history", async () => {
    // Set up existing conversation mapping
    mockGetConversationId.mockResolvedValue("conv-existing-123");

    const eventPayload = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        text: "what about last week?",
        channel: CHANNEL_ID,
        thread_ts: "1234567890.123456",
        user: USER_ID,
      },
    });

    const req = makeSignedRequest("/api/v1/slack/events", eventPayload, "application/json");
    const res = await app.fetch(req);

    // Events endpoint acks immediately
    expect(res.status).toBe(200);

    // Wait for async processing — poll until agent is called
    await waitFor(() => mockExecuteAgentQuery.mock.calls.length > 0);

    // Verify agent was called with correct question
    expect(mockExecuteAgentQuery).toHaveBeenCalled();
    const callArgs = mockExecuteAgentQuery.mock.calls[0];
    expect(callArgs[0]).toBe("what about last week?");

    // Verify priorMessages were passed from conversation history
    const options = callArgs[2] as { priorMessages?: unknown[] } | undefined;
    expect(options?.priorMessages).toBeDefined();
    expect(options!.priorMessages).toHaveLength(2);
  });

  it("handles url_verification challenge", async () => {
    const challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
    const payload = JSON.stringify({
      type: "url_verification",
      challenge,
    });

    const req = makeSignedRequest("/api/v1/slack/events", payload, "application/json");
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe(challenge);
  });

  it("ignores bot messages to prevent loops", async () => {
    const eventPayload = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        text: "bot response",
        channel: CHANNEL_ID,
        thread_ts: "1234567890.123456",
        bot_id: "B_BOT",
      },
    });

    const req = makeSignedRequest("/api/v1/slack/events", eventPayload, "application/json");
    const res = await app.fetch(req);

    expect(res.status).toBe(200);

    // Give async handler a chance to (not) run, then verify agent was not called
    await waitFor(() => slackMock.calls.length >= 0, { timeout: 300 });
    expect(mockExecuteAgentQuery).not.toHaveBeenCalled();
  });
});

describe("E2E: Action button interactions", () => {
  it("processes approve action via block_actions", async () => {
    const actionId = "act-test-approve";
    mockGetAction.mockResolvedValue({
      id: actionId,
      action_type: "jira:create",
      target: "JIRA-123",
      summary: "Create ticket for data anomaly",
      status: "pending",
    });
    mockApproveAction.mockResolvedValue({
      id: actionId,
      status: "executed",
      error: null,
    });

    const interactionPayload = JSON.stringify({
      type: "block_actions",
      user: { id: USER_ID },
      actions: [
        { action_id: "atlas_action_approve", value: actionId },
      ],
      response_url: `${slackMock.url}/response`,
    });

    const body = `payload=${encodeURIComponent(interactionPayload)}`;
    const req = makeSignedRequest("/api/v1/slack/interactions", body);
    const res = await app.fetch(req);

    // Interactions ack immediately
    expect(res.status).toBe(200);

    // Wait for async processing — poll until approveAction is called
    await waitFor(() => mockApproveAction.mock.calls.length > 0);

    // Verify approveAction was called
    expect(mockApproveAction).toHaveBeenCalled();
    const approveArgs = mockApproveAction.mock.calls[0];
    expect(approveArgs[0]).toBe(actionId);
    expect(approveArgs[1]).toBe(`slack:${USER_ID}`);
  });

  it("processes deny action via block_actions", async () => {
    const actionId = "act-test-deny";
    mockGetAction.mockResolvedValue({
      id: actionId,
      action_type: "email:send",
      target: "team@example.com",
      summary: "Send weekly report",
      status: "pending",
    });
    mockDenyAction.mockResolvedValue({
      id: actionId,
      status: "denied",
    });

    const interactionPayload = JSON.stringify({
      type: "block_actions",
      user: { id: USER_ID },
      actions: [
        { action_id: "atlas_action_deny", value: actionId },
      ],
      response_url: `${slackMock.url}/response`,
    });

    const body = `payload=${encodeURIComponent(interactionPayload)}`;
    const req = makeSignedRequest("/api/v1/slack/interactions", body);
    const res = await app.fetch(req);

    expect(res.status).toBe(200);

    // Wait for async processing — poll until denyAction is called
    await waitFor(() => mockDenyAction.mock.calls.length > 0);

    expect(mockDenyAction).toHaveBeenCalled();
    const denyArgs = mockDenyAction.mock.calls[0];
    expect(denyArgs[0]).toBe(actionId);
    expect(denyArgs[1]).toBe(`slack:${USER_ID}`);
  });
});

describe("E2E: OAuth install + callback", () => {
  it("redirects to Slack OAuth authorize URL on install", async () => {
    const originalClientId = process.env.SLACK_CLIENT_ID;
    process.env.SLACK_CLIENT_ID = "test-client-id";

    try {
      const res = await app.fetch(new Request("http://localhost/api/slack/install"));
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toContain("https://slack.com/oauth/v2/authorize");
      expect(location).toContain("client_id=test-client-id");
      expect(location).toContain("state=");
    } finally {
      if (originalClientId) {
        process.env.SLACK_CLIENT_ID = originalClientId;
      } else {
        delete process.env.SLACK_CLIENT_ID;
      }
    }
  });

  it("returns 501 when OAuth is not configured", async () => {
    const originalClientId = process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_ID;

    try {
      const res = await app.fetch(new Request("http://localhost/api/slack/install"));
      expect(res.status).toBe(501);
    } finally {
      if (originalClientId) {
        process.env.SLACK_CLIENT_ID = originalClientId;
      }
    }
  });

  it("rejects callback with invalid state parameter", async () => {
    const originalClientId = process.env.SLACK_CLIENT_ID;
    const originalClientSecret = process.env.SLACK_CLIENT_SECRET;
    process.env.SLACK_CLIENT_ID = "test-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-client-secret";

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/slack/callback?state=invalid-state&code=test-code"),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("Invalid or expired state");
    } finally {
      if (originalClientId) {
        process.env.SLACK_CLIENT_ID = originalClientId;
      } else {
        delete process.env.SLACK_CLIENT_ID;
      }
      if (originalClientSecret) {
        process.env.SLACK_CLIENT_SECRET = originalClientSecret;
      } else {
        delete process.env.SLACK_CLIENT_SECRET;
      }
    }
  });
});

describe("E2E: Error scrubbing", () => {
  it("scrubs errors matching SENSITIVE_PATTERNS (e.g. password keyword)", async () => {
    // Error contains "password" which matches SENSITIVE_PATTERNS regex
    mockExecuteAgentQuery.mockRejectedValueOnce(
      new Error("invalid password for user postgres at connection string postgresql://admin:s3cret@db.internal:5432/prod"),
    );

    const body = makeSlackCommandBody("query that fails");
    const req = makeSignedRequest("/api/v1/slack/commands", body);
    const res = await app.fetch(req);

    // Ack is still 200
    expect(res.status).toBe(200);

    // Wait for async error handling — poll for the error message to appear
    await waitFor(() =>
      slackMock.calls.filter((c) => c.path === "/api/chat.postMessage").length >= 1 &&
      slackMock.calls.filter((c) => c.path === "/api/chat.postMessage").some((c) => {
        const parsed = JSON.parse(c.body);
        return parsed.text?.includes("internal error");
      }),
    );

    // Verify NO Slack message contains the sensitive content
    const postCalls = slackMock.calls.filter((c) => c.path === "/api/chat.postMessage");
    for (const call of postCalls) {
      expect(call.body).not.toContain("s3cret");
      expect(call.body).not.toContain("db.internal");
    }

    // Verify the scrubbed generic message was sent instead
    const errorPost = postCalls.find((c) => {
      const parsed = JSON.parse(c.body);
      return parsed.text?.includes("internal error");
    });
    expect(errorPost).toBeDefined();
  });

  it("scrubs Access denied errors from Slack messages", async () => {
    // "Access denied for user" matches ER_ACCESS_DENIED_ERROR-adjacent pattern
    mockExecuteAgentQuery.mockRejectedValueOnce(
      new Error("Access denied for user 'root'@'10.0.0.1' (using password: YES)"),
    );

    const body = makeSlackCommandBody("another failing query");
    const req = makeSignedRequest("/api/v1/slack/commands", body);
    await app.fetch(req);

    // Wait for the error message post
    await waitFor(() =>
      slackMock.calls.filter((c) => c.path === "/api/chat.postMessage").some((c) => {
        const parsed = JSON.parse(c.body);
        return parsed.text?.includes("internal error");
      }),
    );

    const postCalls = slackMock.calls.filter((c) => c.path === "/api/chat.postMessage");
    for (const call of postCalls) {
      // The raw error message with "Access denied for user" should be scrubbed
      // because it matches SENSITIVE_PATTERNS
      expect(call.body).not.toContain("Access denied for user");
      expect(call.body).not.toContain("10.0.0.1");
    }
  });

  it("scrubs long error messages (>200 chars)", async () => {
    // Messages > 200 chars get scrubbed regardless of content
    const longError = "Something went wrong: " + "x".repeat(250);
    mockExecuteAgentQuery.mockRejectedValueOnce(new Error(longError));

    const body = makeSlackCommandBody("long error query");
    const req = makeSignedRequest("/api/v1/slack/commands", body);
    await app.fetch(req);

    // Wait for the error message post
    await waitFor(() =>
      slackMock.calls.filter((c) => c.path === "/api/chat.postMessage").some((c) => {
        const parsed = JSON.parse(c.body);
        return parsed.text?.includes("internal error");
      }),
    );

    const postCalls = slackMock.calls.filter((c) => c.path === "/api/chat.postMessage");
    for (const call of postCalls) {
      expect(call.body).not.toContain("x".repeat(250));
    }
  });
});
