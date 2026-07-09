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
import {
  makeQueryEffectMock,
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";
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
// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). Unconditional `=`
// is intentional: this test owns `tmpRoot`, so a parent-env value would
// break hermetic isolation (post-#2813 codex fix). The
// `packages/api/src/test-setup.ts` preload strips `ATLAS_*` per-file so
// cross-file leakage under `bun test --parallel` (#2797) stays bounded
// — for path-typed test-owned vars, the override behavior is required.
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

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

void mock.module("@atlas/api/lib/db/connection", () =>
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

void mock.module("@atlas/api/lib/semantic", () => ({
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

void mock.module("@atlas/api/lib/db/internal", () => ({
  InternalDB: MockInternalDB,
  makeInternalDBShimLayer: () =>
    makeMockInternalDBShimLayer(mockInternalQuery, { available: mockHasInternalDB }),
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mockInternalQuery,
  withWorkspaceAdminLock: (
    _orgId: string,
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>,
  ) => fn({ query: (sql: string, params?: unknown[]) => mockInternalQuery(sql, params) }),
  withWorkspaceAdminLocks: (
    _orgIds: readonly string[],
    fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>,
  ) => fn({ query: (sql: string, params?: unknown[]) => mockInternalQuery(sql, params) }),
  queryEffect: makeQueryEffectMock(mockInternalQuery),
  internalExecute: mock(() => {}),
  isInternalCircuitOpen: () => false,
  getInternalDB: mock(() => ({})),
  closeInternalDB: mock(async () => {}),
  migrateInternalDB: mock(async () => {}),
  loadSavedConnections: mock(async () => 0),
  _resetPool: mock(() => {}),
  _resetCircuitBreaker: mock(() => {}),
  encryptSecret: (url: string) => url,
  decryptSecret: (url: string) => url,
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
  getWorkspaceNamesByIds: mock(async () => new Map<string, string | null>()),
  updateWorkspaceStatus: mock(async () => true),
  updateWorkspacePlanTier: mock(async () => true),
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0, settings: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
  getWorkspaceRegion: mock(async () => null),
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
  findPatternBySQL: mock(async () => null),
  insertLearnedPattern: mock(() => {}),
  incrementPatternCount: mock(() => {}),
  getAutoApproveThreshold: mock(() => 999),
  getAutoApproveTypes: mock(() => new Set(["update_description", "add_dimension"])),
  updateWorkspaceByot: mock(async () => {}),
  setWorkspaceTrialEndsAt: mock(async () => {}),
}));

// --- Slack store mock ---

const mockGetInstallationByOrg: Mock<(orgId: string) => Promise<unknown>> = mock(
  () => Promise.resolve(null),
);
const mockDeleteInstallationByOrg: Mock<(orgId: string) => Promise<boolean>> = mock(
  () => Promise.resolve(false),
);

void mock.module("@atlas/api/lib/slack/store", () => ({
  getInstallation: mock(async () => null),
  getInstallationByOrg: mockGetInstallationByOrg,
  saveInstallation: mock(async () => {}),
  deleteInstallation: mock(async () => {}),
  deleteInstallationByOrg: mockDeleteInstallationByOrg,
  getBotToken: mock(async () => null),
  ENV_TEAM_ID: "env",
}));

void mock.module("@atlas/api/lib/email/store", () => ({
  EMAIL_PROVIDERS: ["resend", "sendgrid", "postmark", "smtp", "ses"],
  getEmailInstallationByOrg: mock(async () => null),
  saveEmailInstallation: mock(async () => {}),
  deleteEmailInstallationByOrg: mock(async () => false),
}));

// --- Other mocks needed by the admin router ---

void mock.module("@atlas/api/lib/cache", () => ({
  getCache: mock(() => ({ get: () => null, set: () => {}, delete: () => false, flush: () => {}, stats: () => ({}) })),
  cacheEnabled: mock(() => true),
  setCacheBackend: mock(() => {}),
  flushCache: mock(() => {}),
  getDefaultTtl: mock(() => 300000),
  _resetCache: mock(() => {}),
  buildCacheKey: mock(() => "mock-key"),
}));

void mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: mock(async () => ({ allowed: true })),
}));

void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  buildRetrievalQuery: () => "",
  getRetrievalTurns: () => 3,
  invalidatePatternCache: () => {},
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
}));

void mock.module("@atlas/api/lib/settings", () => ({
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
  isSaasModeForGuard: mock(() => false), // #3389 — admin settings write gates probe via this
}));

void mock.module("@atlas/api/lib/plugins/registry", () => ({
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

void mock.module("@atlas/api/lib/plugins/settings", () => ({
  loadPluginSettings: mock(async () => 0),
  savePluginEnabled: mock(async () => {}),
  savePluginConfig: mock(async () => {}),
  getPluginConfig: mock(async () => null),
  getAllPluginSettings: mock(async () => []),
}));

void mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: mock(async () => {}),
}));

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: () => {},
  invalidateOrgExploreBackends: () => {},
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
}));

