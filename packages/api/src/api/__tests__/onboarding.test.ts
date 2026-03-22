/**
 * Tests for onboarding API routes.
 *
 * Covers the self-serve signup flow endpoints:
 * - POST /api/v1/onboarding/test-connection
 * - POST /api/v1/onboarding/complete
 * - GET /api/v1/onboarding/social-providers
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";

// --- Mocks ---

let mockAuthMode = "managed";
mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
  resetAuthModeCache: () => {},
}));

const mockAuthenticate: Mock<() => Promise<{
  authenticated: boolean;
  mode: string;
  user?: { id: string; mode: string; label: string; role: string; activeOrganizationId?: string };
  status?: number;
  error?: string;
}>> = mock(() =>
  Promise.resolve({
    authenticated: true,
    mode: "managed",
    user: { id: "user-1", mode: "managed", label: "test@example.com", role: "admin", activeOrganizationId: "org-1" },
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticate,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

const mockHealthCheck: Mock<() => Promise<{ status: string; latencyMs: number }>> = mock(() =>
  Promise.resolve({ status: "healthy", latencyMs: 42 }),
);

const mockRegister: Mock<(id: string, config: Record<string, unknown>) => void> = mock(() => {});
const mockUnregister: Mock<(id: string) => void> = mock(() => {});
const mockHas: Mock<(id: string) => boolean> = mock(() => true);

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      healthCheck: mockHealthCheck,
      register: mockRegister,
      unregister: mockUnregister,
      has: mockHas,
    },
    detectDBType: (url?: string) => {
      const connStr = url ?? "";
      if (connStr.startsWith("postgresql://") || connStr.startsWith("postgres://")) return "postgres";
      if (connStr.startsWith("mysql://") || connStr.startsWith("mysql2://")) return "mysql";
      throw new Error(`Unsupported database URL scheme`);
    },
  }),
);

const mockHasInternalDB: Mock<() => boolean> = mock(() => true);
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
  async () => [{ id: "default" }],
);
const mockEncryptUrl: Mock<(url: string) => string> = mock((url: string) => `encrypted:${url}`);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: mockInternalQuery,
  internalExecute: () => {},
  encryptUrl: mockEncryptUrl,
  decryptUrl: (url: string) => url,
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  isPlaintextUrl: () => true,
  getEncryptionKey: () => null,
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  _resetEncryptionKeyCache: () => {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/security", () => ({
  maskConnectionUrl: (url: string) => url.replace(/\/\/.*@/, "//***@"),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
}));

// --- Import the route after mocks are set up ---

const { onboarding } = await import("../routes/onboarding");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/onboarding", onboarding);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

/** Type-safe JSON parse for test assertions. */
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/v1/onboarding/social-providers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it("returns empty array when no providers configured", async () => {
    const res = await request("/api/v1/onboarding/social-providers");
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data).toEqual({ providers: [] });
  });

  it("returns configured providers", async () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    process.env.GITHUB_CLIENT_ID = "ghid";
    process.env.GITHUB_CLIENT_SECRET = "ghsecret";

    const res = await request("/api/v1/onboarding/social-providers");
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.providers).toContain("google");
    expect(data.providers).toContain("github");
    expect(data.providers).not.toContain("microsoft");
  });
});

describe("POST /api/v1/onboarding/test-connection", () => {
  beforeEach(() => {
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "member" },
      }),
    );
    mockHealthCheck.mockImplementation(() =>
      Promise.resolve({ status: "healthy", latencyMs: 42 }),
    );
    mockRegister.mockClear();
    mockUnregister.mockClear();
    mockHas.mockImplementation(() => true);
  });

  it("rejects when auth mode is not managed", async () => {
    mockAuthMode = "none";
    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://localhost/test" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated requests", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({ authenticated: false, mode: "managed", status: 401, error: "No session" }),
    );
    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://localhost/test" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing URL", async () => {
    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // 422: Zod validation via OpenAPIHono createRoute rejects missing required field
    expect(res.status).toBe(422);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
    const body = (await res.json()) as any;
    expect(body.error).toBe("validation_error");
  });

  it("returns 400 for malformed JSON body", async () => {
    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_request");
  });

  it("rejects unsupported URL schemes", async () => {
    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "redis://localhost:6379" }),
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("invalid_url");
  });

  it("tests a valid PostgreSQL connection", async () => {
    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.status).toBe("healthy");
    expect(data.latencyMs).toBe(42);
    expect(data.dbType).toBe("postgres");
    expect(mockRegister).toHaveBeenCalled();
    expect(mockUnregister).toHaveBeenCalled();
  });

  it("returns error on connection failure", async () => {
    mockHealthCheck.mockImplementation(() => Promise.reject(new Error("Connection refused")));
    // After a failed healthCheck, the finally block calls connections.has + unregister
    mockHas.mockImplementation(() => true);

    const res = await request("/api/v1/onboarding/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@badhost:5432/mydb" }),
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("connection_failed");
  });
});

describe("POST /api/v1/onboarding/complete", () => {
  beforeEach(() => {
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    mockHealthCheck.mockImplementation(() =>
      Promise.resolve({ status: "healthy", latencyMs: 25 }),
    );
    mockRegister.mockClear();
    mockUnregister.mockClear();
    mockHas.mockImplementation(() => true);
  });

  it("rejects when no active organization", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "member" },
      }),
    );
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://localhost/test" }),
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("no_organization");
  });

  it("rejects when no internal DB", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://localhost/test" }),
    });
    expect(res.status).toBe(404);
    const data = await json(res);
    expect(data.error).toBe("not_available");
    mockHasInternalDB.mockImplementation(() => true);
  });

  it("completes onboarding with valid connection", async () => {
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("default");
    expect(data.dbType).toBe("postgres");
  });

  it("uses custom connectionId when provided", async () => {
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "mysql://user:pass@localhost:3306/mydb", connectionId: "warehouse" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("warehouse");
    expect(data.dbType).toBe("mysql");
  });

  it("returns 500 with requestId when encryption fails", async () => {
    mockEncryptUrl.mockImplementation(() => { throw new Error("bad key"); });
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("encryption_failed");
    expect(data.requestId).toBeDefined();
    mockEncryptUrl.mockImplementation((url: string) => `encrypted:${url}`);
  });

  it("returns 500 with requestId when DB write fails", async () => {
    mockInternalQuery.mockImplementation(async () => { throw new Error("connection reset"); });
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("internal_error");
    expect(data.requestId).toBeDefined();
    mockInternalQuery.mockImplementation(async () => [{ id: "default" }]);
  });

  it("returns 409 when connection ID belongs to another org", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(409);
    const data = await json(res);
    expect(data.error).toBe("conflict");
    mockInternalQuery.mockImplementation(async () => [{ id: "default" }]);
  });

  it("returns error on connection health check failure", async () => {
    mockHealthCheck.mockImplementation(() => Promise.reject(new Error("Connection refused")));
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("connection_failed");
  });
});

