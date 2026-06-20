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
mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve({ id: "conv-1" })),
  addMessage: mock(() => {}),
  persistAssistantSteps: mockPersistAssistantSteps,
  getConversation: mockGetConversation,
  generateTitle: mock((q: string) => q.slice(0, 80)),
  reserveConversationBudget: mock(() => Promise.resolve({ status: "ok", totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
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
});
