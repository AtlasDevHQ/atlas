/**
 * Tests for admin integrations API routes.
 *
 * Tests: GET /integrations/status, DELETE /integrations/slack.
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-integrations-test-${Date.now()}`);
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

// --- Slack store mock ---

const mockGetInstallationByOrg: Mock<(orgId: string) => Promise<unknown>> = mock(
  () => Promise.resolve(null),
);
const mockDeleteInstallationByOrg: Mock<(orgId: string) => Promise<boolean>> = mock(
  () => Promise.resolve(false),
);

mock.module("@atlas/api/lib/slack/store", () => ({
  getInstallation: mock(async () => null),
  getInstallationByOrg: mockGetInstallationByOrg,
  saveInstallation: mock(async () => {}),
  deleteInstallation: mock(async () => {}),
  deleteInstallationByOrg: mockDeleteInstallationByOrg,
  getBotToken: mock(async () => null),
  ENV_TEAM_ID: "env",
}));

mock.module("@atlas/api/lib/email/store", () => ({
  getEmailInstallationByOrg: mock(async () => null),
  saveEmailInstallation: mock(async () => {}),
  deleteEmailInstallationByOrg: mock(async () => false),
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
  getSettingAuto: mock(() => undefined),
  getSettingLive: mock(async () => undefined),
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

// --- Import the app AFTER mocks ---

const { admin } = await import("../routes/admin");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/admin", admin);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

// --- Tests ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
});

describe("admin integrations routes", () => {
  const savedSlackClientId = process.env.SLACK_CLIENT_ID;
  const savedSlackClientSecret = process.env.SLACK_CLIENT_SECRET;
  const savedSlackBotToken = process.env.SLACK_BOT_TOKEN;

  beforeEach(() => {
    mockHasInternalDB = true;
    mockGetInstallationByOrg.mockClear();
    mockDeleteInstallationByOrg.mockClear();
    mockInternalQuery.mockClear();
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_BOT_TOKEN;
  });

  afterAll(() => {
    if (savedSlackClientId !== undefined) process.env.SLACK_CLIENT_ID = savedSlackClientId;
    else delete process.env.SLACK_CLIENT_ID;
    if (savedSlackClientSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedSlackClientSecret;
    else delete process.env.SLACK_CLIENT_SECRET;
    if (savedSlackBotToken !== undefined) process.env.SLACK_BOT_TOKEN = savedSlackBotToken;
    else delete process.env.SLACK_BOT_TOKEN;
  });

  // ─── GET /integrations/status ────────────────────────────────────

  describe("GET /api/v1/admin/integrations/status", () => {
    it("returns disconnected status when no Slack installation", async () => {
      mockGetInstallationByOrg.mockResolvedValue(null);
      mockInternalQuery.mockResolvedValue([{ count: 0 }]);

      const res = await request("/api/v1/admin/integrations/status");
      expect(res.status).toBe(200);

      const data = await res.json() as {
        slack: { connected: boolean; oauthConfigured: boolean; envConfigured: boolean };
        webhooks: { activeCount: number };
        deliveryChannels: string[];
      };

      expect(data.slack.connected).toBe(false);
      expect(data.slack.oauthConfigured).toBe(false);
      expect(data.slack.envConfigured).toBe(false);
      expect(data.webhooks.activeCount).toBe(0);
      expect(data.deliveryChannels).toContain("email");
      expect(data.deliveryChannels).toContain("webhook");
      expect(data.deliveryChannels).not.toContain("slack");
    });

    it("returns connected status when Slack installation exists", async () => {
      mockGetInstallationByOrg.mockResolvedValue({
        team_id: "T123",
        bot_token: "xoxb-abc",
        org_id: "org-1",
        workspace_name: "My Team",
        installed_at: "2025-01-01T00:00:00Z",
      });
      mockInternalQuery.mockResolvedValue([{ count: 3 }]);

      const res = await request("/api/v1/admin/integrations/status");
      expect(res.status).toBe(200);

      const data = await res.json() as {
        slack: { connected: boolean; teamId: string; workspaceName: string; installedAt: string };
        webhooks: { activeCount: number };
        deliveryChannels: string[];
      };

      expect(data.slack.connected).toBe(true);
      expect(data.slack.teamId).toBe("T123");
      expect(data.slack.workspaceName).toBe("My Team");
      expect(data.slack.installedAt).toBe("2025-01-01T00:00:00Z");
      expect(data.webhooks.activeCount).toBe(3);
      expect(data.deliveryChannels).toContain("slack");
    });

    it("includes slack in deliveryChannels when envConfigured", async () => {
      mockGetInstallationByOrg.mockResolvedValue(null);
      mockInternalQuery.mockResolvedValue([{ count: 0 }]);
      process.env.SLACK_BOT_TOKEN = "xoxb-env-token";

      const res = await request("/api/v1/admin/integrations/status");
      expect(res.status).toBe(200);

      const data = await res.json() as { slack: { envConfigured: boolean }; deliveryChannels: string[] };
      expect(data.slack.envConfigured).toBe(true);
      expect(data.deliveryChannels).toContain("slack");
    });

    it("reports oauthConfigured when Slack OAuth env vars are set", async () => {
      mockGetInstallationByOrg.mockResolvedValue(null);
      mockInternalQuery.mockResolvedValue([{ count: 0 }]);
      process.env.SLACK_CLIENT_ID = "client-id";
      process.env.SLACK_CLIENT_SECRET = "client-secret";

      const res = await request("/api/v1/admin/integrations/status");
      expect(res.status).toBe(200);

      const data = await res.json() as { slack: { oauthConfigured: boolean } };
      expect(data.slack.oauthConfigured).toBe(true);
    });

    it("does not expose bot_token in response", async () => {
      mockGetInstallationByOrg.mockResolvedValue({
        team_id: "T123",
        bot_token: "xoxb-secret",
        org_id: "org-1",
        workspace_name: null,
        installed_at: "2025-01-01T00:00:00Z",
      });
      mockInternalQuery.mockResolvedValue([{ count: 0 }]);

      const res = await request("/api/v1/admin/integrations/status");
      const text = await res.text();
      expect(text).not.toContain("xoxb-secret");
    });
  });

  // ─── DELETE /integrations/slack ──────────────────────────────────

  describe("DELETE /api/v1/admin/integrations/slack", () => {
    it("returns 200 on successful disconnect", async () => {
      mockDeleteInstallationByOrg.mockResolvedValue(true);

      const res = await request("/api/v1/admin/integrations/slack", { method: "DELETE" });
      expect(res.status).toBe(200);

      const data = await res.json() as { message: string };
      expect(data.message).toContain("disconnected");
      expect(mockDeleteInstallationByOrg).toHaveBeenCalledWith("org-1");
    });

    it("returns 404 when no installation found", async () => {
      mockDeleteInstallationByOrg.mockResolvedValue(false);

      const res = await request("/api/v1/admin/integrations/slack", { method: "DELETE" });
      expect(res.status).toBe(404);

      const data = await res.json() as { error: string };
      expect(data.error).toBe("not_found");
    });
  });
});
