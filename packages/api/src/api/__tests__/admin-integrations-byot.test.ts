/**
 * Tests for BYOT (Bring Your Own Token) admin integration routes.
 *
 * Tests: POST /integrations/telegram, POST /integrations/slack/byot,
 *        POST /integrations/teams/byot, POST /integrations/discord/byot.
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
import { createConnectionMock } from "@atlas/api/testing/connection";
import * as fs from "fs";
import * as path from "path";

// --- Temp semantic fixtures ---

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-byot-test-${Date.now()}`);
fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
fs.writeFileSync(
  path.join(tmpRoot, "entities", "stub.yml"),
  "table: stub\ndescription: stub\ndimensions:\n  id:\n    type: integer\n",
);
fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: Test\n");
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;

// --- Mocks (before any import that touches the modules) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
      },
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
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [{ id: "default", dbType: "postgres" }],
      healthCheck: mock(() => Promise.resolve({ status: "healthy" })),
      register: mock(() => {}),
      unregister: mock(() => {}),
      has: mock(() => false),
      getForOrg: () => null,
    },
    resolveDatasourceUrl: () => "postgresql://stub",
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
  getApprovedPatterns: mock(async () => []),
  upsertSuggestion: mock(() => Promise.resolve("created")),
  getSuggestionsByTables: mock(() => Promise.resolve([])),
  getPopularSuggestions: mock(() => Promise.resolve([])),
  incrementSuggestionClick: mock(),
  deleteSuggestion: mock(() => Promise.resolve(false)),
  getAuditLogQueries: mock(() => Promise.resolve([])),
  getWorkspaceStatus: mock(async () => "active"),
  getWorkspaceDetails: mock(async () => null),
  updateWorkspaceStatus: mock(async () => true),
  updateWorkspacePlanTier: mock(async () => true),
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
}));

// --- Store mocks ---

const mockSaveSlackInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(
  async () => {},
);

mock.module("@atlas/api/lib/slack/store", () => ({
  getInstallation: mock(async () => null),
  getInstallationByOrg: mock(async () => null),
  saveInstallation: mockSaveSlackInstallation,
  deleteInstallation: mock(async () => {}),
  deleteInstallationByOrg: mock(async () => false),
  getBotToken: mock(async () => null),
  ENV_TEAM_ID: "env",
}));

const mockSaveTeamsInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(
  async () => {},
);

mock.module("@atlas/api/lib/teams/store", () => ({
  getTeamsInstallation: mock(async () => null),
  getTeamsInstallationByOrg: mock(async () => null),
  saveTeamsInstallation: mockSaveTeamsInstallation,
  deleteTeamsInstallation: mock(async () => {}),
  deleteTeamsInstallationByOrg: mock(async () => false),
}));

const mockSaveDiscordInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(
  async () => {},
);

mock.module("@atlas/api/lib/discord/store", () => ({
  getDiscordInstallation: mock(async () => null),
  getDiscordInstallationByOrg: mock(async () => null),
  saveDiscordInstallation: mockSaveDiscordInstallation,
  deleteDiscordInstallation: mock(async () => {}),
  deleteDiscordInstallationByOrg: mock(async () => false),
}));

const mockSaveTelegramInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(
  async () => {},
);

mock.module("@atlas/api/lib/telegram/store", () => ({
  getTelegramInstallation: mock(async () => null),
  getTelegramInstallationByOrg: mock(async () => null),
  saveTelegramInstallation: mockSaveTelegramInstallation,
  deleteTelegramInstallation: mock(async () => {}),
  deleteTelegramInstallationByOrg: mock(async () => false),
}));

// --- Other mocks needed by the admin router ---

mock.module("@atlas/api/lib/cache", () => ({
  getCache: mock(() => ({ get: () => null, set: () => {}, delete: () => false, flush: () => {}, stats: () => ({}) })),
  cacheEnabled: mock(() => true),
  setCacheBackend: mock(() => {}),
  flushCache: mock(() => {}),
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
}));

mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: mock(async () => ({ allowed: true })),
}));

mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: mock(() => []),
  getSettingsRegistry: mock(() => []),
  getSettingDefinition: mock(() => undefined),
  setSetting: mock(async () => {}),
  deleteSetting: mock(async () => {}),
  loadSettings: mock(async () => 0),
  getSetting: mock(() => undefined),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
}));

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [],
    get: () => undefined,
    getStatus: () => undefined,
    enable: () => false,
    disable: () => false,
    isEnabled: () => false,
    getAllHealthy: () => [],
    getByType: () => [],
    size: 0,
  },
  PluginRegistry: class {},
}));

mock.module("@atlas/api/lib/plugins/settings", () => ({
  loadPluginSettings: mock(async () => 0),
  savePluginEnabled: mock(async () => {}),
  savePluginConfig: mock(async () => {}),
  getPluginConfig: mock(async () => null),
  getAllPluginSettings: mock(async () => []),
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: mock(async () => {}),
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
  starConversation: mock(() => Promise.resolve(false)),
  shareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  unshareConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  getShareStatus: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  cleanupExpiredShares: mock(() => Promise.resolve(0)),
  getSharedConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  updateNotebookState: mock(() => Promise.resolve({ ok: true })),
  forkConversation: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => null,
  listAllUsers: mock(() => Promise.resolve([])),
  setUserRole: mock(async () => {}),
  setBanStatus: mock(async () => {}),
  setPasswordChangeRequired: mock(async () => {}),
  deleteUser: mock(async () => {}),
}));

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  listScheduledTasks: mock(async () => []),
  getScheduledTask: mock(async () => null),
  createScheduledTask: mock(async () => ({})),
  updateScheduledTask: mock(async () => null),
  deleteScheduledTask: mock(async () => false),
  listScheduledTaskRuns: mock(async () => []),
  getRecentRuns: mock(async () => []),
  scheduledTaskBelongsToUser: mock(async () => false),
}));

mock.module("@atlas/api/lib/scheduler", () => ({
  getSchedulerEngine: mock(() => null),
}));

mock.module("@atlas/api/lib/scheduler/preview", () => ({
  previewSchedule: () => [],
}));

// --- Mock global fetch for API validation calls ---

const originalFetch = globalThis.fetch;
let mockFetchImpl: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

// --- Import the app AFTER mocks ---

const { admin } = await import("../routes/admin");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/admin", admin);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

function jsonPost(path: string, body: Record<string, unknown>) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
  globalThis.fetch = originalFetch;
});

describe("BYOT routes", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockInternalQuery.mockClear();
    mockSaveSlackInstallation.mockReset();
    mockSaveSlackInstallation.mockImplementation(async () => {});
    mockSaveTeamsInstallation.mockReset();
    mockSaveTeamsInstallation.mockImplementation(async () => {});
    mockSaveDiscordInstallation.mockReset();
    mockSaveDiscordInstallation.mockImplementation(async () => {});
    mockSaveTelegramInstallation.mockReset();
    mockSaveTelegramInstallation.mockImplementation(async () => {});
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          activeOrganizationId: "org-1",
        },
      }),
    );
    // Reset fetch mock
    mockFetchImpl = mock(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis.fetch requires preconnect; safe to cast in tests
    globalThis.fetch = mockFetchImpl as any;
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /telegram
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/telegram", () => {
    it("returns 401 without auth", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid or expired token",
          status: 401,
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "123:ABC",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 without org context", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: {
            id: "admin-1",
            mode: "simple-key",
            label: "Admin",
            role: "admin",
            activeOrganizationId: null,
          },
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "123:ABC",
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 with missing botToken", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/telegram", {});
      expect(res.status).toBe(422);
    });

    it("returns 400 with invalid bot token (HTTP error)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
            status: 401,
          }),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "invalid-token",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("returns 400 with invalid bot token (body ok:false)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false }), { status: 200 }),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "invalid-token",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("returns 400 when fetch throws (network error)", async () => {
      mockFetchImpl.mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      });

      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "123:ABC",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("saves installation on success", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: { id: 777, username: "atlas_bot" } }),
            { status: 200 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "123:ABC",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { message: string; botUsername: string };
      expect(data.message).toContain("connected");
      expect(data.botUsername).toBe("atlas_bot");
      expect(mockSaveTelegramInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveTelegramInstallation).toHaveBeenCalledWith("777", {
        orgId: "org-1",
        botUsername: "atlas_bot",
        botToken: "123:ABC",
      });
    });

    it("returns 500 when store save throws (org hijack)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: { id: 777, username: "atlas_bot" } }),
            { status: 200 },
          ),
        ),
      );
      mockSaveTelegramInstallation.mockImplementation(() => {
        throw new Error("Bot 777 is already bound to a different organization.");
      });

      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "123:ABC",
      });
      expect(res.status).toBe(500);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await jsonPost("/api/v1/admin/integrations/telegram", {
        botToken: "123:ABC",
      });
      // requireOrgContext middleware returns 404 when no internal DB
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /slack/byot
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/slack/byot", () => {
    it("returns 401 without auth", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid or expired token",
          status: 401,
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 without org context", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: {
            id: "admin-1",
            mode: "simple-key",
            label: "Admin",
            role: "admin",
            activeOrganizationId: null,
          },
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 with invalid token format", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "not-a-xoxb-token",
      });
      // Zod validation rejects tokens that don't start with xoxb-
      expect(res.status).toBe(422);
    });

    it("returns 400 when Slack auth.test fails", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
            status: 200,
          }),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("returns 400 when fetch throws (network error)", async () => {
      mockFetchImpl.mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      });

      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("saves installation on success", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, team_id: "T123", team: "My Workspace" }),
            { status: 200 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { message: string; workspaceName: string; teamId: string };
      expect(data.message).toContain("connected");
      expect(data.workspaceName).toBe("My Workspace");
      expect(data.teamId).toBe("T123");
      expect(mockSaveSlackInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveSlackInstallation).toHaveBeenCalledWith("T123", "xoxb-test-token", {
        orgId: "org-1",
        workspaceName: "My Workspace",
      });
    });

    it("returns 500 when store save throws (org hijack)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, team_id: "T123", team: "My Workspace" }),
            { status: 200 },
          ),
        ),
      );
      mockSaveSlackInstallation.mockImplementation(() => {
        throw new Error("Slack workspace T123 is already bound to a different organization.");
      });

      const res = await jsonPost("/api/v1/admin/integrations/slack/byot", {
        botToken: "xoxb-test-token",
      });
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /teams/byot
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/teams/byot", () => {
    it("returns 401 without auth", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid or expired token",
          status: 401,
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        appPassword: "secret",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 without org context", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: {
            id: "admin-1",
            mode: "simple-key",
            label: "Admin",
            role: "admin",
            activeOrganizationId: null,
          },
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        appPassword: "secret",
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 with missing fields", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        // missing appPassword
      });
      expect(res.status).toBe(422);
    });

    it("returns 400 when Azure AD token fails", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "invalid_client", error_description: "Bad credentials" }),
            { status: 400 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        appPassword: "bad-secret",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_credentials");
    });

    it("returns 400 when fetch throws (network error)", async () => {
      mockFetchImpl.mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      });

      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        appPassword: "bad-secret",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_credentials");
    });

    it("saves installation on success", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "eyJ0eXAiOiJKV1QiLCJhbGci..." }),
            { status: 200 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        appPassword: "good-secret",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { message: string; appId: string };
      expect(data.message).toContain("connected");
      expect(data.appId).toBe("app-123");
      expect(mockSaveTeamsInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveTeamsInstallation).toHaveBeenCalledWith("app-123", {
        orgId: "org-1",
        appPassword: "good-secret",
      });
    });

    it("returns 500 when store save throws (org hijack)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "eyJ0eXAiOiJKV1QiLCJhbGci..." }),
            { status: 200 },
          ),
        ),
      );
      mockSaveTeamsInstallation.mockImplementation(() => {
        throw new Error("Tenant app-123 is already bound to a different organization.");
      });

      const res = await jsonPost("/api/v1/admin/integrations/teams/byot", {
        appId: "app-123",
        appPassword: "good-secret",
      });
      expect(res.status).toBe(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /discord/byot
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/discord/byot", () => {
    it("returns 401 without auth", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid or expired token",
          status: 401,
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 without org context", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: {
            id: "admin-1",
            mode: "simple-key",
            label: "Admin",
            role: "admin",
            activeOrganizationId: null,
          },
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 with missing fields", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        // missing applicationId, publicKey
      });
      expect(res.status).toBe(422);
    });

    it("returns 400 when Discord /users/@me fails", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "401: Unauthorized" }), {
            status: 401,
          }),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "bad-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("returns 400 when fetch throws (network error)", async () => {
      mockFetchImpl.mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      });

      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("saves installation on success", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ id: "bot-999", username: "atlas-discord-bot" }),
            { status: 200 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { message: string; botUsername: string };
      expect(data.message).toContain("connected");
      expect(data.botUsername).toBe("atlas-discord-bot");
      expect(mockSaveDiscordInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveDiscordInstallation).toHaveBeenCalledWith("app-456", {
        orgId: "org-1",
        guildName: "@atlas-discord-bot",
        botToken: "discord-bot-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
    });

    it("returns 500 when store save throws (org hijack)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ id: "bot-999", username: "atlas-discord-bot" }),
            { status: 200 },
          ),
        ),
      );
      mockSaveDiscordInstallation.mockImplementation(() => {
        throw new Error("Guild app-456 is already bound to a different organization.");
      });

      const res = await jsonPost("/api/v1/admin/integrations/discord/byot", {
        botToken: "discord-bot-token",
        applicationId: "app-456",
        publicKey: "pk-789",
      });
      expect(res.status).toBe(500);
    });
  });
});