void mock.module("@atlas/api/lib/tools/actions", () => ({}));

void mock.module("@atlas/api/lib/conversations", () => ({
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
  starConversation: mock(() => Promise.resolve(false)),
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
  resolveGroupForConnection: mock(() => Promise.resolve(null)),
  verifyGroupBelongsToOrg: mock(() => Promise.resolve("ok")),
  updateConversationRoutingMode: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestExcluded: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationRestFocus: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationGroupReach: mock(() => Promise.resolve({ ok: true as const })),
  updateConversationAnswerStyle: mock(() => Promise.resolve({ ok: true as const })),
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
}));

void mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => null,
  listAllUsers: mock(() => Promise.resolve([])),
  setUserRole: mock(async () => {}),
  setBanStatus: mock(async () => {}),
  setPasswordChangeRequired: mock(async () => {}),
  deleteUser: mock(async () => {}),
}));

void mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  listScheduledTasks: mock(async () => []),
  getScheduledTask: mock(async () => null),
  createScheduledTask: mock(async () => ({})),
  updateScheduledTask: mock(async () => null),
  deleteScheduledTask: mock(async () => false),
  listScheduledTaskRuns: mock(async () => []),
  getRecentRuns: mock(async () => []),
  scheduledTaskBelongsToUser: mock(async () => false),
}));

void mock.module("@atlas/api/lib/scheduler", () => ({
  getSchedulerEngine: mock(() => null),
}));

void mock.module("@atlas/api/lib/scheduler/preview", () => ({
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

    // #3161 — teams/telegram/gchat/whatsapp connection status is re-sourced
    // from `workspace_plugins` (their per-platform tables were dropped). A row
    // for catalog:<slug> means connected; routing-id config fields map through.
    it("reports static-bot platforms connected from workspace_plugins, mapping config fields", async () => {
      mockGetInstallationByOrg.mockResolvedValue(null);
      // sql-discriminating mock: the static-bot status query selects from
      // workspace_plugins with `catalog_id = ANY(...)`; everything else
      // (slack meta lookup, webhook count) gets the inert `[{ count: 0 }]`.
      mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
        if (sql.includes("catalog_id = ANY")) {
          return [
            { catalog_id: "catalog:teams", installed_at: "2026-06-01T00:00:00.000Z", config: { tenant_id: "t-abc", tenant_name: "Acme" } },
            { catalog_id: "catalog:whatsapp", installed_at: "2026-06-02T00:00:00.000Z", config: { phone_number_id: "1098765432109876", display_phone: "+1 555 0100" } },
          ];
        }
        return [{ count: 0 }];
      });

      const res = await request("/api/v1/admin/integrations/status");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        teams: { connected: boolean; tenantId: string | null; tenantName: string | null; installedAt: string | null };
        whatsapp: { connected: boolean; phoneNumberId: string | null; displayPhone: string | null };
        telegram: { connected: boolean; botId: string | null; botUsername: string | null };
        gchat: { connected: boolean; projectId: string | null; serviceAccountEmail: string | null };
      };

      // Present rows → connected, with config fields mapped through.
      expect(data.teams.connected).toBe(true);
      expect(data.teams.tenantId).toBe("t-abc");
      expect(data.teams.tenantName).toBe("Acme");
      expect(data.teams.installedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(data.whatsapp.connected).toBe(true);
      expect(data.whatsapp.phoneNumberId).toBe("1098765432109876");
      expect(data.whatsapp.displayPhone).toBe("+1 555 0100");

      // Absent rows → disconnected.
      expect(data.telegram.connected).toBe(false);
      expect(data.gchat.connected).toBe(false);

      // The credential-specific fields that lived in the dropped tables are
      // gone — operator-shared bots have no per-workspace bot id / project id /
      // SA email, so these stay null even when connected.
      expect(data.telegram.botId).toBeNull();
      expect(data.telegram.botUsername).toBeNull();
      expect(data.gchat.projectId).toBeNull();
      expect(data.gchat.serviceAccountEmail).toBeNull();
    });

    it("reports static-bot platforms disconnected when no workspace_plugins row exists", async () => {
      mockGetInstallationByOrg.mockResolvedValue(null);
      mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
        if (sql.includes("catalog_id = ANY")) return []; // none installed
        return [{ count: 0 }];
      });

      const res = await request("/api/v1/admin/integrations/status");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        teams: { connected: boolean };
        telegram: { connected: boolean };
        gchat: { connected: boolean };
        whatsapp: { connected: boolean };
      };
      expect(data.teams.connected).toBe(false);
      expect(data.telegram.connected).toBe(false);
      expect(data.gchat.connected).toBe(false);
      expect(data.whatsapp.connected).toBe(false);
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
