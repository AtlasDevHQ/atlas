/**
 * E2E: Action framework tests.
 *
 * Validates the full action lifecycle: create pending, list, approve, deny,
 * CAS conflict detection, JIRA execution via mock server, email execution
 * via mock SMTP, and role-based permission enforcement.
 *
 * Uses in-process Hono app.fetch() with mocked internals (no real DB).
 * The action handler's in-memory store is used for persistence.
 */

import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
import { createRoutedMockServer, type MockServer } from "../helpers/mock-server";
import { createConnectionMock } from "../../packages/api/src/__mocks__/connection";

// ---------------------------------------------------------------------------
// Environment — must be set before any app module imports
// ---------------------------------------------------------------------------

process.env.ATLAS_ACTIONS_ENABLED = "true";
process.env.JIRA_BASE_URL = "http://placeholder"; // overridden per test
process.env.JIRA_EMAIL = "test@example.com";
process.env.JIRA_API_TOKEN = "test-token";
process.env.JIRA_DEFAULT_PROJECT = "TEST";
process.env.RESEND_API_KEY = "re_test_key";

// ---------------------------------------------------------------------------
// Mocks — every module that the action routes import chain touches
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
  resetStartupCache: mock(() => {}),
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
    rewriteClickHouseUrl: (url: string) => url,
    parseSnowflakeURL: () => ({}),
  });
});

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
  getCrossSourceJoins: () => [],
  registerPluginEntities: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
  explore: { type: "function" },
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "api-key",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
  buildSystemParam: mock(() => ({})),
  applyCacheControl: mock(() => {}),
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
}));

// Internal DB — return false so action handler uses in-memory store
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  getInternalDB: () => { throw new Error("No internal DB in test"); },
  closeInternalDB: async () => {},
  internalQuery: async () => [],
  internalExecute: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: async () => {},
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
}));

// Config — return null to use action defaults
mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
  configFromEnv: () => ({}),
  defineConfig: (c: unknown) => c,
  validateAndResolve: (c: unknown) => c,
  loadConfig: async () => null,
  initializeConfig: async () => {},
  validateToolConfig: async () => {},
  applyDatasources: async () => {},
  _resetConfig: () => {},
}));

// Plugin hooks — no-op
mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async <T>(
    _hook: string,
    payload: T,
  ): Promise<T> => payload,
}));

// ---------------------------------------------------------------------------
// Auth mock — configurable per test
// ---------------------------------------------------------------------------

const ownerUser = { id: "owner-1", mode: "simple-key" as const, label: "Owner", role: "owner" as const };
const adminUser = { id: "admin-1", mode: "simple-key" as const, label: "Admin", role: "admin" as const };
const memberUser = { id: "member-1", mode: "simple-key" as const, label: "Member", role: "member" as const };

const mockAuthenticateRequest: Mock<(req: Request) => Promise<
  | { authenticated: true; mode: string; user: unknown }
  | { authenticated: false; mode: string; status: 401 | 500; error: string }
>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "api-key",
    user: adminUser,
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  _stopCleanup: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import app + handler after all mocks are in place
// ---------------------------------------------------------------------------

const { app } = await import("../../packages/api/src/api/index");
const {
  handleAction,
  buildActionRequest,
  _resetActionStore,
  getAction,
  listPendingActions,
  approveAction,
  denyAction,
  getActionConfig,
  registerActionExecutor,
  getActionExecutor,
} = await import("../../packages/api/src/lib/tools/actions/handler");
const { withRequestContext } = await import("../../packages/api/src/lib/logger");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a pending action in the in-memory store via handleAction. */
async function createPendingAction(overrides?: {
  actionType?: string;
  requestedBy?: string;
  summary?: string;
}) {
  const actionType = overrides?.actionType ?? "jira:create";
  const requestedBy = overrides?.requestedBy ?? adminUser.id;

  const request = buildActionRequest({
    actionType,
    target: "TEST",
    summary: overrides?.summary ?? "Test action",
    payload: { summary: "Test", description: "Test description" },
    reversible: true,
  });

  // handleAction reads request context for user info
  const result = await withRequestContext(
    {
      requestId: crypto.randomUUID(),
      user: { id: requestedBy, mode: "simple-key" as const, label: "Test", role: "admin" as const },
    },
    () => handleAction(request, async (payload) => ({ ok: true, payload })),
  );

  return { actionId: request.id, result };
}

