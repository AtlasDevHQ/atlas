/**
 * Unified API test mock factory.
 *
 * 40+ test files independently mock the same ~30 modules before importing
 * the Hono app.  This factory centralises all default mocks so that module
 * API changes only need updating here and per-test customisation is done
 * via overrides.
 *
 * Usage:
 *   import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
 *
 *   const mocks = createApiTestMocks();          // sensible defaults
 *   const { app } = await import("../index");    // import app AFTER
 *
 *   // Override specific modules after the factory (later mock.module wins):
 *   mock.module("@atlas/api/lib/plugins/registry", () => ({ ... }));
 *
 * IMPORTANT: call at module level (top of file), NOT inside describe/beforeEach.
 * Bun's mock.module() must run before the mocked modules are first imported,
 * which happens when the app is imported at module scope.
 *
 * @module
 */

import { mock, type Mock } from "bun:test";
import { Effect } from "effect";
import {
  createConnectionMock,
  type ConnectionMockOverrides,
} from "./connection";
import * as fs from "fs";
import * as path from "path";

// ── Types ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally generic mock function type for test overrides
type AnyFn = (...args: any[]) => any;

/** Shape of the user object returned inside the authenticateRequest response. */
export interface AuthUser {
  id: string;
  mode: string;
  label: string;
  role: string;
  activeOrganizationId?: string;
}

export interface ApiTestMockOverrides {
  /** Auth user returned by authenticateRequest (default: simple-key admin). */
  authUser?: AuthUser;
  /** Auth mode returned by detectAuthMode (default: matches authUser.mode). */
  authMode?: string;
  /** Override connection mock (passed to createConnectionMock). */
  connection?: ConnectionMockOverrides;
  /** Override individual db/internal exports. */
  internal?: Record<string, unknown>;
  /** Override individual semantic exports. */
  semantic?: Record<string, unknown>;
  /** Override individual cache exports. Applies to both cache and cache/index. */
  cache?: Record<string, unknown>;
  /** Create a temp semantic dir with stub entity YAML (default: true). */
  semanticDir?: boolean;
}

export interface ApiTestMocks {
  /** The authenticateRequest mock — override per test via .mockImplementation(), .mockImplementationOnce(), or .mockResolvedValue(). */
  mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>>;
  /** The checkRateLimit mock. */
  mockCheckRateLimit: Mock<AnyFn>;
  /** The internalQuery mock — call .mockImplementation() per test. */
  mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>>;
  /** The internalExecute mock. */
  mockInternalExecute: Mock<AnyFn>;
  /**
   * Controls `hasInternalDB()` return value.
   * Note: if you override `hasInternalDB` via the `internal` option, the getter/setter
   * here will be disconnected from the mock module. Use this property instead.
   */
  hasInternalDB: boolean;
  /** Path to the temp semantic dir (undefined if semanticDir: false). */
  tmpRoot: string | undefined;

  // ── Role helpers ────────────────────────────────────────────────

