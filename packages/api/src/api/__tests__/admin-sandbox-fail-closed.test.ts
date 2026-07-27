/**
 * #4837 — `/api/v1/admin/sandbox/status` must report a fail-closed deployment as
 * an OUTAGE, never as a backend id.
 *
 * `getExploreBackendType()` gained `"fail-closed"` in #4835. The admin route
 * typed `activeBackend` as a bare `string` and passed it straight through, so
 * `/admin/sandbox` — the page whose entire purpose is diagnosing sandboxing —
 * rendered `Active: fail-closed` in the same monospace slot that otherwise holds
 * `vercel-sandbox`. It read as one more selectable backend.
 *
 * Reachable in SaaS production, not theory: `deploy/api/atlas.config.ts` pins
 * `priority: ["vercel-sandbox"]` with no `just-bash` on staging and all three
 * prod regions, and `VERCEL_TOKEN` is a per-service Railway secret that shared
 * vars do not inherit (#4828). Drop it on one regional service and that region
 * is fail-closed with explore refusing every request.
 *
 * Separate file from `admin-sandbox.test.ts` because Bun's `mock.module()` is
 * process-global and irreversible — this file needs `getExploreBackendType()` to
 * return `"fail-closed"` where that one pins `"vercel-sandbox"`. Same reason
 * `health-sandbox-fail-closed.test.ts` is split from `health.test.ts`.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { SANDBOX_PROVIDER_KEYS, SandboxStatusSchema } from "@useatlas/schemas";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
// The real policy module — deliberately NOT mocked. The assertions below tie the
// admin payload to what the runtime actually does with the SAME inputs, which is
// the whole point of the parity invariant; mocking it would make them vacuous.
import {
  planSandboxSelection,
  runSandboxPlan,
  formatSandboxFailClosed,
  type SandboxSelectionEnv,
} from "@atlas/api/lib/tools/backends/selection";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
});

/**
 * The live SaaS posture: `deploy/api/atlas.config.ts` pins vercel-sandbox alone,
 * and the region has lost `VERCEL_TOKEN`, so `vercelAvailable` is false. Every
 * step is unavailable and the pin carries no `just-bash`, so the plan resolves
 * fail-closed.
 */
const SAAS_PIN_ENV: SandboxSelectionEnv = {
  atlasSandbox: undefined,
  vercelAvailable: false,
  sidecarAvailable: false,
  nsjailAvailable: false,
  nsjailFailed: false,
  configPriority: ["vercel-sandbox"],
};

// --- Settings mock (overrides the factory's) ---

const mockSettings = new Map<string, string>();

void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingAuto: (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingLive: async (key: string, _orgId?: string) => mockSettings.get(key),
  getSettingsForAdmin: mock(() => []),
  getSettingsRegistry: mock(() => []),
  getSettingDefinition: mock(() => undefined),
  setSetting: mock(async () => {}),
  deleteSetting: mock(async () => {}),
  loadSettings: mock(async () => 0),
  getAllSettingOverrides: mock(async () => []),
  _resetSettingsCache: mock(() => {}),
}));

// --- Config — SaaS, so the remediation omits the just-bash escape hatch ---
// Overrides the factory's `getConfig: () => null`. `mock.module` is last-write
// -wins, so this must register after `createApiTestMocks`.

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: "saas" as const }),
  defineConfig: (c: unknown) => c,
}));

// --- Key mock: the resolver reports that NO backend will construct ---

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "fail-closed",
  getActiveSandboxPluginId: () => null,
  snapshotExploreSandboxEnv: () => SAAS_PIN_ENV,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  invalidateOrgExploreBackends: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
  _formatSandboxPriorityFailureForTest: mock(() => ""),
}));

// --- BYOC credentials — mutable connected list ---

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

void mock.module("@atlas/api/lib/sandbox/credentials", () => ({
  SANDBOX_PROVIDERS: SANDBOX_PROVIDER_KEYS,
  getSandboxCredentials: mock(async () => mockCredentials),
  getSandboxCredentialByProvider: mock(async () => null),
  saveSandboxCredential: mock(async () => {}),
  deleteSandboxCredential: mock(async () => true),
}));

void mock.module("@atlas/api/lib/sandbox/validate", () => ({
  isSafeExternalUrl: () => true,
  isBlockedResolvedAddress: () => false,
  validateVercelCredentials: mock(async () => ({ valid: true as const })),
  validateE2BCredentials: mock(async () => ({ valid: true as const })),
  validateDaytonaCredentials: mock(async () => ({ valid: true as const })),
  validateRailwayCredentials: mock(async () => ({ valid: true as const })),
  validateCredentials: mock(async () => ({ valid: true as const, displayName: "Acme" })),
}));

const mockRuntimeAvailability: Record<string, boolean> = {
  vercel: true,
  e2b: false,
  daytona: false,
  railway: false,
};

const realSandboxRuntime = await import("@atlas/api/lib/sandbox/runtime");

void mock.module("@atlas/api/lib/sandbox/runtime", () => ({
  ...realSandboxRuntime,
  isProviderRuntimeAvailable: async (provider: string) =>
    mockRuntimeAvailability[provider] ?? false,
  getProviderRuntimeAvailability: async () => ({ ...mockRuntimeAvailability }),
  tryCreateByocBackend: mock(async () => null),
}));

// --- Built-in backend detection — the region lost VERCEL_TOKEN ---
// This is what makes the pinned backend unavailable, and therefore what makes
// `availableBackends` honest about there being nothing to select.

