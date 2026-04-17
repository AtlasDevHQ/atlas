/**
 * Tests for GET /api/v1/mode (#1439).
 *
 * Covers:
 * - Mode resolution (developer vs published) based on cookie + role
 * - canToggle gating (admin/owner/platform_admin/none vs member)
 * - demoIndustry from ATLAS_DEMO_INDUSTRY setting
 * - demoConnectionActive based on __demo__ row status
 * - draftCounts shape and per-field counts
 * - hasDrafts derived from the counts
 * - Non-admin users get mode='published' regardless of cookie
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the route
// ---------------------------------------------------------------------------

interface MockUser {
  id: string;
  mode: string;
  label: string;
  role?: string;
  activeOrganizationId?: string;
}

let currentUser: MockUser | undefined = {
  id: "admin-1",
  mode: "managed",
  label: "admin@example.com",
  role: "admin",
  activeOrganizationId: "org-1",
};
let currentAuthMode = "managed";
let authenticated = true;

const mockAuthenticate: Mock<() => Promise<{
  authenticated: boolean;
  mode: string;
  user?: MockUser;
  status?: number;
  error?: string;
}>> = mock(() =>
  Promise.resolve({
    authenticated,
    mode: currentAuthMode,
    user: currentUser,
    status: authenticated ? undefined : 401,
    error: authenticated ? undefined : "No session",
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticate,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
}));

let mockHasInternalDBValue = true;
const mockHasInternalDB: Mock<() => boolean> = mock(() => mockHasInternalDBValue);

interface DraftCountFixture {
  connections: number;
  entities: number;
  entityEdits: number;
  entityDeletes: number;
  prompts: number;
  starterPrompts: number;
}

let draftFixture: DraftCountFixture = {
  connections: 0,
  entities: 0,
  entityEdits: 0,
  entityDeletes: 0,
  prompts: 0,
  starterPrompts: 0,
};
let demoActiveFixture = false;

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>> = mock(
  async (sql: string) => {
    if (sql.includes("FROM connections") && sql.includes("'__demo__'")) {
      return [{ active: demoActiveFixture }];
    }
    if (sql.includes("UNION ALL") && sql.includes("draft")) {
      return [
        { k: "connections", v: draftFixture.connections },
        { k: "entities", v: draftFixture.entities },
        { k: "entityEdits", v: draftFixture.entityEdits },
        { k: "entityDeletes", v: draftFixture.entityDeletes },
        { k: "prompts", v: draftFixture.prompts },
        { k: "starterPrompts", v: draftFixture.starterPrompts },
      ];
    }
    return [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: mockHasInternalDB,
  internalQuery: mockInternalQuery,
}));

let demoIndustryFixture: string | undefined;
const mockGetSettingAuto: Mock<(key: string, orgId?: string) => string | undefined> = mock(
  (key) => (key === "ATLAS_DEMO_INDUSTRY" ? demoIndustryFixture : undefined),
);

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: mockGetSettingAuto,
  getSetting: mockGetSettingAuto,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { mode } = await import("../mode");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/mode", mode);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asAdmin() {
  authenticated = true;
  currentAuthMode = "managed";
  currentUser = {
    id: "admin-1",
    mode: "managed",
    label: "admin@example.com",
    role: "admin",
    activeOrganizationId: "org-1",
  };
}

function asMember() {
  authenticated = true;
  currentAuthMode = "managed";
  currentUser = {
    id: "member-1",
    mode: "managed",
    label: "member@example.com",
    role: "member",
    activeOrganizationId: "org-1",
  };
}

function asNoAuthMode() {
  authenticated = true;
  currentAuthMode = "none";
  currentUser = undefined;
}

function asUnauthenticated() {
  authenticated = false;
  currentUser = undefined;
}

function devCookie() {
  return { Cookie: "atlas-mode=developer" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/mode — mode resolution", () => {
  beforeEach(() => {
    asAdmin();
    mockHasInternalDBValue = true;
    draftFixture = { connections: 0, entities: 0, entityEdits: 0, entityDeletes: 0, prompts: 0, starterPrompts: 0 };
    demoActiveFixture = false;
    demoIndustryFixture = undefined;
  });

  it("returns mode=developer when admin sends atlas-mode=developer cookie", async () => {
    const res = await request("/api/v1/mode", { headers: devCookie() });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.mode).toBe("developer");
    expect(data.canToggle).toBe(true);
  });

  it("returns mode=published when admin sends no cookie", async () => {
    const res = await request("/api/v1/mode");
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.mode).toBe("published");
    expect(data.canToggle).toBe(true);
  });

  it("forces mode=published for non-admin even with developer cookie", async () => {
    asMember();
    const res = await request("/api/v1/mode", { headers: devCookie() });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.mode).toBe("published");
    expect(data.canToggle).toBe(false);
  });

  it("treats auth mode 'none' (local dev) as implicit admin", async () => {
    asNoAuthMode();
    const res = await request("/api/v1/mode", { headers: devCookie() });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.mode).toBe("developer");
    expect(data.canToggle).toBe(true);
  });

  it("rejects unauthenticated requests with 401", async () => {
    asUnauthenticated();
    const res = await request("/api/v1/mode");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/mode — canToggle by role", () => {
  beforeEach(() => {
    mockHasInternalDBValue = true;
    draftFixture = { connections: 0, entities: 0, entityEdits: 0, entityDeletes: 0, prompts: 0, starterPrompts: 0 };
    demoActiveFixture = false;
    demoIndustryFixture = undefined;
  });

  it.each([
    ["admin", true],
    ["owner", true],
    ["platform_admin", true],
  ])("canToggle=true for role=%s", async (role, expected) => {
    authenticated = true;
    currentAuthMode = "managed";
    currentUser = { id: `${role}-1`, mode: "managed", label: `${role}@x.com`, role, activeOrganizationId: "org-1" };
    const res = await request("/api/v1/mode");
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.canToggle).toBe(expected);
  });

  it("canToggle=false for member", async () => {
    asMember();
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.canToggle).toBe(false);
  });

  it("canToggle=true for auth mode 'none' (local dev)", async () => {
    asNoAuthMode();
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.canToggle).toBe(true);
  });
});

describe("GET /api/v1/mode — demo state", () => {
  beforeEach(() => {
    asAdmin();
    mockHasInternalDBValue = true;
    draftFixture = { connections: 0, entities: 0, entityEdits: 0, entityDeletes: 0, prompts: 0, starterPrompts: 0 };
  });

  it("returns demoIndustry from settings", async () => {
    demoIndustryFixture = "cybersecurity";
    demoActiveFixture = true;
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.demoIndustry).toBe("cybersecurity");
  });

  it("returns demoIndustry=null when setting is unset", async () => {
    demoIndustryFixture = undefined;
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.demoIndustry).toBeNull();
  });

  it("demoConnectionActive=true when __demo__ is published", async () => {
    demoActiveFixture = true;
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.demoConnectionActive).toBe(true);
  });

  it("demoConnectionActive=false when __demo__ is missing or archived", async () => {
    demoActiveFixture = false;
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.demoConnectionActive).toBe(false);
  });
});

describe("GET /api/v1/mode — draft counts", () => {
  beforeEach(() => {
    asAdmin();
    mockHasInternalDBValue = true;
    demoActiveFixture = false;
    demoIndustryFixture = undefined;
  });

  it("returns draftCounts=null and hasDrafts=false when no drafts exist", async () => {
    draftFixture = { connections: 0, entities: 0, entityEdits: 0, entityDeletes: 0, prompts: 0, starterPrompts: 0 };
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.draftCounts).toBeNull();
    expect(data.hasDrafts).toBe(false);
  });

  it("returns draftCounts and hasDrafts=true when any draft exists", async () => {
    draftFixture = { connections: 1, entities: 0, entityEdits: 0, entityDeletes: 0, prompts: 0, starterPrompts: 0 };
    const res = await request("/api/v1/mode");
    const data = await json(res) as { hasDrafts: boolean; draftCounts: Record<string, number> | null };
    expect(data.hasDrafts).toBe(true);
    expect(data.draftCounts).not.toBeNull();
    expect(data.draftCounts!.connections).toBe(1);
  });

  it("includes all six draft fields with the expected counts", async () => {
    draftFixture = { connections: 2, entities: 7, entityEdits: 3, entityDeletes: 1, prompts: 4, starterPrompts: 5 };
    const res = await request("/api/v1/mode");
    const data = await json(res) as { draftCounts: Record<string, number> };
    expect(data.draftCounts).toMatchObject({
      connections: 2,
      entities: 7,
      entityEdits: 3,
      entityDeletes: 1,
      prompts: 4,
      starterPrompts: 5,
    });
  });

  // Regression guard for #1478: a typo in DRAFT_COUNTS_SQL (missing
  // UNION branch, wrong key casing, wrong status literal) would let
  // rowsToCounts() silently fall back to ZERO_COUNTS for starterPrompts
  // without failing any other assertion. Pin the key end-to-end.
  it("reports draftCounts.starterPrompts when only starter-prompt drafts exist", async () => {
    draftFixture = {
      connections: 0,
      entities: 0,
      entityEdits: 0,
      entityDeletes: 0,
      prompts: 0,
      starterPrompts: 3,
    };
    const res = await request("/api/v1/mode");
    const data = await json(res) as {
      hasDrafts: boolean;
      draftCounts: Record<string, number> | null;
    };
    expect(data.hasDrafts).toBe(true);
    expect(data.draftCounts).not.toBeNull();
    expect(data.draftCounts!.starterPrompts).toBe(3);
  });

  it("queries query_suggestions in the DRAFT_COUNTS_SQL UNION", async () => {
    // A regression that dropped the starterPrompts branch would leave
    // the SQL untouched but callers would see zero. Assert the SQL
    // actually references query_suggestions so the phase-3d source
    // table stays in the union.
    await request("/api/v1/mode");
    const calls = mockInternalQuery.mock.calls.map(([sql]) => String(sql));
    const unionCall = calls.find(
      (sql) => sql.includes("UNION ALL") && sql.includes("'starterPrompts'"),
    );
    expect(unionCall).toBeDefined();
    expect(unionCall).toContain("FROM query_suggestions");
    expect(unionCall).toContain("status = 'draft'");
  });

  it("returns draftCounts=null when no orgId is available", async () => {
    authenticated = true;
    currentAuthMode = "managed";
    currentUser = { id: "user-1", mode: "managed", label: "u@x.com", role: "admin" }; // no activeOrganizationId
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.draftCounts).toBeNull();
    expect(data.hasDrafts).toBe(false);
  });

  it("returns draftCounts=null when there is no internal DB", async () => {
    mockHasInternalDBValue = false;
    const res = await request("/api/v1/mode");
    const data = await json(res);
    expect(data.draftCounts).toBeNull();
    expect(data.hasDrafts).toBe(false);
  });
});

describe("GET /api/v1/mode — error handling", () => {
  beforeEach(() => {
    asAdmin();
    mockHasInternalDBValue = true;
    draftFixture = { connections: 0, entities: 0, entityEdits: 0, entityDeletes: 0, prompts: 0, starterPrompts: 0 };
    demoActiveFixture = false;
    demoIndustryFixture = undefined;
  });

  it("returns 500 with requestId when DB query throws", async () => {
    mockInternalQuery.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    const res = await request("/api/v1/mode");
    expect(res.status).toBe(500);
    const data = await json(res);
    expect(data.error).toBe("internal_error");
    expect(data.requestId).toBeDefined();
  });
});
