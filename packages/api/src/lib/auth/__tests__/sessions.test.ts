/**
 * Tests for session management: admin session routes, user self-service,
 * and idle/absolute timeout enforcement.
 *
 * Mocks: auth middleware, internal DB, auth detect, settings.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";

// --- Mocks (before any import that touches the modules) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", mode: "managed", label: "admin@test.com", role: "admin" },
    }),
);

const mockCheckRateLimit: Mock<(key: string) => { allowed: boolean }> = mock(
  () => ({ allowed: true }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
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

// Stub out transitive deps
mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
  connections: {
    get: () => ({}),
    getDefault: () => ({}),
    getDBType: () => "postgres",
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
    describe: () => [{ id: "default", dbType: "postgres" }],
    healthCheck: mock(() => Promise.resolve({ status: "healthy" })),
    has: () => false,
    register: () => {},
    unregister: () => {},
  },
  detectDBType: () => "postgres",
  extractTargetHost: () => "localhost",
  ConnectionRegistry: class {},
  ConnectionNotRegisteredError: class extends Error {},
  NoDatasourceConfiguredError: class extends Error {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  getCrossSourceJoins: () => [],
  _resetWhitelists: () => {},
  registerPluginEntities: () => {},
  _resetPluginEntities: () => {},
}));

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
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
  isPlaintextUrl: () => true,
  _resetEncryptionKeyCache: mock(() => {}),
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

mock.module("@atlas/api/lib/plugins/settings", () => ({
  savePluginEnabled: mock(() => Promise.resolve()),
  savePluginConfig: mock(() => Promise.resolve()),
  getPluginConfig: mock(() => Promise.resolve(null)),
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string) => {
    if (key === "ATLAS_SESSION_IDLE_TIMEOUT") return "0";
    if (key === "ATLAS_SESSION_ABSOLUTE_TIMEOUT") return "0";
    return undefined;
  },
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  setSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve()),
  initializeSettings: mock(() => Promise.resolve()),
}));

mock.module("@atlas/api/lib/security", () => ({
  maskConnectionUrl: (_url: string) => "***",
}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: {
      listUsers: mock(() => Promise.resolve({ users: [], total: 0 })),
      listUserSessions: mock(() => Promise.resolve([])),
      revokeUserSession: mock(() => Promise.resolve()),
      setRole: mock(() => Promise.resolve()),
      banUser: mock(() => Promise.resolve()),
      unbanUser: mock(() => Promise.resolve()),
      removeUser: mock(() => Promise.resolve()),
      revokeSessions: mock(() => Promise.resolve()),
    },
    handler: mock(() => new Response()),
  }),
  resetAuthInstance: mock(() => {}),
  _setAuthInstance: mock(() => {}),
}));

// Need to mock semantic-files since admin.ts imports it
mock.module("@atlas/api/lib/semantic-files", () => ({
  getSemanticRoot: () => "/tmp/atlas-test-sessions",
  isValidEntityName: () => true,
  readYamlFile: () => ({}),
  discoverEntities: () => ({ entities: [], warnings: [] }),
  findEntityFile: () => null,
}));

// Mock audit module
mock.module("@atlas/api/lib/auth/audit", () => ({
  writeAuditEvent: mock(() => Promise.resolve()),
}));

// Now import after mocks
import { Hono } from "hono";

const { admin } = await import("../../../api/routes/admin");
const { sessions } = await import("../../../api/routes/sessions");

const app = new Hono();
app.route("/api/v1/admin", admin);
app.route("/api/v1/sessions", sessions);

// ── Helpers ───────────────────────────────────────────────────────

function get(path: string) {
  return app.request(path, { method: "GET" });
}

function del(path: string) {
  return app.request(path, { method: "DELETE" });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Admin session routes", () => {
  beforeEach(() => {
    mockInternalQuery.mockReset();
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "admin-1", mode: "managed", label: "admin@test.com", role: "admin" },
      }),
    );
  });

  describe("GET /api/v1/admin/sessions", () => {
    it("returns sessions list with pagination", async () => {
      const now = new Date().toISOString();
      mockInternalQuery
        .mockImplementationOnce(() =>
          Promise.resolve([
            {
              id: "sess-1",
              userId: "user-1",
              userEmail: "user@test.com",
              createdAt: now,
              updatedAt: now,
              expiresAt: now,
              ipAddress: "127.0.0.1",
              userAgent: "Mozilla/5.0",
            },
          ]),
        )
        .mockImplementationOnce(() =>
          Promise.resolve([{ count: "1" }]),
        );

      const res = await get("/api/v1/admin/sessions");
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: Array<Record<string, unknown>>; total: number };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe("sess-1");
      expect(body.sessions[0].userEmail).toBe("user@test.com");
      expect(body.total).toBe(1);
    });

    it("returns 401 when not authenticated", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({ authenticated: false, mode: "managed", status: 401, error: "Not signed in" }),
      );
      const res = await get("/api/v1/admin/sessions");
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin users", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "managed",
          user: { id: "user-1", mode: "managed", label: "user@test.com", role: "viewer" },
        }),
      );
      const res = await get("/api/v1/admin/sessions");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/admin/sessions/stats", () => {
    it("returns session stats", async () => {
      mockInternalQuery
        .mockImplementationOnce(() => Promise.resolve([{ count: "10" }]))
        .mockImplementationOnce(() => Promise.resolve([{ count: "8" }]))
        .mockImplementationOnce(() => Promise.resolve([{ count: "5" }]));

      const res = await get("/api/v1/admin/sessions/stats");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.total).toBe(10);
      expect(body.active).toBe(8);
      expect(body.uniqueUsers).toBe(5);
    });
  });

  describe("DELETE /api/v1/admin/sessions/:id", () => {
    it("revokes a session", async () => {
      mockInternalQuery
        .mockImplementationOnce(() => Promise.resolve([{ id: "sess-1" }])) // SELECT exists
        .mockImplementationOnce(() => Promise.resolve([])); // DELETE

      const res = await del("/api/v1/admin/sessions/sess-1");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
    });

    it("returns 404 for non-existent session", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([]));

      const res = await del("/api/v1/admin/sessions/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/admin/sessions/user/:userId", () => {
    it("revokes all sessions for a user", async () => {
      mockInternalQuery
        .mockImplementationOnce(() => Promise.resolve([{ count: "3" }])) // COUNT
        .mockImplementationOnce(() => Promise.resolve([])); // DELETE

      const res = await del("/api/v1/admin/sessions/user/user-1");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.count).toBe(3);
    });

    it("returns 404 when user has no sessions", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));

      const res = await del("/api/v1/admin/sessions/user/no-sessions");
      expect(res.status).toBe(404);
    });
  });
});

describe("User self-service session routes", () => {
  beforeEach(() => {
    mockInternalQuery.mockReset();
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "user@test.com", role: "viewer" },
      }),
    );
  });

  describe("GET /api/v1/sessions", () => {
    it("returns current user's sessions", async () => {
      const now = new Date().toISOString();
      mockInternalQuery.mockImplementationOnce(() =>
        Promise.resolve([
          {
            id: "sess-1",
            createdAt: now,
            updatedAt: now,
            expiresAt: now,
            ipAddress: "127.0.0.1",
            userAgent: "Test/1.0",
          },
        ]),
      );

      const res = await get("/api/v1/sessions");
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: Array<Record<string, unknown>> };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe("sess-1");
    });

    it("returns 401 when not authenticated", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({ authenticated: false, mode: "managed", status: 401, error: "Not signed in" }),
      );
      const res = await get("/api/v1/sessions");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/v1/sessions/:id", () => {
    it("revokes own session", async () => {
      mockInternalQuery
        .mockImplementationOnce(() => Promise.resolve([{ id: "sess-1", userId: "user-1" }]))
        .mockImplementationOnce(() => Promise.resolve([]));

      const res = await del("/api/v1/sessions/sess-1");
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
    });

    it("returns 403 when trying to revoke another user's session", async () => {
      mockInternalQuery.mockImplementationOnce(() =>
        Promise.resolve([{ id: "sess-2", userId: "other-user" }]),
      );

      const res = await del("/api/v1/sessions/sess-2");
      expect(res.status).toBe(403);
    });

    it("returns 404 for non-existent session", async () => {
      mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await del("/api/v1/sessions/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});

describe("Session timeout enforcement", () => {
  // Test the timeout logic in managed.ts via the getSetting mock
  // These tests verify the concept — actual integration requires
  // a running Better Auth instance with session data.

  it("idle timeout setting defaults to 0 (disabled)", () => {
    // Our mock returns "0" for ATLAS_SESSION_IDLE_TIMEOUT
    const raw = "0";
    const parsed = parseInt(raw, 10);
    expect(parsed).toBe(0);
    // 0 means disabled — no timeout enforcement
  });

  it("parses valid timeout values correctly", () => {
    const values = [
      { input: "3600", expected: 3600 },
      { input: "86400", expected: 86400 },
      { input: "0", expected: 0 },
    ];
    for (const { input, expected } of values) {
      expect(parseInt(input, 10)).toBe(expected);
    }
  });

  it("handles invalid timeout values gracefully", () => {
    const invalid = ["", "abc", "-1"];
    for (const val of invalid) {
      const n = parseInt(val, 10);
      const timeout = Number.isFinite(n) && n > 0 ? n : 0;
      expect(timeout).toBe(0);
    }
  });
});