  /** Set auth to a workspace admin with the given orgId. */
  setOrgAdmin(orgId: string): void;
  /** Set auth to a platform_admin with the given orgId (default: "org-test"). */
  setPlatformAdmin(orgId?: string): void;
  /** Set auth to a regular member with the given orgId. */
  setMember(orgId?: string): void;
  /** Cleanup temp semantic dir (call in afterAll). */
  cleanup(): void;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createApiTestMocks(
  overrides?: ApiTestMockOverrides,
): ApiTestMocks {
  const authUser: AuthUser = overrides?.authUser ?? {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  };
  const authMode = overrides?.authMode ?? authUser.mode;

  // ── Temp semantic directory ────────────────────────────────────

  const wantSemanticDir = overrides?.semanticDir !== false;
  let tmpRoot: string | undefined;
  if (wantSemanticDir) {
    tmpRoot = path.join(
      process.env.TMPDIR ?? "/tmp",
      `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "entities", "stub.yml"),
      "table: stub\ndescription: stub\ndimensions:\n  id:\n    type: integer\n",
    );
    fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: Test\n");
    process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;
  }

  // ── Auth middleware ────────────────────────────────────────────

  const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> =
    mock(() =>
      Promise.resolve({
        authenticated: true,
        mode: authUser.mode,
        user: { ...authUser },
      }),
    );

  const mockCheckRateLimit: Mock<AnyFn> = mock(() => ({ allowed: true }));

  mock.module("@atlas/api/lib/auth/middleware", () => ({
    authenticateRequest: mockAuthenticateRequest,
    checkRateLimit: mockCheckRateLimit,
    getClientIP: mock(() => null),
    resetRateLimits: mock(() => {}),
    rateLimitCleanupTick: mock(() => {}),
    _setValidatorOverrides: mock(() => {}),
  }));

  // ── Auth detect ───────────────────────────────────────────────

  mock.module("@atlas/api/lib/auth/detect", () => ({
    detectAuthMode: () => authMode,
    resetAuthModeCache: () => {},
  }));

  // ── Auth types ────────────────────────────────────────────────

  mock.module("@atlas/api/lib/auth/types", () => ({
    AUTH_MODES: ["none", "simple-key", "byot", "managed"],
    ATLAS_ROLES: ["member", "admin", "owner"],
    createAtlasUser: (
      id: string,
      mode: string,
      label: string,
      opts?: Record<string, unknown>,
    ) => Object.freeze({ id, mode, label, ...opts }),
  }));

  // ── Auth server ───────────────────────────────────────────────

  mock.module("@atlas/api/lib/auth/server", () => ({
    getAuthInstance: () => null,
    listAllUsers: mock(() => Promise.resolve([])),
    setUserRole: mock(async () => {}),
    setBanStatus: mock(async () => {}),
    setPasswordChangeRequired: mock(async () => {}),
    deleteUser: mock(async () => {}),
  }));

  // ── Startup ───────────────────────────────────────────────────

  mock.module("@atlas/api/lib/startup", () => ({
    validateEnvironment: mock(() => Promise.resolve([])),
    getStartupWarnings: mock(() => []),
  }));

  // ── DB connection ─────────────────────────────────────────────

  mock.module("@atlas/api/lib/db/connection", () =>
    createConnectionMock({
      connections: {
        get: () => null,
        getDefault: () => null,
        describe: () => [{ id: "default", dbType: "postgres" }],
        healthCheck: mock(() =>
          Promise.resolve({ status: "healthy", latencyMs: 1, checkedAt: new Date() }),
        ),
        register: mock(() => {}),
        unregister: mock(() => {}),
        has: mock(() => false),
        getForOrg: () => null,
      },
      resolveDatasourceUrl: () => "postgresql://stub",
      ...overrides?.connection,
    }),
  );

  // ── DB internal ───────────────────────────────────────────────

  let _hasInternalDB = true;

  const mockInternalQuery: Mock<
    (sql: string, params?: unknown[]) => Promise<unknown[]>
  > = mock(() => Promise.resolve([]));

  const mockInternalExecute: Mock<AnyFn> = mock(() => {});

  const internalDefaults: Record<string, unknown> = {
    hasInternalDB: () => _hasInternalDB,
    internalQuery: mockInternalQuery,
    internalExecute: mockInternalExecute,
    getInternalDB: mock(() => ({})),
    closeInternalDB: mock(async () => {}),
    migrateInternalDB: mock(async () => {}),
    loadSavedConnections: mock(async () => 0),
    _resetPool: mock(() => {}),
    _resetCircuitBreaker: mock(() => {}),
    encryptUrl: (url: string) => url,
    decryptUrl: (url: string) => url,
    getEncryptionKey: () => null,
    isPlaintextUrl: (value: string) =>
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
    _resetEncryptionKeyCache: mock(() => {}),
    findPatternBySQL: async () => null,
    insertLearnedPattern: () => {},
    incrementPatternCount: () => {},
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
    cascadeWorkspaceDelete: mock(async () => ({
      conversations: 0,
      semanticEntities: 0,
      learnedPatterns: 0,
      suggestions: 0,
      scheduledTasks: 0,
      settings: 0,
    })),
    getWorkspaceHealthSummary: mock(async () => null),
    getWorkspaceRegion: mock(async () => null),
    setWorkspaceRegion: mock(async () => ({ assigned: true })),
    updateWorkspaceByot: mock(async () => true),
    setWorkspaceStripeCustomerId: mock(async () => true),
    setWorkspaceTrialEndsAt: mock(async () => true),
    insertSemanticAmendment: mock(async () => "mock-amendment-id"),
    getPendingAmendmentCount: mock(async () => 0),
  };

  mock.module("@atlas/api/lib/db/internal", () => ({
    ...internalDefaults,
    ...overrides?.internal,
  }));

  // ── Semantic ──────────────────────────────────────────────────

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
    ...overrides?.semantic,
  }));

  mock.module("@atlas/api/lib/semantic/entities", () => ({
    listEntities: mock(() => Promise.resolve([])),
    getEntity: mock(() => Promise.resolve(null)),
    upsertEntity: mock(() => Promise.resolve()),
    deleteEntity: mock(() => Promise.resolve(false)),
    countEntities: mock(() => Promise.resolve(0)),
    bulkUpsertEntities: mock(() => Promise.resolve(0)),
  }));

  mock.module("@atlas/api/lib/semantic/diff", () => ({
    runDiff: mock(async () => ({
      connection: "default",
      newTables: [],
      removedTables: [],
      tableDiffs: [],
    })),
  }));

  // ── Cache ─────────────────────────────────────────────────────

  const cacheMock = () => ({
    getCache: mock(() => ({
      get: () => null,
      set: () => {},
      delete: () => false,
      flush: () => {},
      stats: () => ({}),
    })),
    cacheEnabled: mock(() => true),
    setCacheBackend: mock(() => {}),
    flushCache: mock(() => {}),
    getDefaultTtl: mock(() => 300000),
    _resetCache: mock(() => {}),
    buildCacheKey: mock(() => "mock-key"),
    ...overrides?.cache,
  });

  // Both paths needed: route handlers use dynamic import("@atlas/api/lib/cache/index")
  mock.module("@atlas/api/lib/cache", cacheMock);
  mock.module("@atlas/api/lib/cache/index", cacheMock);

  // ── Workspace ─────────────────────────────────────────────────

  mock.module("@atlas/api/lib/workspace", () => ({
    checkWorkspaceStatus: mock(async () => ({ allowed: true })),
  }));

  // ── Pattern cache ─────────────────────────────────────────────

  mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
    buildLearnedPatternsSection: async () => "",
    getRelevantPatterns: async () => [],
    invalidatePatternCache: () => {},
    extractKeywords: () => new Set(),
    _resetPatternCache: () => {},
  }));

  // ── Plugins ───────────────────────────────────────────────────

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

  mock.module("@atlas/api/lib/plugins/hooks", () => ({
    dispatchHook: mock(async () => {}),
  }));

  mock.module("@atlas/api/lib/plugins/settings", () => ({
    loadPluginSettings: mock(async () => 0),
    savePluginEnabled: mock(async () => {}),
    savePluginConfig: mock(async () => {}),
    getPluginConfig: mock(async () => null),
    getAllPluginSettings: mock(async () => []),
  }));

  // ── Tools ─────────────────────────────────────────────────────

  mock.module("@atlas/api/lib/tools/explore", () => ({
    getExploreBackendType: () => "just-bash",
    getActiveSandboxPluginId: () => null,
    explore: { type: "function" },
  }));

  mock.module("@atlas/api/lib/tools/actions", () => ({}));

  // ── Agent ─────────────────────────────────────────────────────

  mock.module("@atlas/api/lib/agent", () => ({
    runAgent: mock(() =>
      Promise.resolve({
        toUIMessageStreamResponse: () =>
          new Response("stream", { status: 200 }),
        text: Promise.resolve("answer"),
      }),
    ),
  }));

  // ── Conversations ─────────────────────────────────────────────

  mock.module("@atlas/api/lib/conversations", () => ({
    createConversation: mock(() => Promise.resolve(null)),
    addMessage: mock(() => {}),
    getConversation: mock(() => Promise.resolve(null)),
    generateTitle: mock((q: string) => q.slice(0, 80)),
    listConversations: mock(() =>
      Promise.resolve({ conversations: [], total: 0 }),
    ),
    deleteConversation: mock(() => Promise.resolve(false)),
    starConversation: mock(() => Promise.resolve(false)),
    shareConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    unshareConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    getShareStatus: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    cleanupExpiredShares: mock(() => Promise.resolve(0)),
    getSharedConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
    updateNotebookState: mock(() => Promise.resolve({ ok: true })),
    forkConversation: mock(() =>
      Promise.resolve({ ok: false, reason: "not_found" }),
    ),
  }));

  // ── Security ──────────────────────────────────────────────────

  mock.module("@atlas/api/lib/security", () => ({
    maskConnectionUrl: (url: string) => url.replace(/\/\/.*@/, "//***@"),
    SENSITIVE_PATTERNS: [],
  }));

  // ── Residency ─────────────────────────────────────────────────

  mock.module("@atlas/api/lib/residency/misrouting", () => ({
    detectMisrouting: mock(async () => null),
    isStrictRoutingEnabled: mock(() => false),
    getMisroutedCount: mock(() => 0),
    _resetMisroutedCount: mock(() => {}),
    _resetRegionCache: mock(() => {}),
    getApiRegion: mock(() => null),
  }));

  mock.module("@atlas/api/lib/residency/readonly", () => ({
    isWorkspaceMigrating: mock(async () => false),
  }));

  // ── Settings ──────────────────────────────────────────────────

  mock.module("@atlas/api/lib/settings", () => ({
    getSettingsForAdmin: mock(() => []),
    getSettingsRegistry: mock(() => []),
    getSettingDefinition: mock(() => undefined),
    setSetting: mock(async () => {}),
    deleteSetting: mock(async () => {}),
    getSetting: mock(() => undefined),
    getSettingAuto: mock(() => undefined),
    getSettingLive: mock(async () => undefined),
    loadSettings: mock(async () => 0),
    getAllSettingOverrides: mock(async () => []),
    _resetSettingsCache: mock(() => {}),
  }));

  // ── Config ────────────────────────────────────────────────────

  mock.module("@atlas/api/lib/config", () => ({
    getConfig: () => null,
    defineConfig: (c: unknown) => c,
  }));

  // ── Scheduled tasks / Scheduler ───────────────────────────────

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

  // ── EE: IP allowlist (queries internal DB, which doesn't exist in tests) ──

  mock.module("@atlas/ee/auth/ip-allowlist", () => ({
    checkIPAllowlist: mock(() => Effect.succeed({ allowed: true })),
    listIPAllowlistEntries: mock(async () => []),
    addIPAllowlistEntry: mock(async () => ({})),
    removeIPAllowlistEntry: mock(async () => false),
    IPAllowlistError: class extends Error {
      public readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "IPAllowlistError";
        this.code = code;
      }
    },
    invalidateCache: mock(() => {}),
    _clearCache: mock(() => {}),
    parseCIDR: mock(() => null),
    isIPInRange: mock(() => false),
    isIPAllowed: mock(() => true),
  }));

  // ── Security: abuse ───────────────────────────────────────────

  mock.module("@atlas/api/lib/security/abuse", () => ({
    listFlaggedWorkspaces: mock(() => []),
    reinstateWorkspace: mock(() => true),
    getAbuseEvents: mock(async () => []),
    getAbuseConfig: mock(() => ({
      queryRateLimit: 200,
      queryRateWindowSeconds: 300,
      errorRateThreshold: 0.5,
      uniqueTablesLimit: 50,
      throttleDelayMs: 2000,
    })),
    checkAbuseStatus: mock(() => ({ level: "none" })),
    recordQueryEvent: mock(() => {}),
    restoreAbuseState: mock(async () => {}),
    _resetAbuseState: mock(() => {}),
    abuseCleanupTick: mock(() => {}),
    ABUSE_CLEANUP_INTERVAL_MS: 300_000,
  }));

  // ── Role helper functions ─────────────────────────────────────

  function setOrgAdmin(orgId: string): void {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "admin@test.com",
          role: "admin",
          activeOrganizationId: orgId,
        },
      }),
    );
  }

  function setPlatformAdmin(orgId = "org-test"): void {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "platform-admin-1",
          mode: "managed",
          label: "platform@test.com",
          role: "platform_admin",
          activeOrganizationId: orgId,
        },
      }),
    );
  }

  function setMember(orgId = "org-1"): void {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: authMode,
        user: {
          id: "user-1",
          mode: authMode,
          label: "user@test.com",
          role: "member",
          activeOrganizationId: orgId,
        },
      }),
    );
  }

  function cleanup(): void {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      delete process.env.ATLAS_SEMANTIC_ROOT;
    }
  }

  return {
    mockAuthenticateRequest,
    mockCheckRateLimit,
    mockInternalQuery,
    mockInternalExecute,
    get hasInternalDB() {
      return _hasInternalDB;
    },
    set hasInternalDB(v: boolean) {
      _hasInternalDB = v;
    },
    tmpRoot,
    setOrgAdmin,
    setPlatformAdmin,
    setMember,
    cleanup,
  };
}
