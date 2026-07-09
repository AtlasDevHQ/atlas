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
import { Effect, Layer, ManagedRuntime } from "effect";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { makeQueryEffectMock } from "@atlas/api/testing/api-test-mocks";
import { ResidencyResolver, type ResidencyResolverShape } from "@atlas/api/lib/effect/services";

// --- Mocks ---

let mockAuthMode = "managed";
void mock.module("@atlas/api/lib/auth/detect", () => ({
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

void mock.module("@atlas/api/lib/auth/middleware", () => ({
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

void mock.module("@atlas/api/lib/db/connection", () =>
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
// Fake `withDemoSeedLock` (#3683): synchronously runs the seed callback with a
// `tx.query` bound to `mockInternalQuery`, so the in-transaction phase-3 upsert
// lands on the same spy and a throwing callback rejects (matching the real
// rollback path) without a Postgres connection.
const mockWithDemoSeedLock = mock(
  (_orgId: string, fn: (tx: { query: typeof mockInternalQuery }) => Promise<unknown>): Promise<unknown> =>
    fn({ query: mockInternalQuery }),
);
const mockEncryptUrl: Mock<(url: string) => string> = mock((url: string) => `encrypted:${url}`);

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  getInternalDB: () => ({ query: async () => ({ rows: [] }) }),
  internalQuery: mockInternalQuery,
  queryEffect: makeQueryEffectMock(mockInternalQuery),
  // The /use-demo seed (#3683) runs phases 2+3 inside `withDemoSeedLock`. The
  // fake invokes the callback with a `tx.query` bound to `mockInternalQuery`, so
  // the in-transaction `workspace_plugins` upsert is recorded on the same spy
  // existing assertions read. (Real lock/transaction mechanics — BEGIN, the
  // advisory lock, ROLLBACK — are covered in `demo-seed-lock.test.ts`.)
  withDemoSeedLock: mockWithDemoSeedLock,
  internalExecute: () => {},
  encryptSecret: mockEncryptUrl,
  decryptSecret: (url: string) => url,
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

void mock.module("@atlas/api/lib/semantic", () => ({
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

const mockImportFromDisk: Mock<(orgId: string, options?: { connectionId?: string; sourceDir?: string; exec?: unknown }) => Promise<{ imported: number; skipped: number; errors: unknown[]; total: number; dbFailures: number }>> = mock(
  async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }),
);

void mock.module("@atlas/api/lib/semantic/sync", () => ({
  importFromDisk: mockImportFromDisk,
}));

void mock.module("@atlas/api/lib/semantic/files", () => ({
  getSemanticRoot: () => "/mock/semantic",
}));

// Mock fs.existsSync so getDemoSemanticDir can resolve paths without real
// filesystem. Per-test overrides (e.g. to exercise the dev fallback branch)
// can swap `existsSyncImpl` before invoking the route.
let existsSyncImpl: (path: string) => boolean = () => true;
void mock.module("fs", () => ({
  existsSync: (path: string) => existsSyncImpl(path),
  promises: {
    readFile: async () => "",
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => true }),
    mkdir: async () => undefined,
    writeFile: async () => undefined,
  },
}));

void mock.module("@atlas/api/lib/security", () => ({
  maskConnectionUrl: (url: string) => url.replace(/\/\/.*@/, "//***@"),
}));

// Spyable logger so tests can assert deprecation/info paths fire correctly.
// Pino accepts both `log.warn("string only")` (e.g. onboarding.ts handler-
// level log calls) and `log.warn({ bindings }, "msg")`. Union-typed first
// arg covers both shapes; tests narrow with `typeof call[0] === "object"`
// before reading bindings fields.
type LogFn = (arg: string | Record<string, unknown>, msg?: string) => void;
const mockLogInfo = mock<LogFn>(() => {});
const mockLogWarn = mock<LogFn>(() => {});
const mockLogError = mock<LogFn>(() => {});
const mockLogDebug = mock<LogFn>(() => {});
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

void mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
}));

// Onboarding-email milestone hooks. The route dynamically imports this module
// post-commit; mock all exports so we can assert which hook fires on each
// path (#3949: /use-demo must fire onDemoActivated, NOT onDatabaseConnected).
const mockOnUserSignup = mock(() => {});
const mockOnDatabaseConnected = mock(() => {});
const mockOnDemoActivated = mock(() => {});
const mockOnFirstQueryExecuted = mock(() => {});
const mockOnTeamMemberInvited = mock(() => {});
const mockOnFeatureExplored = mock(() => {});
void mock.module("@atlas/api/lib/email/hooks", () => ({
  onUserSignup: mockOnUserSignup,
  onDatabaseConnected: mockOnDatabaseConnected,
  onDemoActivated: mockOnDemoActivated,
  onFirstQueryExecuted: mockOnFirstQueryExecuted,
  onTeamMemberInvited: mockOnTeamMemberInvited,
  onFeatureExplored: mockOnFeatureExplored,
}));

const mockSetSetting: Mock<(key: string, value: string, userId?: string, orgId?: string) => Promise<void>> = mock(async () => {});

void mock.module("@atlas/api/lib/settings", () => ({
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
void mock.module("@atlas/ee/auth/ip-allowlist", () => ({
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

// Residency resolver injection (#4156). The `/regions` route yields
// `ResidencyResolver` (the ONLY enterprise Tag onboarding uses) from the
// enterprise runtime; the real runtime resolves it to the no-op (available:
// false) in a self-hosted test build. Override `getEnterpriseRuntime` to a
// runtime whose ResidencyResolver reads mutable per-test vars via getters, so a
// test can drive the configured multi-region path without the heavier
// effect-module shim `admin-residency.test.ts` uses. Default = unavailable, so
// the pre-existing `configured:false` regions test is unaffected.
let mockResidencyAvailable = false;
let mockResidencyDefaultRegion = "us";
let mockResidencyRegions: Record<
  string,
  { label: string; apiUrl?: string; selectable?: boolean }
> = {};
const fakeResidencyResolver = {
  get available() {
    return mockResidencyAvailable;
  },
  listRegions: () => Effect.succeed([]),
  getDefaultRegion: () => mockResidencyDefaultRegion,
  getConfiguredRegions: () => mockResidencyRegions,
  assignWorkspaceRegion: () => Effect.succeed(null),
  getWorkspaceRegionAssignment: () => Effect.succeed(null),
  listWorkspaceRegions: () => Effect.succeed([]),
  isConfiguredRegion: (r: string) => r in mockResidencyRegions,
} as unknown as ResidencyResolverShape;
const testEnterpriseRuntime = ManagedRuntime.make(
  Layer.succeed(ResidencyResolver, fakeResidencyResolver),
);
const realEnterpriseLayer = await import("@atlas/api/lib/effect/enterprise-layer");
void mock.module("@atlas/api/lib/effect/enterprise-layer", () => ({
  ...realEnterpriseLayer,
  getEnterpriseRuntime: () => testEnterpriseRuntime,
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

describe("GET /api/v1/onboarding/regions (public — pre-auth, ADR-0024 §4)", () => {
  it("returns 200 without a session — the picker renders before any identity write", async () => {
    // Under the signup reorder the region step precedes account creation, so
    // there is NO session yet. `standardAuth` would 401 this; the route is now
    // public. Force an unauthenticated `authenticate` to prove the route never
    // consults it (withRequestId runs no auth).
    mockAuthMode = "managed";
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({ authenticated: false, mode: "managed", status: 401, error: "No session" }),
    );
    const res = await request("/api/v1/onboarding/regions");
    expect(res.status).toBe(200);
    const data = await json(res);
    // Residency resolver is unavailable in the test runtime → configured:false
    // (still a 200; the frontend reads `configured` to skip the region step).
    expect(data.configured).toBe(false);
    expect(data.availableRegions).toEqual([]);
  });

  it("404s when auth mode is not managed", async () => {
    mockAuthMode = "none";
    try {
      const res = await request("/api/v1/onboarding/regions");
      expect(res.status).toBe(404);
    } finally {
      // Restore even if the assertion throws, so the mode can't leak forward.
      mockAuthMode = "managed";
    }
  });

  it("collapses the picker to this deploy's own (non-selectable staging) home arm — the { apiRegion } wiring (#4131/#4156)", async () => {
    // The staging deploy claims ATLAS_API_REGION=staging while building from the
    // shared prod config, so its home arm is the non-selectable `staging` entry.
    // The route MUST thread `{ apiRegion: getApiRegion() }` into
    // buildSignupRegions so the picker collapses to ONLY that home arm — every
    // public arm's apiUrl points at a DIFFERENT deploy, so offering them would
    // cross-origin the signup POST and dead-end (#4131). Dropping the
    // `{ apiRegion }` argument (a plausible refactor) would offer the selectable
    // prod arms (us, eu) instead and this assertion fails — the regression this
    // route test exists to catch.
    mockAuthMode = "managed";
    mockResidencyAvailable = true;
    mockResidencyDefaultRegion = "us";
    mockResidencyRegions = {
      us: { label: "US", apiUrl: "https://api.useatlas.dev", selectable: true },
      eu: { label: "EU", apiUrl: "https://eu.api.useatlas.dev", selectable: true },
      staging: {
        label: "Staging",
        apiUrl: "https://api-staging.useatlas.dev",
        selectable: false,
      },
    };
    const prevApiRegion = process.env.ATLAS_API_REGION;
    process.env.ATLAS_API_REGION = "staging";
    try {
      const res = await request("/api/v1/onboarding/regions");
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.configured).toBe(true);
      // Collapsed to the home arm only — NOT the selectable prod arms.
      expect(data.defaultRegion).toBe("staging");
      expect(data.availableRegions).toEqual([
        {
          id: "staging",
          label: "Staging",
          isDefault: true,
          apiUrl: "https://api-staging.useatlas.dev",
        },
      ]);
    } finally {
      if (prevApiRegion === undefined) delete process.env.ATLAS_API_REGION;
      else process.env.ATLAS_API_REGION = prevApiRegion;
      mockResidencyAvailable = false;
      mockResidencyRegions = {};
      mockResidencyDefaultRegion = "us";
    }
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
    mockOnDatabaseConnected.mockClear();
    mockOnDemoActivated.mockClear();
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

  it("fires onDatabaseConnected (BYO milestone unchanged) and NOT onDemoActivated (#3949)", async () => {
    const res = await request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "postgresql://user:pass@localhost:5432/mydb" }),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    // A real BYO connection still triggers the existing milestone unchanged.
    expect(mockOnDatabaseConnected).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", email: "test@example.com", orgId: "org-1" }),
    );
    expect(mockOnDemoActivated).not.toHaveBeenCalled();
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
    // Post-#2744: /use-demo first looks up the demo-postgres catalog row,
    // then runs an UPSERT into `workspace_plugins` that returns
    // `install_id AS id`. Stub both — most tests just need the round-trip
    // to succeed; assertion-focused tests further override locally.
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM plugin_catalog") && sql.includes("demo-postgres")) {
        return [{ id: "cat_demo_postgres" }];
      }
      if (typeof sql === "string" && sql.includes("INSERT INTO workspace_plugins")) {
        return [{ id: "__demo__" }];
      }
      return [{ id: "__demo__" }];
    });
    mockWithDemoSeedLock.mockClear();
    mockWithDemoSeedLock.mockImplementation((_orgId, fn) => fn({ query: mockInternalQuery }));
    mockEncryptUrl.mockClear();
    mockEncryptUrl.mockImplementation((url: string) => `encrypted:${url}`);
    mockRegister.mockClear();
    mockUnregister.mockClear();
    mockHas.mockImplementation(() => true);
    mockImportFromDisk.mockClear();
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
    mockSetSetting.mockClear();
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    mockLogError.mockClear();
    mockOnDemoActivated.mockClear();
    mockOnDatabaseConnected.mockClear();
    // Reset filesystem stub to "all paths exist" — individual tests may
    // override `existsSyncImpl` to exercise the getDemoSemanticDir fallback.
    existsSyncImpl = () => true;
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

  it("fires onDemoActivated (suppresses connect_database) and NOT onDatabaseConnected (#3949)", async () => {
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    // Dynamic import + fire-and-forget hook resolves on a microtask.
    await new Promise((r) => setTimeout(r, 10));

    // Demo activation marks the connect_database step satisfied (no email)…
    expect(mockOnDemoActivated).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", email: "test@example.com", orgId: "org-1" }),
    );
    // …and must NOT fire the BYO milestone that would send the misleading
    // "Connect your database" email.
    expect(mockOnDatabaseConnected).not.toHaveBeenCalled();
  });

  it("does not fire onDemoActivated when the seed fails (no demo activated)", async () => {
    // Import returns zero entities → DemoSeedFailure → 500, no hook.
    mockImportFromDisk.mockImplementation(async () => ({ imported: 0, skipped: 0, errors: [], total: 0, dbFailures: 0 }));
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnDemoActivated).not.toHaveBeenCalled();
  });

  it("does not fire onDemoActivated when the user label is not an email (boundary, #3949)", async () => {
    // Forces the `user.label?.includes("@")` guard's false branch with a
    // non-email label (the shape a non-managed-auth label can take). The demo
    // still seeds successfully (201) — only the email-drip decoration is skipped.
    mockAuthenticate.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "user-1", mode: "managed", label: "no-email-label", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockOnDemoActivated).not.toHaveBeenCalled();
  });

  it("saves connection with status='published' in workspace_plugins upsert SQL", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });

    // Post-#2744 the upsert lands on `workspace_plugins` with the demo
    // catalog row's id and a hard-coded 'published' status. The URL is
    // encrypted into the JSONB `config` payload, not into a top-level
    // column — assert on the install_id + the literal status in the SQL.
    const connectionInsertCall = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(connectionInsertCall).toBeDefined();
    const sql = connectionInsertCall![0] as string;
    expect(sql).toContain("'published'");
    expect(sql).toContain("'datasource'");
    // ON CONFLICT key for the singleton (workspace, catalog, install_id) PK.
    expect(sql).toContain("ON CONFLICT (workspace_id, catalog_id, install_id)");
    const params = connectionInsertCall![1] as unknown[];
    // Params: [`cn_${orgId}_${id}`, orgId, catalogId, id, configJson]
    expect(params[1]).toBe("org-1");      // workspace_id
    expect(params[2]).toBe("cat_demo_postgres"); // catalog_id from the lookup mock
    expect(params[3]).toBe("__demo__");   // install_id
  });

  it("imports semantic entities with connectionId='__demo__' as PUBLISHED (#3932)", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });

    // The demo layer is curated + read-only with no human-review step, so it
    // seeds as `published` (not the import default `draft`). A fresh signup runs
    // in published atlas-mode by default; draft entities would be invisible to
    // both the chat data-setup gate AND the agent's published-mode whitelist,
    // dead-ending the user at the activation moment (#3932).
    expect(mockImportFromDisk).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ connectionId: "__demo__", status: "published" }),
    );
  });

  it("writes demo_industry setting (always 'ecommerce' since 1.4.0 #2021)", async () => {
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(mockSetSetting).toHaveBeenCalledWith(
      "ATLAS_DEMO_INDUSTRY",
      "ecommerce",
      "user-1",
      "org-1",
    );
  });

  it("ignores legacy demoType body fields, logs warn + Deprecation header", async () => {
    // Legacy clients might still send `demoType: "cybersec"` or `demoType: "demo"`.
    // Atlas ships a single canonical demo since 1.4.0 (#2021), so the field is
    // accepted (Zod strips unknown keys) but ignored — every demo workspace
    // gets ecommerce. The contract: 201 status, ecommerce industry, canonical
    // connection id, AND a warn-level log + RFC 9745 Deprecation header so
    // operators and client devs see the staleness.
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Deprecation")).toContain('field="demoType"');
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
    expect(data.dbType).toBe("postgres");
    expect(data.entitiesImported).toBe(5);

    expect(mockSetSetting).toHaveBeenCalledWith(
      "ATLAS_DEMO_INDUSTRY",
      "ecommerce",
      "user-1",
      "org-1",
    );

    // Deprecation log fires with the legacy value for telemetry.
    const warnCall = mockLogWarn.mock.calls.find((call) =>
      typeof call[1] === "string" && call[1].includes("Legacy demoType"),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({ legacyDemoType: "cybersec" });
  });

  it("ignores legacy demoType: 'demo' (the old default)", async () => {
    // Pre-1.4.0 default: `demoType: "demo"` mapped to the SaaS CRM seed.
    // Now also ignored — every demo workspace gets ecommerce.
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "demo" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Deprecation")).toContain('field="demoType"');

    expect(mockSetSetting).toHaveBeenCalledWith(
      "ATLAS_DEMO_INDUSTRY",
      "ecommerce",
      "user-1",
      "org-1",
    );
    const warnCall = mockLogWarn.mock.calls.find((call) =>
      typeof call[1] === "string" && call[1].includes("Legacy demoType"),
    );
    expect(warnCall![0]).toMatchObject({ legacyDemoType: "demo" });
  });

  it("accepts garbage body fields without erroring", async () => {
    // The body schema strips unknown keys (`.strip()`); the route reads the
    // legacy `demoType` field from the raw body for telemetry only. Locks in
    // permissive intent: a future tightening to `.strict()` would 422 every
    // legacy client and break this test, signalling the compat surface needs
    // reconsidering.
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "garbage", extra: { nested: 42 } }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Deprecation")).toContain('field="demoType"');
  });

  it("rejects an array body with 422 and never fires deprecation telemetry", async () => {
    // The validation hook (validation-hook.ts) deterministically returns 422
    // for any Zod failure on this OpenAPI route. Pinning the status catches
    // a regression where someone drops `defaultHook: validationHook` from
    // the OpenAPIHono construction.
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["demoType", "cybersec"]),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(
      mockLogWarn.mock.calls.some((call) =>
        typeof call[1] === "string" && call[1].includes("Legacy demoType"),
      ),
    ).toBe(false);
  });

  it("does not warn or send Deprecation header for a numeric demoType", async () => {
    // The peek requires `typeof demoType === "string"`. Numeric/boolean
    // values were never produced by historical Atlas clients, but the route
    // must not crash if a malformed client sends one.
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: 42 }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  it("returns 400 invalid_request when the body is malformed JSON", async () => {
    // onboarding.onError normalizes JSON parse errors to a deterministic
    // shape: 400 + { error: "invalid_request", message: "Invalid JSON body." }.
    // Pinning the status + error code locks in that contract so a future
    // refactor of the error normalizer can't silently change the response.
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json-at-all",
    });
    expect(res.status).toBe(400);
    const data = await json(res);
    expect(data.error).toBe("invalid_request");
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  it("falls back to packages/cli/data/seeds/ecommerce/semantic when the configured root has no entities", async () => {
    // Simulate a dev workspace where `semantic/` hasn't been initialized yet:
    // getSemanticRoot() returns "/mock/semantic" but its entities/ subdir is
    // missing. getDemoSemanticDir should fall through to the bundled seed
    // path and the route should log info ("Demo semantic layer resolved via
    // dev fallback") with the seeds path.
    existsSyncImpl = (p: string) => {
      // Root semantic path has no entities dir; bundled seeds path does.
      if (p.startsWith("/mock/semantic")) return false;
      return p.includes("seeds/ecommerce/semantic");
    };

    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    const fallbackLog = mockLogInfo.mock.calls.find((call) =>
      typeof call[1] === "string" && call[1].includes("bundled-seed dev fallback"),
    );
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog![0]).toMatchObject({
      semanticDir: expect.stringContaining("seeds/ecommerce/semantic"),
    });
  });

  it("does NOT warn or send Deprecation header for canonical body or empty body", async () => {
    // No demoType field → no deprecation signal (no false-positive noise).
    const resEmpty = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(201);
    expect(resEmpty.headers.get("Deprecation")).toBeNull();
    expect(
      mockLogWarn.mock.calls.some((call) =>
        typeof call[1] === "string" && call[1].includes("Legacy demoType"),
      ),
    ).toBe(false);

    // demoType: "ecommerce" matches the canonical seed → no deprecation either.
    mockLogWarn.mockClear();
    const resCanonical = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "ecommerce" }),
    });
    expect(resCanonical.status).toBe(201);
    expect(resCanonical.headers.get("Deprecation")).toBeNull();
    expect(
      mockLogWarn.mock.calls.some((call) =>
        typeof call[1] === "string" && call[1].includes("Legacy demoType"),
      ),
    ).toBe(false);
  });

  it("does NOT seed org-scoped builtin prompt collections — globals are visible to org-with-demo via the listing query", async () => {
    // /use-demo previously copied each global builtin (org_id IS NULL,
    // is_builtin = true) into the calling org's namespace. The
    // `org-with-demo` listing query already returns global builtins
    // matching the demo industry alongside org-scoped customs (see
    // packages/api/src/lib/prompts/scoping.ts → buildCollectionsListQuery),
    // so the per-org copy was redundant — and surfaced as the duplicate
    // "E-commerce KPIs" library reported in #2169 (one row from the
    // global seed at startup, one from the per-org copy here). The
    // /use-demo flow must not touch prompt_collections at all.
    await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // No write into prompt_collections / prompt_items.
    const promptCollectionWrites = mockInternalQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO prompt_collections"),
    );
    expect(promptCollectionWrites.length).toBe(0);

    const promptItemWrites = mockInternalQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO prompt_items"),
    );
    expect(promptItemWrites.length).toBe(0);

    // No read of prompt_collections either — the previous seed function
    // first SELECTed the global builtins for this industry, so a
    // residual call here would mean the function is still being invoked
    // (just dropping inserts because of the mock returning a stub row).
    const promptCollectionReads = mockInternalQuery.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("FROM prompt_collections"),
    );
    expect(promptCollectionReads.length).toBe(0);
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
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
  });

  it("ATOMICITY: import failure leaves no connection row committed", async () => {
    // Reproduces the dharma symptom — connection had been committed BEFORE
    // the import attempt, so a failed import left a half-state. Phase order
    // is now: import first, connection last. A throwing import must mean
    // zero `INSERT INTO workspace_plugins` calls.
    mockImportFromDisk.mockImplementation(async () => {
      throw new Error("simulated disk failure");
    });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("import_failed");

    const connectionInsert = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(connectionInsert).toBeUndefined();
    expect(mockRegister).not.toHaveBeenCalled();
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
  });

  it("ATOMICITY: import returning zero imports out of N total fails before writing connection", async () => {
    // bulkUpsertEntities swallows per-row errors and returns a count. If
    // every row fails (imported=0, total>0) we'd have a connection without
    // entities — the exact partial state we're preventing. Treat as fatal.
    mockImportFromDisk.mockImplementation(async () => ({
      imported: 0,
      skipped: 13,
      errors: [{ file: "users.yml", reason: "broken yaml" }],
      total: 13,
      dbFailures: 13,
    }));
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("import_failed");

    const connectionInsert = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(connectionInsert).toBeUndefined();
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
  });

  it("ATOMICITY: bundled YAML scan returning zero entities fails before writing connection (dharma-class)", async () => {
    // The actual cause of dharma's state: pre-#2154 the bundled YAML was
    // missing on the API image, so `importFromDisk` returned
    // `{ imported: 0, total: 0 }` (scan found nothing). The old code only
    // failed on `total > 0`, so it silently absorbed the no-op, set
    // ATLAS_DEMO_INDUSTRY, and committed the __demo__ connection. dharma
    // got a half-installed workspace with `connection but no entities` —
    // exactly the state the semantic page drift drawer exposes today.
    //
    // The fix: any scan returning `total === 0` is a deploy-time
    // misconfiguration (the bundled seed isn't on the server) and must
    // fail loudly with `demo_not_available` so no connection commits and
    // the user sees a clear error instead of a silent half-success.
    mockImportFromDisk.mockImplementation(async () => ({
      imported: 0,
      skipped: 0,
      errors: [],
      total: 0,
      dbFailures: 0,
    }));
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("demo_not_available");

    const connectionInsert = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(connectionInsert).toBeUndefined();

    // Settings/prompt seeding must NOT have run either — those are
    // post-commit decorations and shouldn't fire on a failed install.
    expect(mockSetSetting).not.toHaveBeenCalled();
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
  });

  it("ATOMICITY: missing bundled YAML fails before writing connection", async () => {
    // getDemoSemanticDir() throws when neither the configured root nor the
    // bundled-seed dir has an entities/ subdir. The pre-validation phase
    // must catch this before any DB write.
    existsSyncImpl = () => false;
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("demo_not_available");

    const connectionInsert = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(connectionInsert).toBeUndefined();
    expect(mockImportFromDisk).not.toHaveBeenCalled();
  });

  it("ATOMICITY: import is invoked BEFORE the connection insert in the happy path", async () => {
    // The phase-reorder is the load-bearing invariant. Asserting the
    // call order pins it directly so a future refactor that flips
    // phases 2 and 3 (both succeeding) is caught.
    let importInvocationOrder = -1;
    let connectionInsertOrder = -1;
    let counter = 0;
    mockImportFromDisk.mockImplementation(async () => {
      importInvocationOrder = ++counter;
      return { imported: 13, skipped: 0, errors: [], total: 13, dbFailures: 0 };
    });
    const baseImpl = mockInternalQuery.getMockImplementation();
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("INSERT INTO workspace_plugins")) {
        connectionInsertOrder = ++counter;
        return [{ id: "__demo__" }];
      }
      return baseImpl ? baseImpl(sql, params) : [];
    });

    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect(importInvocationOrder).toBeGreaterThan(0);
    expect(connectionInsertOrder).toBeGreaterThan(0);
    expect(importInvocationOrder).toBeLessThan(connectionInsertOrder);

    if (baseImpl) mockInternalQuery.mockImplementation(baseImpl);
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
  });

  it("PARTIAL: imported > 0 && imported < total still commits the connection (lenient contract)", async () => {
    // Pinning the lenient behavior so a future tightening to all-or-
    // nothing would have to update this test deliberately. The 0-of-N
    // case is handled separately as a hard fail.
    mockImportFromDisk.mockImplementation(async () => ({
      imported: 8,
      skipped: 5,
      errors: [{ file: "broken.yml", reason: "yaml parse" }],
      total: 13,
      // The gap here is YAML-parse skips, not DB write failures — the lenient
      // contract still commits. A `dbFailures > 0` gap is the fatal case,
      // covered separately (#3683).
      dbFailures: 0,
    }));
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entitiesImported).toBe(8);

    const connectionInsert = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(connectionInsert).toBeDefined();
    mockImportFromDisk.mockImplementation(async () => ({ imported: 5, skipped: 0, errors: [], total: 5, dbFailures: 0 }));
  });

  it("RACE: idempotent UPSERT — ON CONFLICT DO UPDATE returns the install_id even on re-run (#2304)", async () => {
    // Post-#2744 the demo upsert uses `ON CONFLICT (workspace_id, catalog_id,
    // install_id) DO UPDATE SET config = EXCLUDED.config, status = 'published'`.
    // RETURNING install_id always yields the row on both the fresh-insert
    // and the conflict-update branch — so a second onboarder gets 201 with
    // the same canonical id. The legacy `DO NOTHING` + verify-SELECT
    // pattern that the global `__global__` install used is gone (each
    // workspace owns its own demo row now per migration 0094).
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM plugin_catalog") && sql.includes("demo-postgres")) {
        return [{ id: "cat_demo_postgres" }];
      }
      if (typeof sql === "string" && sql.includes("INSERT INTO workspace_plugins")) {
        return [{ id: "__demo__" }];
      }
      return [];
    });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
  });

  it("RACE: skip in-memory `connections.register` when the pool already has the id (#2304)", async () => {
    // Concurrent onboarders would otherwise needlessly drain and recreate
    // the pool. If a future refactor flips `if (!connections.has(id))` to
    // unconditional `unregister + register`, this test will catch the
    // regression.
    mockHas.mockReturnValueOnce(true);
    const registerCallsBefore = mockRegister.mock.calls.length;
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    // No new register() since the pool already had `__demo__`.
    expect(mockRegister.mock.calls.length).toBe(registerCallsBefore);
  });

  it("ATOMICITY: idempotent retry — a successful retry after a failure persists everything", async () => {
    // First call fails on import (no connection committed). Second call
    // succeeds (import is upsert-safe; connection upsert is idempotent).
    // The user can self-recover without admin intervention — that's the
    // recovery story for the dharma-class incident.
    mockImportFromDisk.mockImplementationOnce(async () => {
      throw new Error("transient disk error");
    });
    const firstRes = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(firstRes.status).toBe(500);

    mockImportFromDisk.mockImplementation(async () => ({ imported: 13, skipped: 0, errors: [], total: 13, dbFailures: 0 }));
    const secondRes = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(secondRes.status).toBe(201);
    const data = await json(secondRes);
    expect(data.connectionId).toBe("__demo__");
    expect(data.entitiesImported).toBe(13);
  });

  it("MUTUAL EXCLUSION: runs phases 2+3 inside a single per-workspace withDemoSeedLock transaction (#3683)", async () => {
    // The seed must be serialized + atomic per workspace: the import (phase 2)
    // and the workspace_plugins published flip (phase 3) both run inside one
    // `withDemoSeedLock(orgId, …)` transaction. Assert the lock wraps the seed,
    // is keyed on the caller's org, and that the entity import runs on the
    // transaction-bound executor (not a stray pooled connection).
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    expect(mockWithDemoSeedLock).toHaveBeenCalledTimes(1);
    expect(mockWithDemoSeedLock.mock.calls[0][0]).toBe("org-1");

    // importFromDisk received the transaction-bound executor so its upserts
    // commit (or roll back) with the phase-3 flip.
    const importCall = mockImportFromDisk.mock.calls.at(-1);
    expect(importCall?.[1]).toMatchObject({ connectionId: "__demo__" });
    expect(typeof importCall?.[1]?.exec).toBe("function");

    // The published flip landed inside the locked section (recorded on the
    // tx-bound spy).
    const flip = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(flip).toBeDefined();
  });

  it("PARTIAL SEED: a sub-total DB import (dbFailures > 0) fails the request instead of 201'ing (#3683)", async () => {
    // The MEDIUM finding: a 7-of-13 seed where the missing rows are DB write
    // failures used to return a clean 201. It must now hard-fail before the
    // published flip so no half-seeded workspace is committed.
    mockImportFromDisk.mockImplementation(async () => ({
      imported: 7,
      skipped: 6,
      errors: [],
      total: 13,
      dbFailures: 6,
    }));
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("import_failed");

    // The published flip and the post-commit decorations never ran.
    const flip = mockInternalQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO workspace_plugins"),
    );
    expect(flip).toBeUndefined();
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("ATOMICITY: a phase-3 published-flip failure rolls back the whole seed (#3683)", async () => {
    // A DB error on the workspace_plugins flip (inside the locked transaction)
    // must propagate so the transaction rolls back — the phase-2 entity import
    // can't be left committed without the published install that makes it
    // visible. The error surfaces as a 500, and no post-commit decoration runs.
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM plugin_catalog") && sql.includes("demo-postgres")) {
        return [{ id: "cat_demo_postgres" }];
      }
      if (typeof sql === "string" && sql.includes("INSERT INTO workspace_plugins")) {
        throw new Error("deadlock detected");
      }
      return [{ id: "__demo__" }];
    });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("import_failed");
    expect(data.requestId).toBeDefined();
    // Post-commit decorations must not run on a rolled-back seed.
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
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

  it("succeeds even when setSetting fails — but surfaces partialFailures", async () => {
    mockSetSetting.mockImplementation(async () => { throw new Error("settings db down"); });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ demoType: "cybersec" }),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.connectionId).toBe("__demo__");
    // Phase-4 failures used to be silent. Now the 201 carries a stable
    // `partialFailures` array so the frontend can render a degraded-state
    // warning. The shape is always-array (never optional) and the enum
    // boundary is enforced — only known phase-4 step names appear.
    expect(Array.isArray(data.partialFailures)).toBe(true);
    expect(data.partialFailures).toContain("demo_industry_setting");
    expect(data.partialFailures).not.toContain("demo_prompt_collections");
  });

  it("partialFailures is always an empty array when both phase-4 decorations succeed", async () => {
    // Pinning the always-emit shape: a frontend that does
    // `result.partialFailures.includes(...)` shouldn't have to optional-
    // chain on success. Empty array > missing key.
    mockSetSetting.mockImplementation(async () => { /* succeed */ });
    const res = await request("/api/v1/onboarding/use-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.partialFailures).toEqual([]);
  });

  // The pre-#2169 phase 4 ran two decorations (demo_industry_setting +
  // demo_prompt_collections) and tracked both in `partialFailures`.
  // After #2169 the prompt-collection seed is gone (the global builtins
  // are visible to org-with-demo orgs already), so the only decoration
  // left is `demo_industry_setting` — covered by the test above.

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
