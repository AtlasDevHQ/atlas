/**
 * Route-level tests for /api/slack endpoints.
 *
 * Mocks the agent, Slack API calls, and internal DB to isolate route logic.
 * Tests signature verification, slash command ack, events API, and OAuth.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import crypto from "crypto";

// --- Mocks ---

const mockRunAgent: Mock<(opts: unknown) => Promise<{
  text: Promise<string>;
  steps: Promise<{ toolResults: unknown[] }[]>;
  totalUsage: Promise<{ inputTokens: number; outputTokens: number }>;
}>> = mock(() =>
  Promise.resolve({
    text: Promise.resolve("42 active users"),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
  }),
);

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

const mockPostMessage: Mock<(token: string, params: unknown) => Promise<{ ok: boolean; ts?: string }>> = mock(() =>
  Promise.resolve({ ok: true, ts: "1234567890.123456" }),
);

const mockUpdateMessage: Mock<(token: string, params: unknown) => Promise<{ ok: boolean }>> = mock(() =>
  Promise.resolve({ ok: true }),
);

const mockSlackAPI: Mock<(method: string, token: string, body: unknown) => Promise<{ ok: boolean; team?: unknown; access_token?: string }>> = mock(() =>
  Promise.resolve({ ok: true }),
);

const mockPostEphemeral: Mock<(token: string, params: unknown) => Promise<{ ok: boolean }>> = mock(() =>
  Promise.resolve({ ok: true }),
);

mock.module("@atlas/api/lib/slack/api", () => ({
  postMessage: mockPostMessage,
  updateMessage: mockUpdateMessage,
  postEphemeral: mockPostEphemeral,
  slackAPI: mockSlackAPI,
}));

const mockApproveAction: Mock<(actionId: string, approverId: string) => Promise<Record<string, unknown> | null>> = mock(() =>
  Promise.resolve({ id: "act-001", status: "executed", action_type: "notification", target: "#revenue", summary: "Send notification" }),
);
const mockDenyAction: Mock<(actionId: string, denierId: string, reason?: string) => Promise<Record<string, unknown> | null>> = mock(() =>
  Promise.resolve({ id: "act-001", status: "denied", action_type: "notification", target: "#revenue", summary: "Send notification" }),
);
const mockGetAction: Mock<(actionId: string) => Promise<Record<string, unknown> | null>> = mock(() =>
  Promise.resolve({ id: "act-001", status: "pending", action_type: "notification", target: "#revenue", summary: "Send notification" }),
);

mock.module("@atlas/api/lib/tools/actions/handler", () => ({
  approveAction: mockApproveAction,
  denyAction: mockDenyAction,
  getAction: mockGetAction,
  handleAction: mock(() => Promise.resolve({ status: "pending_approval", actionId: "act-001" })),
  buildActionRequest: mock(() => ({ id: "act-001" })),
  getActionConfig: mock(() => ({ approval: "manual" })),
  registerActionExecutor: mock(() => {}),
  getActionExecutor: mock(() => undefined),
  listPendingActions: mock(() => Promise.resolve([])),
  _resetActionStore: mock(() => {}),
}));

const mockGetBotToken: Mock<(teamId: string) => Promise<string | null>> = mock(() =>
  Promise.resolve("xoxb-test-token"),
);

const mockSaveInstallation: Mock<(teamId: string, token: string) => Promise<void>> = mock(() => Promise.resolve());

mock.module("@atlas/api/lib/slack/store", () => ({
  getBotToken: mockGetBotToken,
  saveInstallation: mockSaveInstallation,
}));

const mockGetConversationId: Mock<(channelId: string, threadTs: string) => Promise<string | null>> = mock(() =>
  Promise.resolve(null),
);

const mockSetConversationId: Mock<(channelId: string, threadTs: string, conversationId: string) => void> = mock(() => {});

mock.module("@atlas/api/lib/slack/threads", () => ({
  getConversationId: mockGetConversationId,
  setConversationId: mockSetConversationId,
}));

const mockCreateConversation: Mock<(opts: Record<string, unknown>) => Promise<{ id: string } | null>> = mock(() =>
  Promise.resolve({ id: "conv-123" }),
);

const mockAddMessage: Mock<(opts: Record<string, unknown>) => void> = mock(() => {});

const mockGetConversation: Mock<(id: string, userId?: string | null) => Promise<Record<string, unknown> | null>> = mock(() =>
  Promise.resolve(null),
);

const mockGenerateTitle: Mock<(question: string) => string> = mock((q: string) => q.slice(0, 80));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  getConversation: mockGetConversation,
  generateTitle: mockGenerateTitle,
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
}));

const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(() =>
  ({ allowed: true }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  checkRateLimit: mockCheckRateLimit,
  authenticateRequest: mock(() => Promise.resolve({ mode: "none" as const, user: null })),
  getClientIP: mock(() => "127.0.0.1"),
  _stopCleanup: mock(() => {}),
}));

// --- Test setup ---

const SIGNING_SECRET = "test_secret_for_tests";

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

// Dynamic import so env vars are set before module loads
async function getApp() {
  const { app } = await import("../../api/index");
  return app;
}

describe("/api/slack", () => {
  const savedSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const savedClientId = process.env.SLACK_CLIENT_ID;
  const savedClientSecret = process.env.SLACK_CLIENT_SECRET;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    mockRunAgent.mockClear();
    mockPostMessage.mockClear();
    mockUpdateMessage.mockClear();
    mockPostEphemeral.mockClear();
    mockSlackAPI.mockClear();
    mockGetBotToken.mockClear();
    mockSaveInstallation.mockClear();
    mockGetConversationId.mockClear();
    mockSetConversationId.mockClear();
    mockCreateConversation.mockClear();
    mockAddMessage.mockClear();
    mockGetConversation.mockClear();
    mockGenerateTitle.mockClear();
    mockCheckRateLimit.mockClear();
    mockApproveAction.mockClear();
    mockDenyAction.mockClear();
    mockGetAction.mockClear();
  });

  afterEach(() => {
    // Restore only the vars we changed — never replace process.env entirely
    if (savedSigningSecret !== undefined) process.env.SLACK_SIGNING_SECRET = savedSigningSecret;
    else delete process.env.SLACK_SIGNING_SECRET;
    if (savedClientId !== undefined) process.env.SLACK_CLIENT_ID = savedClientId;
    else delete process.env.SLACK_CLIENT_ID;
    if (savedClientSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedClientSecret;
    else delete process.env.SLACK_CLIENT_SECRET;
  });

  describe("POST /api/slack/commands", () => {
    it("acks a slash command with 200 and in_channel response", async () => {
      const app = await getApp();
      const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/slack/commands", {
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

    it("returns usage hint for empty text", async () => {
      const app = await getApp();
      const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/slack/commands", {
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

    it("rejects unsigned requests with 401", async () => {
      const app = await getApp();
      const body = "token=xxx&text=hello";

      const resp = await app.request("/api/slack/commands", {
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
  });

  describe("POST /api/slack/events", () => {
    it("responds to url_verification challenge", async () => {
      const app = await getApp();
      const payload = JSON.stringify({
        type: "url_verification",
        challenge: "test_challenge_string",
      });
      const { signature, timestamp } = makeSignature(payload);

      const resp = await app.request("/api/slack/events", {
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

    it("ignores bot messages", async () => {
      const app = await getApp();
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

      const resp = await app.request("/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: payload,
      });

      expect(resp.status).toBe(200);
      // Should not have triggered any agent call
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("rejects invalid signatures for event callbacks", async () => {
      const app = await getApp();
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

      const resp = await app.request("/api/slack/events", {
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

    it("rejects url_verification with invalid signature", async () => {
      const app = await getApp();
      const payload = JSON.stringify({
        type: "url_verification",
        challenge: "should_not_echo",
      });

      const resp = await app.request("/api/slack/events", {
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

    it("processes thread follow-up events and calls the agent", async () => {
      const app = await getApp();
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

      const resp = await app.request("/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: payload,
      });

      // Should ack immediately
      expect(resp.status).toBe(200);

      // Wait for async fire-and-forget processing
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRunAgent).toHaveBeenCalled();
    });
  });

  describe("async processing", () => {
    it("posts thinking message, runs agent, and updates message for slash commands", async () => {
      const app = await getApp();
      const body =
        "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+active+users";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/slack/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body,
      });

      expect(resp.status).toBe(200);

      // Wait for async fire-and-forget processing
      await new Promise((r) => setTimeout(r, 100));

      // Thinking message was posted
      expect(mockPostMessage).toHaveBeenCalled();
      // Agent was called
      expect(mockRunAgent).toHaveBeenCalled();
      // Result was sent back by updating the thinking message
      expect(mockUpdateMessage).toHaveBeenCalled();
    });
  });

  describe("conversation persistence", () => {
    it("creates conversation for slash commands", async () => {
      const app = await getApp();
      const body =
        "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+active+users";
      const { signature, timestamp } = makeSignature(body);

      await app.request("/api/slack/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body,
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: "slack",
          title: expect.any(String),
        }),
      );
      // Messages persisted
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
    });

    it("loads conversation history for thread follow-ups", async () => {
      // Set up: conversation exists with prior messages
      mockGetConversationId.mockResolvedValueOnce("conv-existing");
      mockGetConversation.mockResolvedValueOnce({
        id: "conv-existing",
        messages: [
          { id: "m1", conversationId: "conv-existing", role: "user", content: "initial question", createdAt: "2024-01-01" },
          { id: "m2", conversationId: "conv-existing", role: "assistant", content: "initial answer", createdAt: "2024-01-01" },
        ],
      });

      const app = await getApp();
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

      await app.request("/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: payload,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Should have loaded conversation
      expect(mockGetConversation).toHaveBeenCalledWith("conv-existing");
      // Agent was called (priorMessages passed internally)
      expect(mockRunAgent).toHaveBeenCalled();
      // New messages persisted
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
    });

    it("handles thread follow-ups without prior conversation gracefully", async () => {
      // No conversation mapping exists
      mockGetConversationId.mockResolvedValueOnce(null);

      const app = await getApp();
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

      await app.request("/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: payload,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Agent still called — just without prior context
      expect(mockRunAgent).toHaveBeenCalled();
      // No conversation to load
      expect(mockGetConversation).not.toHaveBeenCalled();
      // No messages persisted (no conversationId)
      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  describe("rate limiting", () => {
    it("returns rate limit message for slash commands", async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 30000 });

      const app = await getApp();
      const body =
        "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/slack/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body,
      });

      // Should still ack immediately
      expect(resp.status).toBe(200);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 100));

      // Rate limit message posted, agent NOT called
      expect(mockPostMessage).toHaveBeenCalledWith(
        "xoxb-test-token",
        expect.objectContaining({ text: expect.stringContaining("Rate limit") }),
      );
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("returns rate limit message for thread follow-ups", async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 30000 });

      const app = await getApp();
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

      const resp = await app.request("/api/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: payload,
      });

      expect(resp.status).toBe(200);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 100));

      // Rate limit message posted in thread, agent NOT called
      expect(mockPostMessage).toHaveBeenCalledWith(
        "xoxb-test-token",
        expect.objectContaining({
          text: expect.stringContaining("Rate limit"),
          thread_ts: "1234567890.000001",
        }),
      );
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/slack/interactions", () => {
    function makeInteractionPayload(actionId: string, action_id: string) {
      return JSON.stringify({
        type: "block_actions",
        team: { id: "T123" },
        user: { id: "U789" },
        actions: [{ action_id, value: actionId }],
        response_url: "https://hooks.slack.com/actions/test",
      });
    }

    it("approves an action when approve button is clicked", async () => {
      const app = await getApp();
      const payload = makeInteractionPayload("act-001", "atlas_action_approve");
      const formBody = `payload=${encodeURIComponent(payload)}`;
      const { signature, timestamp } = makeSignature(formBody);

      const resp = await app.request("/api/slack/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: formBody,
      });

      expect(resp.status).toBe(200);
      const json = (await resp.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 100));

      expect(mockGetAction).toHaveBeenCalledWith("act-001");
      expect(mockApproveAction).toHaveBeenCalledWith("act-001", "slack:U789");
    });

    it("denies an action when deny button is clicked", async () => {
      const app = await getApp();
      const payload = makeInteractionPayload("act-001", "atlas_action_deny");
      const formBody = `payload=${encodeURIComponent(payload)}`;
      const { signature, timestamp } = makeSignature(formBody);

      const resp = await app.request("/api/slack/interactions", {
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
      expect(mockDenyAction).toHaveBeenCalledWith("act-001", "slack:U789");
    });

    it("rejects unsigned interaction requests with 401", async () => {
      const app = await getApp();
      const payload = makeInteractionPayload("act-001", "atlas_action_approve");
      const formBody = `payload=${encodeURIComponent(payload)}`;

      const resp = await app.request("/api/slack/interactions", {
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

    it("returns 400 when payload is missing", async () => {
      const app = await getApp();
      const formBody = "no_payload_here=true";
      const { signature, timestamp } = makeSignature(formBody);

      const resp = await app.request("/api/slack/interactions", {
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
  });

  describe("GET /api/slack/install", () => {
    it("redirects to Slack OAuth URL when configured", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      const app = await getApp();

      const resp = await app.request("/api/slack/install", {
        method: "GET",
        redirect: "manual",
      });

      expect(resp.status).toBe(302);
      const location = resp.headers.get("location");
      expect(location).toContain("slack.com/oauth/v2/authorize");
      expect(location).toContain("test_client_id");
    });

    it("returns 501 when OAuth is not configured", async () => {
      delete process.env.SLACK_CLIENT_ID;
      const app = await getApp();

      const resp = await app.request("/api/slack/install", { method: "GET" });
      expect(resp.status).toBe(501);
    });
  });

  describe("GET /api/slack/callback", () => {
    it("completes OAuth flow and saves installation", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";

      mockSlackAPI.mockResolvedValueOnce({
        ok: true,
        team: { id: "T999" },
        access_token: "xoxb-new-token",
      });

      const app = await getApp();

      // Get state from install redirect
      const installResp = await app.request("/api/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      const location = installResp.headers.get("location") ?? "";
      const stateParam = new URL(location).searchParams.get("state");

      const resp = await app.request(
        `/api/slack/callback?code=test_code&state=${stateParam}`,
        { method: "GET" },
      );
      expect(resp.status).toBe(200);
      const html = await resp.text();
      expect(html).toContain("Atlas installed!");
      expect(mockSaveInstallation).toHaveBeenCalledWith("T999", "xoxb-new-token");
    });

    it("returns error HTML when OAuth response is missing team data", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";

      // ok: true but no team or access_token
      mockSlackAPI.mockResolvedValueOnce({ ok: true });

      const app = await getApp();

      // Get a valid state
      const installResp = await app.request("/api/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      const location = installResp.headers.get("location") ?? "";
      const stateParam = new URL(location).searchParams.get("state");

      const resp = await app.request(
        `/api/slack/callback?code=test_code&state=${stateParam}`,
        { method: "GET" },
      );
      expect(resp.status).toBe(500);
      const html = await resp.text();
      expect(html).toContain("Installation Failed");
      expect(mockSaveInstallation).not.toHaveBeenCalled();
    });

    it("returns 400 when state parameter is invalid or missing", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";
      const app = await getApp();

      // No state at all
      const resp1 = await app.request("/api/slack/callback?code=test_code", {
        method: "GET",
      });
      expect(resp1.status).toBe(400);
      const json1 = (await resp1.json()) as Record<string, unknown>;
      expect(json1.error).toContain("state");

      // Bogus state value
      const resp2 = await app.request(
        "/api/slack/callback?code=test_code&state=bogus-state-value",
        { method: "GET" },
      );
      expect(resp2.status).toBe(400);
    });

    it("returns 400 when code parameter is missing", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";
      const app = await getApp();

      // Need a valid state but no code
      const installResp = await app.request("/api/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      const location = installResp.headers.get("location") ?? "";
      const stateParam = new URL(location).searchParams.get("state");

      const resp = await app.request(
        `/api/slack/callback?state=${stateParam}`,
        { method: "GET" },
      );
      expect(resp.status).toBe(400);
    });

    it("returns 501 when OAuth is not configured", async () => {
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_CLIENT_SECRET;
      const app = await getApp();

      const resp = await app.request("/api/slack/callback?code=test", {
        method: "GET",
      });
      expect(resp.status).toBe(501);
    });
  });
});
