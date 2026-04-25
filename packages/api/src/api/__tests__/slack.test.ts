/**
 * Route-level tests for /api/v1/slack endpoints.
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
  handleAction: mock(() => Promise.resolve({ status: "pending", actionId: "act-001" })),
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

const mockGetInstallation: Mock<(teamId: string) => Promise<{
  team_id: string;
  bot_token: string;
  org_id: string | null;
  workspace_name: string | null;
  installed_at: string;
} | null>> = mock((teamId: string) =>
  Promise.resolve({
    team_id: teamId,
    bot_token: "xoxb-test-token",
    org_id: "org-xyz",
    workspace_name: "TestWorkspace",
    installed_at: new Date().toISOString(),
  }),
);

mock.module("@atlas/api/lib/slack/store", () => ({
  getBotToken: mockGetBotToken,
  getInstallation: mockGetInstallation,
  getInstallationByOrg: mock(() => Promise.resolve(null)),
  saveInstallation: mockSaveInstallation,
  deleteInstallation: mock(() => Promise.resolve()),
  deleteInstallationByOrg: mock(() => Promise.resolve(false)),
  ENV_TEAM_ID: "env" as const,
}));

// F-55: capture the RequestContext that the agent runs under so route tests
// can assert the chat-platform actor was bound. The existing mockRunAgent
// already covers the agent loop; this proxy snoops the AsyncLocalStorage
// state at the moment runAgent is invoked. Default mockRunAgent reads no
// context, so we wrap the mock to capture it then delegate to the original
// behaviour. Tests can also override the agent's tool result so we can
// simulate an approval-required response without standing up a real
// approval gate.
const observedAgentContexts: Array<{ requestId?: string; user?: { id: string; activeOrganizationId?: string | undefined } | undefined }> = [];
let pendingApprovalToolResultOverride: { approval_required: true; approval_request_id: string; matched_rules: string[]; message: string } | null = null;
const baseRunAgentImpl = mockRunAgent.getMockImplementation();
mockRunAgent.mockImplementation(async (opts) => {
  const { getRequestContext } = await import("@atlas/api/lib/logger");
  const ctx = getRequestContext();
  observedAgentContexts.push({
    ...(ctx?.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...(ctx?.user !== undefined ? {
      user: {
        id: ctx.user.id,
        ...(ctx.user.activeOrganizationId !== undefined ? { activeOrganizationId: ctx.user.activeOrganizationId } : {}),
      },
    } : {}),
  });
  if (pendingApprovalToolResultOverride) {
    return {
      text: Promise.resolve("approval required"),
      steps: Promise.resolve([
        {
          toolResults: [
            {
              toolName: "executeSQL",
              input: { sql: "SELECT * FROM customer_pii" },
              output: { success: false, ...pendingApprovalToolResultOverride },
            },
          ],
        },
      ]),
      totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    };
  }
  return baseRunAgentImpl ? baseRunAgentImpl(opts) : {
    text: Promise.resolve("42 active users"),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
  };
});

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
  persistAssistantSteps: mock(() => {}),
  getConversation: mockGetConversation,
  generateTitle: mockGenerateTitle,
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  convertToNotebook: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  deleteBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  renameBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(() =>
  ({ allowed: true }),
);

// Mutable auth mock so install tests can swap between authenticated admin / unauth / non-admin.
let authResultForTests: { authenticated: boolean; mode: string; status?: number; error?: string; user?: unknown } = {
  authenticated: true,
  mode: "none",
  user: null,
};
const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(() =>
  Promise.resolve(authResultForTests),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  checkRateLimit: mockCheckRateLimit,
  authenticateRequest: mockAuthenticateRequest,
  getClientIP: mock(() => "127.0.0.1"),
  rateLimitCleanupTick: mock(() => {}),
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

describe("/api/v1/slack", () => {
  const savedSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const savedClientId = process.env.SLACK_CLIENT_ID;
  const savedClientSecret = process.env.SLACK_CLIENT_SECRET;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    // Default: implicit-admin (mode "none") so existing install tests behave as before.
    authResultForTests = { authenticated: true, mode: "none", user: null };
    mockAuthenticateRequest.mockClear();
    mockRunAgent.mockClear();
    mockPostMessage.mockClear();
    mockUpdateMessage.mockClear();
    mockPostEphemeral.mockClear();
    mockSlackAPI.mockClear();
    mockGetBotToken.mockClear();
    mockSaveInstallation.mockClear();
    mockGetInstallation.mockClear();
    mockGetInstallation.mockImplementation((teamId: string) =>
      Promise.resolve({
        team_id: teamId,
        bot_token: "xoxb-test-token",
        org_id: "org-xyz",
        workspace_name: "TestWorkspace",
        installed_at: new Date().toISOString(),
      }),
    );
    observedAgentContexts.length = 0;
    pendingApprovalToolResultOverride = null;
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

  describe("POST /api/v1/slack/commands", () => {
    it("acks a slash command with 200 and in_channel response", async () => {
      const app = await getApp();
      const body = "token=xxx&team_id=T123&channel_id=C456&user_id=U789&text=how+many+users";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/v1/slack/commands", {
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

      const resp = await app.request("/api/v1/slack/commands", {
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

      const resp = await app.request("/api/v1/slack/commands", {
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

  describe("POST /api/v1/slack/events", () => {
    it("responds to url_verification challenge", async () => {
      const app = await getApp();
      const payload = JSON.stringify({
        type: "url_verification",
        challenge: "test_challenge_string",
      });
      const { signature, timestamp } = makeSignature(payload);

      const resp = await app.request("/api/v1/slack/events", {
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

      const resp = await app.request("/api/v1/slack/events", {
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

      const resp = await app.request("/api/v1/slack/events", {
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

      const resp = await app.request("/api/v1/slack/events", {
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
      expect(json.error).toBe("invalid_signature");
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

      const resp = await app.request("/api/v1/slack/events", {
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

      const resp = await app.request("/api/v1/slack/commands", {
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

      await app.request("/api/v1/slack/commands", {
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

      await app.request("/api/v1/slack/events", {
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

      await app.request("/api/v1/slack/events", {
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

      const resp = await app.request("/api/v1/slack/commands", {
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

      const resp = await app.request("/api/v1/slack/events", {
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

  describe("POST /api/v1/slack/interactions", () => {
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

      const resp = await app.request("/api/v1/slack/interactions", {
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

      const resp = await app.request("/api/v1/slack/interactions", {
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

      const resp = await app.request("/api/v1/slack/interactions", {
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

      const resp = await app.request("/api/v1/slack/interactions", {
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
      expect(json.error).toBe("missing_payload");
    });
  });

  describe("GET /api/v1/slack/install", () => {
    it("redirects to Slack OAuth URL when configured", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      const app = await getApp();

      const resp = await app.request("/api/v1/slack/install", {
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

      const resp = await app.request("/api/v1/slack/install", { method: "GET" });
      expect(resp.status).toBe(501);
    });

    // F-04 (security): /install must require authenticated admin so the OAuth state
    // binds the resulting installation to a real org. See packages/api/src/api/routes/slack.ts.
    it("returns 401 when caller is unauthenticated (managed mode)", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      authResultForTests = {
        authenticated: false,
        mode: "managed",
        status: 401,
        error: "Authentication required",
      };
      const app = await getApp();

      const resp = await app.request("/api/v1/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.requestId).toBeDefined();
    });

    it("returns 403 when caller is authenticated but not an admin", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      authResultForTests = {
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "User", role: "member", activeOrganizationId: "org-test" },
      };
      const app = await getApp();

      const resp = await app.request("/api/v1/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(403);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
      expect(body.requestId).toBeDefined();
    });
  });

  describe("GET /api/v1/slack/callback", () => {
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
      const installResp = await app.request("/api/v1/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      const location = installResp.headers.get("location") ?? "";
      const stateParam = new URL(location).searchParams.get("state");

      const resp = await app.request(
        `/api/v1/slack/callback?code=test_code&state=${stateParam}`,
        { method: "GET" },
      );
      expect(resp.status).toBe(200);
      const html = await resp.text();
      expect(html).toContain("Atlas installed!");
      expect(mockSaveInstallation).toHaveBeenCalledWith("T999", "xoxb-new-token", { orgId: undefined, workspaceName: undefined });
    });

    it("returns error HTML when OAuth response is missing team data", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";

      // ok: true but no team or access_token
      mockSlackAPI.mockResolvedValueOnce({ ok: true });

      const app = await getApp();

      // Get a valid state
      const installResp = await app.request("/api/v1/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      const location = installResp.headers.get("location") ?? "";
      const stateParam = new URL(location).searchParams.get("state");

      const resp = await app.request(
        `/api/v1/slack/callback?code=test_code&state=${stateParam}`,
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

      // No state at all — OpenAPIHono schema validation rejects before handler runs
      const resp1 = await app.request("/api/v1/slack/callback?code=test_code", {
        method: "GET",
      });
      expect(resp1.status).toBe(422);

      // Bogus state value — passes schema validation but handler rejects unknown state
      const resp2 = await app.request(
        "/api/v1/slack/callback?code=test_code&state=bogus-state-value",
        { method: "GET" },
      );
      expect(resp2.status).toBe(400);
    });

    it("returns 400 when code parameter is missing", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";
      const app = await getApp();

      // Need a valid state but no code
      const installResp = await app.request("/api/v1/slack/install", {
        method: "GET",
        redirect: "manual",
      });
      const location = installResp.headers.get("location") ?? "";
      const stateParam = new URL(location).searchParams.get("state");

      const resp = await app.request(
        `/api/v1/slack/callback?state=${stateParam}`,
        { method: "GET" },
      );
      expect(resp.status).toBe(422);
    });

    it("returns 501 when OAuth is not configured", async () => {
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_CLIENT_SECRET;
      const app = await getApp();

      // Both code and state are required by the OpenAPIHono route schema
      const resp = await app.request("/api/v1/slack/callback?code=test&state=dummy", {
        method: "GET",
      });
      expect(resp.status).toBe(501);
    });

    // F-04 (security): in SaaS mode, an OAuth state with orgId=undefined
    // means /install was reached without a valid admin session — the
    // callback must refuse to bind the workspace to a NULL org.
    it("returns 400 in SaaS mode when oauth state has no orgId", async () => {
      process.env.SLACK_CLIENT_ID = "test_client_id";
      process.env.SLACK_CLIENT_SECRET = "test_client_secret";

      // Mint a state row with orgId=undefined (simulates pre-fix data or
      // a state row tampered with). Default fallback store is in-memory.
      const { saveOAuthState, _resetMemoryFallback } = await import("@atlas/api/lib/auth/oauth-state");
      _resetMemoryFallback();
      await saveOAuthState("orphan-state", { provider: "slack" });

      // Flip deploy mode to saas. Cast through the test setter to avoid
      // building a full ResolvedConfig — only deployMode is read in this path.
      const config = await import("@atlas/api/lib/config");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "saas" } as any);

      try {
        const app = await getApp();
        const resp = await app.request(
          "/api/v1/slack/callback?code=test_code&state=orphan-state",
          { method: "GET" },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toBe("missing_org_binding");
        // Ensure we never reached the saveInstallation path
        expect(mockSaveInstallation).not.toHaveBeenCalled();
      } finally {
        config._setConfigForTest(null);
      }
    });
  });

  // ── F-55 regression tests ────────────────────────────────────────────
  // The Slack receiver used to call executeAgentQuery without binding any
  // user, so checkApprovalRequired short-circuited and any rule-matching
  // query ran ungated. These tests pin the new behaviour: an installation's
  // org_id is resolved up front and an approval-required result is surfaced
  // to the user with a "approve via the Atlas web app" message instead of
  // delivering query results.

  describe("F-55: chat-platform approval gate", () => {
    it("binds the workspace's installation org as the agent actor for slash commands", async () => {
      const app = await getApp();
      const body = "token=xxx&team_id=T999&channel_id=C456&user_id=U789&text=show+me+pii";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/v1/slack/commands", {
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

      expect(mockGetInstallation).toHaveBeenCalledWith("T999");
      expect(observedAgentContexts).toHaveLength(1);
      // Synthetic chat-platform actor — id format `slack-bot:<teamId>:<userId>`,
      // org from the installation row so checkApprovalRequired sees a real orgId.
      expect(observedAgentContexts[0].user?.id).toBe("slack-bot:T999:U789");
      expect(observedAgentContexts[0].user?.activeOrganizationId).toBe("org-xyz");
    });

    it("rejects an approval-required query with a clear Slack message instead of executing", async () => {
      pendingApprovalToolResultOverride = {
        approval_required: true,
        approval_request_id: "approval-req-77",
        matched_rules: ["Block PII reads"],
        message: "This query requires approval before execution.",
      };

      const app = await getApp();
      const body = "token=xxx&team_id=T999&channel_id=C456&user_id=U789&text=show+me+pii";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/v1/slack/commands", {
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

      // The approval-required path replaces the "Thinking..." message
      // with a clear approval notice. Find the update that mentions the
      // rule — there may be other updateMessage calls in the test session.
      const updateCalls = mockUpdateMessage.mock.calls;
      const approvalUpdate = updateCalls.find((call) => {
        const params = call[1] as { text?: string } | undefined;
        return typeof params?.text === "string" && params.text.includes("Block PII reads");
      });
      expect(approvalUpdate).toBeDefined();
      const approvalParams = approvalUpdate?.[1] as { text?: string };
      expect(approvalParams.text).toContain("requires approval");
      expect(approvalParams.text).toContain("Atlas admin console");
    });

    it("does not bind an actor when the installation has no org_id (single-workspace env-token deployment)", async () => {
      mockGetInstallation.mockResolvedValueOnce({
        team_id: "T999",
        bot_token: "xoxb-test-token",
        org_id: null,
        workspace_name: null,
        installed_at: new Date().toISOString(),
      });

      const app = await getApp();
      const body = "token=xxx&team_id=T999&channel_id=C456&user_id=U789&text=hello";
      const { signature, timestamp } = makeSignature(body);

      const resp = await app.request("/api/v1/slack/commands", {
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

      // Without an org binding, no user is bound — the agent runs as
      // unauthenticated and the defensive check in approval.ts will
      // fail-closed if any rule exists. Non-rule queries continue to work.
      expect(observedAgentContexts).toHaveLength(1);
      expect(observedAgentContexts[0].user).toBeUndefined();
    });
  });
});
