/**
 * Tests for admin residency API endpoints.
 *
 * Tests the adminResidency sub-router directly (not through the parent admin
 * router) to avoid needing to mock every sub-router dependency.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// --- Effect mock ---
// Mock the Effect bridge so the route file can load and execute without
// the full Effect runtime. Effect.gen + runEffect are shimmed to execute
// the generator directly, resolving yield* calls to mocked services.

let mockEffectUser: Record<string, unknown> = {
  id: "admin-1",
  mode: "simple-key",
  label: "Admin",
  role: "admin",
  activeOrganizationId: "org-1",
  orgId: "org-1",
};

const fakeAuthContext = {
  [Symbol.iterator]: function* () {
    return yield mockEffectUser;
  },
};

mock.module("effect", () => {
  const Effect = {
    gen: (genFn: () => Generator) => {
      return { _tag: "EffectGen", genFn };
    },
    promise: (fn: () => Promise<unknown>) => {
      // Wrap the promise so it can be yielded in the generator
      return {
        [Symbol.iterator]: function* () {
          // Return a sentinel that runEffect resolves asynchronously
          return yield { _tag: "EffectPromise", fn };
        },
      };
    },
  };
  return { Effect };
});

mock.module("@atlas/api/lib/effect/services", () => ({
  AuthContext: fakeAuthContext,
  RequestContext: { [Symbol.iterator]: function* () { return yield { requestId: "test-req-1", startTime: Date.now() }; } },
  makeRequestContextLayer: () => ({}),
  makeAuthContextLayer: () => ({}),
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runEffect: async (_c: unknown, effect: { _tag: string; genFn: () => Generator }, _opts?: unknown) => {
    const gen = effect.genFn();
    let result = gen.next();
    while (!result.done) {
      let value = result.value;
      // Resolve Effect.promise sentinels
      if (value && typeof value === "object" && "_tag" in value && value._tag === "EffectPromise") {
        try {
          value = await (value as { fn: () => Promise<unknown> }).fn();
          result = gen.next(value);
        } catch (err) {
          result = gen.throw(err);
        }
      } else {
        result = gen.next(value);
      }
    }
    return result.value;
  },
  DomainErrorMapping: Array,
}));

// --- Auth mock ---

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
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

// --- Internal DB mock ---

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: () => {},
  getWorkspaceRegion: () => Promise.resolve(null),
  setWorkspaceRegion: () => Promise.resolve({ assigned: true }),
}));

// --- EE residency mock ---

let mockAssignment: { workspaceId: string; region: string; assignedAt: string } | null =
  null;
let mockAssignResult: { workspaceId: string; region: string; assignedAt: string } | null =
  null;
let mockAssignError: Error | null = null;
let mockResidencyConfigured = true;
let mockDefaultRegion = "us-east";
let mockRegions: Record<string, { label: string; databaseUrl: string }> = {
  "us-east": { label: "US East", databaseUrl: "postgresql://us" },
  "eu-west": { label: "EU West", databaseUrl: "postgresql://eu" },
  "ap-southeast": { label: "Asia Pacific", databaseUrl: "postgresql://ap" },
};

class MockResidencyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ResidencyError";
  }
}

mock.module("@atlas/ee/platform/residency", () => ({
  getDefaultRegion: () => {
    if (!mockResidencyConfigured)
      throw new MockResidencyError("not configured", "not_configured");
    return mockDefaultRegion;
  },
  getConfiguredRegions: () => {
    if (!mockResidencyConfigured)
      throw new MockResidencyError("not configured", "not_configured");
    return mockRegions;
  },
  getWorkspaceRegionAssignment: async () => mockAssignment,
  assignWorkspaceRegion: async () => {
    if (mockAssignError) throw mockAssignError;
    return mockAssignResult;
  },
  ResidencyError: MockResidencyError,
  listRegions: async () => [],
  listWorkspaceRegions: async () => [],
  resolveRegionDatabaseUrl: async () => null,
  isConfiguredRegion: () => true,
}));

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: mock(async () => ({ allowed: true })),
  listIPAllowlistEntries: mock(async () => []),
  addIPAllowlistEntry: mock(async () => ({})),
  removeIPAllowlistEntry: mock(async () => false),
  IPAllowlistError: class extends Error { constructor(message: string, public readonly code: string) { super(message); this.name = "IPAllowlistError"; } },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Import sub-router directly ---

const { adminResidency } = await import("../routes/admin-residency");

// --- Helpers ---

function resetMocks() {
  mockHasInternalDB = true;
  mockAssignment = null;
  mockAssignResult = null;
  mockAssignError = null;
  mockResidencyConfigured = true;
  mockDefaultRegion = "us-east";
  mockRegions = {
    "us-east": { label: "US East", databaseUrl: "postgresql://us" },
    "eu-west": { label: "EU West", databaseUrl: "postgresql://eu" },
    "ap-southeast": { label: "Asia Pacific", databaseUrl: "postgresql://ap" },
  };
  mockEffectUser = {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
    orgId: "org-1",
  };
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
}

async function request(method: string, path = "/", body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return adminResidency.request(`http://localhost${path}`, init);
}

// --- Tests ---

describe("GET /api/v1/admin/residency", () => {
  beforeEach(resetMocks);

  it("returns status with no region assigned", async () => {
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResidencyStatusResponse;
    expect(json.configured).toBe(true);
    expect(json.region).toBeNull();
    expect(json.availableRegions).toHaveLength(3);
    expect(json.defaultRegion).toBe("us-east");
  });

  it("returns status with region assigned", async () => {
    mockAssignment = {
      workspaceId: "org-1",
      region: "eu-west",
      assignedAt: "2026-03-01T00:00:00Z",
    };
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResidencyStatusResponse;
    expect(json.region).toBe("eu-west");
    expect(json.regionLabel).toBe("EU West");
    expect(json.assignedAt).toBe("2026-03-01T00:00:00Z");
  });

  it("returns configured=false when residency not configured", async () => {
    mockResidencyConfigured = false;
    const res = await request("GET");
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResidencyStatusResponse;
    expect(json.configured).toBe(false);
    expect(json.availableRegions).toHaveLength(0);
  });

  it("returns 400 when no active org", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          activeOrganizationId: undefined,
        },
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: false,
        status: 401,
        error: "Not authenticated",
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin user", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "User",
          role: "member",
          activeOrganizationId: "org-1",
        },
      }),
    );
    const res = await request("GET");
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/v1/admin/residency", () => {
  beforeEach(resetMocks);

  it("assigns region successfully", async () => {
    mockAssignResult = {
      workspaceId: "org-1",
      region: "eu-west",
      assignedAt: "2026-03-28T00:00:00Z",
    };
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { region: string; workspaceId: string };
    expect(json.region).toBe("eu-west");
    expect(json.workspaceId).toBe("org-1");
  });

  it("returns 409 when region already assigned", async () => {
    mockAssignError = new MockResidencyError(
      'Workspace is already assigned to region "us-east".',
      "already_assigned",
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("already assigned");
  });

  it("returns 400 for invalid region", async () => {
    mockAssignError = new MockResidencyError(
      'Invalid region "mars-1".',
      "invalid_region",
    );
    const res = await request("PUT", "/", { region: "mars-1" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid region");
  });

  it("returns 404 when workspace not found", async () => {
    mockAssignError = new MockResidencyError(
      'Workspace "org-1" not found.',
      "workspace_not_found",
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when no active org", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: {
          id: "admin-1",
          mode: "simple-key",
          label: "Admin",
          role: "admin",
          activeOrganizationId: undefined,
        },
      }),
    );
    const res = await request("PUT", "/", { region: "eu-west" });
    expect(res.status).toBe(400);
  });
});

// --- Type helpers ---

interface ResidencyStatusResponse {
  configured: boolean;
  region: string | null;
  regionLabel: string | null;
  assignedAt: string | null;
  defaultRegion: string;
  availableRegions: Array<{
    id: string;
    label: string;
    isDefault: boolean;
  }>;
}
