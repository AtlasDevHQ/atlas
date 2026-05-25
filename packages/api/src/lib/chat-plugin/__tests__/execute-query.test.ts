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
  mock((teamId) => {
    if (teamId === "T999") return Promise.resolve(null);
    if (teamId === "T_THROW") return Promise.reject(new Error("ECONNREFUSED postgres://internal-db:5432"));
    return Promise.resolve({
      team_id: teamId,
      org_id: "org-xyz",
      bot_token: "xoxb-test",
      workspace_name: "Test",
      installed_at: new Date().toISOString(),
    });
  });

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

// `internalQuery` is used by the Telegram + Discord branches to
// resolve `chat_id` / `guild_id` → workspace_id. Mocked at the boundary
// (per CLAUDE.md "mock all exports" — spread the real exports and
// override only what each test needs).
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
  () => Promise.resolve([]),
);
const realInternal = await import("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
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
    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    mockAddMessage.mockClear();
    mockGetConversation.mockClear();
    mockCheckRateLimit.mockClear();
    mockCheckRateLimit.mockImplementation((key) => {
      observedRateLimitKeys.push(key);
      return { allowed: true };
    });
  });

  it("binds botActorUser with slack platform, team_id externalId, and resolved orgId — and maps the full agent result", async () => {
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
    // Full AgentQueryResult → ChatQueryResult mapping (not just `answer`).
    expect(result.sql).toEqual(["SELECT COUNT(*) FROM users"]);
    expect(result.data).toEqual([{ columns: ["count"], rows: [{ count: 42 }] }]);
    expect(result.steps).toBe(1);
    expect(result.usage).toEqual({ totalTokens: 100 });
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

  it("rate-limit key for thread follow-up is team-wide `slack:<teamId>` — matches slack.ts:491", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      // No `type: "app_mention"` — this is a thread follow-up.
      rawMessage: { team_id: "T0ABC", user: "U0XYZ", channel: "C1", ts: "1.2", thread_ts: "1.0" },
    });

    expect(observedRateLimitKeys).toEqual(["slack:T0ABC"]);
  });

  it("rate-limit key for top-level @mention is per-user `slack:<teamId>:<userId>` — matches slack.ts:667", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: {
        type: "app_mention",
        team_id: "T0ABC",
        user: "U0XYZ",
        channel: "C1",
        ts: "1.2",
      },
    });

    expect(observedRateLimitKeys).toEqual(["slack:T0ABC:U0XYZ"]);
  });

  it("rate-limit key for top-level @mention without user falls back to ts — matches slack.ts:667 `eventUserId || mentionTs`", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      // app_mention with no `user` (e.g. mentions from automations)
      rawMessage: { type: "app_mention", team_id: "T0ABC", channel: "C1", ts: "1.2" },
    });

    expect(observedRateLimitKeys).toEqual(["slack:T0ABC:1.2"]);
  });

  it("extracts team_id from interactive `block_actions` payload where `team` is `{id, domain}` — not the object literal", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    // `atlas_run_again` / `atlas_export_csv` button clicks route through
    // executeQuery with a Slack `block_actions` payload, where `team` is
    // an object (not a string) and `team_id` is absent. The helper MUST
    // pull `team.id` so the rate-limit key + installation lookup get a
    // real tenant key (not `[object Object]`).
    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: {
        type: "block_actions",
        team: { id: "T0ABC", domain: "acme" },
        user: { id: "U0XYZ" },
        channel: { id: "C1" },
      },
    });

    // Non-`app_mention` event → team-wide key, but with the resolved id.
    expect(observedRateLimitKeys).toEqual(["slack:T0ABC"]);
    // user.id + channel.id resolve too (block_actions payloads nest both).
    expect(capturedAgentCalls).toHaveLength(1);
    expect(capturedAgentCalls[0]!.options?.actor?.id).toBe("slack-bot:T0ABC:U0XYZ");
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
    // Orphan-row guard: createConversation must complete before
    // setConversationId stamps the thread mapping, otherwise a failed
    // create leaves the mapping pointing at a non-existent row.
    const createOrder = mockCreateConversation.mock.invocationCallOrder[0]!;
    const setOrder = mockSetConversationId.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(setOrder);
  });

  it("does not stamp the thread mapping when createConversation rejects (no orphan row)", async () => {
    mockCreateConversation.mockRejectedValueOnce(new Error("db down"));
    const { runExecuteQuery } = await import("../executeQuery");

    // The catch logs at error and proceeds with in-memory only — the
    // call should still complete, but no setConversationId stamp.
    await runExecuteQuery("q", {
      threadId: "slack:Corph-1.0",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U", channel: "Corph", ts: "1.0" },
    });
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockSetConversationId).not.toHaveBeenCalled();
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

    // Teams stays on the placeholder branch in 1.5.3 — its install
    // handler hasn't shipped yet. (Discord moved off this branch in
    // #2749 — see the discord-specific tests below.)
    await expect(
      runExecuteQuery("q", {
        threadId: "teams:abc",
        adapter: { name: "teams" },
        rawMessage: { team_id: "T0" },
      }),
    ).rejects.toThrow(/not yet supported/);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("refuses Discord DM interactions (no guild_id) without invoking the agent — 1.5.3 #2749", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "discord:abc",
        adapter: { name: "discord" },
        // DM interactions have no `guild_id` — the static-bot install
        // model is per-server, so DMs intentionally have no tenant
        // binding and short-circuit before the agent runs.
        rawMessage: { id: "interaction-1", channel_id: "C1" },
      }),
    ).rejects.toThrow(/direct messages/i);
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
    // Parity with legacy slack.ts test — both anchor phrases assert on
    // the canonical notice the user sees.
    expect(result.answer).toContain("Atlas admin console");
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

  it("fail-closes on an unknown Slack team_id (no installation row) — never invokes the agent", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    // T999 → getInstallation returns null per the mock. The agent loop
    // MUST NOT run with `actor=undefined` — that silently bypasses the
    // F-55 approval gate. The helper now refuses with a user-safe error
    // (PR review P0-1).
    await expect(
      runExecuteQuery("q", {
        threadId: "slack:C1-1.2",
        adapter: { name: "slack" },
        rawMessage: { team_id: "T999", user: "U", channel: "C1", ts: "1.2" },
      }),
    ).rejects.toThrow(/not registered with Atlas/);
    expect(capturedAgentCalls).toHaveLength(0);
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

  it("logs the original error (with stack) on agent failure and re-throws unscrubbed — bridge owns scrubbing", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    const sensitiveErr = new Error(
      "ENOENT: postgresql://user:secret@host:5432/db at /app/src/foo.ts:42",
    );
    mockExecuteAgentQuery.mockRejectedValueOnce(sensitiveErr);

    let thrown: unknown;
    try {
      await runExecuteQuery("q", {
        threadId: "slack:C1-1.2",
        adapter: { name: "slack" },
        rawMessage: { team_id: "T0ABC", user: "U", channel: "C1", ts: "1.2" },
      });
    } catch (e) {
      thrown = e;
    }

    // The re-throw carries the ORIGINAL message — the bridge's
    // `scrubErrorMessage` is the single point of redaction.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("postgresql://user:secret@");
    expect((thrown as Error).message).toContain("/app/src/foo.ts:42");
    // The original error is chained via `cause` so Sentry sees the full
    // stack trace.
    expect((thrown as Error).cause).toBe(sensitiveErr);
  });

  it("rehydrates conversation history from DB, filtering to user/assistant roles only", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    // Pre-seed an existing conversation id so the helper rehydrates
    // history instead of creating a new one.
    mockGetConversationId.mockResolvedValueOnce("conv-existing");
    mockGetConversation.mockResolvedValueOnce({
      ok: true,
      data: {
        messages: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
          // Non-user/assistant roles MUST be filtered out so the agent
          // never sees tool / system / data messages as conversational
          // history.
          { role: "tool", content: "tool call result" },
          { role: "system", content: "system prompt" },
          { role: "data", content: "{}" },
        ],
      },
    });

    await runExecuteQuery("follow up", {
      threadId: "slack:C9-9.9",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", user: "U", channel: "C9", thread_ts: "9.9" },
    });

    const prior = capturedAgentCalls[0]!.options?.priorMessages;
    expect(prior).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ]);
  });

  it("fail-closes on getInstallation throw (DB outage) with a user-safe error and full Sentry context", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    // T_THROW → mockGetInstallation rejects with a sensitive-looking
    // error string (ECONNREFUSED + connection URL). The helper MUST
    // refuse rather than proceeding with `actor=undefined` (the F-55
    // gate would silently disable). Bridge owns user-safe wording —
    // here we just confirm the re-throw and that the agent never ran.
    await expect(
      runExecuteQuery("q", {
        threadId: "slack:C1-1.2",
        adapter: { name: "slack" },
        rawMessage: { team_id: "T_THROW", user: "U", channel: "C1", ts: "1.2" },
      }),
    ).rejects.toThrow();
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("accepts the legacy `team` alias when `team_id` is absent — keeps rate-limit key shape", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      // No team_id — only the legacy `team` alias. Some Slack webhook
      // shapes (older event_callback envelopes) deliver `team` instead
      // of `team_id`; both must resolve to the same tenant key.
      rawMessage: { team: "T0LEGACY", user: "U", channel: "C", ts: "1.2" },
    });

    expect(observedRateLimitKeys).toEqual(["slack:T0LEGACY"]);
  });

  it("F-55: omits the trailing colon when externalUserId is missing — actor id is `slack-bot:<teamId>` exactly", async () => {
    const { runExecuteQuery } = await import("../executeQuery");

    // Valid team_id + valid installation but no `user` field on the
    // raw event (e.g. message_changed payloads). The
    // `externalUserId ? { externalUserId } : {}` guard MUST produce
    // `slack-bot:T0ABC` with NO trailing colon — otherwise the actor id
    // round-trip breaks downstream parsers.
    await runExecuteQuery("q", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T0ABC", channel: "C1", ts: "1.2" },
    });

    const actor = capturedAgentCalls[0]!.options?.actor;
    expect(actor).toBeDefined();
    expect(actor!.id).toBe("slack-bot:T0ABC");
    expect(actor!.id.endsWith(":")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Discord branch — 1.5.3 #2749 (Phase D)
  // -------------------------------------------------------------------------

  it("Discord happy path: resolves guild_id → workspace + binds discord actor + stamps approvalSurface='discord'", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("workspace_plugins")) {
        return Promise.resolve([{ workspace_id: "org-discord-tenant" }]);
      }
      return Promise.resolve([]);
    });
    const { runExecuteQuery } = await import("../executeQuery");

    const result = await runExecuteQuery("show me users", {
      threadId: "discord:g123-c456",
      adapter: { name: "discord" },
      rawMessage: {
        id: "interaction-1",
        guild_id: "123456789012345678",
        channel_id: "987654321098765432",
        member: { user: { id: "U_DC" } },
      },
    });

    expect(result.answer).toBe("42 active users");
    expect(capturedAgentCalls).toHaveLength(1);
    const call = capturedAgentCalls[0]!;
    expect(call.options?.actor?.id).toBe("discord-bot:123456789012345678:U_DC");
    expect(call.options?.actor?.activeOrganizationId).toBe("org-discord-tenant");
    expect(call.options?.approvalSurface).toBe("discord");
    // Rate-limit key shape is `discord:${guildId}` (per-server bucket).
    expect(observedRateLimitKeys).toContain("discord:123456789012345678");
  });

  it("Discord fail-closes on unknown guild_id (no install row) — never invokes the agent", async () => {
    // No mock override — default returns []; resolver throws
    // DiscordUnknownTenantError; runDiscordExecuteQuery rethrows as a
    // user-safe error. The agent must NOT be invoked.
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "discord:g999",
        adapter: { name: "discord" },
        rawMessage: {
          id: "interaction-2",
          guild_id: "999999999999999999",
          channel_id: "C1",
        },
      }),
    ).rejects.toThrow(/not connected to Atlas/i);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("Discord fail-closes on DB outage during workspace resolution — user-safe error, never invokes the agent", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED postgres://internal-db:5432")),
    );
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "discord:g123",
        adapter: { name: "discord" },
        rawMessage: {
          id: "interaction-3",
          guild_id: "123456789012345678",
          channel_id: "C1",
        },
      }),
    ).rejects.toThrow(/could not resolve the Discord workspace/i);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("Discord fail-closes when the same guild_id maps to multiple workspaces — cross-tenant misroute defense (codex P1)", async () => {
    // The DB schema doesn't enforce global cross-workspace uniqueness
    // on the routing identifier today. Without the duplicate guard in
    // the resolver, two workspaces installing the same guild_id would
    // silently let inbound interactions land in an arbitrary workspace
    // — a cross-tenant data exposure risk. The fail-closed branch
    // surfaces as the same user-safe error as "unknown guild," and an
    // operator log line points at the duplicate.
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("workspace_plugins")) {
        return Promise.resolve([
          { workspace_id: "org-a" },
          { workspace_id: "org-b" },
        ]);
      }
      return Promise.resolve([]);
    });
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "discord:gdup",
        adapter: { name: "discord" },
        rawMessage: {
          id: "interaction-dup",
          guild_id: "123456789012345678",
          channel_id: "C1",
        },
      }),
    ).rejects.toThrow(/not connected to Atlas/i);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("Discord rejects events whose guild_id isn't a valid snowflake — defends rate-limit cache key shape", async () => {
    // Even though the Ed25519 signature gate catches forgery at the
    // adapter layer, the dispatcher belt-and-suspenders by re-validating
    // the snowflake shape. Garbage guild_id surfaces as the same
    // DM-refuse error (missing tenant context) — no DB read, no agent.
    mockInternalQuery.mockImplementation(() => {
      throw new Error("internalQuery should never be reached on shape failure");
    });
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "discord:bad",
        adapter: { name: "discord" },
        rawMessage: {
          id: "interaction-4",
          guild_id: "not-a-snowflake'; DROP TABLE--",
          channel_id: "C1",
        },
      }),
    ).rejects.toThrow(/direct messages/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(capturedAgentCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // WhatsApp branch — 1.5.3 #2753 (Phase D)
  //
  // Per-tenant phone routing verified end-to-end with a mocked Meta
  // webhook envelope. The chat adapter normalizes Meta's nested webhook
  // shape (entry[].changes[].value.metadata.phone_number_id) onto a flat
  // `rawMessage.phoneNumberId` before reaching executeQuery, so the
  // routing test feeds the flat shape — the same data the bridge would
  // hand the host callback in production.
  // ---------------------------------------------------------------------------

  it("WhatsApp happy path: resolves phone_number_id → workspace + binds whatsapp actor + stamps approvalSurface='whatsapp'", async () => {
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("workspace_plugins")) {
        return Promise.resolve([{ workspace_id: "org-whatsapp-tenant" }]);
      }
      return Promise.resolve([]);
    });
    const { runExecuteQuery } = await import("../executeQuery");

    const result = await runExecuteQuery("how many active users?", {
      threadId: "whatsapp:1098765432109876:16315551234",
      adapter: { name: "whatsapp" },
      rawMessage: {
        phoneNumberId: "1098765432109876",
        contact: { profile: { name: "Test User" }, wa_id: "16315551234" },
        message: {
          id: "wamid.HBgLMTYzMTU1NTEyMzQVAgARGBI",
          from: "16315551234",
          type: "text",
          text: { body: "how many active users?" },
        },
      },
    });

    expect(result.answer).toBe("42 active users");
    const call = capturedAgentCalls[0];
    expect(call.options?.actor?.id).toBe("whatsapp-bot:1098765432109876:16315551234");
    expect(call.options?.actor?.activeOrganizationId).toBe("org-whatsapp-tenant");
    expect(call.options?.approvalSurface).toBe("whatsapp");
    // Rate-limit key shape is `whatsapp:${phoneNumberId}` (per-number bucket).
    expect(observedRateLimitKeys).toContain("whatsapp:1098765432109876");
    // DB lookup against the catalog row's stable id with config->>'phone_number_id'.
    const installQueryCalls = mockInternalQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("workspace_plugins"),
    );
    expect(installQueryCalls).toHaveLength(1);
    const [sql, params] = installQueryCalls[0];
    expect(String(sql)).toMatch(/config->>'phone_number_id'/);
    expect(params).toEqual(["catalog:whatsapp", "1098765432109876"]);
  });

  it("WhatsApp fail-closes on unknown phone_number_id (no install row) — never invokes the agent", async () => {
    // No rows match → resolveWhatsAppWorkspaceId throws the inline
    // WhatsAppUnknownTenantError; runWhatsAppExecuteQuery rethrows as
    // a user-safe error. The agent must never run.
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "whatsapp:9999999999999999:16315551234",
        adapter: { name: "whatsapp" },
        rawMessage: {
          phoneNumberId: "9999999999999999",
          contact: { profile: { name: "Test" }, wa_id: "16315551234" },
          message: { from: "16315551234", type: "text", text: { body: "q" } },
        },
      }),
    ).rejects.toThrow(/not connected to Atlas/i);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("WhatsApp fail-closes on DB outage during workspace resolution — user-safe error, never invokes the agent", async () => {
    mockInternalQuery.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED postgres://internal-db:5432")),
    );
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "whatsapp:1098765432109876",
        adapter: { name: "whatsapp" },
        rawMessage: {
          phoneNumberId: "1098765432109876",
          message: { from: "16315551234", type: "text", text: { body: "q" } },
        },
      }),
    ).rejects.toThrow(/could not resolve the WhatsApp workspace/i);
    expect(capturedAgentCalls).toHaveLength(0);
  });

  it("WhatsApp fail-closes when the same phone_number_id maps to multiple workspaces — cross-tenant misroute defense", async () => {
    // Meta issues each phone_number_id exactly once across the entire
    // platform, so a duplicate here is operator misconfig (manual DB
    // edit). The fail-closed branch surfaces as the same user-safe
    // error as "unknown number," and an operator log line points at
    // the duplicate (including the matched workspace_ids — see the
    // handler resolver, the fingerprint-only log was insufficient).
    mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("workspace_plugins")) {
        return Promise.resolve([
          { workspace_id: "org-a" },
          { workspace_id: "org-b" },
        ]);
      }
      return Promise.resolve([]);
    });
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "whatsapp:dup",
        adapter: { name: "whatsapp" },
        rawMessage: {
          phoneNumberId: "1098765432109876",
          message: { from: "16315551234", type: "text", text: { body: "q" } },
        },
      }),
    ).rejects.toThrow(/not connected to Atlas/i);
    expect(capturedAgentCalls).toHaveLength(0);
    // SQL filter shape: the duplicate-match defense MUST scope its
    // lookup to (catalog_id = catalog:whatsapp, enabled = true,
    // config->>'phone_number_id'). A refactor that genericized the
    // resolver and dropped any of these filters would silently widen
    // the cross-tenant boundary.
    const installQueryCalls = mockInternalQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("workspace_plugins"),
    );
    const [sql, params] = installQueryCalls[0];
    expect(String(sql)).toMatch(/catalog_id\s*=\s*\$1/);
    expect(String(sql)).toMatch(/enabled\s*=\s*true/);
    expect(String(sql)).toMatch(/config->>'phone_number_id'/);
    expect(params).toEqual(["catalog:whatsapp", "1098765432109876"]);
  });

  it("WhatsApp rejects events whose phoneNumberId isn't a valid Meta routing id — defends rate-limit cache key shape", async () => {
    // Even though the HMAC-SHA256 webhook signature gate catches forgery
    // at the adapter layer, the dispatcher belt-and-suspenders by
    // re-validating the routing-id shape (WHATSAPP_PHONE_NUMBER_ID_RE).
    // Garbage phoneNumberId surfaces as the "missing tenant context"
    // error — no DB read, no agent.
    mockInternalQuery.mockImplementation(() => {
      throw new Error("internalQuery should never be reached on shape failure");
    });
    const { runExecuteQuery } = await import("../executeQuery");

    await expect(
      runExecuteQuery("q", {
        threadId: "whatsapp:bad",
        adapter: { name: "whatsapp" },
        rawMessage: {
          phoneNumberId: "not-a-number'; DROP TABLE--",
          message: { from: "16315551234", type: "text", text: { body: "q" } },
        },
      }),
    ).rejects.toThrow(/missing tenant context/i);
    expect(mockInternalQuery).not.toHaveBeenCalled();
    expect(capturedAgentCalls).toHaveLength(0);
  });
});
