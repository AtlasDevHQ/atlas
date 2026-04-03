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
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "platform_admin",
  },
});

// --- Test-specific plugin mocks (override factory defaults) ---

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

// --- Import the app AFTER mocks ---

const { admin } = await import("../routes/admin");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/admin", admin);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper for JSON response bodies
async function json(res: Response): Promise<any> {
  return res.json();
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "platform_admin" },
    }),
  );
  mocks.hasInternalDB = true;
  mockPluginEnabled = true;
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
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
    mocks.hasInternalDB = false;
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
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
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
    mocks.hasInternalDB = false;
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
    mocks.hasInternalDB = false;
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
