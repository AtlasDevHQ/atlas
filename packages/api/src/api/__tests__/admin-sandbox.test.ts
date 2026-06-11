/**
 * Tests for admin sandbox routes — backend-id vocabulary (#3375, #3371).
 *
 * GET /status must speak one vocabulary: `ATLAS_SANDBOX_BACKEND` stores
 * backend ids ("e2b-sandbox"), but legacy workspaces may hold bare provider
 * keys ("e2b") written before the fix. Both spellings must resolve
 * identically, and `connectedProviders[].isActive` must never contradict
 * `activeBackend`.
 *
 * Tests the adminSandbox sub-router directly (not through the parent admin
 * router) to avoid mocking every sibling sub-router dependency.
 */

import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
import { SANDBOX_PROVIDER_KEYS, SANDBOX_PROVIDER_BACKEND_IDS } from "@useatlas/schemas";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
});

// --- Settings mock (overrides the factory's) ---

const mockSettings = new Map<string, string>();
const mockDeleteSetting: Mock<(key: string, userId?: string, orgId?: string) => Promise<void>> =
  mock(async () => {});

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingAuto: (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingLive: async (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingsForAdmin: mock(() => []),
  getSettingsRegistry: mock(() => []),
  getSettingDefinition: mock(() => undefined),
  setSetting: mock(async () => {}),
  deleteSetting: mockDeleteSetting,
  loadSettings: mock(async () => 0),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
}));

// --- Explore mock — platform default is the SaaS pin ---

const mockInvalidateOrgExploreBackends: Mock<(orgId: string) => void> = mock(() => {});

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "vercel-sandbox",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  invalidateOrgExploreBackends: mockInvalidateOrgExploreBackends,
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
  _formatSandboxPriorityFailureForTest: mock(() => ""),
}));

// --- BYOC runtime — real pure helpers, deterministic availability ---
// `missingCredentialFields` / `sandboxProviderForBackendId` are pure and used
// as-is; runtime availability is environment-dependent (module resolution),
// so tests pin it. Defaults mirror the SaaS image: only vercel installed.

const realSandboxRuntime = await import("@atlas/api/lib/sandbox/runtime");

let mockRuntimeAvailability: Record<string, boolean> = {
  vercel: true,
  e2b: false,
  daytona: false,
  railway: false,
};

mock.module("@atlas/api/lib/sandbox/runtime", () => ({
  ...realSandboxRuntime,
  isProviderRuntimeAvailable: async (provider: string) =>
    mockRuntimeAvailability[provider] ?? false,
  getProviderRuntimeAvailability: async () => ({ ...mockRuntimeAvailability }),
  tryCreateByocBackend: mock(async () => null),
}));

// --- Built-in backend detection ---

mock.module("@atlas/api/lib/tools/backends/detect", () => ({
  vercelSandboxAccess: () => undefined,
  useVercelSandbox: () => true,
  useSidecar: () => false,
  _resetVercelSandboxDetectForTest: () => {},
  _partialCredsWarnedForTest: () => false,
}));

// --- Plugin registry — mutable sandbox plugin list ---

let mockSandboxPlugins: Array<{ id: string; name?: string }> = [];

mock.module("@atlas/api/lib/plugins/registry", () => ({
  plugins: {
    describe: () => [],
    get: () => undefined,
    getStatus: () => undefined,
    enable: () => false,
    disable: () => false,
    isEnabled: () => false,
    getAllHealthy: () => [],
    getByType: (type: string) => (type === "sandbox" ? mockSandboxPlugins : []),
    size: 0,
  },
  PluginRegistry: class {},
}));

// --- Sandbox credentials — mutable connected list ---

interface MockCredential {
  id: string;
  orgId: string;
  provider: (typeof SANDBOX_PROVIDER_KEYS)[number];
  credentials: Record<string, unknown>;
  displayName: string | null;
  validatedAt: string | null;
  connectedAt: string;
}

let mockCredentials: MockCredential[] = [];
const mockDeleteCredential: Mock<(orgId: string, provider: string) => Promise<boolean>> =
  mock(async () => true);

mock.module("@atlas/api/lib/sandbox/credentials", () => ({
  SANDBOX_PROVIDERS: SANDBOX_PROVIDER_KEYS,
  getSandboxCredentials: mock(async () => mockCredentials),
  getSandboxCredentialByProvider: mock(async () => null),
  saveSandboxCredential: mock(async () => {}),
  deleteSandboxCredential: mockDeleteCredential,
}));

