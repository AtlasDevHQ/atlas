/**
 * Tests for onboarding API routes.
 *
 * Covers the self-serve signup flow endpoints:
 * - POST /api/v1/onboarding/test-connection
 * - POST /api/v1/onboarding/complete
 * - GET /api/v1/onboarding/social-providers
 * - GET /api/v1/onboarding/tour-status
 * - POST /api/v1/onboarding/tour-complete
 * - POST /api/v1/onboarding/tour-reset
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { makeQueryEffectMock } from "@atlas/api/testing/api-test-mocks";

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
  queryEffect: makeQueryEffectMock(mockInternalQuery),
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
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
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

const mockImportFromDisk: Mock<(orgId: string, options?: { connectionId?: string; sourceDir?: string }) => Promise<{ imported: number; skipped: number; errors: unknown[]; total: number }>> = mock(
  async () => ({ imported: 5, skipped: 0, errors: [], total: 5 }),
);

mock.module("@atlas/api/lib/semantic/sync", () => ({
  importFromDisk: mockImportFromDisk,
}));

mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/mock/semantic",
}));

// Mock fs.existsSync so getDemoSemanticDir can resolve paths without real filesystem
mock.module("fs", () => ({
  existsSync: () => true,
  promises: {
    readFile: async () => "",
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => true }),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
  },
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

const mockSetSetting: Mock<(key: string, value: string, userId?: string, orgId?: string) => Promise<void>> = mock(async () => {});

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
  getSettingLive: async () => undefined,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: mockSetSetting,
  deleteSetting: async () => {},
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// Skip EE IP allowlist check — no real DB in tests
mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: mock(() => Effect.succeed({ allowed: true })),
  listIPAllowlistEntries: mock(async () => []),
  addIPAllowlistEntry: mock(async () => ({})),
  removeIPAllowlistEntry: mock(async () => false),
  IPAllowlistError: class extends Error { constructor(message: string, public readonly code: string) { super(message); this.name = "IPAllowlistError"; } },
  invalidateCache: mock(() => {}),
  _clearCache: mock(() => {}),
  parseCIDR: mock(() => null),
  isIPInRange: mock(() => false),
  isIPAllowed: mock(() => true),
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
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(async () => [{ id: "default" }]);
    mockEncryptUrl.mockImplementation((url: string) => `encrypted:${url}`);
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

  it("succeeds even when another org has the same connection ID (composite PK)", async () => {
    // With composite PK (id, org_id), upsert always returns a row for the current org
    mockInternalQuery.mockImplementation(async () => [{ id: "default" }]);
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("default");
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

// ---------------------------------------------------------------------------
// Tour status / completion / reset
// ---------------------------------------------------------------------------

describe("GET /api/v1/onboarding/tour-status", () => {
  beforeEach(() => {
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "member" },
      }),
    );
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(async () => []);
  });

  it("returns tourCompleted=false when no onboarding row exists", async () => {
    const res = await request("/api/v1/onboarding/tour-status");
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tourCompleted).toBe(false);
    expect(data.tourCompletedAt).toBeNull();
  });

  it("returns tourCompleted=true when tour_completed_at is set", async () => {
    const ts = "2026-03-22T10:00:00.000Z";
    mockInternalQuery.mockImplementation(async () => [{ tour_completed_at: ts }]);
    const res = await request("/api/v1/onboarding/tour-status");
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tourCompleted).toBe(true);
    expect(data.tourCompletedAt).toBe(ts);
  });

  it("returns 404 when auth mode is not managed", async () => {
    mockAuthMode = "none";
    const res = await request("/api/v1/onboarding/tour-status");
    expect(res.status).toBe(404);
  });

  it("returns 404 when no internal DB", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    const res = await request("/api/v1/onboarding/tour-status");
    expect(res.status).toBe(404);
    mockHasInternalDB.mockImplementation(() => true);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({ authenticated: false, mode: "managed", status: 401, error: "No session" }),
    );
    const res = await request("/api/v1/onboarding/tour-status");
    expect(res.status).toBe(401);
  });

  it("returns 500 with requestId when query fails", async () => {
    mockInternalQuery.mockImplementation(async () => { throw new Error("db timeout"); });
    const res = await request("/api/v1/onboarding/tour-status");
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("internal_error");
    expect(data.requestId).toBeDefined();
    mockInternalQuery.mockImplementation(async () => []);
  });
});

describe("POST /api/v1/onboarding/tour-complete", () => {
  beforeEach(() => {
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "member" },
      }),
    );
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(async () => []);
  });

  it("marks tour as completed", async () => {
    const res = await request("/api/v1/onboarding/tour-complete", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tourCompleted).toBe(true);
    expect(data.tourCompletedAt).toBeDefined();
  });

  it("returns 404 when auth mode is not managed", async () => {
    mockAuthMode = "none";
    const res = await request("/api/v1/onboarding/tour-complete", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 500 with requestId when query fails", async () => {
    mockInternalQuery.mockImplementation(async () => { throw new Error("db timeout"); });
    const res = await request("/api/v1/onboarding/tour-complete", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("internal_error");
    expect(data.requestId).toBeDefined();
    mockInternalQuery.mockImplementation(async () => []);
  });
});

describe("POST /api/v1/onboarding/tour-reset", () => {
  beforeEach(() => {
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "member" },
      }),
    );
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockImplementation(async () => []);
  });

  it("resets tour completion", async () => {
    const res = await request("/api/v1/onboarding/tour-reset", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.tourCompleted).toBe(false);
    expect(data.tourCompletedAt).toBeNull();
  });

  it("returns 404 when auth mode is not managed", async () => {
    mockAuthMode = "none";
    const res = await request("/api/v1/onboarding/tour-reset", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/onboarding/use-demo
// ---------------------------------------------------------------------------

describe("POST /api/v1/onboarding/use-demo", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    mockHasInternalDB.mockImplementation(() => true);
    mockInternalQuery.mockClear();
    mockInternalQuery.mockImplementation(async () => [{ id: "__demo__" }]);
    mockEncryptUrl.mockClear();
    mockEncryptUrl.mockImplementation((url: string) => `encrypted:${url}`);
    mockRegister.mockClear();
    mockUnregister.mockClear();
    mockHas.mockImplementation(() => true);
    mockImportFromDisk.mockClear();
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5 }));
    mockSetSetting.mockClear();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://demo:pass@localhost:5432/demo";
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it("creates demo connection with id='__demo__'", async () => {
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
    expect(data.dbType).toBe("postgres");
    expect(data.entitiesImported).toBe(5);
  });

  it("saves connection with status='published' in upsert SQL", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });

    // Find the INSERT INTO connections call
    const connectionInsertCall = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO connections"),
    );
    expect(connectionInsertCall).toBeDefined();
    const sql = connectionInsertCall![0] as string;
    expect(sql).toContain("'published'");
    // F-47: INSERT carries url_key_version so post-rotation ops queries
    // (`WHERE url_key_version < $active`) surface demo-flow rows too.
    expect(sql).toContain("url_key_version");
    const params = connectionInsertCall![1] as unknown[];
    expect(params[0]).toBe("__demo__");
    // url_key_version defaults to 1 in tests with no ATLAS_ENCRYPTION_KEYS set.
    expect(params[params.length - 1]).toBe(1);
  });

  it("imports semantic entities with connectionId='__demo__'", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });

    expect(mockImportFromDisk).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ connectionId: "__demo__" }),
    );
  });

  it("writes demo_industry setting for the org", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });

    expect(mockSetSetting).toHaveBeenCalledWith(
      "ATLAS_DEMO_INDUSTRY",
      "cybersecurity",
      "user-1",
      "org-1",
    );
  });

  it("maps demo type 'ecommerce' to industry 'ecommerce'", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "ecommerce" }),
    });

    expect(mockSetSetting).toHaveBeenCalledWith(
      "ATLAS_DEMO_INDUSTRY",
      "ecommerce",
      "user-1",
      "org-1",
    );
  });

  it("maps demo type 'demo' to industry 'saas'", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(mockSetSetting).toHaveBeenCalledWith(
      "ATLAS_DEMO_INDUSTRY",
      "saas",
      "user-1",
      "org-1",
    );
  });

  it("seeds demo prompt collections for matching industry", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });

    // The seedDemoPromptCollections function queries for builtin collections
    const builtinQuery = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("is_builtin = true") && call[0].includes("industry"),
    );
    expect(builtinQuery).toBeDefined();
    const params = builtinQuery![1] as unknown[];
    expect(params[0]).toBe("cybersecurity");
  });

  it("rejects when auth mode is not managed", async () => {
    mockAuthMode = "none";
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects when no active organization", async () => {
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "test@example.com", role: "member" },
      }),
    );
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("no_organization");
  });

  it("returns 400 when no datasource URL is configured", async () => {
    delete process.env.ATLAS_DATASOURCE_URL;
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("no_demo_datasource");
  });

  it("returns 500 when semantic import fails", async () => {
    mockImportFromDisk.mockImplementation(async () => { throw new Error("import boom"); });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("import_failed");
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5 }));
  });

  it("returns 500 with requestId when encryption fails", async () => {
    mockEncryptUrl.mockImplementation(() => { throw new Error("bad key"); });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("encryption_failed");
    expect(data.requestId).toBeDefined();
    mockEncryptUrl.mockImplementation((url: string) => `encrypted:${url}`);
  });

  it("succeeds even when setSetting fails (non-fatal)", async () => {
    mockSetSetting.mockImplementation(async () => { throw new Error("settings db down"); });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
  });

  it("succeeds even when prompt collection seeding fails (non-fatal)", async () => {
    const originalImpl = mockInternalQuery.getMockImplementation();
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("is_builtin = true")) {
        throw new Error("prompt_collections table missing");
      }
      return [{ id: "__demo__" }];
    });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
    if (originalImpl) mockInternalQuery.mockImplementation(originalImpl);
  });

  it("returns 500 with requestId when DB upsert fails", async () => {
    mockInternalQuery.mockImplementation(async () => { throw new Error("connection reset"); });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("internal_error");
    expect(data.requestId).toBeDefined();
  });
});

