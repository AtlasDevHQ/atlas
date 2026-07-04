/**
 * Route tests for the crash-resume endpoint (#3747, ADR-0020 phase 2):
 * `POST /api/v1/chat/:conversationId/resume`.
 *
 * Mocks auth, the resume entry point (`prepareResume`/`finishResume`),
 * conversation ownership, and the agent to isolate the route wiring. Asserts the
 * acceptance criteria that live at the HTTP layer:
 *   - fail-closed on revoked access: ownership re-check fails ⇒ 404, and the
 *     resume claim + agent never run (security is re-resolved live, not trusted
 *     from the checkpoint)
 *   - single-flight: a `leased` claim ⇒ 409
 *   - success ⇒ 200 SSE with a stable `x-run-id` (+ `x-conversation-id`) header,
 *     `runAgent` invoked with the resume handle, lease released on finish
 *   - nothing to resume / durability off ⇒ 404
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import type { PrepareResumeResult } from "@atlas/api/lib/durable-resume";
import * as realAgentGate from "@atlas/api/lib/billing/agent-gate";

// --- Auth / rate-limit ---
const mockAuthenticateRequest: Mock<(req: Request) => Promise<AuthResult>> = mock(() =>
  Promise.resolve({ authenticated: true as const, mode: "none" as const, user: undefined }),
);
const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean; retryAfterMs?: number }> = mock(() => ({ allowed: true }));
const mockGetClientIP: Mock<(req: Request) => string | null> = mock(() => null);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

// --- Resume entry point ---
const mockPrepareResume: Mock<() => Promise<PrepareResumeResult>> = mock(() =>
  Promise.resolve({
    status: "resumable" as const,
    handle: { runId: "run-abc", transcript: [{ role: "user", content: "hi" }], priorStepIndex: 2, leaseOwner: "lease-1" },
  }),
);
const mockFinishResume = mock(() => {});
mock.module("@atlas/api/lib/durable-resume", () => ({
  prepareResume: mockPrepareResume,
  finishResume: mockFinishResume,
}));

// --- Latest-run-status probe (#3749) ---
import type { LatestRunStatus } from "@atlas/api/lib/durable-session";
import * as realDurableSession from "@atlas/api/lib/durable-session";
const mockLoadLatestRunStatus: Mock<() => Promise<LatestRunStatus>> = mock(() =>
  Promise.resolve({ status: "running" as const, runId: "run-abc", parkedReason: null }),
);
mock.module("@atlas/api/lib/durable-session", () => ({
  ...realDurableSession,
  loadLatestRunStatus: mockLoadLatestRunStatus,
}));

// --- Agent ---
const mockRunAgent = mock(() =>
  Promise.resolve({
    runId: "run-abc",
    toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
    steps: Promise.resolve([]),
    text: Promise.resolve("answer"),
  }),
);
mock.module("@atlas/api/lib/agent", () => ({ runAgent: mockRunAgent }));

mock.module("@atlas/api/lib/tools/python-stream", () => ({
  setStreamWriter: () => {},
  clearStreamWriter: () => {},
  getStreamWriter: () => undefined,
}));

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
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

const mockGetConversation = mock((): Promise<{ ok: boolean; reason?: string; data?: unknown }> =>
  Promise.resolve({ ok: true, data: { id: "conv-1", messages: [] } }),
);
const mockPersistAssistantSteps = mock(() => {});
const mockReserveConversationBudget = mock(
  (): Promise<{ status: string; totalStepsBefore?: number; totalSteps?: number }> =>
    Promise.resolve({ status: "ok", totalStepsBefore: 0 }),
);
const mockSettleConversationSteps = mock(() => {});
mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve({ id: "conv-1" })),
  addMessage: mock(() => {}),
  persistAssistantSteps: mockPersistAssistantSteps,
  getConversation: mockGetConversation,
  generateTitle: mock((q: string) => q.slice(0, 80)),
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
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestExcluded: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestFocus: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationGroupReach: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationAnswerStyle: mock(() => Promise.resolve({ ok: true as const })),
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
}));

mock.module("@atlas/api/lib/plugins/tools", () => ({
  getPluginTools: mock(() => undefined),
  setPluginTools: () => {},
  getContextFragments: () => [],
  setContextFragments: () => {},
  getDialectHints: () => [],
  setDialectHints: () => {},
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: mock(async () => false),
}));

// Billing/abuse/plan gate — allow by default; the resume route runs the same
// gate as the chat route, so without this it fails closed against a real DB.
const mockCheckAgentBillingGate = mock(() => Promise.resolve({ allowed: true as const }));
mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  ...realAgentGate,
  checkAgentBillingGate: mockCheckAgentBillingGate,
}));

const { app } = await import("../index");

// A spec-valid UUID (v4-shaped: version nibble 4, variant nibble 8) so the
// route's `.uuid()` path-param validation passes and we exercise the handler.
const CONV_ID = "11111111-1111-4111-8111-111111111111";

function resumeRequest(): Request {
  return new Request(`http://localhost/api/v1/chat/${CONV_ID}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/v1/chat/:conversationId/resume", () => {
  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "u-1",
        mode: "managed" as const,
        label: "u-1@useatlas.dev",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: {},
      },
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);
    mockGetConversation.mockReset();
    mockGetConversation.mockResolvedValue({ ok: true, data: { id: CONV_ID, messages: [] } });
    mockPrepareResume.mockReset();
    mockPrepareResume.mockResolvedValue({
      status: "resumable" as const,
      handle: { runId: "run-abc", transcript: [{ role: "user", content: "hi" }], priorStepIndex: 2, leaseOwner: "lease-1" },
    });
    mockFinishResume.mockReset();
    mockCheckAgentBillingGate.mockReset();
    mockCheckAgentBillingGate.mockResolvedValue({ allowed: true as const });
    mockRunAgent.mockReset();
    mockRunAgent.mockResolvedValue({
      runId: "run-abc",
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      steps: Promise.resolve([]),
      text: Promise.resolve("answer"),
    });
    mockPersistAssistantSteps.mockReset();
    mockReserveConversationBudget.mockReset();
    mockReserveConversationBudget.mockResolvedValue({ status: "ok", totalStepsBefore: 0 });
    mockSettleConversationSteps.mockReset();
    // F-77 — the resume route runs the conversation step-cap gate. Disabled by
    // default (cap unset) so existing wiring tests don't depend on a cap; the
    // budget tests set it explicitly.
    delete process.env.ATLAS_CONVERSATION_STEP_CAP;
    delete process.env.ATLAS_AGENT_MAX_STEPS;
  });

  it("streams 200 with x-run-id + x-conversation-id headers and re-enters runAgent with the handle", async () => {
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-run-id")).toBe("run-abc");
    expect(res.headers.get("x-conversation-id")).toBe(CONV_ID);

    // runAgent was re-entered with the resume descriptor (transcript + run id +
    // prior step index) — the continuation, not a fresh turn.
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const calls = mockRunAgent.mock.calls as unknown as Array<[{ resume?: { runId: string; priorStepIndex: number } }]>;
    const arg = calls[0]![0];
    expect(arg.resume?.runId).toBe("run-abc");
    expect(arg.resume?.priorStepIndex).toBe(2);
  });

  it("fails closed (404) when conversation ownership re-check fails — never claims or resumes", async () => {
    // A user who lost access while interrupted: getConversation returns not_found.
    mockGetConversation.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(404);
    // The resume claim and the agent must NOT run — security is re-resolved live
    // and fails closed BEFORE touching the checkpoint.
    expect(mockPrepareResume).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("rejects a second concurrent resume with 409 (single-resumer lease)", async () => {
    mockPrepareResume.mockResolvedValue({ status: "leased" });
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("resume_in_progress");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 404 when there is nothing to resume", async () => {
    mockPrepareResume.mockResolvedValue({ status: "none" });
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("nothing_to_resume");
  });

  it("returns 404 when durability is disabled for the workspace", async () => {
    mockPrepareResume.mockResolvedValue({ status: "disabled" });
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(404);
  });

  it("returns 503 (retryable) when the resume claim fails (fail closed, not resumable)", async () => {
    mockPrepareResume.mockResolvedValue({ status: "error" });
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("resume_unavailable");
    expect(body.retryable).toBe(true);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated — never claims or resumes", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false as const,
      status: 401,
      error: "no token",
      mode: "none" as const,
    } as AuthResult);
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(401);
    expect(mockPrepareResume).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // F-77 — the resume route must charge the same per-conversation step cap as the
  // chat route, or a client could drive unbounded steps via repeated resumes.
  it("rejects with conversation_budget_exceeded (429) when the cap is exceeded — never resumes, releases the lease", async () => {
    process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
    mockReserveConversationBudget.mockResolvedValue({ status: "exceeded", totalSteps: 10 });

    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryable: boolean };
    expect(body.error).toBe("conversation_budget_exceeded");
    expect(body.retryable).toBe(false);
    // The resumed agent loop must never run when the cap is already spent.
    expect(mockRunAgent).not.toHaveBeenCalled();
    // The just-claimed lease is released so a rejected resume can't wedge the run.
    expect(mockFinishResume).toHaveBeenCalledTimes(1);
    // No settlement on the rejection path — nothing was charged for an agent run.
    expect(mockSettleConversationSteps).not.toHaveBeenCalled();
  });

  it("charges the worst-case budget upfront and settles the resumed step delta on stream finish", async () => {
    process.env.ATLAS_CONVERSATION_STEP_CAP = "10";
    process.env.ATLAS_AGENT_MAX_STEPS = "5";
    mockReserveConversationBudget.mockResolvedValue({ status: "ok", totalStepsBefore: 2 });
    // Resumed stream resolves with 3 new steps ⇒ settlement refunds 5 − 3 = 2.
    mockRunAgent.mockResolvedValue({
      runId: "run-abc",
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      steps: Promise.resolve([{}, {}, {}]),
      text: Promise.resolve("answer"),
    } as unknown as Awaited<ReturnType<typeof mockRunAgent>>);

    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(200);
    // Reservation charged the row by the worst-case agent step budget upfront.
    const reserveCalls = mockReserveConversationBudget.mock.calls as unknown as unknown[][];
    expect(reserveCalls.length).toBe(1);
    expect(reserveCalls[0]).toEqual([CONV_ID, 5, 10]);
    // Settlement runs with the resumed delta (this call's new steps), reserved=5.
    await Promise.resolve();
    await Promise.resolve();
    const settleCalls = mockSettleConversationSteps.mock.calls as unknown as unknown[][];
    expect(settleCalls.length).toBe(1);
    expect(settleCalls[0]).toEqual([CONV_ID, 5, 3]);
  });

  // F6 — a regression that drops the lease release would wedge the run until TTL.
  it("releases the lease on the stream-finish (success) path", async () => {
    const res = await app.fetch(resumeRequest());
    expect(res.status).toBe(200);
    // Drain the (empty) stream so onFinish fires.
    await res.text();
    expect(mockFinishResume).toHaveBeenCalledTimes(1);
  });

  it("releases the lease on the build-failure catch path (runAgent throws)", async () => {
    mockRunAgent.mockRejectedValue(new Error("registry boom"));
    const res = await app.fetch(resumeRequest());
    // The failure is classified to a non-stream error response, not a 200 SSE.
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The lease must be released even though the stream object never existed.
    expect(mockFinishResume).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #3749 — GET /api/v1/chat/:conversationId/run-status. The read-only probe the
// web chat calls on load to decide which durability affordance to render.
// ---------------------------------------------------------------------------

function runStatusRequest(): Request {
  return new Request(`http://localhost/api/v1/chat/${CONV_ID}/run-status`, { method: "GET" });
}

describe("GET /api/v1/chat/:conversationId/run-status", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "u-1",
        mode: "managed" as const,
        label: "u-1@useatlas.dev",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: {},
      },
    });
    mockGetConversation.mockReset();
    mockGetConversation.mockResolvedValue({ ok: true, data: { id: CONV_ID, messages: [] } });
    mockLoadLatestRunStatus.mockReset();
    mockLoadLatestRunStatus.mockResolvedValue({ status: "running" as const, runId: "run-abc", parkedReason: null });
  });

  it("returns the latest run's status (running → resume affordance) for an owned conversation", async () => {
    const res = await app.fetch(runStatusRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; runId?: string; parkedReason?: string | null };
    expect(body).toEqual({ status: "running", runId: "run-abc", parkedReason: null });
    // Probed by the SAME conversation id the route was called with.
    expect(mockLoadLatestRunStatus).toHaveBeenCalledWith(CONV_ID);
  });

  it("surfaces a parked run with its approval ref (waiting on approval)", async () => {
    mockLoadLatestRunStatus.mockResolvedValue({ status: "parked" as const, runId: "run-8", parkedReason: "req-42" });
    const res = await app.fetch(runStatusRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "parked", runId: "run-8", parkedReason: "req-42" });
  });

  it("returns none for a conversation with no run (no affordance)", async () => {
    mockLoadLatestRunStatus.mockResolvedValue({ status: "none" as const });
    const res = await app.fetch(runStatusRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "none" });
  });

  it("fails closed (404) when conversation ownership re-check fails — never probes run state", async () => {
    // A user who lost access: the run id / parked ref must not leak across tenancy.
    mockGetConversation.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await app.fetch(runStatusRequest());
    expect(res.status).toBe(404);
    expect(mockLoadLatestRunStatus).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated — never probes run state", async () => {
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false as const,
      status: 401,
      error: "no token",
      mode: "none" as const,
    } as AuthResult);
    const res = await app.fetch(runStatusRequest());
    expect(res.status).toBe(401);
    expect(mockLoadLatestRunStatus).not.toHaveBeenCalled();
  });
});