mock.module("@atlas/api/lib/sandbox/validate", () => ({
  isSafeExternalUrl: () => true,
  validateVercelCredentials: mock(async () => ({ valid: true as const })),
  validateE2BCredentials: mock(async () => ({ valid: true as const })),
  validateDaytonaCredentials: mock(async () => ({ valid: true as const })),
  validateRailwayCredentials: mock(async () => ({ valid: true as const })),
  validateCredentials: mock(async () => ({ valid: true as const, displayName: "Acme" })),
}));

// --- Import sub-router AFTER mocks ---

const { adminSandbox } = await import("../routes/admin-sandbox");

// --- Helpers ---

function makeCredential(provider: MockCredential["provider"]): MockCredential {
  return {
    id: `cred-${provider}`,
    orgId: "org-1",
    provider,
    credentials: { apiKey: "test" },
    displayName: `${provider}-account`,
    validatedAt: "2026-06-01T00:00:00.000Z",
    connectedAt: "2026-06-01T00:00:00.000Z",
  };
}

interface StatusResponse {
  activeBackend: string;
  platformDefault: string;
  workspaceOverride: string | null;
  connectedProviders: Array<{
    provider: string;
    isActive: boolean;
    needsReconnect: boolean;
  }>;
  providerRuntimeAvailability: Record<string, boolean>;
}

async function getStatus(): Promise<StatusResponse> {
  const res = await adminSandbox.request("http://localhost/status");
  expect(res.status).toBe(200);
  return (await res.json()) as StatusResponse;
}

/** The #3375 invariant: a "Live" provider row implies the runtime actually
 *  resolves that provider's backend — the two fields can never contradict. */
function expectNoContradiction(status: StatusResponse) {
  for (const p of status.connectedProviders) {
    if (p.isActive) {
      const backendId =
        SANDBOX_PROVIDER_BACKEND_IDS[p.provider as keyof typeof SANDBOX_PROVIDER_BACKEND_IDS];
      expect(backendId).toBeDefined();
      expect(status.activeBackend).toBe(backendId);
    }
  }
}

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mockSettings.clear();
  mockSandboxPlugins = [];
  mockCredentials = [];
  mockRuntimeAvailability = { vercel: true, e2b: false, daytona: false, railway: false };
  mockDeleteSetting.mockClear();
  mockDeleteCredential.mockClear();
  mockInvalidateOrgExploreBackends.mockClear();
});

// --- Tests ---

describe("GET /api/v1/admin/sandbox/status — vocabulary normalization", () => {
  it("legacy provider-key override 'e2b' resolves to the e2b-sandbox backend", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b");
    mockSandboxPlugins = [{ id: "e2b-sandbox", name: "E2B" }];
    mockCredentials = [makeCredential("e2b")];

    const status = await getStatus();
    expect(status.workspaceOverride).toBe("e2b-sandbox");
    expect(status.activeBackend).toBe("e2b-sandbox");
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "e2b", isActive: true }),
    ]);
    expectNoContradiction(status);
  });

  it("canonical backend-id override 'e2b-sandbox' resolves identically", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockSandboxPlugins = [{ id: "e2b-sandbox", name: "E2B" }];
    mockCredentials = [makeCredential("e2b")];

    const status = await getStatus();
    expect(status.workspaceOverride).toBe("e2b-sandbox");
    expect(status.activeBackend).toBe("e2b-sandbox");
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "e2b", isActive: true }),
    ]);
    expectNoContradiction(status);
  });

  it("only the selected provider row is active when several are connected", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b");
    mockSandboxPlugins = [
      { id: "e2b-sandbox", name: "E2B" },
      { id: "daytona-sandbox", name: "Daytona" },
    ];
    mockCredentials = [makeCredential("e2b"), makeCredential("daytona")];

    const status = await getStatus();
    const byProvider = Object.fromEntries(
      status.connectedProviders.map((p) => [p.provider, p.isActive]),
    );
    expect(byProvider).toEqual({ e2b: true, daytona: false });
    expectNoContradiction(status);
  });

  it("override for an unavailable backend falls back without marking the row active", async () => {
    // e2b selected but the plugin isn't registered → runtime falls back to
    // platform default. isActive must NOT claim the row is live (the old
    // bug's mirror image: fields contradicting each other).
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b");
    mockSandboxPlugins = [];
    mockCredentials = [makeCredential("e2b")];

    const status = await getStatus();
    expect(status.activeBackend).toBe("vercel-sandbox"); // platform default
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "e2b", isActive: false }),
    ]);
    expectNoContradiction(status);
  });

  it("no override: platform default vercel-sandbox does not mark a connected vercel BYOC row active", async () => {
    // The SaaS platform default IS vercel-sandbox; without an explicit
    // workspace selection the BYOC vercel row must not read "Live".
    mockCredentials = [makeCredential("vercel")];

    const status = await getStatus();
    expect(status.workspaceOverride).toBeNull();
    expect(status.activeBackend).toBe("vercel-sandbox");
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "vercel", isActive: false }),
    ]);
  });
});

