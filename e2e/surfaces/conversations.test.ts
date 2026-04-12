/**
 * E2E: Conversations API tests.
 *
 * Validates the full conversations surface: create + list, get with messages,
 * delete, and auth scoping (user A cannot see user B's conversations).
 *
 * Uses in-process Hono app.fetch() with an in-memory conversation store
 * that replaces the real DB-backed module. Auth middleware is mocked to
 * return configurable users per test.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { createConnectionMock } from "../../packages/api/src/__mocks__/connection";

// ---------------------------------------------------------------------------
// In-memory conversation store
// ---------------------------------------------------------------------------

interface StoredConversation {
  id: string;
  user_id: string | null;
  title: string | null;
  surface: string;
  connection_id: string | null;
  starred: boolean;
  created_at: string;
  updated_at: string;
}

interface StoredMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: unknown;
  created_at: string;
}

let conversations: StoredConversation[] = [];
let messages: StoredMessage[] = [];

function resetStore() {
  conversations = [];
  messages = [];
}

/** Insert a conversation directly into the in-memory store for test setup. */
function seedConversation(opts: {
  id?: string;
  userId?: string | null;
  title?: string | null;
  surface?: string;
}): string {
  const id = opts.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  conversations.push({
    id,
    user_id: opts.userId ?? null,
    title: opts.title ?? null,
    surface: opts.surface ?? "web",
    connection_id: null,
    starred: false,
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** Insert a message directly into the in-memory store for test setup. */
function seedMessage(opts: {
  conversationId: string;
  role: string;
  content: unknown;
}): string {
  const id = crypto.randomUUID();
  messages.push({
    id,
    conversation_id: opts.conversationId,
    role: opts.role,
    content: opts.content,
    created_at: new Date().toISOString(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Mocks — everything except conversations module (which uses in-memory store)
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

// Internal DB — return true so conversation routes pass the hasInternalDB gate
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => { throw new Error("Use mocked conversations module"); },
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
    name: "createJiraTicket",
    description: "Mock",
    tool: { type: "function" },
    actionType: "jira:create",
    reversible: true,
    defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport",
    description: "Mock",
    tool: { type: "function" },
    actionType: "email:send",
    reversible: false,
    defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
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

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "api-key",
  resetAuthModeCache: () => {},
  getAuthModeSource: () => null,
}));

// ---------------------------------------------------------------------------
// Conversations mock — backed by in-memory store
// ---------------------------------------------------------------------------

type CrudResult = { ok: true } | { ok: false; reason: string };
type CrudDataResult<T> = { ok: true; data: T } | { ok: false; reason: string };

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock((opts: {
    id?: string;
    userId?: string | null;
    title?: string | null;
    surface?: string;
    connectionId?: string | null;
  }) => {
    const id = opts.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    conversations.push({
      id,
      user_id: opts.userId ?? null,
      title: opts.title ?? null,
      surface: opts.surface ?? "web",
      connection_id: opts.connectionId ?? null,
      starred: false,
      created_at: now,
      updated_at: now,
    });
    return Promise.resolve({ id });
  }),

  addMessage: mock((opts: {
    conversationId: string;
    role: string;
    content: unknown;
  }) => {
    messages.push({
      id: crypto.randomUUID(),
      conversation_id: opts.conversationId,
      role: opts.role,
      content: opts.content,
      created_at: new Date().toISOString(),
    });
  }),

  persistAssistantSteps: mock(() => {}),

  getConversation: mock((id: string, userId?: string | null): Promise<CrudDataResult<unknown>> => {
    const conv = conversations.find((c) =>
      c.id === id && (userId == null || c.user_id === userId),
    );
    if (!conv) return Promise.resolve({ ok: false as const, reason: "not_found" });
    const msgs = messages
      .filter((m) => m.conversation_id === id)
      .map((m) => ({
        id: m.id,
        conversationId: m.conversation_id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      }));
    return Promise.resolve({
      ok: true as const,
      data: {
        id: conv.id,
        userId: conv.user_id,
        title: conv.title,
        surface: conv.surface,
        connectionId: conv.connection_id,
        starred: conv.starred,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        messages: msgs,
      },
    });
  }),

  listConversations: mock((opts?: {
    userId?: string | null;
    starred?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    let filtered = [...conversations];
    if (opts?.userId) {
      filtered = filtered.filter((c) => c.user_id === opts.userId);
    }
    if (opts?.starred !== undefined) {
      filtered = filtered.filter((c) => c.starred === opts.starred);
    }
    // Sort by updated_at DESC
    filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const total = filtered.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 20;
    const sliced = filtered.slice(offset, offset + limit);
    return Promise.resolve({
      conversations: sliced.map((c) => ({
        id: c.id,
        userId: c.user_id,
        title: c.title,
        surface: c.surface,
        connectionId: c.connection_id,
        starred: c.starred,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
      total,
    });
  }),

  starConversation: mock((id: string, starred: boolean, userId?: string | null): Promise<CrudResult> => {
    const conv = conversations.find((c) =>
      c.id === id && (userId == null || c.user_id === userId),
    );
    if (!conv) return Promise.resolve({ ok: false as const, reason: "not_found" });
    conv.starred = starred;
    conv.updated_at = new Date().toISOString();
    return Promise.resolve({ ok: true as const });
  }),

  deleteConversation: mock((id: string, userId?: string | null): Promise<CrudResult> => {
    const idx = conversations.findIndex((c) =>
      c.id === id && (userId == null || c.user_id === userId),
    );
    if (idx === -1) return Promise.resolve({ ok: false as const, reason: "not_found" });
    conversations.splice(idx, 1);
    // Cascade delete messages
    const remaining = messages.filter((m) => m.conversation_id !== id);
    messages.length = 0;
    messages.push(...remaining);
    return Promise.resolve({ ok: true as const });
  }),

  generateTitle: mock((q: string) => q.slice(0, 80)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

// ---------------------------------------------------------------------------
// Auth mock — configurable per test
// ---------------------------------------------------------------------------

const userA = { id: "user-a", mode: "api-key" as const, label: "User A", role: "analyst" as const };
const userB = { id: "user-b", mode: "api-key" as const, label: "User B", role: "analyst" as const };

let currentUser = userA;

const mockAuthenticateRequest: Mock<(req: Request) => Promise<
  | { authenticated: true; mode: string; user: typeof userA }
  | { authenticated: false; mode: string; status: 401; error: string }
>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "api-key",
    user: currentUser,
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
  resetRateLimits: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import app after all mocks are registered
// ---------------------------------------------------------------------------

const { app } = await import("../../packages/api/src/api/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, opts);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
  currentUser = userA;
  mockAuthenticateRequest.mockClear();
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "api-key",
      user: currentUser,
    }),
  );
});

afterAll(() => {
  resetStore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Conversations API", () => {
  // -------------------------------------------------------------------------
  // 1. Create + list
  // -------------------------------------------------------------------------

  describe("create + list", () => {
    it("lists conversations belonging to the authenticated user", async () => {
      // Seed conversations for user A
      seedConversation({ userId: userA.id, title: "First chat" });
      seedConversation({ userId: userA.id, title: "Second chat" });

      const res = await app.fetch(
        makeRequest("GET", "/api/v1/conversations"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        conversations: { id: string; title: string }[];
        total: number;
      };
      expect(body.total).toBe(2);
      expect(body.conversations).toHaveLength(2);
      expect(body.conversations.map((c) => c.title)).toContain("First chat");
      expect(body.conversations.map((c) => c.title)).toContain("Second chat");
    });

    it("returns empty list when user has no conversations", async () => {
      const res = await app.fetch(
        makeRequest("GET", "/api/v1/conversations"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        conversations: unknown[];
        total: number;
      };
      expect(body.total).toBe(0);
      expect(body.conversations).toHaveLength(0);
    });

    it("respects limit and offset query parameters", async () => {
      // Seed 5 conversations
      for (let i = 1; i <= 5; i++) {
        seedConversation({ userId: userA.id, title: `Chat ${i}` });
      }

      const res = await app.fetch(
        makeRequest("GET", "/api/v1/conversations?limit=2&offset=1"),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        conversations: { title: string }[];
        total: number;
      };
      expect(body.total).toBe(5);
      expect(body.conversations).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Get with messages
  // -------------------------------------------------------------------------

  describe("get with messages", () => {
    it("returns conversation with user and assistant messages", async () => {
      const convId = seedConversation({ userId: userA.id, title: "Test conversation" });
      seedMessage({ conversationId: convId, role: "user", content: "What is the revenue?" });
      seedMessage({ conversationId: convId, role: "assistant", content: "The total revenue is $1M." });

      const res = await app.fetch(
        makeRequest("GET", `/api/v1/conversations/${convId}`),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        title: string;
        messages: { role: string; content: unknown }[];
      };
      expect(body.id).toBe(convId);
      expect(body.title).toBe("Test conversation");
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("What is the revenue?");
      expect(body.messages[1].role).toBe("assistant");
      expect(body.messages[1].content).toBe("The total revenue is $1M.");
    });

    it("returns 404 for non-existent conversation", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await app.fetch(
        makeRequest("GET", `/api/v1/conversations/${fakeId}`),
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("returns 400 for invalid UUID format", async () => {
      const res = await app.fetch(
        makeRequest("GET", "/api/v1/conversations/not-a-uuid"),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Delete
  // -------------------------------------------------------------------------

  describe("delete", () => {
    it("deletes a conversation and returns 204", async () => {
      const convId = seedConversation({ userId: userA.id, title: "To delete" });
      seedMessage({ conversationId: convId, role: "user", content: "hello" });

      const deleteRes = await app.fetch(
        makeRequest("DELETE", `/api/v1/conversations/${convId}`),
      );
      expect(deleteRes.status).toBe(204);

      // Subsequent GET should return 404
      const getRes = await app.fetch(
        makeRequest("GET", `/api/v1/conversations/${convId}`),
      );
      expect(getRes.status).toBe(404);
    });

    it("returns 404 when deleting non-existent conversation", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000001";
      const res = await app.fetch(
        makeRequest("DELETE", `/api/v1/conversations/${fakeId}`),
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid UUID format on delete", async () => {
      const res = await app.fetch(
        makeRequest("DELETE", "/api/v1/conversations/bad-id"),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Auth scoping — user isolation
  // -------------------------------------------------------------------------

  describe("auth scoping", () => {
    it("user A cannot see user B's conversations", async () => {
      // Seed conversation for user B
      const convId = seedConversation({ userId: userB.id, title: "User B private" });
      seedMessage({ conversationId: convId, role: "user", content: "secret question" });

      // Authenticated as user A (default) — list should be empty
      const listRes = await app.fetch(
        makeRequest("GET", "/api/v1/conversations"),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        conversations: { id: string }[];
        total: number;
      };
      expect(listBody.total).toBe(0);
      expect(listBody.conversations).toHaveLength(0);

      // GET by ID should also return 404
      const getRes = await app.fetch(
        makeRequest("GET", `/api/v1/conversations/${convId}`),
      );
      expect(getRes.status).toBe(404);
    });

    it("user A cannot delete user B's conversation", async () => {
      const convId = seedConversation({ userId: userB.id, title: "User B owns this" });

      // Authenticated as user A — delete should return 404
      const deleteRes = await app.fetch(
        makeRequest("DELETE", `/api/v1/conversations/${convId}`),
      );
      expect(deleteRes.status).toBe(404);

      // Verify conversation still exists (switch to user B)
      currentUser = userB;
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true as const,
          mode: "api-key",
          user: currentUser,
        }),
      );

      const getRes = await app.fetch(
        makeRequest("GET", `/api/v1/conversations/${convId}`),
      );
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as { id: string; title: string };
      expect(body.id).toBe(convId);
      expect(body.title).toBe("User B owns this");
    });

    it("each user sees only their own conversations in the list", async () => {
      seedConversation({ userId: userA.id, title: "A's chat" });
      seedConversation({ userId: userB.id, title: "B's chat" });

      // User A sees only their conversation
      const resA = await app.fetch(
        makeRequest("GET", "/api/v1/conversations"),
      );
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as {
        conversations: { title: string }[];
        total: number;
      };
      expect(bodyA.total).toBe(1);
      expect(bodyA.conversations[0].title).toBe("A's chat");

      // Switch to user B
      currentUser = userB;
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true as const,
          mode: "api-key",
          user: currentUser,
        }),
      );

      const resB = await app.fetch(
        makeRequest("GET", "/api/v1/conversations"),
      );
      expect(resB.status).toBe(200);
      const bodyB = (await resB.json()) as {
        conversations: { title: string }[];
        total: number;
      };
      expect(bodyB.total).toBe(1);
      expect(bodyB.conversations[0].title).toBe("B's chat");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Star / unstar
  // -------------------------------------------------------------------------

  describe("star / unstar", () => {
    it("stars a conversation and verifies via get", async () => {
      const convId = seedConversation({ userId: userA.id, title: "Star me" });

      const starRes = await app.fetch(
        makeRequest("PATCH", `/api/v1/conversations/${convId}/star`, { starred: true }),
      );
      expect(starRes.status).toBe(200);
      const starBody = (await starRes.json()) as { id: string; starred: boolean };
      expect(starBody.starred).toBe(true);

      // Verify via GET
      const getRes = await app.fetch(
        makeRequest("GET", `/api/v1/conversations/${convId}`),
      );
      expect(getRes.status).toBe(200);
      const conv = (await getRes.json()) as { starred: boolean };
      expect(conv.starred).toBe(true);
    });

    it("returns 404 when starring non-existent conversation", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000002";
      const res = await app.fetch(
        makeRequest("PATCH", `/api/v1/conversations/${fakeId}/star`, { starred: true }),
      );
      expect(res.status).toBe(404);
    });
  });
});
