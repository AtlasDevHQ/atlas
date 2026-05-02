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
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

let mockWorkspaceRegion: string | null = null;

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
  },
  internal: {
    getWorkspaceRegion: mock(async () => mockWorkspaceRegion),
  },
});

// --- Test-specific overrides ---

let mockConfigOverride: Record<string, unknown> | null = null;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfigOverride,
  defineConfig: (c: unknown) => c,
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
  getSettingAuto: mock(() => undefined),
  getSettingLive: mock(async () => undefined),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
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
  mocks.cleanup();
});

describe("admin settings routes", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mockWorkspaceRegion = null;
    mockConfigOverride = null;
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
      mocks.hasInternalDB = false;
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);

      const data = (await res.json()) as { manageable: boolean };
      expect(data.manageable).toBe(false);
    });

    it("returns 403 for non-admin users", async () => {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.hasInternalDB = false;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(404);
    });

    // #1978 — when setSetting throws SaasImmutableSettingError (SaaS admin
    // attempts to hot-reload an immutable key), the route must map it to
    // 409 with `error: "saas_immutable"` and a requestId. Without this
    // integration test, removing the route's catch block would leave the
    // 500 path unobserved by tests.
    it("maps SaasImmutableSettingError to 409 with saas_immutable error code", async () => {
      const { SaasImmutableSettingError } = await import("@atlas/api/lib/settings-errors");
      mockSetSetting.mockImplementationOnce(() => {
        return Promise.reject(new SaasImmutableSettingError("ATLAS_EMAIL_PROVIDER"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(409);

      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("saas_immutable");
      expect(data.message).toContain("cannot be changed at runtime");
      // requestId is set by the auth middleware — its presence is the
      // contract for client-side log correlation.
      expect(typeof data.requestId === "string" || data.requestId === undefined).toBe(true);
    });

    it("propagates non-SaasImmutable setSetting errors as 500", async () => {
      mockSetSetting.mockImplementationOnce(() => {
        return Promise.reject(new Error("unrelated DB connection failure"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      // Generic errors must NOT be silently mapped to 409 — verify the
      // catch block's `throw err` re-raise path stays intact.
      expect(res.status).toBe(500);
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
      mocks.hasInternalDB = false;
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
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

  // ─── regionApiUrl in response ──────────────────────────────────

  describe("GET /api/v1/admin/settings regionApiUrl", () => {
    it("includes regionApiUrl when workspace has region with apiUrl", async () => {
      mockWorkspaceRegion = "eu-west";
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBe("https://api-eu.useatlas.dev");
    });

    it("omits regionApiUrl when workspace has no region", async () => {
      mockWorkspaceRegion = null;
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl when region has no apiUrl configured", async () => {
      mockWorkspaceRegion = "us-east";
      mockConfigOverride = {
        residency: {
          regions: {
            "us-east": { label: "US East", databaseUrl: "postgresql://us-east/atlas" },
          },
          defaultRegion: "us-east",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl when no residency config", async () => {
      // Default: mockConfigOverride = null → getConfig() returns null
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl for self-hosted admin (no org)", async () => {
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      // Default mock: no activeOrganizationId
      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("omits regionApiUrl when workspace region is not in config (region drift)", async () => {
      mockWorkspaceRegion = "ap-south"; // region assigned but decommissioned from config
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });

    it("returns 200 and omits regionApiUrl when getWorkspaceRegion throws", async () => {
      mockWorkspaceRegion = null;
      mockConfigOverride = {
        residency: {
          regions: {
            "eu-west": { label: "EU West", databaseUrl: "postgresql://eu-west/atlas", apiUrl: "https://api-eu.useatlas.dev" },
          },
          defaultRegion: "eu-west",
        },
      };

      // Override getWorkspaceRegion to throw (simulating a DB error)
      const { getWorkspaceRegion: gwrMock } = await import("@atlas/api/lib/db/internal");
      (gwrMock as ReturnType<typeof mock>).mockImplementationOnce(() => {
        throw new Error("connection refused");
      });

      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { regionApiUrl?: string };
      expect(data.regionApiUrl).toBeUndefined();
    });
  });
});
