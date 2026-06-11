/**
 * Tests for BYOT (Bring Your Own Token) admin integration routes.
 *
 * Tests: POST /integrations/slack/byot, POST /integrations/discord/byot,
 *        POST /integrations/linear, DELETE /integrations/linear,
 *        DELETE /integrations/whatsapp, POST /integrations/email.
 *
 * The legacy Telegram / Teams-BYOT / Google Chat / WhatsApp *connect*
 * routes were removed in #2994 (chat-cap bypass + non-functional installs
 * pending ADR-0007 wiring); their disabled state is locked by the
 * "disabled chat install routes" suite below. Disconnect routes remain.
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-byot-test-${Date.now()}`);
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

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
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
  setWorkspaceStripeCustomerId: mock(async () => {}),
  setWorkspaceTrialEndsAt: mock(async () => {}),
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

// teams/telegram/whatsapp stores were deleted with their tables in #3161 — the
// admin router no longer imports them, so they're no longer mocked here.

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

const mockSaveLinearInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(
  async () => {},
);
const mockDeleteLinearInstallationByOrg: Mock<(...args: unknown[]) => Promise<boolean>> = mock(
  async () => true,
);

mock.module("@atlas/api/lib/linear/store", () => ({
  getLinearInstallation: mock(async () => null),
  getLinearInstallationByOrg: mock(async () => null),
  saveLinearInstallation: mockSaveLinearInstallation,
  deleteLinearInstallation: mock(async () => {}),
  deleteLinearInstallationByOrg: mockDeleteLinearInstallationByOrg,
}));

const mockSaveEmailInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(
  async () => {},
);
const mockGetEmailInstallationByOrg: Mock<(...args: unknown[]) => Promise<unknown>> = mock(
  async () => null,
);
const mockDeleteEmailInstallationByOrg: Mock<(...args: unknown[]) => Promise<boolean>> = mock(
  async () => true,
);

mock.module("@atlas/api/lib/email/store", () => ({
  EMAIL_PROVIDERS: ["resend", "sendgrid", "postmark", "smtp", "ses"],
  getEmailInstallationByOrg: mockGetEmailInstallationByOrg,
  saveEmailInstallation: mockSaveEmailInstallation,
  deleteEmailInstallationByOrg: mockDeleteEmailInstallationByOrg,
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
  isSaasModeForGuard: mock(() => false), // #3389 — admin settings write gates probe via this
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
  resolveRoutingMode: mock((m: "auto" | "pin" | "all" | null | undefined = null) => m ?? "pin"),
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
    mockSaveDiscordInstallation.mockReset();
    mockSaveDiscordInstallation.mockImplementation(async () => {});
    mockSaveLinearInstallation.mockReset();
    mockSaveLinearInstallation.mockImplementation(async () => {});
    mockDeleteLinearInstallationByOrg.mockReset();
    mockDeleteLinearInstallationByOrg.mockImplementation(async () => true);
    mockSaveEmailInstallation.mockReset();
    mockSaveEmailInstallation.mockImplementation(async () => {});
    mockGetEmailInstallationByOrg.mockReset();
    mockGetEmailInstallationByOrg.mockImplementation(async () => null);
    mockDeleteEmailInstallationByOrg.mockReset();
    mockDeleteEmailInstallationByOrg.mockImplementation(async () => true);
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
  // Disabled legacy chat install routes (#2994)
  //
  // Telegram / Teams-BYOT / Google Chat / WhatsApp installed via legacy
  // credential-store-only routes that wrote no `workspace_plugins` row,
  // so they bypassed the per-tier chat-integration cap (#2953) — and they
  // never produced a runtime-routable install either (the chat runtime
  // routes purely off `workspace_plugins.config`). The connect routes are
  // removed pending the unified ADR-0007 install wiring; the install path
  // must stay closed so the cap has no bypass. Disconnect routes remain so
  // existing tenants can clean up. A re-added POST handler fails here.
  // ═══════════════════════════════════════════════════════════════════

  describe("disabled chat install routes (#2994)", () => {
    it.each([
      "/api/v1/admin/integrations/telegram",
      "/api/v1/admin/integrations/teams/byot",
      "/api/v1/admin/integrations/gchat",
      "/api/v1/admin/integrations/whatsapp",
    ])("POST %s is removed (404 — no install bypass)", async (path) => {
      const res = await jsonPost(path, {
        botToken: "x",
        appId: "x",
        appPassword: "x",
        credentialsJson: "x",
        phoneNumberId: "1",
        accessToken: "x",
      });
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

  // ═══════════════════════════════════════════════════════════════════
  // POST /linear
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/linear", () => {
    it("returns 401 without auth", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid or expired token",
          status: 401,
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
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
      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 with missing apiKey", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/linear", {});
      expect(res.status).toBe(422);
    });

    it("returns 400 when Linear API returns HTTP error", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ errors: [{ message: "Authentication required" }] }),
            { status: 401 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_invalid",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("returns 400 when Linear API returns GraphQL errors", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ errors: [{ message: "Invalid API key" }] }),
            { status: 200 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_invalid",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("returns 400 when fetch throws (network error)", async () => {
      mockFetchImpl.mockImplementation(() => {
        throw new Error("ECONNREFUSED");
      });

      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("invalid_token");
    });

    it("saves installation on success", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { viewer: { id: "user-123", name: "Test User", email: "test@example.com" } },
            }),
            { status: 200 },
          ),
        ),
      );

      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { message: string; userName: string; userEmail: string };
      expect(data.message).toContain("connected");
      expect(data.userName).toBe("Test User");
      expect(data.userEmail).toBe("test@example.com");
      expect(mockSaveLinearInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveLinearInstallation).toHaveBeenCalledWith("user-123", {
        orgId: "org-1",
        userName: "Test User",
        userEmail: "test@example.com",
        apiKey: "lin_api_test",
      });
    });

    it("returns 409 when store save throws (org hijack)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { viewer: { id: "user-123", name: "Test User", email: "test@example.com" } },
            }),
            { status: 200 },
          ),
        ),
      );
      mockSaveLinearInstallation.mockImplementation(() => {
        throw new Error("Linear user user-123 is already bound to a different organization.");
      });

      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      });
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("conflict");
    });

    it("returns 500 when store save throws (non-hijack DB error)", async () => {
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { viewer: { id: "user-123", name: "Test User", email: "test@example.com" } },
            }),
            { status: 200 },
          ),
        ),
      );
      mockSaveLinearInstallation.mockImplementation(() => {
        throw new Error("connection terminated unexpectedly");
      });

      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      });
      expect(res.status).toBe(500);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await jsonPost("/api/v1/admin/integrations/linear", {
        apiKey: "lin_api_test",
      });
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE /linear
  // ═══════════════════════════════════════════════════════════════════

  describe("DELETE /integrations/linear", () => {
    it("returns 200 on successful disconnect", async () => {
      const res = await request("/api/v1/admin/integrations/linear", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("disconnected");
    });

    it("returns 404 when no installation found", async () => {
      mockDeleteLinearInstallationByOrg.mockImplementation(async () => false);

      const res = await request("/api/v1/admin/integrations/linear", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Legacy static-bot disconnect routes removed (#3161)
  // ═══════════════════════════════════════════════════════════════════
  //
  // teams/telegram/gchat/whatsapp now disconnect through the unified
  // `DELETE /api/v1/integrations/:slug` (#3154 GAP 1); their per-platform
  // legacy endpoints and backing `*_installations` tables were dropped. A
  // re-added handler fails here. Discord keeps its legacy `DELETE /discord`
  // (BYOT `discord_installations`), so it is NOT in this list.
  describe("removed legacy disconnect routes (#3161)", () => {
    it.each([
      "/api/v1/admin/integrations/teams",
      "/api/v1/admin/integrations/telegram",
      "/api/v1/admin/integrations/gchat",
      "/api/v1/admin/integrations/whatsapp",
    ])("DELETE %s is removed (404 — unified disconnect only)", async (path) => {
      const res = await request(path, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /email (connect)
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/email", () => {
    it("returns 401 without auth", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid or expired token",
          status: 401,
        }),
      );
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "sendgrid",
        senderAddress: "noreply@example.com",
        config: { provider: "sendgrid", apiKey: "SG.test" },
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
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "sendgrid",
        senderAddress: "noreply@example.com",
        config: { provider: "sendgrid", apiKey: "SG.test" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 with missing fields", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/email", {});
      expect(res.status).toBe(422);
    });

    it("saves SendGrid config on success", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "sendgrid",
        senderAddress: "noreply@example.com",
        config: { provider: "sendgrid", apiKey: "SG.test-key" },
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { message: string; provider: string; senderAddress: string };
      expect(data.message).toContain("connected");
      expect(data.provider).toBe("sendgrid");
      expect(data.senderAddress).toBe("noreply@example.com");
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveEmailInstallation).toHaveBeenCalledWith("org-1", {
        provider: "sendgrid",
        senderAddress: "noreply@example.com",
        config: { provider: "sendgrid", apiKey: "SG.test-key" },
      });
    });

    it("saves Postmark config on success", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "postmark",
        senderAddress: "noreply@example.com",
        config: { provider: "postmark", serverToken: "pm-test-token" },
      });
      expect(res.status).toBe(200);
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveEmailInstallation).toHaveBeenCalledWith("org-1", {
        provider: "postmark",
        senderAddress: "noreply@example.com",
        config: { provider: "postmark", serverToken: "pm-test-token" },
      });
    });

    it("saves SMTP config on success", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "smtp",
        senderAddress: "noreply@example.com",
        config: { provider: "smtp", host: "smtp.example.com", port: 587, username: "user", password: "pass", tls: true },
      });
      expect(res.status).toBe(200);
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveEmailInstallation).toHaveBeenCalledWith("org-1", {
        provider: "smtp",
        senderAddress: "noreply@example.com",
        config: { provider: "smtp", host: "smtp.example.com", port: 587, username: "user", password: "pass", tls: true },
      });
    });

    it("saves SES config on success", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "ses",
        senderAddress: "noreply@example.com",
        config: { provider: "ses", region: "us-east-1", accessKeyId: "AKIA...", secretAccessKey: "secret" },
      });
      expect(res.status).toBe(200);
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveEmailInstallation).toHaveBeenCalledWith("org-1", {
        provider: "ses",
        senderAddress: "noreply@example.com",
        config: { provider: "ses", region: "us-east-1", accessKeyId: "AKIA...", secretAccessKey: "secret" },
      });
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await jsonPost("/api/v1/admin/integrations/email", {
        provider: "sendgrid",
        senderAddress: "noreply@example.com",
        config: { provider: "sendgrid", apiKey: "SG.test" },
      });
      // requireOrgContext middleware returns 404 when no internal DB
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /email/test
  // ═══════════════════════════════════════════════════════════════════

  describe("POST /integrations/email/test", () => {
    it("returns 400 when no email config exists", async () => {
      mockGetEmailInstallationByOrg.mockImplementation(async () => null);

      const res = await jsonPost("/api/v1/admin/integrations/email/test", {
        recipientEmail: "test@example.com",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("not_found");
    });

    it("returns 200 with success when SendGrid config exists", async () => {
      mockGetEmailInstallationByOrg.mockImplementation(async () => ({
        config_id: "test-id",
        provider: "sendgrid",
        sender_address: "noreply@example.com",
        config: { provider: "sendgrid", apiKey: "SG.test" },
        org_id: "org-1",
        installed_at: new Date().toISOString(),
      }));

      // Mock SendGrid API success
      mockFetchImpl.mockImplementation(() =>
        Promise.resolve(new Response("", { status: 202 })),
      );

      const res = await jsonPost("/api/v1/admin/integrations/email/test", {
        recipientEmail: "test@example.com",
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it("returns 422 with missing recipientEmail", async () => {
      const res = await jsonPost("/api/v1/admin/integrations/email/test", {});
      expect(res.status).toBe(422);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE /email
  // ═══════════════════════════════════════════════════════════════════

  describe("DELETE /integrations/email", () => {
    it("returns 200 on successful disconnect", async () => {
      const res = await request("/api/v1/admin/integrations/email", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("disconnected");
    });

    it("returns 404 when no installation found", async () => {
      mockDeleteEmailInstallationByOrg.mockImplementation(async () => false);

      const res = await request("/api/v1/admin/integrations/email", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
