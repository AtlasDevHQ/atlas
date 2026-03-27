/**
 * Tests for admin settings API routes.
 *
 * Tests: GET /settings, PUT /settings/:key, DELETE /settings/:key.
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

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-settings-test-${Date.now()}`);
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
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
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

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: mock(() => Promise.resolve([])),
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
  cascadeWorkspaceDelete: mock(async () => ({ conversations: 0, semanticEntities: 0, learnedPatterns: 0, suggestions: 0, scheduledTasks: 0 })),
  getWorkspaceHealthSummary: mock(async () => null),
}));

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

// Settings registry data used by mocks
const settingsRegistryData = [
  {
    key: "ATLAS_ROW_LIMIT",
    section: "Query Limits",
    label: "Row Limit",
    description: "Max rows",
    type: "number",
    default: "1000",
    envVar: "ATLAS_ROW_LIMIT",
    scope: "workspace",
  },
  {
    key: "ATLAS_PROVIDER",
    section: "Agent",
    label: "LLM Provider",
    description: "Provider",
    type: "select",
    options: ["anthropic", "openai", "bedrock", "ollama", "openai-compatible", "gateway"],
    default: "anthropic",
    envVar: "ATLAS_PROVIDER",
    scope: "platform",
  },
  {
    key: "ATLAS_RLS_ENABLED",
    section: "Security",
    label: "RLS",
    description: "Enable RLS",
    type: "boolean",
    envVar: "ATLAS_RLS_ENABLED",
    scope: "platform",
  },
  {
    key: "ANTHROPIC_API_KEY",
    section: "Secrets",
    label: "Anthropic API Key",
    description: "API key",
    type: "string",
    secret: true,
    envVar: "ANTHROPIC_API_KEY",
    scope: "platform",
  },
];

// Settings mock — we need to intercept the actual settings functions
const mockGetSettingsForAdmin = mock(() => [
  {
    ...settingsRegistryData[0],
    currentValue: "1000",
    source: "default",
  },
  {
    ...settingsRegistryData[3],
    currentValue: "sk-a••••here",
    source: "env",
  },
]);

const mockSetSetting: Mock<(key: string, value: string, userId?: string, orgId?: string) => Promise<void>> = mock(
  () => Promise.resolve(),
);

const mockDeleteSetting: Mock<(key: string, userId?: string, orgId?: string) => Promise<void>> = mock(
  () => Promise.resolve(),
);

const mockGetSettingsRegistry = mock(() => settingsRegistryData);

const settingsMap = new Map(settingsRegistryData.map((s) => [s.key, s]));
const mockGetSettingDefinition = mock((key: string) => settingsMap.get(key));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: mockGetSettingsForAdmin,
  getSettingsRegistry: mockGetSettingsRegistry,
  getSettingDefinition: mockGetSettingDefinition,
  setSetting: mockSetSetting,
  deleteSetting: mockDeleteSetting,
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

describe("admin settings routes", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockSetSetting.mockClear();
    mockDeleteSetting.mockClear();
  });

  // ─── GET /settings ──────────────────────────────────────────────

  describe("GET /api/v1/admin/settings", () => {
    it("returns settings with values and manageable flag", async () => {
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);

      const data = (await res.json()) as { manageable: boolean; settings: unknown[] };
      expect(data.manageable).toBe(true);
      expect(Array.isArray(data.settings)).toBe(true);
      expect(data.settings.length).toBeGreaterThan(0);
    });

    it("returns manageable=false when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);

      const data = (await res.json()) as { manageable: boolean };
      expect(data.manageable).toBe(false);
    });

    it("returns 403 for non-admin users", async () => {
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(403);
    });
  });

  // ─── PUT /settings/:key ─────────────────────────────────────────

  describe("PUT /api/v1/admin/settings/:key", () => {
    it("saves a valid setting override", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { success: boolean; key: string; value: string };
      expect(data.success).toBe(true);
      expect(data.key).toBe("ATLAS_ROW_LIMIT");
      expect(data.value).toBe("500");
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("rejects unknown setting keys", async () => {
      const res = await request("/api/v1/admin/settings/NONEXISTENT_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "foo" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects secret settings", async () => {
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new-key" }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects missing value", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("validates number type", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "not-a-number" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty string for number type", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects negative numbers", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "-5" }),
      });
      expect(res.status).toBe(400);
    });

    it("validates select type options", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "invalid-provider" }),
      });
      expect(res.status).toBe(400);
    });

    it("validates boolean type", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid boolean", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /settings/:key ──────────────────────────────────────

  describe("DELETE /api/v1/admin/settings/:key", () => {
    it("deletes an override", async () => {
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { success: boolean };
      expect(data.success).toBe(true);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
    });

    it("rejects unknown keys", async () => {
      const res = await request("/api/v1/admin/settings/NONEXISTENT_KEY", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
    });

    it("rejects secret settings", async () => {
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── GET scope filtering ────────────────────────────────────────

  describe("GET /api/v1/admin/settings scope filtering", () => {
    it("workspace admin GET → getSettingsForAdmin called with (orgId, false)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      // Workspace admin with orgId → isPlatformAdmin=false, !orgId=false → second arg is false
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith("org-1", false);
    });

    it("platform admin GET → getSettingsForAdmin called with (orgId, true)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      // Platform admin → isPlatformAdmin=true → second arg is true
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith("org-1", true);
    });

    it("self-hosted admin GET → getSettingsForAdmin called with (undefined, true)", async () => {
      mockGetSettingsForAdmin.mockClear();
      // Default mock: no activeOrganizationId, role=admin → self-hosted

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      // No orgId → !orgId=true → second arg is true
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, true);
    });
  });

  // ─── Org-scoped settings ────────────────────────────────────────

  describe("org-scoped settings enforcement", () => {
    it("workspace admin cannot update platform-scoped settings", async () => {
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.message).toContain("platform-level setting");
    });

    it("workspace admin cannot delete platform-scoped settings", async () => {
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.message).toContain("platform-level setting");
    });

    it("workspace admin can update workspace-scoped settings with orgId passthrough", async () => {
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // Verify orgId is forwarded for workspace-scoped settings
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "ws-admin-1", "org-1");
    });

    it("workspace admin can delete workspace-scoped settings with orgId passthrough", async () => {
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      // Verify orgId is forwarded for workspace-scoped settings
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "ws-admin-1", "org-1");
    });

    it("platform admin can update platform-scoped settings — orgId NOT forwarded", async () => {
      mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // Platform-scoped: orgId should NOT be forwarded
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_PROVIDER", "openai", "platform-admin-1", undefined);
    });

    it("self-hosted admin (no org) can update platform-scoped settings", async () => {
      // Default mock has no activeOrganizationId — simulates self-hosted
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // Self-hosted: no orgId
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_PROVIDER", "openai", "admin-1", undefined);
    });
  });
});
