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
import { createConnectionMock } from "@atlas/api/testing/connection";

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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => mockDBConnection,
    connections: {
      get: () => mockDBConnection,
      getDefault: () => mockDBConnection,
      list: () => connMetadata.map((m) => m.id),
      describe: () => connMetadata,
      getForOrg: () => mockDBConnection,
    },
    resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || null,
  }),
);

mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
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
  persistAssistantSteps: mock(() => {}),
  // F-77 step-cap helpers — chat.ts imports both via @atlas/api/lib/conversations.
  reserveConversationBudget: mock(() => Promise.resolve({ status: 'ok' as const, totalStepsBefore: 0 })),
  settleConversationSteps: mock(() => {}),
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
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  convertToNotebook: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  deleteBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  renameBranch: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
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

// #1987 — plugin registry mock so tests can drive healthCheckAll() per scenario.
type PluginHealthEntry = {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
  status: "registered" | "initializing" | "healthy" | "unhealthy" | "teardown";
};
let pluginDescribeImpl: () => Array<{
  id: string;
  types: readonly string[];
  version: string;
  name: string;
  status: string;
  enabled: boolean;
}> = () => [];
let pluginHealthCheckAllImpl: () => Promise<Map<string, PluginHealthEntry>> = () =>
  Promise.resolve(new Map());

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => pluginDescribeImpl(),
    healthCheckAll: () => pluginHealthCheckAllImpl(),
    getAll: () => [],
    getAllHealthy: () => [],
    getByType: () => [],
    get size() {
      return pluginDescribeImpl().length;
    },
  },
  PluginRegistry: class {},
}));

// Internal DB mock — defaults to a successful SELECT 1, individual tests
// can override by reassigning `internalDBQueryImpl` to reject. We spread the
// real module so the dozens of route files that statically import other
// helpers (internalQuery, hasInternalDB, encryptUrl, etc.) keep working.
const realInternalDBModule = await import("@atlas/api/lib/db/internal");
let internalDBQueryImpl: () => Promise<unknown> = () =>
  Promise.resolve({ rows: [{ "?column?": 1 }] });
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternalDBModule,
  getInternalDB: () => ({ query: () => internalDBQueryImpl() }),
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

// #1981 — internal DB unreachable must fail the SaaS load-balancer probe.
// Self-hosted treats the internal DB as optional, so degraded → 200 must hold.
describe("GET /api/health — internal DB / deploy mode contract", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  const origDatabaseUrl = process.env.DATABASE_URL;
  const origDeployMode = process.env.ATLAS_DEPLOY_MODE;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.DATABASE_URL;
    delete process.env.ATLAS_DEPLOY_MODE;
    connMetadata = [];
    mockValidateEnvironment.mockReset();
    mockGetStartupWarnings.mockReset();
    mockGetStartupWarnings.mockReturnValue([]);
    internalDBQueryImpl = () => Promise.resolve({ rows: [{ "?column?": 1 }] });
  });

  afterEach(async () => {
    if (origDatasource !== undefined) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
    if (origDeployMode !== undefined) process.env.ATLAS_DEPLOY_MODE = origDeployMode;
    else delete process.env.ATLAS_DEPLOY_MODE;
    const config = await import("@atlas/api/lib/config");
    config._setConfigForTest(null);
    internalDBQueryImpl = () => Promise.resolve({ rows: [{ "?column?": 1 }] });
  });

  it("returns 503 in SaaS when internal DB diagnostic flags it unreachable", async () => {
    mockValidateEnvironment.mockResolvedValue([
      { code: "INTERNAL_DB_UNREACHABLE", message: "internal db down" },
    ]);
    const config = await import("@atlas/api/lib/config");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
    config._setConfigForTest({ deployMode: "saas" } as any);

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("error");
  });

  it("returns 503 in SaaS when the live internal DB probe rejects", async () => {
    // Realistic mid-life failure: pod was connected, internal DB just died.
    // Surfaces via internalProbeError (live SELECT 1), not the boot diagnostic.
    process.env.DATABASE_URL = "postgresql://internal:internal@localhost:5432/atlas";
    internalDBQueryImpl = () => Promise.reject(new Error("connection refused"));
    mockValidateEnvironment.mockResolvedValue([]);
    const config = await import("@atlas/api/lib/config");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
    config._setConfigForTest({ deployMode: "saas" } as any);

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("error");
  });

  it("returns 503 when ATLAS_DEPLOY_MODE=saas even if config is not yet loaded", async () => {
    // Boot-window safety net: a probe hitting a SaaS pod before loadConfig()
    // resolves must still fail closed. getConfig() returns null here.
    mockValidateEnvironment.mockResolvedValue([
      { code: "INTERNAL_DB_UNREACHABLE", message: "internal db down" },
    ]);
    process.env.ATLAS_DEPLOY_MODE = "saas";
    const config = await import("@atlas/api/lib/config");
    config._setConfigForTest(null);

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("error");
  });

  it("returns 200 degraded in self-hosted when internal DB is unreachable", async () => {
    mockValidateEnvironment.mockResolvedValue([
      { code: "INTERNAL_DB_UNREACHABLE", message: "internal db down" },
    ]);
    const config = await import("@atlas/api/lib/config");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
    config._setConfigForTest({ deployMode: "self-hosted" } as any);

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
  });
});

