/**
 * E2E: Health endpoint tests.
 *
 * Tests the health endpoint in-process via Hono app.fetch().
 * Uses mocks to isolate from real databases.
 */

import { describe, it, expect, mock } from "bun:test";
import { createConnectionMock } from "../../packages/api/src/__mocks__/connection";

// --- Mocks (isolate from real DB/providers) ---

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

mock.module("@atlas/api/lib/db/connection", () => {
  const mockDBConn = {
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  };
  return createConnectionMock({
    getDB: () => mockDBConn,
    connections: {
      get: () => mockDBConn,
      getDefault: () => mockDBConn,
      list: () => [],
      describe: () => [],
    },
  });
});

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
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

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: { name: "createJiraTicket", description: "Mock", tool: { type: "function" }, actionType: "jira:create", reversible: true, defaultApproval: "manual", requiredCredentials: ["JIRA_BASE_URL"] },
  sendEmailReport: { name: "sendEmailReport", description: "Mock", tool: { type: "function" }, actionType: "email:send", reversible: false, defaultApproval: "admin-only", requiredCredentials: ["RESEND_API_KEY"] },
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  starConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({ authenticated: true as const, mode: "none" as const, user: undefined }),
  ),
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  _stopCleanup: mock(() => {}),
}));

// Import app after mocks
const { app } = await import("../../packages/api/src/api/index");

// --- Tests ---

describe("E2E: Health endpoint", () => {
  it("returns 200 with status field", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBeDefined();
    expect(["ok", "degraded"]).toContain(body.status as string);
  });

  it("includes all expected check sections", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { checks: Record<string, unknown> };

    expect(body.checks).toBeDefined();
    expect(body.checks.datasource).toBeDefined();
    expect(body.checks.provider).toBeDefined();
    expect(body.checks.semanticLayer).toBeDefined();
    expect(body.checks.explore).toBeDefined();
    expect(body.checks.auth).toBeDefined();
    expect(body.checks.slack).toBeDefined();
  });

  it("reports correct auth mode", async () => {
    const res = await app.fetch(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { checks: { auth: { mode: string; enabled: boolean } } };

    expect(body.checks.auth.mode).toBe("none");
    expect(body.checks.auth.enabled).toBe(false);
  });
});
