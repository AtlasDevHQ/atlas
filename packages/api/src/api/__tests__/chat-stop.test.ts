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

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

// --- Modules the app import graph needs mocked (same set as chat-resume.test.ts) ---
import type { PrepareResumeResult } from "@atlas/api/lib/durable-resume";
const mockPrepareResume: Mock<() => Promise<PrepareResumeResult>> = mock(() =>
  Promise.resolve({ status: "none" as const }),
);
void mock.module("@atlas/api/lib/durable-resume", () => ({
  prepareResume: mockPrepareResume,
  finishResume: mock(() => {}),
}));

import type { LatestRunStatus } from "@atlas/api/lib/durable-session";
import * as realDurableSession from "@atlas/api/lib/durable-session";
const mockLoadLatestRunStatus: Mock<() => Promise<LatestRunStatus>> = mock(() =>
  Promise.resolve({ status: "none" as const }),
);
void mock.module("@atlas/api/lib/durable-session", () => ({
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
void mock.module("@atlas/api/lib/agent", () => ({ runAgent: mockRunAgent }));

void mock.module("@atlas/api/lib/tools/python-stream", () => ({
  setStreamWriter: () => {},
  clearStreamWriter: () => {},
  getStreamWriter: () => undefined,
}));

void mock.module("@atlas/api/lib/semantic", () => ({
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

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

void mock.module("@atlas/api/lib/conversations", () => ({
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
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  // #4351 — the single conversation-scope write path. No-op success by
  // default; tests that exercise a picker toggle override locally.
  updateConversationScope: mock(() => Promise.resolve({ ok: true as const })),
}));

void mock.module("@atlas/api/lib/plugins/tools", () => ({
  getPluginTools: mock(() => undefined),
  setPluginTools: () => {},
  getContextFragments: () => [],
  setContextFragments: () => {},
  getDialectHints: () => [],
  pluginDialectModules: () => [],
  setDialectHints: () => {},
}));

void mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: mock(async () => false),
}));

const mockCheckAgentBillingGate = mock(() => Promise.resolve({ allowed: true as const }));
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  ...realAgentGate,
  checkAgentBillingGate: mockCheckAgentBillingGate,
}));

// The registry is used REAL — the route's contract under test lives in it.
import {
  registerAbortableRun,
  __clearAbortableRunsForTest,
  __abortableRunCountForTest,
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
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    __clearAbortableRunsForTest();
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue(MANAGED_USER);
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockRunAgent.mockReset();
    mockRunAgent.mockResolvedValue({
      runId: "run-abc",
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      steps: Promise.resolve([]),
      text: Promise.resolve("answer"),
    });
    mockPrepareResume.mockReset();
    mockPrepareResume.mockResolvedValue({ status: "none" as const });
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

  it("returns 403 when auth resolves forbidden and aborts nothing", async () => {
    const controller = new AbortController();
    registerAbortableRun(RUN_ID, { controller, userId: "u-1", orgId: "org-1" });
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: false as const,
      status: 403,
      error: "forbidden",
    } as AuthResult);

    const res = await app.fetch(stopRequest());
    expect(res.status).toBe(403);
    expect(controller.signal.aborted).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Integration glue: the chat/resume routes' register → x-run-id → stop chain.
  // ---------------------------------------------------------------------------

  function chatRequest(): Request {
    return new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      }),
    });
  }

  function echoRunAgent(steps: Promise<unknown[]>) {
    const captured: { signal?: AbortSignal } = {};
    mockRunAgent.mockImplementationOnce(((opts: { runId?: string; abortSignal?: AbortSignal }) => {
      captured.signal = opts.abortSignal;
      return Promise.resolve({
        // Echo the caller-supplied id — exactly what the real runAgent does
        // with `callerRunId`; the x-run-id header must name the REGISTERED id.
        runId: opts.runId ?? "missing-caller-run-id",
        toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
        steps,
        text: Promise.resolve(""),
      });
    }) as never);
    return captured;
  }

  it("chat turn: x-run-id names the registered run and stopping it fires the agent's abort signal (#4294)", async () => {
    let resolveSteps!: (v: unknown[]) => void;
    const steps = new Promise<unknown[]>((r) => { resolveSteps = r; });
    const captured = echoRunAgent(steps);

    const res = await app.fetch(chatRequest());
    expect(res.status).toBe(200);
    const runId = res.headers.get("x-run-id");
    expect(runId).toBeTruthy();
    expect(captured.signal).toBeDefined();
    expect(captured.signal!.aborted).toBe(false);

    // Stop it — same identity as the chat caller.
    const stopRes = await app.fetch(stopRequest(runId!));
    expect(stopRes.status).toBe(200);
    expect(captured.signal!.aborted).toBe(true);

    resolveSteps([]);
  });

  it("chat turn: a settled run unregisters and is no longer stoppable", async () => {
    let resolveSteps!: (v: unknown[]) => void;
    const steps = new Promise<unknown[]>((r) => { resolveSteps = r; });
    echoRunAgent(steps);

    const res = await app.fetch(chatRequest());
    expect(res.status).toBe(200);
    const runId = res.headers.get("x-run-id");

    resolveSteps([]);
    // Let the both-arm settle-cleanup `then` run.
    await new Promise((r) => setTimeout(r, 0));

    const stopRes = await app.fetch(stopRequest(runId!));
    expect(stopRes.status).toBe(404);
  });

  it("chat turn: a runAgent setup throw never leaks a registry entry", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("provider auth failed") as never);

    const res = await app.fetch(chatRequest());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(__abortableRunCountForTest()).toBe(0);
  });

  it("resumed turn: stoppable under its original durable run id (#4294)", async () => {
    const RESUME_RUN_ID = "33333333-3333-4333-8333-333333333333";
    const CONV_ID = "11111111-1111-4111-8111-111111111111";
    mockPrepareResume.mockResolvedValueOnce({
      status: "resumable" as const,
      handle: {
        runId: RESUME_RUN_ID,
        transcript: [{ role: "user" as const, content: "hi" }],
        priorStepIndex: 1,
        leaseOwner: "lease-1",
      },
    } as never);
    // Steps held open: the resumed run is mid-flight when the stop lands.
    const captured = echoRunAgent(new Promise<unknown[]>(() => {}));

    const res = await app.fetch(
      new Request(`http://localhost/api/v1/chat/${CONV_ID}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-run-id")).toBe(RESUME_RUN_ID);

    const stopRes = await app.fetch(stopRequest(RESUME_RUN_ID));
    expect(stopRes.status).toBe(200);
    expect(captured.signal!.aborted).toBe(true);
  });
});
