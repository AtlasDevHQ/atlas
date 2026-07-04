/**
 * Route tests for the explicit-stop endpoint (#4294):
 * `POST /api/v1/chat/runs/:runId/stop`.
 *
 * The abort registry is used REAL (it's a pure in-process map) — entries are
 * registered directly and the route is exercised over HTTP. Asserts the
 * acceptance criteria that live at the HTTP layer:
 *   - matching identity ⇒ 200 `{ stopped: true }` and the controller fires
 *   - unknown / settled / other-tenant run ⇒ uniform 404 (no existence leak)
 *   - unauthenticated ⇒ 401 and nothing aborted
 *   - malformed run id ⇒ rejected by param validation, registry untouched
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";
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

// --- Modules the app import graph needs mocked (same set as chat-resume.test.ts) ---
import type { PrepareResumeResult } from "@atlas/api/lib/durable-resume";
const mockPrepareResume: Mock<() => Promise<PrepareResumeResult>> = mock(() =>
  Promise.resolve({ status: "none" as const }),
);
mock.module("@atlas/api/lib/durable-resume", () => ({
  prepareResume: mockPrepareResume,
  finishResume: mock(() => {}),
}));

import type { LatestRunStatus } from "@atlas/api/lib/durable-session";
import * as realDurableSession from "@atlas/api/lib/durable-session";
const mockLoadLatestRunStatus: Mock<() => Promise<LatestRunStatus>> = mock(() =>
  Promise.resolve({ status: "none" as const }),
);
mock.module("@atlas/api/lib/durable-session", () => ({
  ...realDurableSession,
  loadLatestRunStatus: mockLoadLatestRunStatus,
}));

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

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve({ id: "conv-1" })),
  addMessage: mock(() => {}),
  persistAssistantSteps: mock(() => {}),
  getConversation: mock(() => Promise.resolve({ ok: true, data: { id: "conv-1", messages: [] } })),
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
  updateConversationGroupReach: mock(() => Promise.resolve({ ok: true as const })),
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

const mockCheckAgentBillingGate = mock(() => Promise.resolve({ allowed: true as const }));
mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  ...realAgentGate,
  checkAgentBillingGate: mockCheckAgentBillingGate,
}));

// The registry is used REAL — the route's contract under test lives in it.
import {
  registerAbortableRun,
  __clearAbortableRunsForTest,
} from "@atlas/api/lib/run-abort";

const { app } = await import("../index");

// Spec-valid UUID (version nibble 4, variant nibble 8) so `.uuid()` passes.
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const MANAGED_USER: AuthResult = {
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
};

function stopRequest(runId: string = RUN_ID): Request {
  return new Request(`http://localhost/api/v1/chat/runs/${runId}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/v1/chat/runs/:runId/stop (#4294)", () => {
  beforeEach(() => {
    __clearAbortableRunsForTest();
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue(MANAGED_USER);
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
  });

  it("stops a run registered to the caller's identity — 200 and the controller fires", async () => {
    const controller = new AbortController();
    registerAbortableRun(RUN_ID, { controller, userId: "u-1", orgId: "org-1" });

    const res = await app.fetch(stopRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stopped: boolean };
    expect(body.stopped).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns 404 for an unknown / already-settled run", async () => {
    const res = await app.fetch(stopRequest());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 404 (not 403) for another tenant's run and does NOT abort it — no existence leak", async () => {
    const controller = new AbortController();
    registerAbortableRun(RUN_ID, { controller, userId: "u-other", orgId: "org-other" });

    const res = await app.fetch(stopRequest());
    expect(res.status).toBe(404);
    expect(controller.signal.aborted).toBe(false);
  });

  it("returns 401 when unauthenticated and aborts nothing", async () => {
    const controller = new AbortController();
    registerAbortableRun(RUN_ID, { controller, userId: null, orgId: null });
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false as const,
      status: 401,
      error: "no token",
    } as AuthResult);

    const res = await app.fetch(stopRequest());
    expect(res.status).toBe(401);
    expect(controller.signal.aborted).toBe(false);
  });

  it("rejects a malformed run id before touching the registry", async () => {
    const controller = new AbortController();
    registerAbortableRun("not-a-uuid", { controller, userId: "u-1", orgId: "org-1" });

    const res = await app.fetch(stopRequest("not-a-uuid"));
    // The router-wide `validationHook` rejects malformed params with 422
    // (same for every chat route's `.uuid()` params).
    expect(res.status).toBe(422);
    expect(controller.signal.aborted).toBe(false);
  });
});
