/**
 * Tests for the chat plugin's host-side `executeQuery` (slice 3 of #2607).
 *
 * Feeds a synthetic Slack `app_mention` payload (the same shape Slack's
 * Events API delivers) through `runExecuteQuery` and asserts the agent
 * sees the legacy slack.ts envelope: `orgId` via `botActorUser`,
 * `approvalSurface: "slack"`, conversation persistence by
 * (channel, thread_ts), and rate-limit key `slack:${teamId}`.
 *
 * The agent + Slack store + conversation persistence are mocked at the
 * module boundary. `executeAgentQuery` is captured so its `actor` /
 * `approvalSurface` arguments are asserted directly — that's the F-55
 * gate this slice has to preserve.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";

// --- Mocks ---

interface CapturedAgentCall {
  question: string;
  requestId?: string;
  options?: {
    actor?: { id: string; activeOrganizationId?: string };
    approvalSurface?: string;
    conversationId?: string;
    priorMessages?: Array<{ role: string; content: string }>;
  };
}
const capturedAgentCalls: CapturedAgentCall[] = [];

const mockExecuteAgentQuery: Mock<
  (
    question: string,
    requestId?: string,
    options?: {
      actor?: { id: string; activeOrganizationId?: string };
      approvalSurface?: string;
      conversationId?: string;
      priorMessages?: Array<{ role: string; content: string }>;
    },
  ) => Promise<{
    answer: string;
    sql: string[];
    data: { columns: string[]; rows: Record<string, unknown>[] }[];
    steps: number;
    usage: { totalTokens: number };
    pendingActions?: Array<{
      id: string;
      type: string;
      target: string;
      summary: string;
    }>;
    pendingApproval?: {
      requestId: string | null;
      ruleName: string;
      matchedRules: string[];
      message: string;
    };
  }>
> = mock((question, requestId, options) => {
  capturedAgentCalls.push({
    question,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(options !== undefined ? { options } : {}),
  });
  return Promise.resolve({
    answer: "42 active users",
    sql: ["SELECT COUNT(*) FROM users"],
    data: [{ columns: ["count"], rows: [{ count: 42 }] }],
    steps: 1,
    usage: { totalTokens: 100 },
  });
});

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

const mockGetInstallation: Mock<(teamId: string) => Promise<{ org_id: string | null } | null>> =
  mock((teamId) =>
    Promise.resolve(
      teamId === "T999"
        ? null
        : { team_id: teamId, org_id: "org-xyz", bot_token: "xoxb-test", workspace_name: "Test", installed_at: new Date().toISOString() },
    ),
  );

mock.module("@atlas/api/lib/slack/store", () => ({
  getInstallation: mockGetInstallation,
}));

const mockGetConversationId: Mock<(channelId: string, threadTs: string) => Promise<string | null>> = mock(
  () => Promise.resolve(null),
);
const mockSetConversationId: Mock<(channelId: string, threadTs: string, id: string) => Promise<void>> = mock(
  () => Promise.resolve(),
);

mock.module("@atlas/api/lib/slack/threads", () => ({
  getConversationId: mockGetConversationId,
  setConversationId: mockSetConversationId,
}));

const mockCreateConversation: Mock<(opts: Record<string, unknown>) => Promise<{ id: string }>> = mock(
  () => Promise.resolve({ id: "conv-new" }),
);
const mockAddMessage: Mock<(opts: Record<string, unknown>) => void> = mock(() => {});
const mockGetConversation: Mock<(id: string) => Promise<unknown>> = mock(() =>
  Promise.resolve({ ok: false, reason: "not_found" }),
);
const mockGenerateTitle: Mock<(q: string) => string> = mock((q) => q.slice(0, 80));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  getConversation: mockGetConversation,
  generateTitle: mockGenerateTitle,
}));

const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean }> = mock(() => ({
  allowed: true,
}));

const observedRateLimitKeys: string[] = [];
mockCheckRateLimit.mockImplementation((key) => {
  observedRateLimitKeys.push(key);
  return { allowed: true };
});

mock.module("@atlas/api/lib/auth/middleware", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

// --- Tests ---

describe("chat-plugin executeQuery host helper", () => {
  beforeEach(() => {
    capturedAgentCalls.length = 0;
    observedRateLimitKeys.length = 0;
    mockGetInstallation.mockClear();
    mockGetConversationId.mockClear();
    mockSetConversationId.mockClear();
    mockCreateConversation.mockClear();
    mockAddMessage.mockClear();
    mockGetConversation.mockClear();
    mockCheckRateLimit.mockClear();
    mockCheckRateLimit.mockImplementation((key) => {
      observedRateLimitKeys.push(key);
      return { allowed: true };
    });
  });

  it("binds botActorUser with slack platform, team_id externalId, and resolved orgId", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    const result = await runExecuteQuery("how many active users?", {
      threadId: "slack:C123-1234.5678",
      adapter: { name: "slack" },
      rawMessage: {
        type: "app_mention",
        team_id: "T0ABC",
        user: "U0XYZ",
        channel: "C123",
        text: "<@U_BOT> how many active users?",
        ts: "1234.5678",
      },
    });

    expect(result.answer).toBe("42 active users");
    expect(capturedAgentCalls).toHaveLength(1);

    const actor = capturedAgentCalls[0]!.options?.actor;
    expect(actor).toBeDefined();
    expect(actor!.id).toBe("slack-bot:T0ABC:U0XYZ");
    expect(actor!.activeOrganizationId).toBe("org-xyz");
  });

  it("stamps approvalSurface='slack' on every agent invocation", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("test question", {
      threadId: "slack:C123-1234.5678",
      adapter: { name: "slack" },
      rawMessage: {
        team_id: "T0ABC",
        user: "U0XYZ",
        channel: "C123",
        ts: "1234.5678",
      },
    });

    expect(capturedAgentCalls[0]!.options?.approvalSurface).toBe("slack");
  });

  it("uses rate-limit key 'slack:<teamId>' so legacy buckets keep their state", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U0XYZ", channel: "C1", ts: "1.2" },
    });

    expect(observedRateLimitKeys).toEqual(["slack:T0ABC"]);
  });

  it("creates a conversation mapping when none exists for the thread", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("q", {
      threadId: "slack:C9-9.9",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U", channel: "C9", ts: "9.9" },
    });

    expect(mockGetConversationId).toHaveBeenCalledWith("C9", "9.9");
    expect(mockSetConversationId).toHaveBeenCalledTimes(1);
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    // surface 'slack' so admin filters and audit show the right origin
    expect(mockCreateConversation.mock.calls[0]![0]).toMatchObject({ surface: "slack" });
  });

  it("persists both user and assistant turns via addMessage", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("hello", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U", channel: "C1", ts: "1.2" },
    });

    expect(mockAddMessage).toHaveBeenCalledTimes(2);
    const calls = mockAddMessage.mock.calls.map((c) => c[0]) as Array<{
      role: string;
      content: string;
    }>;
    expect(calls[0]!.role).toBe("user");
    expect(calls[0]!.content).toBe("hello");
    expect(calls[1]!.role).toBe("assistant");
    expect(calls[1]!.content).toBe("42 active users");
  });

  it("refuses unknown platforms cleanly without invoking the agent", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "discord:abc",
        adapter: { name: "discord" },
        rawMessage: { team_id: "T0" },
      }),
    ).rejects.toThrow(/not yet supported/);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("refuses Slack events missing team_id without invoking the agent", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "slack:C1-1.2",
        adapter: { name: "slack" },
        // intentionally omit team_id — defensive against synthetic events
        rawMessage: { user: "U", channel: "C1", ts: "1.2" },
      }),
    ).rejects.toThrow(/tenant context/);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("returns the canonical :lock: notice when the agent reports pendingApproval", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    mockExecuteAgentQuery.mockImplementationOnce(async (question, requestId, options) => {
      capturedAgentCalls.push({
        question,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(options !== undefined ? { options } : {}),
      });
      return {
        answer: "free-form text that should be REPLACED",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 5 },
        pendingApproval: {
          requestId: "req-42",
          ruleName: "PII-Read",
          matchedRules: ["PII-Read"],
          message: "Needs approval",
        },
      };
    });

    const result = await runExecuteQuery("show me PII", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U", channel: "C1", ts: "1.2" },
    });

    expect(result.answer).toContain(":lock:");
    expect(result.answer).toContain("PII-Read");
    expect(result.answer).not.toContain("free-form text");
  });

  it("forwards pendingActions through to the bridge so ephemeral approval prompts can be posted", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    mockExecuteAgentQuery.mockImplementationOnce(async (question, requestId, options) => {
      capturedAgentCalls.push({
        question,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(options !== undefined ? { options } : {}),
      });
      return {
        answer: "Action pending",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 5 },
        pendingActions: [
          {
            id: "act-1",
            type: "notification",
            target: "#revenue",
            summary: "Send revenue alert",
          },
        ],
      };
    });

    const result = await runExecuteQuery("send the alert", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U", channel: "C1", ts: "1.2" },
    });

    expect(result.pendingActions).toHaveLength(1);
    expect(result.pendingActions![0]!.id).toBe("act-1");
  });

  it("rejects when the rate limit is exceeded for this tenant", async () => {
    mockCheckRateLimit.mockImplementationOnce((key) => {
      observedRateLimitKeys.push(key);
      return { allowed: false };
    });
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "slack:C1-1.2",
        adapter: { name: "slack" },
        rawMessage: { team_id: "T0RL", user: "U", channel: "C1", ts: "1.2" },
      }),
    ).rejects.toThrow(/Rate limit exceeded/);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("proceeds with no actor when the workspace has no installation row (self-hosted / unknown team)", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    // T999 → getInstallation returns null per the mock
    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T999", user: "U", channel: "C1", ts: "1.2" },
    });

    expect(capturedAgentCalls).toHaveLength(1);
    expect(capturedAgentCalls[0]!.options?.actor).toBeUndefined();
    // approvalSurface still stamped — the rule engine fail-closes when no
    // actor binds an org, which is the correct behaviour for an unknown
    // tenant (matches slack.ts pre-#2611).
    expect(capturedAgentCalls[0]!.options?.approvalSurface).toBe("slack");
  });

  it("prefers bridge-supplied priorMessages over a stale DB rehydrate", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    const priorMessages = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    await runExecuteQuery("follow up", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      priorMessages,
      rawMessage: { team_id: "T0ABC", user: "U", channel: "C1", thread_ts: "1.2" },
    });

    // getConversation should NOT be called when priorMessages was supplied.
    expect(mockGetConversation).not.toHaveBeenCalled();
    expect(capturedAgentCalls[0]!.options?.priorMessages).toEqual(priorMessages);
  });
});
