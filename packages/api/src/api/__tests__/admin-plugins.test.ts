/**
 * Tests for admin plugin management API routes.
 *
 * Tests: enable/disable, config schema, config update endpoints.
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
import * as fs from "fs";
import * as path from "path";

// --- Temp semantic fixtures ---

const tmpRoot = path.join(process.env.TMPDIR ?? "/tmp", `atlas-plugin-mgmt-test-${Date.now()}`);
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

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({ query: async () => ({ columns: [], rows: [] }), close: async () => {} }),
  connections: {
    get: () => null,
    getDefault: () => null,
    getDBType: () => "postgres",
    getTargetHost: () => "localhost",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
    describe: () => [{ id: "default", dbType: "postgres" }],
    healthCheck: mock(() => Promise.resolve({ status: "healthy" })),
    register: mock(() => {}),
  },
  detectDBType: () => "postgres",
  extractTargetHost: () => "localhost",
  resolveDatasourceUrl: () => "postgresql://stub",
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
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
}));

const mockPluginGetConfigSchema = mock(() => [
  { key: "apiKey", type: "string", label: "API Key", required: true, secret: true },
  { key: "region", type: "select", label: "Region", options: ["us-east", "eu-west"] },
  { key: "debug", type: "boolean", label: "Debug Mode" },
]);

let mockPluginEnabled = true;

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [
      { id: "test-plugin", types: ["context"], version: "1.0.0", name: "Test Plugin", status: "healthy", enabled: mockPluginEnabled },
    ],
    get: (id: string) => {
      if (id === "test-plugin") {
        return {
          id: "test-plugin",
          types: ["context"],
          version: "1.0.0",
          name: "Test Plugin",
          config: { apiKey: "sk-secret-123", region: "us-east", debug: false },
          getConfigSchema: mockPluginGetConfigSchema,
          healthCheck: mock(() => Promise.resolve({ healthy: true })),
        };
      }
      if (id === "no-schema-plugin") {
        return {
          id: "no-schema-plugin",
          types: ["action"],
          version: "0.1.0",
          name: "No Schema Plugin",
          config: { foo: "bar" },
        };
      }
      return undefined;
    },
    getStatus: (id: string) => {
      if (id === "test-plugin") return "healthy";
      if (id === "no-schema-plugin") return "registered";
      return undefined;
    },
    enable: (id: string) => {
      if (id === "test-plugin") { mockPluginEnabled = true; return true; }
      return false;
    },
    disable: (id: string) => {
      if (id === "test-plugin") { mockPluginEnabled = false; return true; }
      return false;
    },
    isEnabled: (id: string) => {
      if (id === "test-plugin") return mockPluginEnabled;
      return false;
    },
    getAllHealthy: () => [],
    getByType: () => [],
    size: 1,
  },
  PluginRegistry: class {},
}));

const mockSavePluginEnabled: Mock<(id: string, enabled: boolean) => Promise<void>> = mock(
  () => Promise.resolve(),
);
const mockSavePluginConfig: Mock<(id: string, config: Record<string, unknown>) => Promise<void>> = mock(
  () => Promise.resolve(),
);
const mockGetPluginConfig: Mock<(id: string) => Promise<Record<string, unknown> | null>> = mock(
  () => Promise.resolve(null),
);

mock.module("@atlas/api/lib/plugins/settings", () => ({
  loadPluginSettings: mock(async () => 0),
  savePluginEnabled: mockSavePluginEnabled,
  savePluginConfig: mockSavePluginConfig,
  getPluginConfig: mockGetPluginConfig,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

// --- Cleanup ---

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
    }),
  );
  mockHasInternalDB = true;
  mockPluginEnabled = true;
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockSavePluginEnabled.mockImplementation(() => Promise.resolve());
  mockSavePluginConfig.mockImplementation(() => Promise.resolve());
  mockGetPluginConfig.mockImplementation(() => Promise.resolve(null));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/plugins", () => {
  it("includes enabled field and manageable flag", async () => {
    const res = await request("/api/v1/admin/plugins");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.plugins).toBeArray();
    expect(body.plugins[0]).toHaveProperty("enabled");
    expect(body).toHaveProperty("manageable", true);
  });

  it("returns manageable=false without internal DB", async () => {
    mockHasInternalDB = false;
    const res = await request("/api/v1/admin/plugins");
    const body = await json(res);
    expect(body.manageable).toBe(false);
  });
});

describe("POST /api/v1/admin/plugins/:id/enable", () => {
  it("enables a plugin and persists state", async () => {
    mockPluginEnabled = false;
    const res = await request("/api/v1/admin/plugins/test-plugin/enable", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(true);
    expect(body.id).toBe("test-plugin");
    expect(body.persisted).toBe(true);
    expect(body.warning).toBeUndefined();
    // Verify persistence was called
    expect(mockSavePluginEnabled).toHaveBeenCalledWith("test-plugin", true);
  });

  it("returns 404 for unknown plugin", async () => {
    const res = await request("/api/v1/admin/plugins/nonexistent/enable", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("requires admin auth", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "user-1", mode: "simple-key", label: "User", role: "analyst" },
      }),
    );
    const res = await request("/api/v1/admin/plugins/test-plugin/enable", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/admin/plugins/:id/disable", () => {
  it("disables a plugin and persists state", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/disable", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(false);
    expect(body.id).toBe("test-plugin");
    expect(body.persisted).toBe(true);
    // Verify persistence was called
    expect(mockSavePluginEnabled).toHaveBeenCalledWith("test-plugin", false);
  });

  it("returns 404 for unknown plugin", async () => {
    const res = await request("/api/v1/admin/plugins/nonexistent/disable", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/admin/plugins/:id/schema", () => {
  it("returns schema and masked values", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/schema");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.schema).toBeArray();
    expect(body.schema.length).toBe(3);
    expect(body.hasSchema).toBe(true);
    expect(body.manageable).toBe(true);
    // Secret field should be masked with fixed placeholder (no prefix leak)
    expect(body.values.apiKey).toBe("••••••••");
    // Non-secret fields should be visible
    expect(body.values.region).toBe("us-east");
    expect(body.values.debug).toBe(false);
  });

  it("returns empty schema for plugins without getConfigSchema", async () => {
    const res = await request("/api/v1/admin/plugins/no-schema-plugin/schema");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.schema).toEqual([]);
    expect(body.hasSchema).toBe(false);
    expect(body.values).toEqual({ foo: "bar" });
  });

  it("returns 404 for unknown plugin", async () => {
    const res = await request("/api/v1/admin/plugins/nonexistent/schema");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/v1/admin/plugins/:id/config", () => {
  it("saves valid config and calls savePluginConfig", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "new-key", region: "eu-west", debug: true }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.message).toContain("saved");
    // Verify persistence was called with the right plugin id
    expect(mockSavePluginConfig).toHaveBeenCalledTimes(1);
    expect(mockSavePluginConfig.mock.calls[0][0]).toBe("test-plugin");
  });

  it("rejects missing required fields", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "us-east" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe("validation_error");
    expect(body.details).toBeArray();
  });

  it("rejects invalid select values", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key", region: "invalid-region" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects wrong types", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: 12345 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 without internal DB", async () => {
    mockHasInternalDB = false;
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for unknown plugin", async () => {
    const res = await request("/api/v1/admin/plugins/nonexistent/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("rejects non-JSON body", async () => {
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("strips extra keys not in schema", async () => {
    mockSavePluginConfig.mockClear();
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "key", region: "us-east", extraField: "malicious" }),
    });
    expect(res.status).toBe(200);
    // Verify the saved config does not include extraField
    const savedConfig = mockSavePluginConfig.mock.calls[0][1] as Record<string, unknown>;
    expect(savedConfig).not.toHaveProperty("extraField");
    expect(savedConfig).toHaveProperty("apiKey", "key");
  });

  it("restores masked secret values from originals", async () => {
    mockSavePluginConfig.mockClear();
    const res = await request("/api/v1/admin/plugins/test-plugin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "••••••••", region: "eu-west" }),
    });
    expect(res.status).toBe(200);
    // The masked value should be replaced with the original secret from plugin config
    const savedConfig = mockSavePluginConfig.mock.calls[0][1] as Record<string, unknown>;
    expect(savedConfig.apiKey).toBe("sk-secret-123");
  });
});

describe("POST /api/v1/admin/plugins/:id/enable — persistence warnings", () => {
  it("returns warning when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    const res = await request("/api/v1/admin/plugins/test-plugin/enable", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(true);
    expect(body.persisted).toBe(false);
    expect(body.warning).toBeString();
  });

  it("returns warning when persistence fails", async () => {
    mockSavePluginEnabled.mockImplementation(() => Promise.reject(new Error("DB error")));
    const res = await request("/api/v1/admin/plugins/test-plugin/enable", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(true);
    expect(body.persisted).toBe(false);
    expect(body.warning).toContain("could not be persisted");
  });
});