describe("GET /api/v1/admin/sandbox/status — BYOC runtime resolution (#3370)", () => {
  it("a usable BYOC selection resolves active even without a registered plugin", async () => {
    // Complete creds + runtime installed, but the operator never registered
    // an e2b plugin — BYOC backends are built on demand from stored
    // credentials, so the selection must still resolve.
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRuntimeAvailability.e2b = true;
    mockCredentials = [makeCredential("e2b")];

    const status = await getStatus();
    expect(status.activeBackend).toBe("e2b-sandbox");
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "e2b", isActive: true, needsReconnect: false }),
    ]);
    expectNoContradiction(status);
  });

  it("a BYOC selection whose runtime is not installed falls back to the platform default", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");
    mockRuntimeAvailability.e2b = false;
    mockCredentials = [makeCredential("e2b")];

    const status = await getStatus();
    expect(status.activeBackend).toBe("vercel-sandbox");
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "e2b", isActive: false }),
    ]);
  });

  it("flags a legacy vercel row without projectId as needsReconnect and not active", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    const legacy = makeCredential("vercel");
    legacy.credentials = { accessToken: "tok", teamId: "team_1" }; // pre-projectId row
    mockCredentials = [legacy];
    // vercel-sandbox is also a built-in here (useVercelSandbox → true), so
    // activeBackend stays vercel-sandbox via the operator path — but the
    // row itself must say the stored credentials can't run.
    const status = await getStatus();
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "vercel", needsReconnect: true }),
    ]);
  });

  it("a complete vercel triple reports needsReconnect false", async () => {
    const cred = makeCredential("vercel");
    cred.credentials = { accessToken: "tok", teamId: "team_1", projectId: "prj_1" };
    mockCredentials = [cred];

    const status = await getStatus();
    expect(status.connectedProviders).toEqual([
      expect.objectContaining({ provider: "vercel", needsReconnect: false }),
    ]);
  });

  it("reports per-provider runtime availability", async () => {
    mockRuntimeAvailability = { vercel: true, e2b: true, daytona: false, railway: false };
    const status = await getStatus();
    expect(status.providerRuntimeAvailability).toEqual({
      vercel: true,
      e2b: true,
      daytona: false,
      railway: false,
    });
  });
});

describe("BYOC credential edits invalidate the org's cached backends (#3370)", () => {
  it("connect tears down cached backends for the org", async () => {
    const res = await adminSandbox.request("http://localhost/connect/e2b", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { apiKey: "e2b_key" } }),
    });
    expect(res.status).toBe(200);
    expect(mockInvalidateOrgExploreBackends).toHaveBeenCalledWith("org-1");
  });

  it("disconnect tears down cached backends for the org", async () => {
    const res = await adminSandbox.request("http://localhost/disconnect/e2b", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockInvalidateOrgExploreBackends).toHaveBeenCalledWith("org-1");
  });
});

describe("DELETE /api/v1/admin/sandbox/disconnect/{provider} — override reset", () => {
  it("resets a legacy provider-key override when its provider is disconnected", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b");

    const res = await adminSandbox.request("http://localhost/disconnect/e2b", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_SANDBOX_BACKEND", undefined, "org-1");
  });

  it("resets a backend-id override when its provider is disconnected", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");

    const res = await adminSandbox.request("http://localhost/disconnect/e2b", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockDeleteSetting).toHaveBeenCalledWith("ATLAS_SANDBOX_BACKEND", undefined, "org-1");
  });

  it("leaves the override alone when a different provider is disconnected", async () => {
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "e2b-sandbox");

    const res = await adminSandbox.request("http://localhost/disconnect/daytona", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(mockDeleteSetting).not.toHaveBeenCalled();
  });

  it("rejects backend ids as the provider URL segment", async () => {
    const res = await adminSandbox.request("http://localhost/disconnect/e2b-sandbox", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});
