/**
 * Integration tests for /api/v1/admin/email-provider.
 *
 * Covers the new org-scoped BYOT route: GET (baseline + override shape per
 * provider), PUT (validation + ATLAS_SMTP_URL gate), DELETE, POST /test
 * (both fresh-creds and saved-creds branches + mismatched-body 400).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
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
// Re-export source lives in @atlas/api/lib/integrations/types; importing from
// there inside the mock factory creates a circular load. Hardcode to mirror
// the current tuple — tracked by #1543 (share via @useatlas/types after
// publish).
const EMAIL_PROVIDERS_MOCK = ["resend", "sendgrid", "postmark", "smtp", "ses"] as const;
import * as fs from "fs";
import * as path from "path";

// --- Temp semantic fixtures ---

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-email-route-${Date.now()}`);
fs.mkdirSync(path.join(tmpRoot, "entities"), { recursive: true });
fs.writeFileSync(
  path.join(tmpRoot, "entities", "stub.yml"),
  "table: stub\ndescription: stub\ndimensions:\n  id:\n    type: integer\n",
);
fs.writeFileSync(path.join(tmpRoot, "catalog.yml"), "name: Test\n");
process.env.ATLAS_SEMANTIC_ROOT = tmpRoot;

// --- Auth / env / misc mocks ---

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
  queryEffect: makeQueryEffectMock(mockInternalQuery),
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

// --- Email store mocks (the key ones for this route) ---

const mockSaveEmailInstallation: Mock<(...args: unknown[]) => Promise<void>> = mock(async () => {});
const mockGetEmailInstallationByOrg: Mock<(...args: unknown[]) => Promise<unknown>> = mock(
  async () => null,
);
const mockDeleteEmailInstallationByOrg: Mock<(...args: unknown[]) => Promise<boolean>> = mock(
  async () => true,
);

mock.module("@atlas/api/lib/email/store", () => ({
  EMAIL_PROVIDERS: EMAIL_PROVIDERS_MOCK,
  getEmailInstallationByOrg: mockGetEmailInstallationByOrg,
  saveEmailInstallation: mockSaveEmailInstallation,
  deleteEmailInstallationByOrg: mockDeleteEmailInstallationByOrg,
}));

// --- Email delivery mocks ---

interface DeliveryResult {
  success: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

const mockSendEmail: Mock<(...args: unknown[]) => Promise<DeliveryResult>> = mock(
  async () => ({ success: true, provider: "resend" } as DeliveryResult),
);
const mockSendEmailWithTransport: Mock<(...args: unknown[]) => Promise<DeliveryResult>> = mock(
  async () => ({ success: true, provider: "resend" } as DeliveryResult),
);

mock.module("@atlas/api/lib/email/delivery", () => ({
  sendEmail: mockSendEmail,
  sendEmailWithTransport: mockSendEmailWithTransport,
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
  persistAssistantSteps: mock(() => {}),
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
}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthServer: mock(() => ({ handler: mock(() => Promise.resolve(new Response("{}"))) })),
}));

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  ADMIN_ACTIONS: new Proxy({}, { get: () => new Proxy({}, { get: () => "noop" }) }),
  _resetAuditLog: () => {},
}));

mock.module("@atlas/api/lib/scheduler-store", () => ({
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

function jsonReq(path: string, method: string, body?: Record<string, unknown>) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.ATLAS_SEMANTIC_ROOT;
  delete process.env.ATLAS_SMTP_URL;
});

// Belt-and-braces env cleanup — beforeEach also deletes ATLAS_SMTP_URL but
// tests that set it mid-run (PUT "accepts smtp" etc.) shouldn't leak into
// any future test added between describes before beforeEach rebinds.
afterEach(() => {
  delete process.env.ATLAS_SMTP_URL;
});

describe("admin email-provider route", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    delete process.env.ATLAS_SMTP_URL;
    mockInternalQuery.mockClear();
    mockSaveEmailInstallation.mockReset();
    mockSaveEmailInstallation.mockImplementation(async () => {});
    mockGetEmailInstallationByOrg.mockReset();
    mockGetEmailInstallationByOrg.mockImplementation(async () => null);
    mockDeleteEmailInstallationByOrg.mockReset();
    mockDeleteEmailInstallationByOrg.mockImplementation(async () => true);
    mockSendEmail.mockReset();
    mockSendEmail.mockImplementation(async () => ({ success: true, provider: "resend" }));
    mockSendEmailWithTransport.mockReset();
    mockSendEmailWithTransport.mockImplementation(async () => ({ success: true, provider: "resend" }));
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
  });

  // ─── GET ────────────────────────────────────────────────────────

  describe("GET /email-provider", () => {
    it("returns baseline and null override when no installation exists", async () => {
      const res = await request("/api/v1/admin/email-provider");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { config: { baseline: { provider: string; fromAddress: string }; override: unknown } };
      expect(data.config.baseline.provider).toBe("resend");
      expect(data.config.baseline.fromAddress).toBe("Atlas <noreply@useatlas.dev>");
      expect(data.config.override).toBeNull();
    });

    it("returns 404 when internal DB is unavailable", async () => {
      mockHasInternalDB = false;
      const res = await request("/api/v1/admin/email-provider");
      expect(res.status).toBe(404);
    });

    it("returns 400 when the user has no active organization", async () => {
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
      const res = await request("/api/v1/admin/email-provider");
      expect(res.status).toBe(400);
    });

    it("returns sendgrid override with empty hints and API-key label", async () => {
      mockGetEmailInstallationByOrg.mockImplementation(async () => ({
        config_id: "cfg-sg",
        provider: "sendgrid",
        sender_address: "Acme <noreply@acme.com>",
        config: { provider: "sendgrid", apiKey: "SG.abcdefghijklmnop" },
        org_id: "org-1",
        installed_at: "2026-04-18T00:00:00Z",
      }));
      const res = await request("/api/v1/admin/email-provider");
      const data = (await res.json()) as {
        config: { override: { provider: string; secretLabel: string; hints: Record<string, string> } };
      };
      expect(data.config.override.provider).toBe("sendgrid");
      expect(data.config.override.secretLabel).toBe("API key");
      expect(data.config.override.hints).toEqual({});
    });

    it("returns postmark override with empty hints and Server-token label", async () => {
      mockGetEmailInstallationByOrg.mockImplementation(async () => ({
        config_id: "cfg-pm",
        provider: "postmark",
        sender_address: "Acme <noreply@acme.com>",
        config: { provider: "postmark", serverToken: "abcdefghijklmnopqrstuvwxyz" },
        org_id: "org-1",
        installed_at: "2026-04-18T00:00:00Z",
      }));
      const res = await request("/api/v1/admin/email-provider");
      const data = (await res.json()) as {
        config: { override: { provider: string; secretLabel: string; hints: Record<string, string> } };
      };
      expect(data.config.override.provider).toBe("postmark");
      expect(data.config.override.secretLabel).toBe("Server token");
      expect(data.config.override.hints).toEqual({});
    });

    it("returns resend override with masked apiKey", async () => {
      mockGetEmailInstallationByOrg.mockImplementation(async () => ({
        config_id: "cfg-1",
        provider: "resend",
        sender_address: "Acme <noreply@acme.com>",
        config: { provider: "resend", apiKey: "re_abcdefghijklmnop" },
        org_id: "org-1",
        installed_at: "2026-04-18T00:00:00Z",
      }));

      const res = await request("/api/v1/admin/email-provider");
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        config: { override: { provider: string; secretLabel: string; secretMasked: string; hints: Record<string, string> } };
      };
      expect(data.config.override.provider).toBe("resend");
      expect(data.config.override.secretLabel).toBe("API key");
      // Masked: first 4 + last 4 of "re_abcdefghijklmnop"
      expect(data.config.override.secretMasked).toBe("re_a••••mnop");
      expect(data.config.override.hints).toEqual({});
    });

    it("masks SMTP password and username in the response", async () => {
      const password = "super-long-password-123";
      const username = "user@company.com";
      mockGetEmailInstallationByOrg.mockImplementation(async () => ({
        config_id: "cfg-smtp",
        provider: "smtp",
        sender_address: "Acme <noreply@acme.com>",
        config: {
          provider: "smtp",
          host: "smtp.example.com",
          port: 587,
          username,
          password,
          tls: true,
        },
        org_id: "org-1",
        installed_at: "2026-04-18T00:00:00Z",
      }));

      const res = await request("/api/v1/admin/email-provider");
      const data = (await res.json()) as {
        config: { override: { secretLabel: string; secretMasked: string; hints: Record<string, string> } };
      };
      expect(data.config.override.secretLabel).toBe("Password");
      expect(data.config.override.secretMasked).not.toBe(password);
      expect(data.config.override.secretMasked).toContain("••••");
      // Host/Port/TLS are non-secret hints
      expect(data.config.override.hints.Host).toBe("smtp.example.com");
      expect(data.config.override.hints.Port).toBe("587");
      expect(data.config.override.hints.TLS).toBe("enabled");
      // Username is credential-adjacent and MUST be masked
      expect(data.config.override.hints.Username).not.toBe(username);
      expect(data.config.override.hints.Username).toContain("••••");
      // Raw values must never appear in the response body
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(password);
      expect(serialized).not.toContain(username);
    });

    it("masks SES secret + access-key-id in the response", async () => {
      const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const keyId = "AKIAIOSFODNN7EXAMPLE";
      mockGetEmailInstallationByOrg.mockImplementation(async () => ({
        config_id: "cfg-ses",
        provider: "ses",
        sender_address: "Acme <noreply@acme.com>",
        config: {
          provider: "ses",
          region: "us-east-1",
          accessKeyId: keyId,
          secretAccessKey: secret,
        },
        org_id: "org-1",
        installed_at: "2026-04-18T00:00:00Z",
      }));

      const res = await request("/api/v1/admin/email-provider");
      const data = (await res.json()) as {
        config: { override: { secretLabel: string; secretMasked: string; hints: Record<string, string> } };
      };
      expect(data.config.override.secretLabel).toBe("Secret access key");
      expect(data.config.override.secretMasked).toContain("••••");
      expect(data.config.override.hints.Region).toBe("us-east-1");
      expect(data.config.override.hints["Access key ID"]).toContain("••••");
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(keyId);
    });
  });

  // ─── PUT ────────────────────────────────────────────────────────

  describe("PUT /email-provider", () => {
    it("saves resend override and returns masked response", async () => {
      mockGetEmailInstallationByOrg
        .mockImplementationOnce(async () => null) // pre-save check
        .mockImplementationOnce(async () => ({
          config_id: "cfg-1",
          provider: "resend",
          sender_address: "Acme <noreply@acme.com>",
          config: { provider: "resend", apiKey: "re_abcdefghijklmnop" },
          org_id: "org-1",
          installed_at: "2026-04-18T00:00:00Z",
        }));

      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "resend",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "resend", apiKey: "re_abcdefghijklmnop" },
      });
      expect(res.status).toBe(200);
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
      expect(mockSaveEmailInstallation).toHaveBeenCalledWith("org-1", {
        provider: "resend",
        senderAddress: "Acme <noreply@acme.com>",
        config: { provider: "resend", apiKey: "re_abcdefghijklmnop" },
      });
    });

    it("returns 400 for smtp/ses when ATLAS_SMTP_URL is missing", async () => {
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "smtp",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "smtp", host: "smtp.example.com", port: 587, username: "u", password: "p", tls: true },
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("ATLAS_SMTP_URL");
      expect(mockSaveEmailInstallation).not.toHaveBeenCalled();
    });

    it("accepts smtp when ATLAS_SMTP_URL is set", async () => {
      process.env.ATLAS_SMTP_URL = "https://bridge.example.com";
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "smtp",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "smtp", host: "smtp.example.com", port: 587, username: "u", password: "p", tls: true },
      });
      expect(res.status).toBe(200);
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
    });

    it("returns 400 for ses when ATLAS_SMTP_URL is missing", async () => {
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "ses",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "ses", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret" },
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("SES");
      expect(data.message).toContain("ATLAS_SMTP_URL");
      expect(mockSaveEmailInstallation).not.toHaveBeenCalled();
    });

    it("accepts ses when ATLAS_SMTP_URL is set", async () => {
      process.env.ATLAS_SMTP_URL = "https://bridge.example.com";
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "ses",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "ses", region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret" },
      });
      expect(res.status).toBe(200);
      expect(mockSaveEmailInstallation).toHaveBeenCalledTimes(1);
    });

    it("returns 422 when config shape doesn't match any provider variant", async () => {
      // Post-#1542 `config` is a `z.discriminatedUnion("provider", [...])`
      // at the wire layer. A config missing `provider` (or with an unknown
      // value) fails the route Zod parse with 422 before the handler runs.
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "smtp",
        fromAddress: "Acme <noreply@acme.com>",
        config: { apiKey: "re_wrong_shape" },
      });
      expect(res.status).toBe(422);
      expect(mockSaveEmailInstallation).not.toHaveBeenCalled();
    });

    it("returns 400 when config.provider disagrees with sibling provider", async () => {
      // Both sides carry a valid tag but they disagree. The union wire
      // schema accepts the config (it's a valid ResendConfig), then
      // `validateProviderConfig("smtp", resendConfig)` fails because
      // SmtpConfigSchema's `provider` literal doesn't match — the handler
      // surfaces this as a structured 400.
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "smtp",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "resend", apiKey: "re_wrong_provider" },
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("smtp");
      expect(mockSaveEmailInstallation).not.toHaveBeenCalled();
    });
  });

  // ─── DELETE ─────────────────────────────────────────────────────

  describe("DELETE /email-provider", () => {
    it("removes the override and returns 200", async () => {
      const res = await request("/api/v1/admin/email-provider", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockDeleteEmailInstallationByOrg).toHaveBeenCalledWith("org-1");
    });

    it("returns 200 even when no override existed (idempotent)", async () => {
      mockDeleteEmailInstallationByOrg.mockImplementation(async () => false);
      const res = await request("/api/v1/admin/email-provider", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });

  // ─── POST /test ─────────────────────────────────────────────────

  describe("POST /email-provider/test", () => {
    it("uses sendEmailWithTransport when provider + config supplied", async () => {
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
        provider: "resend",
        fromAddress: "Acme <noreply@acme.com>",
        config: { provider: "resend", apiKey: "re_test_key" },
      });
      expect(res.status).toBe(200);
      expect(mockSendEmailWithTransport).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it("uses sendEmail when only recipientEmail supplied", async () => {
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
      });
      expect(res.status).toBe(200);
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmailWithTransport).not.toHaveBeenCalled();
    });

    it("returns 400 when provider is supplied without config", async () => {
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
        provider: "resend",
      });
      expect(res.status).toBe(400);
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockSendEmailWithTransport).not.toHaveBeenCalled();
    });

    it("returns 422 when config is supplied without a provider discriminator", async () => {
      // Without `provider` on the config payload, the route's
      // `z.discriminatedUnion` can't select a variant — wire-layer 422.
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
        config: { apiKey: "re_test_key" },
      });
      expect(res.status).toBe(422);
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockSendEmailWithTransport).not.toHaveBeenCalled();
    });

    it("returns 422 when fresh config shape is invalid for the declared provider", async () => {
      // `provider: "smtp"` + `config: { apiKey }` — the apiKey payload
      // matches no smtp variant; discriminator lookup fails → 422.
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
        provider: "smtp",
        fromAddress: "Acme <noreply@acme.com>",
        config: { apiKey: "re_wrong_shape" },
      });
      expect(res.status).toBe(422);
      expect(mockSendEmailWithTransport).not.toHaveBeenCalled();
    });

    it("returns 200 with success:false when delivery fails", async () => {
      mockSendEmail.mockImplementation(async () => ({
        success: false,
        provider: "resend",
        error: "auth failed",
      }));
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; message: string };
      expect(data.success).toBe(false);
      expect(data.message).toBe("auth failed");
    });
  });

  // ─── requireOrgContext coverage on write verbs ─────────────────
  // The middleware is reused across GET/PUT/DELETE/POST test. A regression
  // that re-ordered middleware so the org check only ran on GET would be
  // caught here rather than silently allowing cross-org writes.

  describe("requireOrgContext on write verbs", () => {
    it("PUT returns 400 without active org", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: null },
        }),
      );
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "resend",
        fromAddress: "x@example.com",
        config: { provider: "resend", apiKey: "re_abc" },
      });
      expect(res.status).toBe(400);
      expect(mockSaveEmailInstallation).not.toHaveBeenCalled();
    });

    it("PUT returns 404 without internal DB", async () => {
      mockHasInternalDB = false;
      const res = await jsonReq("/api/v1/admin/email-provider", "PUT", {
        provider: "resend",
        fromAddress: "x@example.com",
        config: { provider: "resend", apiKey: "re_abc" },
      });
      expect(res.status).toBe(404);
    });

    it("DELETE returns 400 without active org", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: null },
        }),
      );
      const res = await request("/api/v1/admin/email-provider", { method: "DELETE" });
      expect(res.status).toBe(400);
      expect(mockDeleteEmailInstallationByOrg).not.toHaveBeenCalled();
    });

    it("DELETE returns 404 without internal DB", async () => {
      mockHasInternalDB = false;
      const res = await request("/api/v1/admin/email-provider", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("POST /test returns 400 without active org", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: null },
        }),
      );
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
      });
      expect(res.status).toBe(400);
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockSendEmailWithTransport).not.toHaveBeenCalled();
    });

    it("POST /test returns 404 without internal DB", async () => {
      mockHasInternalDB = false;
      const res = await jsonReq("/api/v1/admin/email-provider/test", "POST", {
        recipientEmail: "you@example.com",
      });
      expect(res.status).toBe(404);
    });
  });
});
