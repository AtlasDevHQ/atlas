/**
 * Tests for admin user invitation API routes.
 *
 * Covers: POST /users/invite, GET /users/invitations, DELETE /users/invitations/:id.
 * Mocks: auth middleware, internal DB, and transitive dependencies.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as fs from "fs";
import * as path from "path";

// --- Temp semantic fixtures ---

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-invite-test-${Date.now()}`);
fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
fs.writeFileSync(
  path.join(tmpRoot, "entities", "stub.yml"),
  "table: stub\ndescription: stub\n",
);
fs.writeFileSync(path.join(tmpRoot, "glossary.yml"), "terms: []\n");
fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: test\n");
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;

// --- Mocks ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin" },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

const mockDBConnection = {
  query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      describe: () => [{ id: "default", dbType: "postgres", description: "Test DB" }],
      healthCheck: mock(() => Promise.resolve({ status: "healthy", latencyMs: 5, checkedAt: new Date() })),
      getForOrg: () => mockDBConnection,
    },
  }),
);

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["stub"]),
  getCrossSourceJoins: () => [],
  _resetWhitelists: () => {},
  registerPluginEntities: () => {},
  _resetPluginEntities: () => {},
}));

let mockHasInternalDB = true;
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => {}),
  getInternalDB: mock(() => ({})),
  closeInternalDB: mock(async () => {}),
  migrateInternalDB: mock(async () => {}),
  loadSavedConnections: mock(async () => 0),
  _resetPool: mock(() => {}),
  _resetCircuitBreaker: mock(() => {}),
  encryptUrl: (url: string) => url,
  decryptUrl: (url: string) => url,
  getEncryptionKey: () => null,
  isPlaintextUrl: (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
  _resetEncryptionKeyCache: mock(() => {}),
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  incrementPatternCount: () => {},
  getApprovedPatterns: mock(async () => []),
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
}));

mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [],
    get: () => undefined,
    getStatus: () => undefined,
    getAllHealthy: () => [],
    getByType: () => [],
    size: 0,
  },
  PluginRegistry: class {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

// Import app after all mocks are registered
const { app } = await import("../index");

// --- Helpers ---

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body) {
    opts.headers = { ...opts.headers, "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${urlPath}`, opts);
}

// --- Tests ---

describe("Admin routes — user invitations", () => {
  beforeEach(() => {
    mockInternalQuery.mockReset();
    mockInternalQuery.mockResolvedValue([]);
    mockHasInternalDB = true;
  });

  describe("POST /users/invite", () => {
    it("creates an invitation with valid email and role", async () => {
      // Promise.all: check existing user + pending invitation → both empty
      // Then INSERT → return new invitation
      mockInternalQuery
        .mockResolvedValueOnce([]) // user check
        .mockResolvedValueOnce([]) // pending check
        .mockResolvedValueOnce([{ id: "inv-1", created_at: "2026-01-01T00:00:00Z" }]); // INSERT

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "new@example.com",
          role: "member",
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.email).toBe("new@example.com");
      expect(body.role).toBe("member");
      expect(body.inviteUrl).toBeTruthy();
      expect(typeof body.token).toBe("string");
      expect(body.emailSent).toBe(false);
    });

    it("rejects missing email", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          role: "member",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toContain("email");
    });

    it("rejects invalid email format", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "not-an-email",
          role: "member",
        }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects invalid role", async () => {
      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "valid@example.com",
          role: "superadmin",
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toContain("role");
    });

    it("rejects invitation when user already exists", async () => {
      // Promise.all: user check returns existing, pending check returns empty
      mockInternalQuery
        .mockResolvedValueOnce([{ id: "user-existing" }]) // user check
        .mockResolvedValueOnce([]); // pending check

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "existing@example.com",
          role: "member",
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toContain("already exists");
    });

    it("rejects duplicate pending invitation", async () => {
      // Promise.all: user check returns empty, pending check returns existing
      mockInternalQuery
        .mockResolvedValueOnce([]) // user check
        .mockResolvedValueOnce([{ id: "inv-existing" }]); // pending check

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "pending@example.com",
          role: "member",
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toContain("pending invitation");
    });

    it("normalizes email to lowercase", async () => {
      mockInternalQuery
        .mockResolvedValueOnce([]) // user check
        .mockResolvedValueOnce([]) // pending check
        .mockImplementationOnce(async (_sql: string, params?: unknown[]) => {
          // Verify normalized email was stored in INSERT
          if (params) expect(params[0]).toBe("test@example.com");
          return [{ id: "inv-2", created_at: "2026-01-01T00:00:00Z" }];
        });

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "  Test@Example.COM  ",
          role: "admin",
        }),
      );
      expect(res.status).toBe(200);
    });

    it("returns 404 when internal DB is unavailable", async () => {
      mockHasInternalDB = false;

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invite", "POST", {
          email: "test@example.com",
          role: "member",
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /users/invitations", () => {
    it("returns a list of invitations", async () => {
      mockInternalQuery.mockResolvedValueOnce([
        {
          id: "inv-1",
          email: "a@b.com",
          role: "member",
          status: "pending",
          invited_by: "admin-1",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          accepted_at: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);

      const res = await app.fetch(adminRequest("/api/v1/admin/users/invitations"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { invitations: unknown[] };
      expect(body.invitations).toHaveLength(1);
    });

    it("marks expired invitations in the response", async () => {
      mockInternalQuery.mockResolvedValueOnce([
        {
          id: "inv-2",
          email: "expired@b.com",
          role: "member",
          status: "pending",
          invited_by: "admin-1",
          expires_at: new Date(Date.now() - 86400000).toISOString(), // yesterday
          accepted_at: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);

      const res = await app.fetch(adminRequest("/api/v1/admin/users/invitations"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { invitations: Array<{ status: string }> };
      expect(body.invitations[0].status).toBe("expired");
    });

    it("returns 404 when internal DB is unavailable", async () => {
      mockHasInternalDB = false;

      const res = await app.fetch(adminRequest("/api/v1/admin/users/invitations"));
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /users/invitations/:id", () => {
    it("revokes a pending invitation", async () => {
      mockInternalQuery.mockResolvedValueOnce([{ id: "inv-1" }]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invitations/inv-1", "DELETE"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(true);
    });

    it("returns 404 for non-existent invitation", async () => {
      mockInternalQuery.mockResolvedValueOnce([]);

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invitations/inv-nonexistent", "DELETE"),
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when internal DB is unavailable", async () => {
      mockHasInternalDB = false;

      const res = await app.fetch(
        adminRequest("/api/v1/admin/users/invitations/inv-1", "DELETE"),
      );
      expect(res.status).toBe(404);
    });
  });
});
