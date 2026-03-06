/**
 * Tests for the health endpoint per-source health reporting.
 *
 * Mocks startup diagnostics, connection registry, semantic layer,
 * explore backend, and auth detection to isolate the health route's
 * per-source health aggregation logic.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import type { ConnectionMetadata, HealthCheckResult } from "@atlas/api/lib/db/connection";

// --- Mocks ---

const mockValidateEnvironment: Mock<() => Promise<{ message: string; code: string }[]>> =
  mock(() => Promise.resolve([]));

const mockGetStartupWarnings: Mock<() => string[]> = mock(() => []);

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: mockGetStartupWarnings,
}));

// Mutable connection metadata — tests push entries to simulate different states
let connMetadata: ConnectionMetadata[] = [];

const mockDBConnection = {
  query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
  close: async () => {},
};

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnection,
  connections: {
    get: () => mockDBConnection,
    getDefault: () => mockDBConnection,
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => connMetadata.map((m) => m.id),
    describe: () => connMetadata,
  },
  detectDBType: () => "postgres" as const,
  resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || null,
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies"]),
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

// Mock action tools to prevent import errors
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

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  deleteConversation: mock(() => Promise.resolve(false)),
  starConversation: async () => false,
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "none" as const,
      user: undefined,
    }),
  ),
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
}));

// Import after all mocks are registered
const { app } = await import("../index");

// --- Test helpers ---

function healthRequest(): Request {
  return new Request("http://localhost/api/health");
}

// --- Tests ---

describe("GET /api/health — sources section", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.DATABASE_URL;
    connMetadata = [];
    mockValidateEnvironment.mockReset();
    mockValidateEnvironment.mockResolvedValue([]);
    mockGetStartupWarnings.mockReset();
    mockGetStartupWarnings.mockReturnValue([]);
  });

  afterEach(() => {
    if (origDatasource !== undefined) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  it("returns sources section omitted when no connections are registered", async () => {
    connMetadata = [];

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.sources).toBeUndefined();
  });

  it("includes sources with correct shape when connections are registered", async () => {
    const healthResult: HealthCheckResult = {
      status: "healthy",
      latencyMs: 5,
      checkedAt: new Date("2026-01-15T12:00:00Z"),
    };
    connMetadata = [
      { id: "default", dbType: "postgres", health: healthResult },
    ];

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.sources).toBeDefined();
    const sources = body.sources as Record<string, unknown>;
    expect(sources.default).toBeDefined();
    const defaultSource = sources.default as Record<string, unknown>;
    expect(defaultSource.status).toBe("healthy");
    // Live probe latency overrides the registry's cached value for default connection
    expect(typeof defaultSource.latencyMs).toBe("number");
    expect(defaultSource.dbType).toBe("postgres");
    expect(defaultSource.checkedAt).toBe("2026-01-15T12:00:00.000Z");
  });

  it("promotes top-level status to 'error' when a non-default source is unhealthy", async () => {
    const unhealthy: HealthCheckResult = {
      status: "unhealthy",
      latencyMs: 5000,
      message: "Connection timed out",
      checkedAt: new Date(),
    };
    connMetadata = [
      { id: "warehouse", dbType: "postgres", health: unhealthy },
    ];

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("error");
    const sources = body.sources as Record<string, unknown>;
    expect((sources.warehouse as Record<string, unknown>).status).toBe("unhealthy");
  });

  it("promotes top-level status to 'degraded' when a non-default source is degraded and no other errors", async () => {
    const degraded: HealthCheckResult = {
      status: "degraded",
      latencyMs: 2000,
      message: "High latency",
      checkedAt: new Date(),
    };
    connMetadata = [
      { id: "warehouse", dbType: "postgres", health: degraded },
    ];

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
  });

  it("includes multiple sources in the sources section", async () => {
    connMetadata = [
      {
        id: "default",
        dbType: "postgres",
        health: { status: "healthy", latencyMs: 3, checkedAt: new Date() },
      },
      {
        id: "warehouse",
        dbType: "mysql",
        health: { status: "healthy", latencyMs: 10, checkedAt: new Date() },
      },
    ];

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;
    const sources = body.sources as Record<string, unknown>;

    expect(Object.keys(sources)).toContain("default");
    expect(Object.keys(sources)).toContain("warehouse");
    expect((sources.warehouse as Record<string, unknown>).dbType).toBe("mysql");
  });

  it("returns status 'unknown' when non-default source has no health check result", async () => {
    connMetadata = [
      { id: "warehouse", dbType: "mysql" },
    ];

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;
    const sources = body.sources as Record<string, unknown>;
    const warehouseSource = sources.warehouse as Record<string, unknown>;

    expect(warehouseSource.status).toBe("unknown");
  });

  it("uses live probe results for default source status", async () => {
    // Even if registry reports no health, the live probe succeeds → healthy
    connMetadata = [
      { id: "default", dbType: "postgres" },
    ];

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;
    const sources = body.sources as Record<string, unknown>;
    const defaultSource = sources.default as Record<string, unknown>;

    expect(defaultSource.status).toBe("healthy");
  });
});
