/**
 * Unit tests for the Hono chat route.
 *
 * Mocks auth, rate-limiting, startup diagnostics, and the agent to
 * isolate the route wiring logic. Tests the Hono app.fetch() directly.
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
import { APICallError, LoadAPIKeyError, NoSuchModelError } from "ai";
import { GatewayModelNotFoundError } from "@ai-sdk/gateway";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// --- Mocks ---

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "none" as const,
    user: undefined,
  }),
);

const mockCheckRateLimit: Mock<
  (key: string) => { allowed: boolean; retryAfterMs?: number }
> = mock(() => ({ allowed: true }));

const mockGetClientIP: Mock<(req: Request) => string | null> = mock(
  () => null,
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

const mockValidateEnvironment: Mock<
  () => Promise<{ message: string }[]>
> = mock(() => Promise.resolve([]));

const mockRunAgent = mock(() =>
  Promise.resolve({
    toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
    toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
    text: Promise.resolve("answer"),
  }),
);

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

mock.module("@atlas/api/lib/tools/python-stream", () => ({
  setStreamWriter: () => {},
  clearStreamWriter: () => {},
  getStreamWriter: () => undefined,
}));

// Mock modules needed by health and auth routes (loaded via ../index)
mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: () => [],
}));

// Mock action tools so buildRegistry({ includeActions: true }) works
// without needing JIRA/email credentials or external services.
mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket",
    description: "### Create JIRA Ticket\nMock",
    tool: { type: "function" },
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "### Send Email Report\nMock",
    tool: { type: "function" },
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

const mockCreateConversation = mock((): Promise<{ id: string } | null> =>
  Promise.resolve({ id: "conv-test-123" }),
);
const mockAddMessage = mock(() => {});
const mockGetConversationChat = mock((): Promise<{ ok: boolean; reason?: string; data?: unknown }> => Promise.resolve({ ok: false, reason: "not_found" }));
const mockGenerateTitle = mock((q: string) => q.slice(0, 80));
// #3066 — captured so tests can assert the REST exclude-set persist path
// (incl. the re-include `[]` case, the #3073 transport-omits-null bug class).
const mockUpdateConversationRestExcluded = mock(() =>
  Promise.resolve({ ok: true as const }),
);
// #3067 — captured so tests can assert the REST-only focus persist path,
// incl. the clear-via-null case (the #3073 transport-omits-null bug class).
const mockUpdateConversationRestFocus = mock(() =>
  Promise.resolve({ ok: true as const }),
);
// #3895 — captured so tests can assert the Group-reach persist path, incl. the
// widen-via-null case (the #3073 transport-omits-null bug class). The chat route
// imports + CALLS this synchronously (before .catch), so it MUST be mocked or
// the persist-reach branch throws a TypeError the moment the picker is touched.
const mockUpdateConversationGroupReach = mock(() =>
  Promise.resolve({ ok: true as const }),
);
// #4302 — captured so tests can assert the answer-style persist path (persist
// on explicit change, no UPDATE when unchanged/omitted). Like the reach helper
// above, chat.ts calls this synchronously (before .catch), so it MUST be
// mocked or the persist-style branch throws the moment the picker is touched.
const mockUpdateConversationAnswerStyle = mock(() =>
  Promise.resolve({ ok: true as const }),
);
type ReservationResult =
  | { status: "ok"; totalStepsBefore: number }
  | { status: "exceeded"; totalSteps: number }
  | { status: "no_db" }
  | { status: "error" };
const mockReserveConversationBudget = mock(
  (): Promise<ReservationResult> => Promise.resolve({ status: "ok", totalStepsBefore: 0 }),
);
const mockSettleConversationSteps = mock(() => {});
const mockPersistAssistantSteps = mock(() => {});
// #2424 — captured so individual tests can override with
// `mockResolvedValueOnce("not_found")` to exercise the 400 reject path.
const mockVerifyGroupBelongsToOrg = mock(
  (): Promise<"ok" | "not_found" | "no_db" | "error"> => Promise.resolve("ok"),
);

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mockCreateConversation,
  addMessage: mockAddMessage,
  persistAssistantSteps: mockPersistAssistantSteps,
  getConversation: mockGetConversationChat,
  generateTitle: mockGenerateTitle,
  reserveConversationBudget: mockReserveConversationBudget,
  settleConversationSteps: mockSettleConversationSteps,
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  starConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
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
  verifyGroupBelongsToOrg: mockVerifyGroupBelongsToOrg,
  updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestExcluded: mockUpdateConversationRestExcluded,
  updateConversationRestFocus: mockUpdateConversationRestFocus,
  updateConversationGroupReach: mockUpdateConversationGroupReach,
  updateConversationAnswerStyle: mockUpdateConversationAnswerStyle,
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
}));

const mockGetPluginTools: Mock<() => unknown> = mock(() => undefined);

mock.module("@atlas/api/lib/plugins/tools", () => ({
  getPluginTools: mockGetPluginTools,
  setPluginTools: () => {},
  getContextFragments: () => [],
  setContextFragments: () => {},
  getDialectHints: () => [],
  setDialectHints: () => {},
}));

// Plan-limit enforcement is mocked at the module boundary so tests can
// dial in a {allowed: true, warning: ...} result without standing up the
// full billing pipeline. Default returns the no-warning happy path; the
// `#2005 — plan-warning` test section inside the `#1988 B5` describe
// block opts in to the warning shape per-test.
type PlanCheckMockResult =
  | { allowed: true; warning?: { code: "plan_limit_warning"; message: string; metrics: unknown[] } }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: number;
      usage?: unknown;
    };
const mockCheckPlanLimits: Mock<() => Promise<PlanCheckMockResult>> = mock(
  () => Promise.resolve({ allowed: true } as PlanCheckMockResult),
);

// Residency precheck (chat.ts:~510) fires before the abuse gate when a
// request carries `activeOrganizationId`. Default to "not migrating" so
// the abuse branch is the only non-200 source in the #2269 test below.
mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: mock(async () => false),
}));

mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkPlanLimits: mockCheckPlanLimits,
  // Mocking partial named exports causes a SyntaxError elsewhere in
  // the suite (per CLAUDE.md "Mock all exports"). These are no-ops
  // because the chat path only touches `checkPlanLimits`.
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
}));

// Abuse shim mock (#4000 — WS5). The chat path consults the abuse verdict
// through `agent-gate.ts → checkAbuseStatus` (imported from the shim). Post-
// split the graduated-response engine lives in `@atlas/ee` and a core test
// can't reach it, so we mock the shim's `checkAbuseStatus` here to drive the
// route-level contract directly. `mockCheckAbuseStatus` defaults to `none` so
// every OTHER chat test is unaffected; the #2269 block below flips it to
// exercise the suspended (403) and allowlist-shadowed (none → 200) verdicts.
// Mock-all-exports per CLAUDE.md — the rest are inert stubs the chat path
// never touches.
const mockCheckAbuseStatus: Mock<(orgId: string) => { level: string; throttleDelayMs?: number }> =
  mock(() => ({ level: "none" }));

mock.module("@atlas/api/lib/security/abuse", () => ({
  checkAbuseStatus: mockCheckAbuseStatus,
  recordQueryEvent: mock(() => {}),
  listFlaggedWorkspaces: mock(() => []),
  getAbuseDetail: mock(async () => null),
  getAbuseEvents: mock(async () => ({ events: [], status: "db_unavailable" })),
  reinstateWorkspace: mock(() => null),
  getAbuseConfig: mock(() => ({
    queryRateLimit: 200,
    queryRateWindowSeconds: 300,
    errorRateThreshold: 0.5,
    uniqueTablesLimit: 50,
    throttleDelayMs: 2000,
    escalationCooldownMs: 60_000,
  })),
  restoreAbuseState: mock(async () => {}),
  getAbuseRestoreStatus: mock(() => "db_unavailable" as const),
  abuseCleanupTick: mock(() => {}),
  _resetAbuseState: mock(() => {}),
  ABUSE_RESTORE_STATUSES: ["pending", "ok", "db_unavailable", "load_failed"] as const,
  ABUSE_CLEANUP_INTERVAL_MS: 300_000,
}));

// Import after mocks are registered
const { app } = await import("../index");

describe("POST /api/v1/chat", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  const origDatabaseUrl = process.env.DATABASE_URL;
  const origActionsEnabled = process.env.ATLAS_ACTIONS_ENABLED;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL =
      "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "none" as const,
      user: undefined,
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);
    mockValidateEnvironment.mockReset();
    mockValidateEnvironment.mockResolvedValue([]);
    mockRunAgent.mockReset();
    mockRunAgent.mockResolvedValue({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      text: Promise.resolve("answer"),
    });
    mockCreateConversation.mockReset();
    mockCreateConversation.mockResolvedValue({ id: "conv-test-123" });
    mockAddMessage.mockReset();
    mockGetConversationChat.mockReset();
    mockGetConversationChat.mockResolvedValue({ ok: false, reason: "not_found" });
    mockUpdateConversationRestExcluded.mockReset();
    mockUpdateConversationRestExcluded.mockResolvedValue({ ok: true as const });
    mockUpdateConversationRestFocus.mockReset();
    mockUpdateConversationRestFocus.mockResolvedValue({ ok: true as const });
    mockUpdateConversationGroupReach.mockReset();
    mockUpdateConversationGroupReach.mockResolvedValue({ ok: true as const });
    mockUpdateConversationAnswerStyle.mockReset();
    mockUpdateConversationAnswerStyle.mockResolvedValue({ ok: true as const });
    mockReserveConversationBudget.mockReset();
    mockReserveConversationBudget.mockResolvedValue({ status: "ok", totalStepsBefore: 0 });
    mockSettleConversationSteps.mockReset();
    mockPersistAssistantSteps.mockReset();
    delete process.env.ATLAS_ACTIONS_ENABLED;
    delete process.env.ATLAS_CONVERSATION_STEP_CAP;
    mockGetPluginTools.mockReset();
    mockGetPluginTools.mockReturnValue(undefined);
    mockCheckPlanLimits.mockReset();
    mockCheckPlanLimits.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    if (origDatasource !== undefined)
      process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origDatabaseUrl !== undefined)
      process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
    if (origActionsEnabled !== undefined)
      process.env.ATLAS_ACTIONS_ENABLED = origActionsEnabled;
    else delete process.env.ATLAS_ACTIONS_ENABLED;
  });

  function makeRequest(body?: unknown): Request {
    return new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        body ?? {
          messages: [
            {
              id: "1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ),
    });
  }

  it("returns 200 stream on success", async () => {
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    // Response is a UI message SSE stream, not plain text
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("returns 400 when body connectionGroupId belongs to a different org (#2424)", async () => {
    // The chat handler verifies any body-supplied connectionGroupId against
    // the caller's active org BEFORE persisting it onto the conversation.
    // A "not_found" verdict means the group exists in some other tenant
    // (or doesn't exist) — either way, we reject rather than write a
    // cross-org pointer.
    mockVerifyGroupBelongsToOrg.mockResolvedValueOnce("not_found");
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        connectionGroupId: "g_other_org_group",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_connection_group");
    // Never persisted — agent never ran either.
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("propagates per-turn connectionId/connectionGroupId into the ALS frame the agent sees (#2414)", async () => {
    // The central correctness claim of #2345: a per-turn override from the
    // body lands in the `withRequestContext` frame around `runAgent`, so
    // tools downstream (executeSQL, plugin tools) see the routing via
    // `getRequestContext()`. Pre-this test there was no integration check
    // — `conversations-group-routing.test.ts` exercises the ALS primitive
    // and `resolveGroupForConnection` in isolation, but not the chat
    // route's resolution flow that feeds them.
    //
    // We capture `getRequestContext()` at the moment runAgent is invoked,
    // then assert the resolved fields match the body override (NOT the
    // conversation's stored values).
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        connectionId: "eu-conn-id",
        connectionGroupId: "g_prod",
      }),
    );
    expect(response.status).toBe(200);
    // The captured frame must reflect the body override. If a future refactor
    // reads from the persisted row instead, or drops one of the fields from
    // the nested withRequestContext frame, this flips red.
    expect(capturedContext?.connectionId).toBe("eu-conn-id");
    expect(capturedContext?.connectionGroupId).toBe("g_prod");
  });

  // #2518 — three-state Auto/Pin/All picker. Body's `routingMode`
  // lands in the `withRequestContext` frame so `executeSQL` can pass
  // it to `resolveRoutingPlan` as `pickerMode`. Mirror of the #2414
  // test above for the routing-mode plumbing.
  it("propagates per-turn routingMode into the ALS frame the agent sees (#2518)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        routingMode: "all",
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.routingMode).toBe("all");
  });

  // #2518 — back-compat default. When neither the body nor the
  // persisted conversation row carries a routing mode (pre-#2518
  // chats), the chat route stamps 'pin' on the ALS frame so the
  // agent's `scope: "all"` hints don't suddenly start fanning out on
  // legacy chats. The tool's own default ('auto') only kicks in for
  // non-chat callers (MCP / scheduler / direct tool tests).
  it("stamps routingMode='pin' on the ALS frame when neither body nor conversation row supplies one (#2518)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(makeRequest()); // No routingMode in body
    expect(response.status).toBe(200);
    expect(capturedContext?.routingMode).toBe("pin");
  });

  // #3066 — the conversation's REST exclude-set must reach the agent via the
  // ALS frame so the REST datasource resolver (agent.ts) drops the excluded
  // installs before the prompt + the bound executeRestOperation tool see them.
  it("propagates restExcludedDatasourceIds into the ALS frame the agent sees (#3066)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        restExcludedDatasourceIds: ["ds-excluded-1"],
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.restExcludedDatasourceIds).toEqual(["ds-excluded-1"]);
  });

  // #3066 — an empty exclude-set excludes nothing, so it must NOT be stamped
  // on the ALS frame (the resolver's `undefined` = "no exclusions" path). This
  // keeps the legacy "every in-scope datasource queryable" shape for the
  // common case where the user never touched the scope picker.
  it("strips an empty restExcludedDatasourceIds from the ALS frame (empty = exclude nothing) (#3066)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        restExcludedDatasourceIds: [],
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.restExcludedDatasourceIds).toBeUndefined();
  });

  // #3066 / #3073 — the re-include path. An existing conversation already
  // excludes ds-1; the user re-includes it, so the body carries `[]`. Because
  // the web transport drops null/undefined fields, the route distinguishes
  // "field present as []" (persist the cleared set) from "field absent"
  // (inherit the row). This pins the present-`[]` branch — without it a
  // re-include silently keeps the stale exclusion.
  it("persists a re-include ([] clears a prior non-empty exclusion) (#3066/#3073)", async () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: ["ds-1"],
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "re-include" }] }],
        conversationId: convId,
        restExcludedDatasourceIds: [],
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationRestExcluded).toHaveBeenCalledTimes(1);
    const calls = mockUpdateConversationRestExcluded.mock.calls as unknown as unknown[][];
    // Second arg is the new (now-empty) set persisted to the row.
    expect(calls[0]![1]).toEqual([]);
  });

  // #3066 — when the body OMITS the exclude-set (the common follow-up turn),
  // the stored set is inherited and NO redundant UPDATE fires (sameStringSet
  // gate). This is the counterpart to the re-include test above.
  it("inherits the stored exclude-set and skips the UPDATE when the body omits it (#3066)", async () => {
    const convId = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: ["ds-1"],
        messages: [],
      },
    });
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
        // restExcludedDatasourceIds intentionally omitted
      }),
    );
    expect(response.status).toBe(200);
    // Inherited the stored set into the ALS frame…
    expect(capturedContext?.restExcludedDatasourceIds).toEqual(["ds-1"]);
    // …and did NOT burn an UPDATE (body matched the stored set / was absent).
    expect(mockUpdateConversationRestExcluded).not.toHaveBeenCalled();
  });

  // #3066 — the `sameStringSet` gate: a body that sends a non-empty set EQUAL
  // to the stored set (here reordered) must NOT burn an UPDATE. A regression to
  // order-sensitive (e.g. JSON.stringify) comparison would bump `updated_at`
  // and reshuffle the conversation list on every turn.
  it("skips the UPDATE when the body's exclude-set equals the stored set (reordered) (#3066)", async () => {
    const convId = "d4e5f6a7-b8c9-4def-89ab-cdef01234567";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: ["ds-1", "ds-2"],
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "same set" }] }],
        conversationId: convId,
        // Same set, different order — set-equality must treat it as unchanged.
        restExcludedDatasourceIds: ["ds-2", "ds-1"],
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationRestExcluded).not.toHaveBeenCalled();
  });

  // #3067 — the conversation's REST-only focus must reach the agent via the ALS
  // frame so the agent loop resolves only that datasource and suspends executeSQL.
  it("propagates restFocusDatasourceId into the ALS frame the agent sees (#3067)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "ask stripe only" }] }],
        restFocusDatasourceId: "ds-stripe",
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.restFocusDatasourceId).toBe("ds-stripe");
  });

  // #3067 — a null/cleared focus must NOT be stamped on the ALS frame (the
  // agent's "not focused" / default-scope path). Keeps the legacy shape for the
  // common case where the conversation isn't focused.
  it("does not stamp a null restFocusDatasourceId on the ALS frame (not focused) (#3067)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        restFocusDatasourceId: null,
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.restFocusDatasourceId).toBeUndefined();
  });

  // #3067 / #3073 — the clear-focus path. An existing conversation is focused on
  // ds-stripe; the user clears focus, so the body carries `null` (the transport
  // sends null explicitly). The route distinguishes "field present as null"
  // (persist the clear) from "field absent" (inherit the row) — without it a
  // clear silently keeps the stale focus.
  it("persists a clear (null nulls a prior focus) (#3067/#3073)", async () => {
    const convId = "c3d4e5f6-a7b8-49c0-9def-0123456789ab";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: "ds-stripe",
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "clear focus" }] }],
        conversationId: convId,
        restFocusDatasourceId: null,
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationRestFocus).toHaveBeenCalledTimes(1);
    const calls = mockUpdateConversationRestFocus.mock.calls as unknown as unknown[][];
    // Second arg is the new (null) focus persisted to the row.
    expect(calls[0]![1]).toBeNull();
  });

  // #3067 — when the body OMITS focus (the common follow-up turn), the stored
  // focus is inherited into the ALS frame and NO redundant UPDATE fires.
  it("inherits the stored focus and skips the UPDATE when the body omits it (#3067)", async () => {
    const convId = "e5f6a7b8-c9d0-41e2-93f4-56789abcdef0";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: "ds-stripe",
        messages: [],
      },
    });
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
        // restFocusDatasourceId intentionally omitted
      }),
    );
    expect(response.status).toBe(200);
    // Inherited the stored focus into the ALS frame…
    expect(capturedContext?.restFocusDatasourceId).toBe("ds-stripe");
    // …and did NOT burn an UPDATE (body absent → inherit, no change).
    expect(mockUpdateConversationRestFocus).not.toHaveBeenCalled();
  });

  // #3895 — the conversation's Group reach (a Focus group id) must reach the
  // agent via the ALS frame so executeSQL's reach resolver bounds queries to it.
  it("propagates groupReach into the ALS frame the agent sees (#3895)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "focus prod" }] }],
        groupReach: "g_prod",
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.groupReach).toBe("g_prod");
  });

  // #3895 — a null/All-sources reach must NOT be stamped on the ALS frame, so the
  // default "every visible group reachable" shape is byte-identical for the
  // common non-focused conversation.
  it("does not stamp a null groupReach on the ALS frame (All sources) (#3895)", async () => {
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        groupReach: null,
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedContext?.groupReach).toBeUndefined();
  });

  // #3895 / #3073 — the widen path. An existing conversation is Focused on
  // g_prod; the user widens to All sources, so the body carries `null`. The route
  // distinguishes "field present as null" (persist the widen) from "field absent"
  // (inherit the row) — without it a widen silently keeps the stale Focus.
  it("persists a widen (null widens a prior Focus to All sources) (#3895/#3073)", async () => {
    const convId = "a1b2c3d4-e5f6-4708-9a0b-1c2d3e4f5061";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: "g_prod",
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "widen" }] }],
        conversationId: convId,
        groupReach: null,
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationGroupReach).toHaveBeenCalledTimes(1);
    const calls = mockUpdateConversationGroupReach.mock.calls as unknown as unknown[][];
    // Second arg is the new (null) reach persisted to the row.
    expect(calls[0]![1]).toBeNull();
  });

  // #3895 — when the body OMITS groupReach (the common follow-up turn), the
  // stored Focus is inherited into the ALS frame and NO redundant UPDATE fires.
  it("inherits the stored Group reach and skips the UPDATE when the body omits it (#3895)", async () => {
    const convId = "b2c3d4e5-f6a7-4819-8b0c-2d3e4f506172";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: "g_prod",
        messages: [],
      },
    });
    const { getRequestContext } = await import("@atlas/api/lib/logger");
    let capturedContext: ReturnType<typeof getRequestContext> | undefined;
    mockRunAgent.mockImplementationOnce(() => {
      capturedContext = getRequestContext();
      return Promise.resolve({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
        // groupReach intentionally omitted
      }),
    );
    expect(response.status).toBe(200);
    // Inherited the stored Focus into the ALS frame…
    expect(capturedContext?.groupReach).toBe("g_prod");
    // …and did NOT burn an UPDATE (body absent → inherit, no change).
    expect(mockUpdateConversationGroupReach).not.toHaveBeenCalled();
  });

  // #4302 — per-conversation answer style: the header picker's selection
  // rides the chat request, feeds prompt assembly via runAgent's
  // `answerStyle` param (NOT the ALS frame — it's a direct agent option),
  // and persists on the conversation row so it restores on reopen.
  it("passes a body-supplied answerStyle to runAgent and persists it at creation (#4302)", async () => {
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        answerStyle: "executive",
      }),
    );
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const runCalls = mockRunAgent.mock.calls as unknown as unknown[][];
    expect((runCalls[0]![0] as { answerStyle?: string }).answerStyle).toBe("executive");
    // The conversation-creating turn stamps the picked style onto the row.
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    const createCalls = mockCreateConversation.mock.calls as unknown as unknown[][];
    expect((createCalls[0]![0] as { answerStyle?: string | null }).answerStyle).toBe("executive");
  });

  // #4302 — the schema seam is the single validation layer (no DB CHECK, see
  // migration 0165): an out-of-vocabulary style must 422 before any
  // conversation write or agent run.
  it("rejects an out-of-vocabulary answerStyle at the schema seam (#4302)", async () => {
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        answerStyle: "sarcastic",
      }),
    );
    expect(response.status).toBe(422);
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  // #4302 — the acceptance criterion's "subsequent turns" half at the route
  // seam: a conversation pinned to `executive` keeps voicing executive on a
  // follow-up turn whose body omits the field (the transport only sends the
  // style once its state holds one — picked or restored). The prompt-assembly
  // half — runAgent
  // with `executive` building the executive addendum — is pinned by the
  // mock-LLM test in lib/__tests__/agent-answer-style-prompt-shape.test.ts.
  it("inherits the stored answer style on a follow-up turn that omits it (#4302)", async () => {
    const convId = "c3d4e5f6-a7b8-4920-9c1d-3e4f50617283";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
        answerStyle: "executive",
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
        // answerStyle intentionally omitted
      }),
    );
    expect(response.status).toBe(200);
    const runCalls = mockRunAgent.mock.calls as unknown as unknown[][];
    expect((runCalls[0]![0] as { answerStyle?: string }).answerStyle).toBe("executive");
    // Inherit is not a change — no UPDATE burned.
    expect(mockUpdateConversationAnswerStyle).not.toHaveBeenCalled();
  });

  // #4302 — the pre-#4302 back-compat path: an existing conversation whose
  // row has NO explicit choice (NULL) and whose body omits the field must
  // reach runAgent with NO answerStyle — prompt assembly then applies the
  // live surface default, so legacy conversations keep tracking it.
  it("threads no answerStyle for a NULL-row conversation whose body omits it (#4302)", async () => {
    const convId = "a7b8c9d0-e1f2-4d64-b051-728394051627";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
        answerStyle: null,
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "legacy turn" }] }],
        conversationId: convId,
      }),
    );
    expect(response.status).toBe(200);
    const runCalls = mockRunAgent.mock.calls as unknown as unknown[][];
    expect((runCalls[0]![0] as { answerStyle?: string }).answerStyle).toBeUndefined();
    expect(mockUpdateConversationAnswerStyle).not.toHaveBeenCalled();
  });

  // #4302 — an explicit picker change persists onto the row (that's what
  // makes it restore on reopen), and takes effect on this very turn.
  it("persists an explicit answer-style change on an existing conversation (#4302)", async () => {
    const convId = "d4e5f6a7-b8c9-4a31-8d2e-4f5061728394";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
        answerStyle: "analyst",
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "switch voice" }] }],
        conversationId: convId,
        answerStyle: "plain-english",
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationAnswerStyle).toHaveBeenCalledTimes(1);
    const updateCalls = mockUpdateConversationAnswerStyle.mock.calls as unknown as unknown[][];
    expect(updateCalls[0]![0]).toBe(convId);
    expect(updateCalls[0]![1]).toBe("plain-english");
    // The changed style also voices THIS turn.
    const runCalls = mockRunAgent.mock.calls as unknown as unknown[][];
    expect((runCalls[0]![0] as { answerStyle?: string }).answerStyle).toBe("plain-english");
  });

  // #4302 — the most common real-world transition: an existing conversation
  // with NO explicit choice (NULL row) gets its first explicit pick — the
  // UPDATE must fire (null !== "executive") so the pick survives reopen.
  it("persists the first explicit pick on a previously-default conversation (#4302)", async () => {
    const convId = "f6a7b8c9-d0e1-4c53-af40-617283940516";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
        answerStyle: null,
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "first pick" }] }],
        conversationId: convId,
        answerStyle: "executive",
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationAnswerStyle).toHaveBeenCalledTimes(1);
    const updateCalls = mockUpdateConversationAnswerStyle.mock.calls as unknown as unknown[][];
    expect(updateCalls[0]![1]).toBe("executive");
  });

  // #4302 — re-sending the stored style (the transport re-sends it every turn
  // once its state holds one — picked this session or restored on reopen)
  // must NOT burn an UPDATE. This is the common reopened-conversation turn.
  it("skips the UPDATE when the body's answerStyle equals the stored value (#4302)", async () => {
    const convId = "e5f6a7b8-c9d0-4b42-9e3f-506172839405";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: {
        id: convId,
        userId: null,
        title: "Test",
        connectionId: null,
        connectionGroupId: null,
        routingMode: null,
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
        answerStyle: "executive",
        messages: [],
      },
    });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "same voice" }] }],
        conversationId: convId,
        answerStyle: "executive",
      }),
    );
    expect(response.status).toBe(200);
    expect(mockUpdateConversationAnswerStyle).not.toHaveBeenCalled();
  });

  // #4302 — no explicit choice anywhere ⇒ runAgent gets NO answerStyle (prompt
  // assembly applies the live surface default, `analyst`) and the created row
  // persists NULL so it keeps tracking the default rather than freezing it.
  it("omits answerStyle from runAgent and persists NULL when nothing supplies one (#4302)", async () => {
    const response = await app.fetch(makeRequest()); // no answerStyle in body
    expect(response.status).toBe(200);
    const runCalls = mockRunAgent.mock.calls as unknown as unknown[][];
    expect((runCalls[0]![0] as { answerStyle?: string }).answerStyle).toBeUndefined();
    const createCalls = mockCreateConversation.mock.calls as unknown as unknown[][];
    expect((createCalls[0]![0] as { answerStyle?: string | null }).answerStyle).toBeNull();
  });

  // F-74 regression pin: the chat handler MUST pass `bucket: "chat"` so the
  // request lands in the chat-scoped sliding window. Without this option a
  // 25-step agent run drains the same allowance that serves cheap admin
  // reads. Asserting the second argument here catches a refactor that drops
  // the option object — `mockCheckRateLimit` would still gate but the
  // F-74 isolation acceptance criterion would silently regress.
  it("F-74 — chat handler debits the chat bucket", async () => {
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    const calls = mockCheckRateLimit.mock.calls as unknown as unknown[][];
    const args = calls[0]!;
    // Second argument must carry { bucket: "chat" }.
    expect(args[1]).toEqual({ bucket: "chat" });
  });

  it("returns 401 when authenticateRequest returns unauthenticated", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      authenticated: false as const,
      mode: "simple-key" as const,
      status: 401 as const,
      error: "API key required",
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(401);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("API key required");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 500 when authenticateRequest throws", async () => {
    mockAuthenticateRequest.mockRejectedValueOnce(new Error("DB crashed"));

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("auth_error");
    expect(body.message).toBe("Authentication system error");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterMs: 30000,
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(30);

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns retryAfterSeconds=60 when retryAfterMs is undefined", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.retryAfterSeconds).toBe(60);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After for pool exhaustion errors", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("sorry, too many clients already"));
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(body.retryable).toBe(true);
    expect(body.retryAfterSeconds).toBe(5);
    expect(body.message).toContain("pool exhausted");
  });

  it("returns 400 when ATLAS_DATASOURCE_URL is not set", async () => {
    delete process.env.ATLAS_DATASOURCE_URL;

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("no_datasource");
    expect(body.message).toContain("ATLAS_DATASOURCE_URL");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when validateEnvironment reports errors", async () => {
    mockValidateEnvironment.mockResolvedValueOnce([
      { message: "Missing API key" },
    ]);

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("configuration_error");

    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns x-conversation-id header when conversation is created", async () => {
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBe("conv-test-123");
  });

  it("returns 404 when conversationId does not belong to user", async () => {
    mockGetConversationChat.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("continues existing conversation and persists user message", async () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockGetConversationChat.mockResolvedValueOnce({
      ok: true,
      data: { id: convId, userId: null, title: "Test", messages: [] },
    });

    const response = await app.fetch(
      makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBe(convId);
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockAddMessage).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // F-77 — per-conversation aggregate step ceiling
  // ---------------------------------------------------------------------

  describe("F-77 — conversation budget ceiling", () => {
    const convId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    function makeFollowUp(): Request {
      return makeRequest({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "follow up" }] }],
        conversationId: convId,
      });
    }

    it("rejects with conversation_budget_exceeded when reservation is over the cap", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      // Atomic reservation rejects — the gate is enforced at the row, not
      // at the application. The pre-check failure must short-circuit before
      // the agent runs.
      mockReserveConversationBudget.mockResolvedValueOnce({
        status: "exceeded",
        totalSteps: 10,
      });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(429);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("conversation_budget_exceeded");
      expect(body.retryable).toBe(false);
      expect(typeof body.requestId).toBe("string");
      // Agent must not have been invoked.
      expect(mockRunAgent).not.toHaveBeenCalled();
      // Settlement should not run on the rejection path.
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();
    });

    it("allows the request when reservation succeeds and settles after the stream", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      process.env.ATLAS_AGENT_MAX_STEPS = "5";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({
        status: "ok",
        totalStepsBefore: 5,
      });
      // Stream resolves with 3 actual steps so settlement refunds 5 - 3 = 2.
      mockRunAgent.mockResolvedValueOnce({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
        steps: Promise.resolve([{}, {}, {}]),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Reservation must be charged with the full agent step budget upfront.
      const reserveCalls = mockReserveConversationBudget.mock.calls as unknown as unknown[][];
      expect(reserveCalls.length).toBe(1);
      expect(reserveCalls[0]).toEqual([convId, 5, 10]);
      // Wait for the fire-and-forget settlement promise chain to flush.
      await Promise.resolve();
      await Promise.resolve();
      const settleCalls = mockSettleConversationSteps.mock.calls as unknown as unknown[][];
      expect(settleCalls.length).toBe(1);
      expect(settleCalls[0]).toEqual([convId, 5, 3]);

      delete process.env.ATLAS_AGENT_MAX_STEPS;
    });

    // Conservative cost-accounting pin: when the agent stream rejects mid-
    // flight the reservation MUST stay charged (settlement is skipped).
    // Otherwise an attacker could spin up streams that fail mid-flight to
    // refund their full budget — exactly the abuse vector the F-77 cap is
    // designed to bound.
    it("does not settle when the agent stream rejects (reservation stays charged)", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      process.env.ATLAS_AGENT_MAX_STEPS = "5";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({
        status: "ok",
        totalStepsBefore: 0,
      });
      // Suppress the unhandled-rejection log noise; the catch in chat.ts
      // owns the rejection.
      const stepsRejection = Promise.reject(new Error("stream blew up"));
      stepsRejection.catch(() => undefined);
      mockRunAgent.mockResolvedValueOnce({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        text: Promise.resolve("answer"),
        steps: stepsRejection,
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Flush the fire-and-forget chain.
      await Promise.resolve();
      await Promise.resolve();
      // Settlement must NOT have run — the full reservation stays charged.
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();

      delete process.env.ATLAS_AGENT_MAX_STEPS;
    });

    it("disables the gate when ATLAS_CONVERSATION_STEP_CAP=0", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "0";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Reservation must NOT be attempted when the cap is disabled.
      expect(mockReserveConversationBudget).not.toHaveBeenCalled();
    });

    it("fails open when reservation returns no_db (internal DB unavailable)", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({ status: "no_db" });

      // Fail-open: a transient internal-DB glitch must not 429 the chat surface.
      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // No reservation was charged → no settlement either.
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();
    });

    it("fails open when reservation returns error (read/write threw)", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });
      mockReserveConversationBudget.mockResolvedValueOnce({ status: "error" });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      expect(mockSettleConversationSteps).not.toHaveBeenCalled();
    });

    it("invalid ATLAS_CONVERSATION_STEP_CAP falls back to default 500", async () => {
      process.env.ATLAS_CONVERSATION_STEP_CAP = "abc";
      mockGetConversationChat.mockResolvedValueOnce({
        ok: true,
        data: { id: convId, userId: null, title: "Test", messages: [] },
      });

      const response = await app.fetch(makeFollowUp());
      expect(response.status).toBe(200);
      // Reservation must have been called with the default cap of 500.
      const reserveCalls = mockReserveConversationBudget.mock.calls as unknown as unknown[][];
      expect(reserveCalls.length).toBe(1);
      expect(reserveCalls[0]?.[2]).toBe(500);
    });
  });

  it("returns 200 without x-conversation-id when createConversation fails", async () => {
    mockCreateConversation.mockResolvedValueOnce(null);
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBeNull();
  });

  it("returns 200 when conversation creation throws", async () => {
    mockCreateConversation.mockRejectedValueOnce(new Error("DB crashed"));
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-conversation-id")).toBeNull();
  });

  it("returns 400 for invalid conversationId format", async () => {
    const response = await app.fetch(
      makeRequest({
        messages: [
          { id: "1", role: "user", parts: [{ type: "text", text: "hello" }] },
        ],
        conversationId: "not-a-uuid",
      }),
    );
    // OpenAPIHono's built-in Zod validation returns 400 by default (no defaultHook override)
    expect(response.status).toBe(422);
  });

  it("passes action tools to runAgent when ATLAS_ACTIONS_ENABLED=true", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { tools?: unknown };
    expect(call.tools).toBeDefined();
  });

  it("does not pass action tools when ATLAS_ACTIONS_ENABLED is unset", async () => {
    delete process.env.ATLAS_ACTIONS_ENABLED;
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { tools?: unknown };
    expect(call.tools).toBeUndefined();
  });

  it("does not pass action tools when ATLAS_ACTIONS_ENABLED=false", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "false";
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { tools?: unknown };
    expect(call.tools).toBeUndefined();
  });

  it("passes warnings to runAgent when buildRegistry throws", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    // Trigger buildRegistry failure: ATLAS_PYTHON_ENABLED=true without
    // ATLAS_SANDBOX_URL causes buildRegistry to throw (fatal misconfiguration).
    process.env.ATLAS_PYTHON_ENABLED = "true";
    delete process.env.ATLAS_SANDBOX_URL;

    try {
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const calls = mockRunAgent.mock.calls as unknown as unknown[][];
      const call = calls[0]![0] as { warnings?: string[] };
      expect(call.warnings).toBeDefined();
      expect(call.warnings!.length).toBe(1);
      expect(call.warnings![0]).toContain("tool registry failed to build");
    } finally {
      delete process.env.ATLAS_PYTHON_ENABLED;
    }
  });

  it("does not pass warnings when actions build succeeds", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { warnings?: string[] };
    expect(call.warnings).toBeUndefined();
  });

  it("passes warning to runAgent when plugin tools merge throws", async () => {
    mockGetPluginTools.mockImplementation(() => {
      throw new Error("plugin tool has empty name");
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { warnings?: string[] };
    expect(call.warnings).toBeDefined();
    expect(call.warnings!.length).toBe(1);
    expect(call.warnings![0]).toContain("Plugin tools failed to load");
    expect(call.warnings![0]).toContain("plugin tool has empty name");
  });

  it("handles non-Error throw from plugin tools gracefully", async () => {
    mockGetPluginTools.mockImplementation(() => {
      throw "string error from plugin";
    });

    const response = await app.fetch(makeRequest());
    expect(response.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as unknown[][];
    const call = calls[0]![0] as { warnings?: string[] };
    expect(call.warnings).toBeDefined();
    expect(call.warnings!.length).toBe(1);
    expect(call.warnings![0]).toContain("string error from plugin");
  });

  it("accumulates warnings when both action registry and plugin tools fail", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_PYTHON_ENABLED = "true";
    delete process.env.ATLAS_SANDBOX_URL;
    mockGetPluginTools.mockImplementation(() => {
      throw new Error("plugin merge failed");
    });

    try {
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      const calls = mockRunAgent.mock.calls as unknown as unknown[][];
      const call = calls[0]![0] as { warnings?: string[] };
      expect(call.warnings).toBeDefined();
      expect(call.warnings!.length).toBe(2);
      expect(call.warnings![0]).toContain("tool registry failed to build");
      expect(call.warnings![1]).toContain("Plugin tools failed to load");
    } finally {
      delete process.env.ATLAS_PYTHON_ENABLED;
    }
  });

  // ---------------------------------------------------------------------
  // #1980 — provider Retry-After surfacing
  //
  // The chat route forwards `APICallError.responseHeaders["retry-after"]`
  // to both `retryAfterSeconds` in the JSON body and the `Retry-After`
  // HTTP response header so clients don't invent their own backoff.
  // RFC 7231 permits arbitrarily large deltas; the route clamps at 300s
  // because longer waits should be surfaced as a hard failure rather
  // than a UI countdown.
  // ---------------------------------------------------------------------

  describe("#1980 — provider Retry-After header", () => {
    it("forwards Retry-After from a 401 provider response (provider_auth_error)", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Unauthorized",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 401,
          responseHeaders: { "retry-after": "45" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("45");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_auth_error");
      expect(body.retryAfterSeconds).toBe(45);
    });

    it("forwards Retry-After from a 429 provider response (provider_rate_limit)", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Rate limited",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "60" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_rate_limit");
      expect(body.retryAfterSeconds).toBe(60);
    });

    it("forwards Retry-After from a 408 provider response (provider_timeout)", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Request timeout",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 408,
          responseHeaders: { "retry-after": "10" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(504);
      expect(response.headers.get("Retry-After")).toBe("10");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_timeout");
      expect(body.retryAfterSeconds).toBe(10);
    });

    it("forwards Retry-After from a generic 5xx provider response (provider_error)", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Service Unavailable",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 503,
          responseHeaders: { "retry-after": "20" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(502);
      expect(response.headers.get("Retry-After")).toBe("20");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_error");
      expect(body.retryAfterSeconds).toBe(20);
    });

    it("clamps Retry-After to 300s ceiling", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Rate limited",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "9999" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.headers.get("Retry-After")).toBe("300");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.retryAfterSeconds).toBe(300);
    });

    it("ignores HTTP-date Retry-After (delta-seconds only)", async () => {
      // RFC 7231 also allows an HTTP-date form. We only support the delta
      // form because the date form requires a clock-drift-aware parser
      // and providers almost never emit it.
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Rate limited",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      // No header set, no field in body.
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.retryAfterSeconds).toBeUndefined();
    });

    it("omits Retry-After when the provider does not send the header", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Rate limited",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 429,
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_rate_limit");
      expect(body.retryAfterSeconds).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // #1980 — mid-stream structured error frames
  //
  // Once the SSE connection is open, errors travel through the AI SDK
  // error chunk's `errorText` as a `ChatErrorInfo`-shaped JSON body —
  // the same `{ error, message, retryable, retryAfterSeconds?, requestId }`
  // the synchronous response uses. The shape pins parity so a client
  // can `JSON.parse(errorText)` and reuse `parseChatError()` regardless
  // of when the failure happened.
  // ---------------------------------------------------------------------

  describe("#1980 — mid-stream structured error frames", () => {
    function midstreamRunAgent(error: unknown): {
      toUIMessageStreamResponse: () => Response;
      toUIMessageStream: () => ReadableStream<unknown>;
      text: Promise<string>;
      steps: Promise<unknown[]>;
    } {
      // Build a stream that errors out on first read so the merge
      // promise inside createUIMessageStream rejects and our onError
      // callback is invoked.
      return {
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: () =>
          new ReadableStream({
            start(c) {
              c.error(error);
            },
          }),
        text: Promise.resolve(""),
        // steps rejection is fire-and-forget settlement; suppress noise.
        steps: (() => {
          const p = Promise.reject(error);
          p.catch(() => undefined);
          return p;
        })(),
      };
    }

    async function readErrorFrame(
      response: Response,
    ): Promise<Record<string, unknown> | null> {
      const text = await response.text();
      // SSE format: `data: {...json...}\n\n`. Find the chunk whose JSON has
      // type:"error" and parse the errorText field.
      for (const chunk of text.split("\n\n")) {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload) as Record<string, unknown>;
            if (obj.type === "error" && typeof obj.errorText === "string") {
              try {
                return JSON.parse(obj.errorText) as Record<string, unknown>;
              } catch {
                return { errorText: obj.errorText };
              }
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
      return null;
    }

    it("emits a structured ChatErrorInfo frame on mid-stream APICallError 429", async () => {
      mockRunAgent.mockResolvedValueOnce(
        midstreamRunAgent(
          new APICallError({
            message: "Rate limited mid-stream",
            url: "https://api.example.com/v1/chat",
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { "retry-after": "30" },
          }),
        ) as unknown as Awaited<ReturnType<typeof mockRunAgent>>,
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200); // SSE is already open
      const frame = await readErrorFrame(response);
      expect(frame).not.toBeNull();
      expect(frame!.error).toBe("provider_rate_limit");
      expect(frame!.retryable).toBe(true);
      expect(frame!.retryAfterSeconds).toBe(30);
      expect(typeof frame!.requestId).toBe("string");
      expect((frame!.requestId as string).length).toBeGreaterThan(0);
      expect(typeof frame!.message).toBe("string");
    });

    it("emits a structured frame on mid-stream network drop (fetch failed)", async () => {
      mockRunAgent.mockResolvedValueOnce(
        midstreamRunAgent(new Error("fetch failed")) as unknown as Awaited<
          ReturnType<typeof mockRunAgent>
        >,
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      const frame = await readErrorFrame(response);
      expect(frame).not.toBeNull();
      expect(frame!.error).toBe("provider_unreachable");
      expect(frame!.retryable).toBe(true);
      expect(typeof frame!.requestId).toBe("string");
    });

    it("emits a structured frame on mid-stream provider timeout (APICallError 408)", async () => {
      mockRunAgent.mockResolvedValueOnce(
        midstreamRunAgent(
          new APICallError({
            message: "Provider stream timed out",
            url: "https://api.example.com/v1/chat",
            requestBodyValues: {},
            statusCode: 408,
          }),
        ) as unknown as Awaited<ReturnType<typeof mockRunAgent>>,
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      const frame = await readErrorFrame(response);
      expect(frame).not.toBeNull();
      expect(frame!.error).toBe("provider_timeout");
      expect(frame!.retryable).toBe(true);
      expect(typeof frame!.requestId).toBe("string");
    });

    it("falls back to internal_error for unclassifiable mid-stream errors", async () => {
      mockRunAgent.mockResolvedValueOnce(
        midstreamRunAgent(new Error("something nobody recognizes")) as unknown as Awaited<
          ReturnType<typeof mockRunAgent>
        >,
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      const frame = await readErrorFrame(response);
      expect(frame).not.toBeNull();
      expect(frame!.error).toBe("internal_error");
      expect(typeof frame!.requestId).toBe("string");
    });

    // Two onError hooks feed the same classifier:
    //   - `toUIMessageStream({ onError })` runs for per-chunk error events
    //     emitted by `streamText` (the agent loop).
    //   - `createUIMessageStream({ onError })` runs when the merge promise
    //     rejects (the inner stream itself errors).
    // The earlier mid-stream tests exercise the merge-rejection path. This
    // one routes through the per-chunk hook by yielding a `type: "error"`
    // chunk so a refactor that breaks one hook can't slip through behind
    // the other still working.
    it("routes per-chunk error chunks through the same classifier", async () => {
      mockRunAgent.mockResolvedValueOnce({
        toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
        toUIMessageStream: (
          opts?: { onError?: (error: unknown) => string },
        ) =>
          new ReadableStream({
            start(c) {
              const errorText = opts?.onError
                ? opts.onError(
                    new APICallError({
                      message: "rate limited per-chunk",
                      url: "https://api.example.com/v1/chat",
                      requestBodyValues: {},
                      statusCode: 429,
                      responseHeaders: { "retry-after": "12" },
                    }),
                  )
                : "fallback";
              c.enqueue({ type: "error", errorText });
              c.close();
            },
          }),
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
      } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      const frame = await readErrorFrame(response);
      expect(frame).not.toBeNull();
      expect(frame!.error).toBe("provider_rate_limit");
      expect(frame!.retryable).toBe(true);
      expect(frame!.retryAfterSeconds).toBe(12);
      expect(typeof frame!.requestId).toBe("string");
    });
  });

  // ---------------------------------------------------------------------
  // #1988 B5 — context-warning SSE frames
  //
  // The agent's preflight `Effect.catchAll` paths push structured
  // `ChatContextWarning` entries into a caller-supplied out-array.
  // The chat route serializes each as a `data-context-warning` SSE
  // frame BEFORE merging the model stream, so the UI receives the
  // warning ahead of any text-delta. These tests pin:
  //   - the frame `type` literal is exactly `"data-context-warning"`
  //   - the frame carries `severity: "warning"`, `code`, `requestId`
  //   - frames are emitted before any model output
  // A typo in the `type` would silently drop the UI affordance —
  // pin it here so the user-facing contract has a behavioral test.
  // ---------------------------------------------------------------------

  describe("#1988 B5 — context-warning SSE frames", () => {
    /** Read every SSE frame whose data JSON has `type: "data-context-warning"`. */
    async function readContextWarningFrames(
      response: Response,
    ): Promise<Array<Record<string, unknown>>> {
      const text = await response.text();
      const frames: Array<Record<string, unknown>> = [];
      for (const chunk of text.split("\n\n")) {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload) as Record<string, unknown>;
            if (obj.type === "data-context-warning") {
              frames.push(obj);
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
      return frames;
    }

    /**
     * Build a runAgent stub that pushes the supplied warnings into the
     * caller-provided `contextWarnings` out-array (matching real-agent
     * semantics) before returning a no-op stream.
     */
    function runAgentPushingWarnings(
      warnings: ReadonlyArray<Record<string, unknown>>,
    ) {
      return (params: { contextWarnings?: Array<Record<string, unknown>> }) => {
        if (params.contextWarnings) {
          for (const w of warnings) params.contextWarnings.push(w);
        }
        return Promise.resolve({
          toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
          toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
          text: Promise.resolve(""),
          steps: Promise.resolve([]),
        });
      };
    }

    it("emits a data-context-warning frame for every preflight degradation", async () => {
      mockRunAgent.mockImplementationOnce(
        runAgentPushingWarnings([
          {
            severity: "warning",
            code: "semantic_layer_unavailable",
            title: "Semantic layer unavailable",
            detail: "fallback to default",
          },
          {
            severity: "warning",
            code: "learned_patterns_unavailable",
            title: "Query history hints unavailable",
            detail: "skipping few-shot priming",
          },
        ]) as unknown as typeof mockRunAgent,
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);

      const frames = await readContextWarningFrames(response);
      expect(frames.length).toBe(2);

      // Each frame's data carries the warning fields + a server-stamped
      // `requestId`. The `type` literal is exactly the string the UI
      // matches on — a typo here silently drops the banner.
      const codes = frames
        .map((f) => (f.data as Record<string, unknown>).code as string)
        .sort();
      expect(codes).toEqual(["learned_patterns_unavailable", "semantic_layer_unavailable"]);

      for (const frame of frames) {
        const data = frame.data as Record<string, unknown>;
        expect(data.severity).toBe("warning");
        expect(typeof data.title).toBe("string");
        expect(typeof data.requestId).toBe("string");
        expect((data.requestId as string).length).toBeGreaterThan(0);
      }
    });

    it("emits no context-warning frames when runAgent's preflight succeeded", async () => {
      // Default mockRunAgent doesn't push anything, mirroring the
      // happy path. A spurious frame here would be a false-positive
      // banner in the UI.
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);
      const frames = await readContextWarningFrames(response);
      expect(frames).toEqual([]);
    });

    // -------------------------------------------------------------------
    // #2005 — plan-warning rides the unified context-warning channel
    //
    // Pre-#2005 the chat route emitted plan warnings on a separate
    // `data-plan-warning` SSE frame plus an `x-plan-limit-warning`
    // response header. Both were typed-mismatched dead code (server
    // wrote an object, client guarded on string). The cleanup folds
    // the signal onto the same `data-context-warning` channel under
    // a new `plan_limit_warning` code. These tests pin:
    //   - a `checkPlanLimits` warning becomes a structured
    //     `data-context-warning` frame with `code: "plan_limit_warning"`
    //   - the plan-warning frame is `unshift`ed so it leads any
    //     preflight degradations (most-attention-warranting first)
    //   - the route never emits `data-plan-warning` again
    //   - the route never sets the `x-plan-limit-warning` header
    // -------------------------------------------------------------------
    async function readAllFrames(
      response: Response,
    ): Promise<Array<Record<string, unknown>>> {
      const text = await response.text();
      const frames: Array<Record<string, unknown>> = [];
      for (const chunk of text.split("\n\n")) {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            frames.push(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            // ignore malformed lines
          }
        }
      }
      return frames;
    }

    // #3451 — the warning now arrives via the shared billing gate
    // (checkAgentBillingGate), which only consults checkPlanLimits when
    // the request carries an org. Bind one so the warning path is
    // reachable (the pre-gate route called the mocked checkPlanLimits
    // unconditionally, which masked the no-org short-circuit).
    function bindPlanWarningOrg(): void {
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: true as const,
        mode: "managed" as const,
        user: {
          id: "user-plan-warning",
          mode: "managed" as const,
          label: "plan-warning@useatlas.dev",
          role: "admin",
          activeOrganizationId: "org-plan-warning",
          claims: { twoFactorEnabled: true },
        },
      });
    }

    it("folds checkPlanLimits warning into the data-context-warning channel", async () => {
      bindPlanWarningOrg();
      mockCheckPlanLimits.mockResolvedValueOnce({
        allowed: true,
        warning: {
          code: "plan_limit_warning",
          message: "85% of monthly token budget used.",
          metrics: [],
        },
      });
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);

      const frames = await readContextWarningFrames(response);
      expect(frames.length).toBe(1);
      const data = frames[0].data as Record<string, unknown>;
      expect(data.severity).toBe("warning");
      expect(data.code).toBe("plan_limit_warning");
      expect(data.title).toBe("Approaching plan limit");
      expect(data.detail).toBe("85% of monthly token budget used.");
      expect(typeof data.requestId).toBe("string");
    });

    it("plan_limit_warning frame is unshifted ahead of preflight degradations", async () => {
      bindPlanWarningOrg();
      mockCheckPlanLimits.mockResolvedValueOnce({
        allowed: true,
        warning: {
          code: "plan_limit_warning",
          message: "approaching budget",
          metrics: [],
        },
      });
      mockRunAgent.mockImplementationOnce(
        runAgentPushingWarnings([
          {
            severity: "warning",
            code: "semantic_layer_unavailable",
            title: "Semantic layer unavailable",
          },
        ]) as unknown as typeof mockRunAgent,
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(200);

      const frames = await readContextWarningFrames(response);
      expect(frames.length).toBe(2);
      const codes = frames.map((f) => (f.data as Record<string, unknown>).code as string);
      // Plan signal first (unshift), preflight degradation after.
      expect(codes).toEqual(["plan_limit_warning", "semantic_layer_unavailable"]);
    });

    it("never emits a legacy data-plan-warning frame even when a plan warning is present", async () => {
      bindPlanWarningOrg();
      mockCheckPlanLimits.mockResolvedValueOnce({
        allowed: true,
        warning: {
          code: "plan_limit_warning",
          message: "x",
          metrics: [],
        },
      });
      const response = await app.fetch(makeRequest());
      const frames = await readAllFrames(response);
      // Defensive scan over EVERY frame type — any `data-plan-warning`
      // would be a regression of the legacy dead channel.
      const legacy = frames.filter((f) => f.type === "data-plan-warning");
      expect(legacy.length).toBe(0);
    });

    it("never sets the legacy x-plan-limit-warning response header", async () => {
      bindPlanWarningOrg();
      mockCheckPlanLimits.mockResolvedValueOnce({
        allowed: true,
        warning: {
          code: "plan_limit_warning",
          message: "x",
          metrics: [],
        },
      });
      const response = await app.fetch(makeRequest());
      expect(response.headers.get("x-plan-limit-warning")).toBeNull();
    });

    it("#3451 — a plan-limit block from the billing gate returns the chat error envelope (no stream)", async () => {
      bindPlanWarningOrg();
      mockCheckPlanLimits.mockResolvedValueOnce({
        allowed: false,
        errorCode: "trial_expired",
        errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
        httpStatus: 403,
      });
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(403);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("trial_expired");
      expect(body.message).toContain("trial has expired");
      expect(body.retryable).toBe(false);
      expect(typeof body.requestId).toBe("string");
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("emits no plan_limit_warning frame when checkPlanLimits returns no warning", async () => {
      // Default mock returns { allowed: true } with no warning field.
      const response = await app.fetch(makeRequest());
      const frames = await readContextWarningFrames(response);
      const planFrames = frames.filter(
        (f) => (f.data as Record<string, unknown>).code === "plan_limit_warning",
      );
      expect(planFrames.length).toBe(0);
    });

    it("preserves a warning's pre-existing requestId rather than spreading it away", async () => {
      // The agent's preflight emit sites may stamp their own correlation
      // id (e.g. for inner-Effect tracing). The route must not silently
      // overwrite it via `{ ...warning, requestId }`.
      mockRunAgent.mockImplementationOnce(
        runAgentPushingWarnings([
          {
            severity: "warning",
            code: "semantic_layer_unavailable",
            title: "x",
            requestId: "agent-stamped-id",
          },
        ]) as unknown as typeof mockRunAgent,
      );
      const response = await app.fetch(makeRequest());
      const frames = await readContextWarningFrames(response);
      expect(frames.length).toBe(1);
      const data = frames[0].data as Record<string, unknown>;
      expect(data.requestId).toBe("agent-stamped-id");
    });

    it("treats an empty-string requestId on a warning as missing (uses route id)", async () => {
      // Empty string is a useless correlation id and should not pollute
      // the wire. The route's `warning.requestId ? warning : ...`
      // ternary intentionally treats empty-string as falsy — pin it so
      // a future "tighter" refactor (e.g. `!== undefined`) can't quietly
      // start propagating empty correlation ids into the SSE stream.
      mockRunAgent.mockImplementationOnce(
        runAgentPushingWarnings([
          {
            severity: "warning",
            code: "semantic_layer_unavailable",
            title: "x",
            requestId: "",
          },
        ]) as unknown as typeof mockRunAgent,
      );
      const response = await app.fetch(makeRequest());
      const frames = await readContextWarningFrames(response);
      expect(frames.length).toBe(1);
      const data = frames[0].data as Record<string, unknown>;
      expect(typeof data.requestId).toBe("string");
      expect((data.requestId as string).length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------
  // #1980 — synchronous classifier coverage (every emit branch)
  //
  // Pin every code `classifyChatError` can emit to its expected status
  // and shape so a refactor of the cascade (or `CLASSIFIER_STATUS_MAP`)
  // can't silently re-route a known error class.
  // ---------------------------------------------------------------------

  describe("#1980 — synchronous classifier coverage", () => {
    it("classifies LoadAPIKeyError as provider_auth_error 503", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new LoadAPIKeyError({ message: "ANTHROPIC_API_KEY missing" }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_auth_error");
      expect(body.retryable).toBe(false);
      expect(body.retryAfterSeconds).toBeUndefined();
      expect(response.headers.get("Retry-After")).toBeNull();
    });

    it("classifies NoSuchModelError as provider_model_not_found 400", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new NoSuchModelError({
          modelId: "made-up-model",
          modelType: "languageModel",
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_model_not_found");
      expect(body.retryable).toBe(false);
    });

    it("classifies GatewayModelNotFoundError as provider_model_not_found 400", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new GatewayModelNotFoundError({
          message: "model not found on gateway",
          modelId: "anthropic/missing-model",
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_model_not_found");
    });

    it("classifies ECONNREFUSED as provider_unreachable 503 (synchronous)", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new Error("connect ECONNREFUSED 10.0.0.1:443"),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("provider_unreachable");
      expect(body.retryable).toBe(true);
      // No retry-after header for unreachable — the regex-matched fallback
      // doesn't ship one and we don't want clients to invent a delta.
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(body.retryAfterSeconds).toBeUndefined();
    });

    it("omits Retry-After header when provider_auth_error has no header", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Unauthorized",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 401,
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.retryAfterSeconds).toBeUndefined();
    });

    it("omits Retry-After header on the internal_error fallback", async () => {
      // An error matchError can't recognize and which isn't an APICallError.
      mockRunAgent.mockRejectedValueOnce(new Error("totally unfamiliar"));
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(500);
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("internal_error");
      expect(body.retryAfterSeconds).toBeUndefined();
      expect(typeof body.requestId).toBe("string");
    });
  });

  // ---------------------------------------------------------------------
  // #1980 — Retry-After parser edge cases
  //
  // Whitespace, fractional, zero, and negative deltas — each is an
  // explicit branch in `parseProviderRetryAfter`, so pin the contract.
  // ---------------------------------------------------------------------

  describe("#1980 — parseProviderRetryAfter edge cases", () => {
    async function runWith(retryAfter: string): Promise<Response> {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Rate limited",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": retryAfter },
        }),
      );
      return app.fetch(makeRequest());
    }

    it("trims whitespace around delta-seconds", async () => {
      const response = await runWith(" 60 ");
      expect(response.headers.get("Retry-After")).toBe("60");
    });

    it("floors fractional values", async () => {
      const response = await runWith("5.7");
      expect(response.headers.get("Retry-After")).toBe("5");
    });

    it("accepts zero as a valid delta", async () => {
      const response = await runWith("0");
      expect(response.headers.get("Retry-After")).toBe("0");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.retryAfterSeconds).toBe(0);
    });

    it("rejects negative deltas as malformed", async () => {
      const response = await runWith("-5");
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.retryAfterSeconds).toBeUndefined();
    });

    it("accepts mixed-case header key", async () => {
      mockRunAgent.mockRejectedValueOnce(
        new APICallError({
          message: "Rate limited",
          url: "https://api.example.com/v1/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "Retry-After": "15" },
        }),
      );
      const response = await app.fetch(makeRequest());
      expect(response.headers.get("Retry-After")).toBe("15");
    });
  });

  // Asserts the chat route honors the abuse-status verdict end-to-end:
  // when `checkAbuseStatus` reports `none` (which the EE engine's read-time
  // allowlist guard produces for an allowlisted-but-stale-suspended
  // workspace — #2269), the chat route must NOT 403.
  //
  // Post-#4000 (WS5) the graduated-response engine — including the allowlist
  // read-time shadow that *makes* `checkAbuseStatus` return `none` — moved to
  // `@atlas/ee/abuse-prevention/engine`, and that behavior is unit-tested
  // there (a core test can't import `@atlas/ee`; the ee-import guard scans
  // `packages/api/src`). What stays verifiable at this core route boundary is
  // the integration contract: the chat route trusts the `checkAbuseStatus`
  // verdict it gets from the shim. So we mock the shim's `checkAbuseStatus` to
  // the allowlist-shadowed result (`none`) and assert the route returns 200.
  // A regression that re-derived suspension at the route layer (bypassing the
  // shim verdict) would still 403 here and fail.
  describe("#2269 — allowlisted-with-stale-suspended workspace", () => {
    beforeEach(() => {
      mockAuthenticateRequest.mockResolvedValue({
        authenticated: true as const,
        mode: "managed" as const,
        user: {
          id: "user-loadtest",
          mode: "managed" as const,
          label: "loadtest@useatlas.dev",
          role: "admin",
          activeOrganizationId: "ws-loadtest-stale",
          claims: { twoFactorEnabled: true },
        },
      });
    });
    afterEach(() => {
      // Restore the file-wide default so sibling tests stay on `none`.
      mockCheckAbuseStatus.mockImplementation(() => ({ level: "none" }));
    });

    // Positive pin (the contrast that keeps the negative case below honest):
    // the chat route MUST block on a non-`none` abuse verdict. If a refactor
    // dropped the abuse check from the agent gate, this would fail.
    it("blocks with 403 when checkAbuseStatus reports suspended", async () => {
      mockCheckAbuseStatus.mockImplementation(() => ({ level: "suspended" }));
      const response = await app.fetch(makeRequest());
      expect(response.status).toBe(403);
    });

    // The #2269 regression: for an allowlisted-but-stale-suspended workspace
    // the EE engine's read-time allowlist shadow makes `checkAbuseStatus`
    // report `none`. The chat route must TRUST that verdict and return 200 —
    // not re-derive suspension at the route layer. We drive the shadowed
    // verdict directly (`none`); paired with the 403 pin above, a route that
    // ignored the verdict (always blocking) or ignored the gate (never
    // blocking) fails one of the two.
    it("returns 200 when checkAbuseStatus reports none (allowlist-shadowed)", async () => {
      mockCheckAbuseStatus.mockImplementation(() => ({ level: "none" }));
      const response = await app.fetch(makeRequest());
      // Both assertions on purpose — `not.toBe(403)` is the regression
      // guard; `.toBe(200)` keeps a refactor that returns 503 (or any
      // non-200) for a different reason from passing vacuously.
      expect(response.status).not.toBe(403);
      expect(response.status).toBe(200);
    });
  });
});