void mock.module("@atlas/api/lib/tools/backends/detect", () => ({
  vercelSandboxAccess: () => undefined,
  useVercelSandbox: () => false,
  useSidecar: () => false,
  _resetVercelSandboxDetectForTest: () => {},
  _partialCredsWarnedForTest: () => false,
}));

// --- Plugin registry — no sandbox plugin ahead of the plan ---

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

// --- Import sub-router AFTER mocks ---

const { adminSandbox } = await import("../routes/admin-sandbox");

// --- Helpers ---

async function getStatus(): Promise<unknown> {
  const res = await adminSandbox.request("http://localhost/status");
  expect(res.status).toBe(200);
  return await res.json();
}

/**
 * Parse through the SHARED wire schema rather than a local interface. The web
 * page parses the same one, so a payload the page would reject cannot pass here
 * — the `activeBackend: z.string()` this issue replaced is exactly the kind of
 * drift a hand-written local interface hides.
 */
async function getParsedStatus() {
  const parsed = SandboxStatusSchema.safeParse(await getStatus());
  if (!parsed.success) {
    throw new Error(`status payload failed the shared wire schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mockSettings.clear();
  mockCredentials = [];
});

// --- Tests ---

describe("GET /admin/sandbox/status — fail-closed region (#4837)", () => {
  it("reports no active backend and no platform default, rather than a 'fail-closed' backend id", async () => {
    const status = await getParsedStatus();

    expect(status.activeBackend).toBeNull();
    expect(status.platformDefault).toBeNull();
    // The regression itself: the sentinel must not survive anywhere an id lives.
    // A `toBeNull` alone would still pass if some later change reintroduced the
    // string under a different id field.
    expect(JSON.stringify(status)).not.toContain('"fail-closed"');
  });

  it("carries a failClosed block whose remediation names the pinned backend and its credential", async () => {
    const status = await getParsedStatus();

    expect(status.failClosed).toBeDefined();
    const remediation = status.failClosed?.remediation ?? "";

    // Names the ACTUAL cause. Generic "install nsjail" advice is unactionable
    // under a pin that excludes nsjail — #4828's lesson, and the reason this
    // assertion is positive on the pin AND negative on the wrong advice.
    expect(remediation).toContain("vercel-sandbox");
    expect(remediation).toContain("VERCEL_TOKEN");
    expect(remediation).not.toContain("install the binary");
    expect(remediation).not.toContain("ATLAS_SANDBOX_URL");
    // SaaS: the "add just-bash for an unsandboxed fallback" escape hatch is not
    // offered — a managed deployment must not be told to disable isolation.
    expect(remediation).not.toContain("just-bash' if you want");
  });

  it("uses the SAME formatter the boot warning does, so the two surfaces cannot drift", async () => {
    const status = await getParsedStatus();

    // Byte-for-byte against the shared formatter fed the same inputs. A route
    // that grew its own copy of the copy would still contain "VERCEL_TOKEN" and
    // pass the test above; only this one catches the fork.
    const expected = formatSandboxFailClosed(
      planSandboxSelection(SAAS_PIN_ENV),
      SAAS_PIN_ENV,
      "saas",
    );
    expect(status.failClosed?.remediation).toBe(expected);
  });

  it("agrees with the runtime consequence — the same plan refuses to construct anything", async () => {
    const status = await getParsedStatus();

    // The admin surface claims an outage; this is the outage. Walking the plan
    // the route reported on, with every step failing to construct (the missing
    // VERCEL_TOKEN), yields `fail-closed` — explore has no backend to run and
    // throws on every request. Payload and runtime, one set of inputs.
    const outcome = await runSandboxPlan(planSandboxSelection(SAAS_PIN_ENV), async (step) => ({
      failure: { name: step.kind, reason: "not configured" },
    }));

    expect(outcome.kind).toBe("fail-closed");
    expect(status.activeBackend).toBeNull();
  });

  it("marks no connected BYOC provider active when the platform has failed closed", async () => {
    mockCredentials = [
      {
        id: "cred-vercel",
        orgId: "org-1",
        provider: "vercel",
        credentials: { accessToken: "t", teamId: "team", projectId: "prj" },
        displayName: "acme",
        validatedAt: "2026-06-01T00:00:00.000Z",
        connectedAt: "2026-06-01T00:00:00.000Z",
      },
    ];

    const status = await getParsedStatus();

    // No workspace override is set, so the workspace follows the (broken)
    // platform default. `isActive` must not read "Live" off a merely *connected*
    // row — the #3375 contradiction invariant, which a null `activeBackend`
    // makes structurally impossible rather than merely unlikely.
    expect(status.connectedProviders.every((p) => !p.isActive)).toBe(true);
    expect(status.activeBackend).toBeNull();
  });

  it("keeps a usable workspace BYOC override running through the platform outage", async () => {
    // The override sits ahead of the platform plan, so this workspace's explore
    // still works. Reporting it as down would be a false alarm — and the outage
    // block must still be present, because any workspace on the default is down.
    mockSettings.set("ATLAS_SANDBOX_BACKEND", "vercel-sandbox");
    mockCredentials = [
      {
        id: "cred-vercel",
        orgId: "org-1",
        provider: "vercel",
        credentials: { accessToken: "t", teamId: "team", projectId: "prj" },
        displayName: "acme",
        validatedAt: "2026-06-01T00:00:00.000Z",
        connectedAt: "2026-06-01T00:00:00.000Z",
      },
    ];

    const status = await getParsedStatus();

    expect(status.activeBackend).toBe("vercel-sandbox");
    expect(status.platformDefault).toBeNull();
    expect(status.failClosed).toBeDefined();
    expect(status.connectedProviders.find((p) => p.provider === "vercel")?.isActive).toBe(true);
  });
});
