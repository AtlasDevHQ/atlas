/**
 * Tests for the health endpoint explore.pluginId field.
 *
 * Separate from health.test.ts because Bun's mock.module() is
 * process-global and irreversible — we need a different explore
 * mock (returning "plugin" instead of "just-bash").
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

// --- Mocks (must register before importing the app) ---

const mockValidateEnvironment: Mock<() => Promise<{ message: string; code: string }[]>> =
  mock(() => Promise.resolve([]));

const mockGetStartupWarnings: Mock<() => string[]> = mock(() => []);

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mockValidateEnvironment,
  getStartupWarnings: mockGetStartupWarnings,
}));

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  }),
  connections: {
    get: () => ({
      query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
      close: async () => {},
    }),
    getDefault: () => ({
      query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
      close: async () => {},
    }),
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => [],
    describe: () => [],
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

// Key mock: explore backend returns "plugin" with a pluginId
mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "plugin",
  getActiveSandboxPluginId: () => "my-sandbox",
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

// --- Tests ---

describe("GET /api/health — plugin explore backend", () => {
  const origDatasource = process.env.ATLAS_DATASOURCE_URL;

  beforeEach(() => {
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.DATABASE_URL;
    mockValidateEnvironment.mockReset();
    mockValidateEnvironment.mockResolvedValue([]);
    mockGetStartupWarnings.mockReset();
    mockGetStartupWarnings.mockReturnValue([]);
  });

  afterEach(() => {
    if (origDatasource !== undefined) process.env.ATLAS_DATASOURCE_URL = origDatasource;
    else delete process.env.ATLAS_DATASOURCE_URL;
  });

  it("includes explore.pluginId when backend is a sandbox plugin", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/health"),
    );
    const body = (await response.json()) as Record<string, unknown>;
    const checks = body.checks as Record<string, unknown>;
    const explore = checks.explore as Record<string, unknown>;

    expect(explore.backend).toBe("plugin");
    expect(explore.isolated).toBe(true);
    expect(explore.pluginId).toBe("my-sandbox");
  });

  it("includes isolationVerified: false for plugin backends", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/health"),
    );
    const body = (await response.json()) as Record<string, unknown>;
    const checks = body.checks as Record<string, unknown>;
    const explore = checks.explore as Record<string, unknown>;

    expect(explore.isolationVerified).toBe(false);
  });
});
