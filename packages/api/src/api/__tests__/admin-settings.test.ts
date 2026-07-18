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

void mock.module("@atlas/api/lib/config", () => ({
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
  // #3376 — split-axis key: hidden from the generic settings page but
  // writable on SaaS because the dedicated /admin/sandbox page saves it
  // through PUT /admin/settings/{key}. Mirrors the real registry entry.
  {
    key: "ATLAS_SANDBOX_BACKEND",
    section: "Sandbox",
    label: "Sandbox Backend",
    description: "Sandbox backend",
    type: "string",
    envVar: "ATLAS_SANDBOX_BACKEND",
    scope: "workspace",
    saasVisible: false,
    saasWritable: true,
  },
  // #4669 — the Agent Auth master switch: workspace-scoped, but its
  // PLATFORM (global) tier is the operator surface on/off switch. Used
  // to pin the explicit tier=platform write path.
  {
    key: "ATLAS_AGENT_AUTH_ENABLED",
    section: "MCP",
    label: "Enable Agent Auth Protocol",
    description: "Agent Auth master switch",
    type: "boolean",
    default: "false",
    envVar: "ATLAS_AGENT_AUTH_ENABLED",
    scope: "workspace",
  },
  // #3376 — hidden key with no explicit saasWritable: effective
  // writability inherits saasVisible=false, so SaaS workspace admins
  // can neither see nor write it.
  {
    key: "ATLAS_DEMO_INDUSTRY",
    section: "Demo",
    label: "Demo Industry",
    description: "Demo industry",
    type: "string",
    envVar: "ATLAS_DEMO_INDUSTRY",
    scope: "workspace",
    saasVisible: false,
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

// #3389 — the route write gates consult the shared fail-closed probe from
// lib/settings instead of reading getConfig() directly. The default mock
// mirrors the resolved-config happy path (saas ⇒ true, anything else ⇒
// false); fail-closed-on-config-resolution-failure semantics of the REAL
// probe are covered in lib/__tests__/settings-saas.test.ts. Tests that
// simulate a config-resolution failure override this to return true.
const saasGuardDefaultImpl = () =>
  (mockConfigOverride as { deployMode?: string } | null)?.deployMode === "saas";
const mockIsSaasModeForGuard = mock(saasGuardDefaultImpl);

void mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: mockGetSettingsForAdmin,
  getSettingsRegistry: mockGetSettingsRegistry,
  getSettingDefinition: mockGetSettingDefinition,
  setSetting: mockSetSetting,
  deleteSetting: mockDeleteSetting,
  loadSettings: mock(async () => 0),
  getSetting: mock(() => undefined),
  getSettingAuto: mock(() => undefined),
  getSettingOverride: mock(() => undefined),
  getSettingLive: mock(async () => undefined),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
  isSaasModeForGuard: mockIsSaasModeForGuard,
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
    mockIsSaasModeForGuard.mockClear();
    mockIsSaasModeForGuard.mockImplementation(saasGuardDefaultImpl);
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
      // catch block's `throw err` re-raise path stays intact, and that
      // the 500 envelope carries a requestId for log correlation.
      expect(res.status).toBe(500);
      const data = (await res.json()) as { requestId?: string };
      expect(typeof data.requestId).toBe("string");
      expect(data.requestId).not.toBe("");
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

    // #3389 — deleteSetting now enforces SAAS_IMMUTABLE_KEYS like
    // setSetting (clearing an override is a write). The route must map
    // the error to the SAME 409 envelope the PUT handler produces, so
    // the admin UI handles both verbs uniformly.
    it("maps SaasImmutableSettingError to 409 with saas_immutable error code (#3389)", async () => {
      const { SaasImmutableSettingError } = await import("@atlas/api/lib/settings-errors");
      mockDeleteSetting.mockImplementationOnce(() => {
        return Promise.reject(new SaasImmutableSettingError("ATLAS_EMAIL_PROVIDER"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(409);

      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("saas_immutable");
      expect(data.message).toContain("cannot be changed at runtime");
      // Same requestId contract as the PUT 409 path.
      expect(typeof data.requestId === "string" || data.requestId === undefined).toBe(true);
    });

    it("propagates non-SaasImmutable deleteSetting errors as 500", async () => {
      mockDeleteSetting.mockImplementationOnce(() => {
        return Promise.reject(new Error("unrelated DB connection failure"));
      });

      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      // Generic errors must NOT be silently mapped to 409 — verify the
      // catch block's `throw err` re-raise path stays intact, and that
      // the 500 envelope carries a requestId for log correlation.
      expect(res.status).toBe(500);
      const data = (await res.json()) as { requestId?: string };
      expect(typeof data.requestId).toBe("string");
      expect(data.requestId).not.toBe("");
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

    // #3395 — GET's showAll classification matches the write gates: on
    // SaaS, only platform admins see platform-scoped settings. A no-org
    // non-platform-admin session is a workspace admin (same as #3389's
    // write classification), so showAll must be false. The mode probe
    // stays GET's display-only permissive `getConfig()?.deployMode` read.
    it("SaaS no-org non-platform-admin GET → showAll is false (#3395)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, false);
    });

    it("self-hosted no-org admin GET keeps showAll (#3395)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default mock: no activeOrganizationId, role=admin

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledWith(undefined, true);
    });

    it("SaaS no-org platform admin GET keeps showAll (#3395)", async () => {
      mockGetSettingsForAdmin.mockClear();
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin" },
        }),
      );

      const res = await request("/api/v1/admin/settings");
      expect(res.status).toBe(200);
      expect(mockGetSettingsForAdmin).toHaveBeenCalledTimes(1);
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

  // ─── SaaS write gate (#3376) ────────────────────────────────────

  describe("saasWritable enforcement (#3376)", () => {
    // Mock a SaaS workspace admin (org-scoped, role=admin, not platform_admin)
    function asSaasWorkspaceAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    function asSaasPlatformAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    beforeEach(() => {
      // Runs after the outer beforeEach (which resets to null), so every
      // test in this block starts in SaaS mode unless it overrides.
      mockConfigOverride = { deployMode: "saas" };
    });

    it("SaaS workspace admin PUT on a hidden key (saasWritable inherits saasVisible=false) → 403", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "healthcare" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("managed by Atlas in SaaS mode");
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("SaaS workspace admin DELETE on a hidden key → 403", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("forbidden");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    // Pins the /admin/sandbox save path: the sandbox page writes
    // ATLAS_SANDBOX_BACKEND through this route on SaaS (#3375/#3376).
    // If the split flag regresses to plain saasVisible enforcement,
    // this test fails before the sandbox page breaks in prod.
    it("SaaS workspace admin PUT on ATLAS_SANDBOX_BACKEND (saasVisible:false, saasWritable:true) succeeds", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "vercel-sandbox" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_SANDBOX_BACKEND", "vercel-sandbox", "ws-admin-1", "org-1");
    });

    it("SaaS workspace admin DELETE on ATLAS_SANDBOX_BACKEND succeeds", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_SANDBOX_BACKEND", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_SANDBOX_BACKEND", "ws-admin-1", "org-1");
    });

    it("SaaS platform admin PUT on a hidden key succeeds (flag never restricts platform admins)", async () => {
      asSaasPlatformAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "ecommerce" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("self-hosted workspace admin PUT on a hidden key is unaffected", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "cybersecurity" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("self-hosted workspace admin DELETE on a hidden key is unaffected", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
    });

    // #3389 — "unloaded" (getConfig() → null: config legitimately never
    // loaded, the AGPL/dev case) stays permissive. Only config-resolution
    // FAILURE fails closed — see the "fail-closed mode probe" block below.
    it("unloaded config (getConfig() → null) is treated as self-hosted — write allowed", async () => {
      mockConfigOverride = null;
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "saas" }),
      });
      expect(res.status).toBe(200);
    });

    it("SaaS workspace admin PUT on a visible workspace key still succeeds", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it("secret check still fires under SaaS (unchanged by the write gate)", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ANTHROPIC_API_KEY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "sk-new" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("Secret settings");
    });

    it("platform-scope check still fires under SaaS (unchanged by the write gate)", async () => {
      asSaasWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("platform-level setting");
    });
  });

  // ─── Fail-closed mode probe (#3389) ─────────────────────────────

  describe("fail-closed mode probe on the write path (#3389)", () => {
    // Simulate config resolution FAILING at request time: the real
    // isSaasModeForGuard() returns true ("errored" → assume SaaS) — that
    // behavior is pinned in lib/__tests__/settings-saas.test.ts. Here we
    // verify the route gates consume the probe's fail-closed verdict
    // (restrictive) instead of the old permissive getConfig() → null read.
    function simulateConfigResolutionFailure() {
      mockConfigOverride = null; // getConfig() would yield nothing useful
      mockIsSaasModeForGuard.mockImplementation(() => true);
    }

    function asWorkspaceAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    it("saasWritable gate is restrictive on PUT when the probe fails closed", async () => {
      simulateConfigResolutionFailure();
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "healthcare" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("saasWritable gate is restrictive on DELETE when the probe fails closed", async () => {
      simulateConfigResolutionFailure();
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("platform-scope gate (no-org session) is restrictive when the probe fails closed", async () => {
      simulateConfigResolutionFailure();
      // Default auth mock: role=admin, NO activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("platform admins are not affected by the fail-closed probe", async () => {
      simulateConfigResolutionFailure();
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
    });
  });

  // ─── No-org SaaS session edge (#3389) ───────────────────────────

  describe("no-org SaaS session is classified like GET (#3389)", () => {
    // GET filters with `!isPlatformAdmin` only — a SaaS session with no
    // activeOrganizationId is a workspace admin there. The write path
    // must classify it the same way instead of letting `orgId &&
    // !isPlatformAdmin` wave the session past the platform-scope gate.
    function asSaasNoOrgAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );
    }

    beforeEach(() => {
      mockConfigOverride = { deployMode: "saas" };
    });

    it("no-org SaaS admin PUT on a platform-scoped key → 403", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("platform-level setting");
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("no-org SaaS admin DELETE on a platform-scoped key → 403", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_RLS_ENABLED", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { message: string };
      expect(data.message).toContain("platform-level setting");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("no-org SaaS admin PUT on a hidden workspace key → 403 (saasWritable gate already org-independent)", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_DEMO_INDUSTRY", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "healthcare" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("self-hosted no-org admin keeps platform-scope write access", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });
  });

  // ─── No-org SaaS session × workspace-scoped keys (#3395) ────────

  describe("no-org SaaS session cannot reach the global row of a workspace-scoped key (#3395)", () => {
    // Workspace-scope sibling of the #3389 platform-scope alignment: with
    // no org context, a workspace-scoped write lands on the global
    // (org_id IS NULL) row — the tier-2 default resolution applies to
    // EVERY workspace. The route must 403 on SaaS; self-hosted no-org
    // keeps the global-override path (legitimate self-hosted admin write).
    function asSaasNoOrgAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );
    }

    function asSaasNoOrgPlatformAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin" },
        }),
      );
    }

    beforeEach(() => {
      mockConfigOverride = { deployMode: "saas" };
    });

    it("SaaS no-org admin PUT on a workspace-scoped key → 403 (same envelope as the platform-scope gate)", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("workspace-scoped");
      expect(typeof data.requestId === "string" || data.requestId === undefined).toBe(true);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("SaaS no-org admin DELETE on a workspace-scoped key → 403", async () => {
      asSaasNoOrgAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("workspace-scoped");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("self-hosted no-org admin PUT on a workspace-scoped key still succeeds (global override path)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // No orgId → the write targets the global (org_id IS NULL) row
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "admin-1", undefined);
    });

    it("self-hosted no-org admin DELETE on a workspace-scoped key still succeeds (global override path)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "admin-1", undefined);
    });

    it("SaaS no-org platform admin PUT on a workspace-scoped key succeeds (gate never restricts platform admins)", async () => {
      asSaasNoOrgPlatformAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "platform-admin-1", undefined);
    });

    it("SaaS org-scoped workspace admin PUT on a workspace-scoped key is unaffected (org row, not global)", async () => {
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
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_ROW_LIMIT", "500", "ws-admin-1", "org-1");
    });

    it("workspace-scope no-org gate is restrictive when the probe fails closed", async () => {
      // Same fail-closed contract as the #3389 gates: config-resolution
      // failure at request time ⇒ isSaasModeForGuard() → true ⇒ restrictive.
      mockConfigOverride = null;
      mockIsSaasModeForGuard.mockImplementation(() => true);
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("unloaded config (getConfig() → null) is treated as self-hosted — no-org workspace write allowed", async () => {
      mockConfigOverride = null;
      const res = await request("/api/v1/admin/settings/ATLAS_ROW_LIMIT", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "500" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Explicit platform-tier writes (#4669) ──────────────────────

  describe("explicit platform-tier writes (#4669)", () => {
    // The platform console writes the GLOBAL (org_id IS NULL) row of a
    // workspace-scoped key via ?tier=platform — explicit in the request,
    // never inferred from the session org, so a platform admin with an
    // active workspace still reaches the global row.
    function asPlatformAdminWithOrg() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "platform-admin-1", mode: "better-auth", label: "Platform Admin", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    function asWorkspaceAdmin() {
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "ws-admin-1", mode: "better-auth", label: "WS Admin", role: "admin", activeOrganizationId: "org-1" },
        }),
      );
    }

    it("platform admin WITH an active org: PUT ?tier=platform writes the global row (orgId NOT forwarded)", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      // The whole point of #4669: activeOrganizationId is org-1, but the
      // explicit tier targets the global row → orgId undefined.
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "true", "platform-admin-1", undefined);
    });

    it("platform admin WITH an active org: DELETE ?tier=platform clears the global row", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
      expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "platform-admin-1", undefined);
    });

    it("workspace admin PUT ?tier=platform → 403, write never reached", async () => {
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string; requestId?: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("platform_admin");
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("workspace admin DELETE ?tier=platform → 403, delete never reached", async () => {
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string; message: string };
      expect(data.error).toBe("forbidden");
      expect(data.message).toContain("platform_admin");
      expect(mockDeleteSetting).not.toHaveBeenCalled();
    });

    it("SaaS no-org non-platform-admin PUT ?tier=platform → 403", async () => {
      mockConfigOverride = { deployMode: "saas" };
      mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
        Promise.resolve({
          authenticated: true,
          mode: "better-auth",
          user: { id: "no-org-admin-1", mode: "better-auth", label: "No-Org Admin", role: "admin" },
        }),
      );
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("self-hosted no-org admin PUT ?tier=platform keeps the global-override path (#3395 parity)", async () => {
      mockConfigOverride = { deployMode: "self-hosted" };
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "true", "admin-1", undefined);
    });

    it("tier gate is restrictive when the mode probe fails closed", async () => {
      mockConfigOverride = null;
      mockIsSaasModeForGuard.mockImplementation(() => true);
      // Default auth mock: role=admin, no activeOrganizationId
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(403);
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it("without ?tier, a workspace admin's PUT still lands on the WORKSPACE row (/admin/settings unchanged)", async () => {
      asWorkspaceAdmin();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "false" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_AGENT_AUTH_ENABLED", "false", "ws-admin-1", "org-1");
    });

    it("?tier=platform on a platform-scoped key is accepted (already global) for platform admins", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_PROVIDER?tier=platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "openai" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetSetting).toHaveBeenCalledWith("ATLAS_PROVIDER", "openai", "platform-admin-1", undefined);
    });

    it("unknown tier value is schema-rejected (422), no inference", async () => {
      asPlatformAdminWithOrg();
      const res = await request("/api/v1/admin/settings/ATLAS_AGENT_AUTH_ENABLED?tier=workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      // zod-openapi's default validation hook → 422 Unprocessable Entity.
      expect(res.status).toBe(422);
      expect(mockSetSetting).not.toHaveBeenCalled();
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