function makeRequest(path: string, opts?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
    ...opts,
  });
}

/** Helper: monkey-patch globalThis.fetch to intercept Resend API calls. */
function interceptResendFetch(): {
  resendCalls: { url: string; body: string }[];
  restore: () => void;
  mockId: string;
} {
  const originalFetch = globalThis.fetch;
  const resendCalls: { url: string; body: string }[] = [];
  const mockId = `email-${crypto.randomUUID().slice(0, 8)}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (input: string | Request | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.resend.com")) {
      resendCalls.push({ url, body: init?.body as string });
      return new Response(
        JSON.stringify({ id: mockId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  };

  return { resendCalls, restore: () => { globalThis.fetch = originalFetch; }, mockId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Action framework", () => {
  beforeEach(() => {
    _resetActionStore();
    mockAuthenticateRequest.mockClear();
    // Default to admin user for most tests
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true as const,
        mode: "api-key",
        user: adminUser,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // The action routes require hasInternalDB() = true. Since we mocked it as
  // false, the routes will return 404. We test the handler directly for action
  // lifecycle, and verify routes gate correctly when no internal DB is set.
  //
  // Strategy: Two test groups.
  // 1. Handler tests (direct function calls) — test action lifecycle logic
  // 2. Route tests — verify gating when no internal DB (mock.module is
  //    process-global and irreversible, so positive-path route tests need
  //    a separate test file with hasInternalDB mocked as true)
  // -------------------------------------------------------------------------

  describe("handler: action lifecycle", () => {
    it("creates a pending action with manual approval mode", async () => {
      const { actionId, result } = await createPendingAction();

      expect(result).toMatchObject({
        status: "pending_approval",
        actionId,
      });

      const stored = await getAction(actionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe("pending");
      expect(stored!.action_type).toBe("jira:create");
      expect(stored!.requested_by).toBe(adminUser.id);
    });

    it("lists pending actions via handler", async () => {
      await createPendingAction({ summary: "Action A" });
      await createPendingAction({ summary: "Action B" });

      const pending = await listPendingActions({ status: "pending" });
      expect(pending.length).toBe(2);
      expect(pending.map((a) => a.summary)).toContain("Action A");
      expect(pending.map((a) => a.summary)).toContain("Action B");
    });

    it("approves a pending action and executes it", async () => {
      const { actionId } = await createPendingAction();

      const result = await approveAction(actionId, "approver-1");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("executed");
      expect(result!.approved_by).toBe("approver-1");
      expect(result!.result).toMatchObject({ ok: true });
    });

    it("denies a pending action with reason", async () => {
      const { actionId } = await createPendingAction();

      const result = await denyAction(actionId, "denier-1", "Not needed");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("denied");
      expect(result!.error).toBe("Not needed");
    });

    it("rejects double approve (CAS)", async () => {
      const { actionId } = await createPendingAction();

      // First approve succeeds
      const first = await approveAction(actionId, "approver-1");
      expect(first).not.toBeNull();
      expect(first!.status).toBe("executed");

      // Second approve returns null (CAS conflict)
      const second = await approveAction(actionId, "approver-2");
      expect(second).toBeNull();
    });

    it("rejects approve after deny (CAS)", async () => {
      const { actionId } = await createPendingAction();

      const denied = await denyAction(actionId, "denier-1");
      expect(denied).not.toBeNull();

      const approved = await approveAction(actionId, "approver-1");
      expect(approved).toBeNull();
    });

    it("rejects deny after deny (CAS)", async () => {
      const { actionId } = await createPendingAction();

      const first = await denyAction(actionId, "denier-1");
      expect(first).not.toBeNull();

      const second = await denyAction(actionId, "denier-2");
      expect(second).toBeNull();
    });

    it("rejects deny after approve (CAS)", async () => {
      const { actionId } = await createPendingAction();

      const approved = await approveAction(actionId, "approver-1");
      expect(approved).not.toBeNull();

      const denied = await denyAction(actionId, "denier-1");
      expect(denied).toBeNull();
    });
  });

  describe("routes: gating when no internal DB", () => {
    // mock.module is process-global and irreversible — hasInternalDB returns false
    // for the entire test file. These tests verify the 404 gating behavior.
    // TODO: Add positive-path route tests in a separate file where hasInternalDB
    // is mocked as true and internalQuery delegates to the in-memory store.

    it("returns 404 when internal DB is not configured", async () => {
      const res = await app.fetch(makeRequest("/api/v1/actions"));

      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_available");
    });

    it("returns 404 for approve when internal DB is not configured", async () => {
      const res = await app.fetch(
        makeRequest("/api/v1/actions/00000000-0000-0000-0000-000000000001/approve", {
          method: "POST",
        }),
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 for deny when internal DB is not configured", async () => {
      const res = await app.fetch(
        makeRequest("/api/v1/actions/00000000-0000-0000-0000-000000000001/deny", {
          method: "POST",
        }),
      );

      expect(res.status).toBe(404);
    });

    it("hasInternalDB gate runs before auth", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "api-key",
        status: 401 as const,
        error: "Missing API key",
      });

      // hasInternalDB check runs before auth, so we get 404 regardless
      const res = await app.fetch(makeRequest("/api/v1/actions"));
      expect(res.status).toBe(404);
    });
  });

  describe("JIRA execution via mock server", () => {
    let jiraMock: MockServer;

    beforeEach(() => {
      _resetActionStore();
    });

    afterAll(() => {
      jiraMock?.close();
    });

    it("sends POST to JIRA REST API on approval", async () => {
      jiraMock = createRoutedMockServer({
        "/rest/api/3/issue": async () => {
          return new Response(
            JSON.stringify({
              key: "TEST-42",
              self: `${jiraMock.url}/rest/api/3/issue/TEST-42`,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        },
      });

      // Override JIRA_BASE_URL to point to mock server
      const origBaseUrl = process.env.JIRA_BASE_URL;
      process.env.JIRA_BASE_URL = jiraMock.url;

      try {
        const { executeJiraCreate } = await import(
          "../../packages/api/src/lib/tools/actions/jira"
        );

        const result = await executeJiraCreate({
          summary: "Test ticket from E2E",
          description: "Automated test",
          project: "TEST",
          labels: ["e2e"],
        });

        expect(result.key).toBe("TEST-42");
        expect(result.url).toContain("/browse/TEST-42");

        // Verify mock received the correct request
        expect(jiraMock.calls.length).toBe(1);
        const call = jiraMock.calls[0];
        expect(call.method).toBe("POST");
        expect(call.path).toBe("/rest/api/3/issue");

        const reqBody = JSON.parse(call.body);
        expect(reqBody.fields.project.key).toBe("TEST");
        expect(reqBody.fields.summary).toBe("Test ticket from E2E");

        // Verify ADF format in description
        expect(reqBody.fields.description.type).toBe("doc");
        expect(reqBody.fields.description.version).toBe(1);
        expect(reqBody.fields.description.content[0].type).toBe("paragraph");
        expect(reqBody.fields.description.content[0].content[0].text).toBe("Automated test");

        expect(reqBody.fields.labels).toEqual(["e2e"]);
      } finally {
        process.env.JIRA_BASE_URL = origBaseUrl;
      }
    });

    it("handles JIRA API error gracefully", async () => {
      jiraMock?.close();
      jiraMock = createRoutedMockServer({
        "/rest/api/3/issue": () =>
          new Response(
            JSON.stringify({
              errorMessages: ["Project not found"],
              errors: {},
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
      });

      const origBaseUrl = process.env.JIRA_BASE_URL;
      process.env.JIRA_BASE_URL = jiraMock.url;

      try {
        const { executeJiraCreate } = await import(
          "../../packages/api/src/lib/tools/actions/jira"
        );

        await expect(
          executeJiraCreate({
            summary: "Should fail",
            description: "Error test",
          }),
        ).rejects.toThrow("JIRA API error");
      } finally {
        process.env.JIRA_BASE_URL = origBaseUrl;
      }
    });

    it("full lifecycle: create pending -> approve -> JIRA call", async () => {
      jiraMock?.close();
      jiraMock = createRoutedMockServer({
        "/rest/api/3/issue": () =>
          new Response(
            JSON.stringify({
              key: "TEST-99",
              self: "http://jira/rest/api/3/issue/TEST-99",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
      });

      const origBaseUrl = process.env.JIRA_BASE_URL;
      process.env.JIRA_BASE_URL = jiraMock.url;

      try {
        const { executeJiraCreate } = await import(
          "../../packages/api/src/lib/tools/actions/jira"
        );

        // Create a pending action with the JIRA executor
        const request = buildActionRequest({
          actionType: "jira:create",
          target: "TEST",
          summary: "Create JIRA ticket: E2E lifecycle test",
          payload: {
            summary: "E2E lifecycle test",
            description: "Full lifecycle test",
            project: "TEST",
          },
          reversible: true,
        });

        const pendingResult = await withRequestContext(
          {
            requestId: crypto.randomUUID(),
            user: adminUser,
          },
          () =>
            handleAction(request, async (payload) => {
              return executeJiraCreate(payload as { summary: string; description: string; project?: string; labels?: string[] });
            }),
        );

        expect(pendingResult.status).toBe("pending_approval");

        // Approve it
        const approved = await approveAction(request.id, "admin-1");
        expect(approved).not.toBeNull();
        expect(approved!.status).toBe("executed");
        expect((approved!.result as { key: string }).key).toBe("TEST-99");

        // Verify JIRA mock was called
        expect(jiraMock.calls.length).toBe(1);
      } finally {
        process.env.JIRA_BASE_URL = origBaseUrl;
      }
    });
  });

  describe("email execution via mock server", () => {
    it("sends email via Resend API on execution", async () => {
      const { resendCalls, restore, mockId } = interceptResendFetch();

      try {
        const { executeEmailSend } = await import(
          "../../packages/api/src/lib/tools/actions/email"
        );

        const result = await executeEmailSend({
          to: "test@example.com",
          subject: "E2E Test Report",
          body: "<h1>Test</h1><p>Automated test email</p>",
        });

        expect(result.id).toBe(mockId);

        // Verify the Resend API was called correctly
        expect(resendCalls.length).toBe(1);
        const reqBody = JSON.parse(resendCalls[0].body);
        expect(reqBody.to).toEqual(["test@example.com"]);
        expect(reqBody.subject).toBe("E2E Test Report");
        expect(reqBody.html).toContain("<h1>Test</h1>");
      } finally {
        restore();
      }
    });

    it("full lifecycle: create pending email -> approve -> send", async () => {
      const { resendCalls, restore, mockId } = interceptResendFetch();

      try {
        const { executeEmailSend } = await import(
          "../../packages/api/src/lib/tools/actions/email"
        );

        const request = buildActionRequest({
          actionType: "email:send",
          target: "report@example.com",
          summary: "Send email report",
          payload: {
            to: "report@example.com",
            subject: "Weekly Report",
            body: "<p>Report data</p>",
          },
          reversible: false,
        });

        const pendingResult = await withRequestContext(
          {
            requestId: crypto.randomUUID(),
            user: adminUser,
          },
          () =>
            handleAction(request, async (payload) => {
              return executeEmailSend(payload as { to: string | string[]; subject: string; body: string });
            }),
        );

        expect(pendingResult.status).toBe("pending_approval");

        // Approve
        const approved = await approveAction(request.id, "admin-1");
        expect(approved).not.toBeNull();
        expect(approved!.status).toBe("executed");
        expect((approved!.result as { id: string }).id).toBe(mockId);

        // Verify email was sent
        expect(resendCalls.length).toBe(1);
        const body = JSON.parse(resendCalls[0].body);
        expect(body.to).toEqual(["report@example.com"]);
      } finally {
        restore();
      }
    });
  });

  describe("permission enforcement", () => {
    it("canApprove denies viewer for manual actions", async () => {
      const { canApprove } = await import("../../packages/api/src/lib/auth/permissions");

      expect(canApprove(memberUser, "manual")).toBe(false);
      expect(canApprove(adminUser, "manual")).toBe(true);
      expect(canApprove(ownerUser, "manual")).toBe(true);
    });

    it("canApprove denies member and admin for admin-only (owner-only) actions", async () => {
      const { canApprove } = await import("../../packages/api/src/lib/auth/permissions");

      expect(canApprove(memberUser, "admin-only")).toBe(false);
      expect(canApprove(adminUser, "admin-only")).toBe(false);
      expect(canApprove(ownerUser, "admin-only")).toBe(true);
    });

    it("canApprove allows all authenticated users for auto actions", async () => {
      const { canApprove } = await import("../../packages/api/src/lib/auth/permissions");

      expect(canApprove(memberUser, "auto")).toBe(true);
      expect(canApprove(adminUser, "auto")).toBe(true);
      expect(canApprove(ownerUser, "auto")).toBe(true);
    });

    it("canApprove denies when no user (no-auth mode)", async () => {
      const { canApprove } = await import("../../packages/api/src/lib/auth/permissions");

      expect(canApprove(undefined, "manual")).toBe(false);
      expect(canApprove(undefined, "admin-only")).toBe(false);
      expect(canApprove(undefined, "auto")).toBe(false);
    });

    it("canApprove respects per-action requiredRole override", async () => {
      const { canApprove } = await import("../../packages/api/src/lib/auth/permissions");

      // Manual action with requiredRole=owner — admin should be denied, owner allowed
      expect(canApprove(adminUser, "manual", "owner")).toBe(false);
      expect(canApprove(ownerUser, "manual", "owner")).toBe(true);
    });

    it("route rejects non-admin for admin-only action approve (via handler)", async () => {
      // Simulate: create admin-only action, then try to approve as analyst
      const { canApprove } = await import("../../packages/api/src/lib/auth/permissions");

      const { actionId } = await createPendingAction({ actionType: "email:send" });

      // email:send has defaultApproval = admin-only
      // But getActionConfig reads from config (mocked as null), so it falls back to defaultApproval
      // We need to check manually since we're not going through routes
      const stored = await getAction(actionId);
      expect(stored).not.toBeNull();

      // Admin cannot approve admin-only (owner-only)
      const cfg = getActionConfig("email:send", "admin-only");
      expect(canApprove(adminUser, cfg.approval)).toBe(false);

      // Owner can approve
      expect(canApprove(ownerUser, cfg.approval)).toBe(true);
    });
  });

  describe("auto-approval mode", () => {
    it("getActionConfig returns correct defaults", () => {
      // With null config, defaults to the passed defaultApproval or "manual"
      const autoConfig = getActionConfig("test:auto", "auto");
      expect(autoConfig.approval).toBe("auto");

      const manualConfig = getActionConfig("test:manual", "manual");
      expect(manualConfig.approval).toBe("manual");

      const adminConfig = getActionConfig("test:admin", "admin-only");
      expect(adminConfig.approval).toBe("admin-only");

      // No default -> falls back to "manual"
      const noDefault = getActionConfig("test:unknown");
      expect(noDefault.approval).toBe("manual");
    });

    // Auto-approval execution path cannot be tested here because:
    // - handleAction calls getActionConfig(request.actionType) without defaultApproval
    // - getActionConfig reads from getConfig() which is mocked as null (irreversible)
    // - So the auto path in handleAction is never triggered (always falls back to "manual")
    // TODO: Test auto-approval execution in a separate file with config mocked to return
    // actions: { defaults: { approval: "auto" } }
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    it.todo("auto-approval mode executes action immediately without separate approve", () => {});
  });

  describe("ADF formatting", () => {
    it("converts plain text to Atlassian Document Format", async () => {
      const { textToADF } = await import("../../packages/api/src/lib/tools/actions/jira");

      const adf = textToADF("First paragraph\n\nSecond paragraph");

      expect(adf.version).toBe(1);
      expect(adf.type).toBe("doc");
      expect(adf.content).toHaveLength(2);
      expect(adf.content[0].type).toBe("paragraph");
      expect(adf.content[0].content[0].text).toBe("First paragraph");
      expect(adf.content[1].content[0].text).toBe("Second paragraph");
    });

    it("handles empty text with fallback", async () => {
      const { textToADF } = await import("../../packages/api/src/lib/tools/actions/jira");

      const adf = textToADF("");

      expect(adf.content).toHaveLength(1);
      expect(adf.content[0].content[0].text).toBe("(no description)");
    });
  });

  describe("email domain validation", () => {
    it("rejects blocked domains when allowlist is set", async () => {
      const origDomains = process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;
      process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "example.com,acme.org";

      try {
        // Domain validation is in the tool's execute function (sendEmailReport.tool.execute),
        // not in executeEmailSend. Call the tool's execute directly to test the allowlist.
        const { sendEmailReport } = await import(
          "../../packages/api/src/lib/tools/actions/email"
        );

        const toolObj = sendEmailReport.tool as { execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown> };
        const result = await withRequestContext(
          { requestId: crypto.randomUUID(), user: adminUser },
          () =>
            toolObj.execute(
              { to: "user@blocked.com", subject: "Test", body: "<p>Test</p>" },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { toolCallId: "test", messages: [] } as any,
            ),
        );

        // The tool should reject with an error status for the blocked domain
        expect(result).toMatchObject({
          status: "error",
        });
        expect((result as { error: string }).error).toContain("not allowed");
        expect((result as { error: string }).error).toContain("blocked.com");
      } finally {
        if (origDomains !== undefined) {
          process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = origDomains;
        } else {
          delete process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;
        }
      }
    });

    it("allows valid domains when allowlist is set", async () => {
      const origDomains = process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;
      process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = "example.com,acme.org";

      const { restore } = interceptResendFetch();

      try {
        const { sendEmailReport } = await import(
          "../../packages/api/src/lib/tools/actions/email"
        );

        const toolObj = sendEmailReport.tool as { execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown> };
        const result = await withRequestContext(
          { requestId: crypto.randomUUID(), user: adminUser },
          () =>
            toolObj.execute(
              { to: "user@example.com", subject: "Test", body: "<p>Test</p>" },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { toolCallId: "test", messages: [] } as any,
            ),
        );

        // Allowed domain should proceed to pending_approval (not error)
        expect((result as { status: string }).status).toBe("pending_approval");
      } finally {
        restore();
        if (origDomains !== undefined) {
          process.env.ATLAS_EMAIL_ALLOWED_DOMAINS = origDomains;
        } else {
          delete process.env.ATLAS_EMAIL_ALLOWED_DOMAINS;
        }
      }
    });
  });

  describe("executor registry", () => {
    it("registers and retrieves action executor", () => {
      const executor = async () => ({ success: true });
      registerActionExecutor("test-action-id", executor);

      const retrieved = getActionExecutor("test-action-id");
      expect(retrieved).toBe(executor);
    });

    it("returns undefined for unregistered executor", () => {
      const retrieved = getActionExecutor("nonexistent-id");
      expect(retrieved).toBeUndefined();
    });

    it("executor handles failure gracefully", async () => {
      const request = buildActionRequest({
        actionType: "jira:create",
        target: "TEST",
        summary: "Will fail",
        payload: { summary: "Fail test" },
        reversible: true,
      });

      const failResult = await withRequestContext(
        { requestId: crypto.randomUUID(), user: adminUser },
        () =>
          handleAction(request, async () => {
            throw new Error("Simulated failure");
          }),
      );

      // Manual mode -> pending (error only happens on execution)
      expect(failResult.status).toBe("pending_approval");

      // Now approve — executor should fail
      const approved = await approveAction(request.id, "admin-1");
      expect(approved).not.toBeNull();
      expect(approved!.status).toBe("failed");
      expect(approved!.error).toBe("Simulated failure");
    });
  });
});