// #1987 — plugin healthcheck must surface in /health.
// Plugin failures should NOT escalate to 503 (only datasource + SaaS internal-DB
// do that). A degraded plugin is observable but does not page oncall.
describe("GET /api/health — plugin component", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;
  const origDatabaseUrl = process.env.DATABASE_URL;
  const origDeployMode = process.env.ATLAS_DEPLOY_MODE;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.DATABASE_URL;
    delete process.env.ATLAS_DEPLOY_MODE;
    connMetadata = [];
    mockValidateEnvironment.mockReset();
    mockValidateEnvironment.mockResolvedValue([]);
    mockGetStartupWarnings.mockReset();
    mockGetStartupWarnings.mockReturnValue([]);
    pluginDescribeImpl = () => [];
    pluginHealthCheckAllImpl = () => Promise.resolve(new Map());
  });

  afterEach(async () => {
    if (origDatasource !== undefined) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
    if (origDeployMode !== undefined) process.env.ATLAS_DEPLOY_MODE = origDeployMode;
    else delete process.env.ATLAS_DEPLOY_MODE;
    const config = await import("@atlas/api/lib/config");
    config._setConfigForTest(null);
    pluginDescribeImpl = () => [];
    pluginHealthCheckAllImpl = () => Promise.resolve(new Map());
  });

  it("reports plugins component as 'disabled' when no plugins are registered", async () => {
    pluginDescribeImpl = () => [];

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;
    const components = body.components as Record<string, unknown>;

    expect(components.plugins).toBeDefined();
    const plugins = components.plugins as Record<string, unknown>;
    expect(plugins.status).toBe("disabled");
  });

  it("reports plugins component as 'healthy' when every plugin probe succeeds", async () => {
    pluginDescribeImpl = () => [
      { id: "p1", types: ["datasource"], version: "1.0.0", name: "P1", status: "healthy", enabled: true },
      { id: "p2", types: ["action"], version: "1.0.0", name: "P2", status: "healthy", enabled: true },
    ];
    pluginHealthCheckAllImpl = () =>
      Promise.resolve(
        new Map([
          ["p1", { healthy: true, latencyMs: 5, status: "healthy" as const }],
          ["p2", { healthy: true, latencyMs: 10, status: "healthy" as const }],
        ]),
      );

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    const components = body.components as Record<string, unknown>;
    const plugins = components.plugins as Record<string, unknown>;
    expect(plugins.status).toBe("healthy");
  });

  it("reports plugins component as 'degraded' when at least one plugin probe fails", async () => {
    pluginDescribeImpl = () => [
      { id: "p1", types: ["datasource"], version: "1.0.0", name: "P1", status: "healthy", enabled: true },
      { id: "p2", types: ["action"], version: "1.0.0", name: "P2", status: "unhealthy", enabled: true },
    ];
    pluginHealthCheckAllImpl = () =>
      Promise.resolve(
        new Map([
          ["p1", { healthy: true, latencyMs: 5, status: "healthy" as const }],
          ["p2", { healthy: false, message: "stripe down", status: "unhealthy" as const }],
        ]),
      );

    const response = await app.fetch(healthRequest());
    // Plugin failure does NOT escalate to 503 — surfaces as degraded only.
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    const components = body.components as Record<string, unknown>;
    const plugins = components.plugins as Record<string, unknown>;
    expect(plugins.status).toBe("degraded");
  });

  it("does not escalate plugin failures to 503 even in SaaS mode", async () => {
    // The SaaS-503 short-circuit (#1981) is reserved for the internal DB.
    // Plugin failures are observable in the dashboard but never page oncall.
    process.env.ATLAS_DEPLOY_MODE = "saas";
    const config = await import("@atlas/api/lib/config");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
    config._setConfigForTest({ deployMode: "saas" } as any);

    pluginDescribeImpl = () => [
      { id: "p1", types: ["action"], version: "1.0.0", name: "P1", status: "unhealthy", enabled: true },
    ];
    pluginHealthCheckAllImpl = () =>
      Promise.resolve(new Map([["p1", { healthy: false, message: "stripe down", status: "unhealthy" as const }]]));

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
  });

  it("includes per-plugin status detail for the dashboard", async () => {
    pluginDescribeImpl = () => [
      { id: "p1", types: ["datasource"], version: "1.0.0", name: "P1", status: "healthy", enabled: true },
      { id: "p2", types: ["action"], version: "1.0.0", name: "P2", status: "unhealthy", enabled: true },
    ];
    pluginHealthCheckAllImpl = () =>
      Promise.resolve(
        new Map([
          ["p1", { healthy: true, latencyMs: 5, status: "healthy" as const }],
          ["p2", { healthy: false, message: "stripe down", status: "unhealthy" as const }],
        ]),
      );

    const response = await app.fetch(healthRequest());
    const body = (await response.json()) as Record<string, unknown>;
    const components = body.components as Record<string, unknown>;
    const plugins = components.plugins as Record<string, unknown>;
    const items = plugins.items as Array<Record<string, unknown>>;

    expect(items).toHaveLength(2);
    const p1 = items.find((p) => p.id === "p1")!;
    const p2 = items.find((p) => p.id === "p2")!;
    expect(p1.status).toBe("healthy");
    expect(p2.status).toBe("unhealthy");
    expect(p2.message).toBe("stripe down");
  });

  it("survives a healthCheckAll() exception without crashing the endpoint", async () => {
    // If the registry itself throws (e.g. registry initialization race),
    // /health must still return — the operator needs the dashboard most when
    // things are broken.
    pluginDescribeImpl = () => [
      { id: "p1", types: ["datasource"], version: "1.0.0", name: "P1", status: "healthy", enabled: true },
    ];
    pluginHealthCheckAllImpl = () => Promise.reject(new Error("registry exploded"));

    const response = await app.fetch(healthRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const components = body.components as Record<string, unknown>;
    const plugins = components.plugins as Record<string, unknown>;
    // Probe failure → degraded, with a message so operators can see why.
    expect(plugins.status).toBe("degraded");
    expect(typeof plugins.message).toBe("string");
  });
});
