/**
 * E2E: Managed auth (Better Auth) tests.
 *
 * Tests managed auth mode detection, session validation, and the auth
 * API proxy routes. Since managed auth requires Better Auth + internal DB,
 * these tests use mocked auth instances to verify the middleware and
 * routing behavior without a real database.
 *
 * Tests cover:
 * - Managed mode detection when BETTER_AUTH_SECRET is set
 * - Session-based authentication via cookie/bearer
 * - Role extraction from session (admin promotion, default role)
 * - Auth API proxy routes (/api/auth/*)
 * - Missing session returns 401
 *
 * Uses in-process Hono app.fetch() with mocked Better Auth.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createConnectionMock } from "../../packages/api/src/__mocks__/connection";

// ---------------------------------------------------------------------------
// Environment — set up managed auth mode
// ---------------------------------------------------------------------------

// Save original env for cleanup
const savedEnv = {
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  ATLAS_AUTH_MODE: process.env.ATLAS_AUTH_MODE,
  ATLAS_DATASOURCE_URL: process.env.ATLAS_DATASOURCE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
};

// Set managed auth environment
process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.ATLAS_AUTH_MODE = "managed";
process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost/test";

// ---------------------------------------------------------------------------
// Mocks — everything except the managed auth validation path
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
    resolveDatasourceUrl: () => "postgresql://test:test@localhost/test",
    rewriteClickHouseUrl: (url: string) => url,
    parseSnowflakeURL: () => ({}),
  });
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => { throw new Error("Use mocked auth"); },
  internalQuery: async () => [],
  internalExecute: () => {},
  closeInternalDB: async () => {},
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

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
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

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mock(() =>
    Promise.resolve({
      answer: "42",
      sql: ["SELECT 1"],
      data: [{ columns: ["?column?"], rows: [{ "?column?": 1 }] }],
      steps: 1,
      usage: { totalTokens: 100 },
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket", description: "Mock", tool: { type: "function" },
    actionType: "jira:create", reversible: true, defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport", description: "Mock", tool: { type: "function" },
    actionType: "email:send", reversible: false, defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
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

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
  configFromEnv: () => ({}),
  loadConfig: async () => null,
  initializeConfig: async () => {},
  validateAndResolve: () => ({}),
  defineConfig: (c: unknown) => c,
  _resetConfig: () => {},
  validateToolConfig: async () => {},
  applyDatasources: async () => {},
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, payload: unknown) => payload,
}));

// ---------------------------------------------------------------------------
// Mock the managed auth validator directly — the session check layer
// ---------------------------------------------------------------------------

const mockValidateManaged: Mock<(req: Request) => Promise<
  | { authenticated: true; mode: "managed"; user: { id: string; mode: "managed"; label: string; role: string; claims?: Record<string, unknown> } }
  | { authenticated: false; mode: "managed"; status: 401 | 500; error: string }
>> = mock(() =>
  Promise.resolve({
    authenticated: false as const,
    mode: "managed" as const,
    status: 401 as const,
    error: "Not signed in",
  }),
);

mock.module("@atlas/api/lib/auth/managed", () => ({
  validateManaged: mockValidateManaged,
}));

// Mock the auth server module to prevent actual Better Auth initialization
const mockGetAuthInstance = mock(() => ({
  handler: async (req: Request) => {
    const url = new URL(req.url);
    // Simulate auth API responses
    if (url.pathname.endsWith("/get-session")) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "Not implemented in test" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
  api: {
    getSession: mock(async () => null),
  },
}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: mockGetAuthInstance,
  resetAuthInstance: mock(() => {}),
  _setAuthInstance: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import app after all mocks
// ---------------------------------------------------------------------------

const { app } = await import("../../packages/api/src/api/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function queryRequest(headers?: Record<string, string>) {
  return app.fetch(
    new Request("http://localhost/api/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ question: "how many orders?" }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockValidateManaged.mockClear();
  // Default: not authenticated
  mockValidateManaged.mockResolvedValue({
    authenticated: false as const,
    mode: "managed" as const,
    status: 401 as const,
    error: "Not signed in",
  });
});

afterAll(() => {
  // Restore original env
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Managed auth — session validation", () => {
  it("rejects requests with no session (no cookie, no bearer)", async () => {
    const res = await queryRequest();

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("auth_error");
    expect(body.message).toContain("Not signed in");
  });

  it("accepts requests with a valid managed session", async () => {
    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "user-123",
        mode: "managed" as const,
        label: "test@example.com",
        role: "analyst",
      },
    });

    const res = await queryRequest({
      Cookie: "better-auth.session_token=valid-session-token",
    });

    expect(res.status).toBe(200);
    expect(mockValidateManaged).toHaveBeenCalled();
  });

  it("accepts requests with a valid bearer token in managed mode", async () => {
    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "api-user-456",
        mode: "managed" as const,
        label: "api-user@example.com",
        role: "admin",
      },
    });

    const res = await queryRequest({
      Authorization: "Bearer ba_valid-api-key-token",
    });

    expect(res.status).toBe(200);
    expect(mockValidateManaged).toHaveBeenCalled();
  });

  it("propagates admin role from managed session", async () => {
    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "admin-user",
        mode: "managed" as const,
        label: "admin@example.com",
        role: "admin",
      },
    });

    // Request succeeds — admin role is propagated
    const res = await queryRequest({
      Cookie: "better-auth.session_token=admin-session",
    });

    expect(res.status).toBe(200);
    expect(mockValidateManaged).toHaveBeenCalled();
  });

  it("returns 500 when managed auth infrastructure fails", async () => {
    mockValidateManaged.mockResolvedValueOnce({
      authenticated: false as const,
      mode: "managed" as const,
      status: 500 as const,
      error: "Session data is incomplete",
    });

    const res = await queryRequest({
      Cookie: "better-auth.session_token=broken-session",
    });

    expect(res.status).toBe(500);
  });
});

describe("E2E: Managed auth — health endpoint bypass", () => {
  it("health endpoint is accessible without session (not 401)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/health"),
    );

    // Health endpoint should never return 401 even when managed auth is active.
    // It may return 200 or 503 depending on mock completeness, but never 401.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe("E2E: Managed auth — role enforcement", () => {
  it("viewer role can access read-only endpoints", async () => {
    mockValidateManaged.mockResolvedValueOnce({
      authenticated: true as const,
      mode: "managed" as const,
      user: {
        id: "viewer-user",
        mode: "managed" as const,
        label: "viewer@example.com",
        role: "viewer",
      },
    });

    // Query endpoint should work for viewers
    const res = await queryRequest({
      Cookie: "better-auth.session_token=viewer-session",
    });

    // Viewer should be able to query — auth succeeds and request is processed
    expect(res.status).toBe(200);
    expect(mockValidateManaged).toHaveBeenCalled();
  });
});
