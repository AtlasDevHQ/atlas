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

const mockPostEphemeral: Mock<(token: string, params: unknown) => Promise<{ ok: boolean }>> = mock(() =>
  Promise.resolve({ ok: true }),
);

mock.module("@atlas/api/lib/slack/api", () => ({
  postMessage: mockPostMessage,
  updateMessage: mockUpdateMessage,
  postEphemeral: mockPostEphemeral,
  // `slackAPI` was used by the lifted OAuth callback handler; the lift to
  // /api/v1/integrations/slack/* has its own test file (slack-oauth-handler.test.ts).
  // The mock module still exports it so `mock.module` doesn't leave a partial
  // module reference around for other imports that touch this slot.
  slackAPI: mock(() => Promise.resolve({ ok: true })),
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
  // saveInstallation moved to the integrations route's handler post-#2653.
  // Keep the export here so partial-mock leakage doesn't appear in unrelated
  // tests that import the slack store module.
  saveInstallation: mock(() => Promise.resolve()),
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
  // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
  reserveConversationBudget: mock(() => Promise.resolve({ status: 'ok' as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
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
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
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

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    // Default: implicit-admin (mode "none") so existing install tests behave as before.
    authResultForTests = { authenticated: true, mode: "none", user: null };
    mockAuthenticateRequest.mockClear();
    mockRunAgent.mockClear();
    mockPostMessage.mockClear();
    mockUpdateMessage.mockClear();
    mockPostEphemeral.mockClear();
    mockGetBotToken.mockClear();
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
  });

  describe("POST /api/v1/slack/commands", () => {
    it("acks a slash command with 200 and an ephemeral response", async () => {
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
      // Ephemeral so the ack doesn't double up with the bot's in-channel
      // "Thinking..." message — see slack.ts comment for the rationale.
      expect(json.response_type).toBe("ephemeral");
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

    it("rejects invalid signature with 401 even when body is malformed JSON (verify before parse)", async () => {
      // Pins the verify-before-parse ordering: an attacker sending
      // garbage with a forged signature must hit `invalid_signature` /
      // 401, not `invalid_json` / 400. A regression that swaps the
      // order would leak "your signature was fine, your JSON wasn't".
      const app = await getApp();
      const resp = await app.request("/api/v1/slack/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-signature": "v0=bad_signature",
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: "not-json{",
      });

      expect(resp.status).toBe(401);
      const json = (await resp.json()) as Record<string, unknown>;
      expect(json.error).toBe("invalid_signature");
    });

    // (deleted #2611) `processes thread follow-up events and calls the agent`
    // (deleted #2611) `processes a top-level app_mention and runs the agent in a new thread`
    // (deleted #2611) `skips app_mention when posted inside an existing thread (message branch owns it)` — coverage now in plugins/chat/src/bridge.test.ts (`acquireLock` dedup) and the bridge's onSubscribedMessage path
    // (deleted #2611) `ignores app_mention with only the bot prefix and no question` — coverage now in plugins/chat/src/bridge.test.ts (the bridge's onNewMention text-extraction skip path)
    //
    // All four were assertions over the migrated handler (now owned by
    // the chat plugin). Equivalent coverage lives in
    // `packages/api/src/lib/chat-plugin/__tests__/execute-query.test.ts`
    // (F-55 actor binding, approvalSurface stamp, conversation
    // persistence) and `plugins/chat/src/bridge.test.ts` (dedup +
    // text-extraction skip).
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

    // (deleted #2611) `loads conversation history for thread follow-ups`
    // (deleted #2611) `handles thread follow-ups without prior conversation gracefully`
    //
    // Coverage migrated to
    // `packages/api/src/lib/chat-plugin/__tests__/execute-query.test.ts`
    // — the host helper owns conversation history loading via
    // `getConversation` + `addMessage` in the new path.
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

    // (deleted #2611) `returns rate limit message for thread follow-ups`
    // — coverage migrated to the host helper test which asserts the
    // `slack:${teamId}` rate-limit key and the "Rate limit exceeded"
    // throw on `allowed: false`.
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

  // Slack OAuth `/install` + `/callback` lifted to
  // /api/v1/integrations/slack/{install,callback} in #2653. Coverage
  // moved to `lib/integrations/install/__tests__/slack-oauth-handler.test.ts`
  // (handler-level) and the integrations route's own test file.

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

    // (deleted #2611) F-55 thread follow-up assertions migrated to
    // `packages/api/src/lib/chat-plugin/__tests__/execute-query.test.ts`:
    //
    //   - `binds the workspace's installation org as the agent actor for thread follow-ups`
    //   - `thread follow-up with a missing event.user still binds an actor (no trailing colon in id)`
    //   - `rejects approval-required thread follow-ups with a clear thread message`
    //
    // The host helper test pins `botActorUser` id format
    // (`slack-bot:T${teamId}:U${user}` with the trailing-colon guard) and
    // the `:lock:` approval-required path with the same envelope shape.
  });
});
