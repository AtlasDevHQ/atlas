/**
 * Tests for /api/v1/admin/organizations/** — the subtree provides cross-tenant
 * workspace lifecycle CRUD (list / get / stats / status / suspend / activate /
 * plan / delete) and is platform-admin-only.
 *
 * These tests parametrize over every route so adding a new endpoint to the
 * router without a platform gate would surface here immediately.
 *
 * F-08 (#1750): pre-fix, the subtree was mounted on createAdminRouter(),
 * letting any workspace admin CRUD any workspace by id.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { asRatio, type AbuseLevel } from "@useatlas/types";

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-admin-1",
    mode: "managed",
    label: "platform@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-test",
  },
  authMode: "managed",
});

// Re-register the abuse module with a programmable per-workspace map so
// the abuseLevel surfacing tests below can drive non-"none" verdicts —
// `createApiTestMocks` pins `checkAbuseStatus` to `{ level: "none" }`,
// which is fine for the platform-gate parametrized tests but blocks
// any assertion that a real escalation propagates to the wire.
const abuseStatusByWorkspace = new Map<string, AbuseLevel>();
mock.module("@atlas/api/lib/security/abuse", () => ({
  listFlaggedWorkspaces: mock(() => []),
  reinstateWorkspace: mock(() => "warning" as const),
  getAbuseEvents: mock(async () => ({ events: [], status: "ok" })),
  getAbuseConfig: mock(() => ({
    queryRateLimit: 200,
    queryRateWindowSeconds: 300,
    errorRateThreshold: asRatio(0.5),
    uniqueTablesLimit: 50,
    throttleDelayMs: 2000,
  })),
  getAbuseDetail: mock(async () => null),
  checkAbuseStatus: mock((workspaceId: string) => ({
    level: abuseStatusByWorkspace.get(workspaceId) ?? "none",
  })),
  recordQueryEvent: mock(() => {}),
  restoreAbuseState: mock(async () => {}),
  getAbuseRestoreStatus: mock(() => "ok" as const),
  ABUSE_RESTORE_STATUSES: ["pending", "ok", "db_unavailable", "load_failed"] as const,
  _resetAbuseState: mock(() => abuseStatusByWorkspace.clear()),
  abuseCleanupTick: mock(() => {}),
  ABUSE_CLEANUP_INTERVAL_MS: 300_000,
}));

// --- Import app after mocks ---

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helpers ---

function orgsRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function setWorkspaceAdmin(orgId = "org-1"): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      mode: "managed",
      label: "admin@test.com",
      role: "admin",
      activeOrganizationId: orgId,
    },
  });
}

function setWorkspaceOwner(orgId = "org-1"): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: {
      id: "owner-1",
      mode: "managed",
      label: "owner@test.com",
      role: "owner",
      activeOrganizationId: orgId,
    },
  });
}

function setMember(orgId = "org-1"): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: {
      id: "member-1",
      mode: "managed",
      label: "member@test.com",
      role: "member",
      activeOrganizationId: orgId,
    },
  });
}

function setPlatformAdmin(): void {
  mocks.setPlatformAdmin();
}

// Every route under the admin-orgs subtree. Parametrising here means a
// future router addition without a platform gate surfaces immediately — the
// F-08 fix's job is to keep this surface uniformly platform-gated.
type RouteSpec = {
  readonly method: "GET" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
};

const ROUTES: ReadonlyArray<RouteSpec> = [
  { method: "GET", path: "/api/v1/admin/organizations" },
  { method: "GET", path: "/api/v1/admin/organizations/org_target" },
  { method: "GET", path: "/api/v1/admin/organizations/org_target/stats" },
  { method: "GET", path: "/api/v1/admin/organizations/org_target/status" },
  { method: "PATCH", path: "/api/v1/admin/organizations/org_target/suspend" },
  { method: "PATCH", path: "/api/v1/admin/organizations/org_target/activate" },
  {
    method: "PATCH",
    path: "/api/v1/admin/organizations/org_target/plan",
    body: { planTier: "starter" },
  },
  { method: "DELETE", path: "/api/v1/admin/organizations/org_target" },
];

// --- Tests ---

describe("/api/v1/admin/organizations/** — F-08 platform-admin gate (#1750)", () => {
  beforeEach(() => {
    mocks.mockAuthenticateRequest.mockReset();
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    mocks.hasInternalDB = true;
    setPlatformAdmin();
  });

  describe("workspace admin (role: admin) is rejected", () => {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} → 403 forbidden_role`, async () => {
        setWorkspaceAdmin("org-1");
        const res = await app.fetch(orgsRequest(route.method, route.path, route.body));
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("forbidden_role");
      });
    }
  });

  describe("workspace owner (role: owner) is rejected", () => {
    // Owner is still a workspace-scoped role — must not be able to reach
    // platform-admin endpoints.
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} → 403 forbidden_role`, async () => {
        setWorkspaceOwner("org-1");
        const res = await app.fetch(orgsRequest(route.method, route.path, route.body));
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("forbidden_role");
      });
    }
  });

  describe("regular member (role: member) is rejected", () => {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} → 403`, async () => {
        setMember("org-1");
        const res = await app.fetch(orgsRequest(route.method, route.path, route.body));
        // Non-admin callers may 401 (auth pre-check) or 403 (role check);
        // either way the handler must not run.
        expect([401, 403]).toContain(res.status);
      });
    }
  });

  describe("platform admin (role: platform_admin) passes the gate", () => {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} → not 403`, async () => {
        setPlatformAdmin();
        const res = await app.fetch(orgsRequest(route.method, route.path, route.body));
        // Handler ran — we don't care whether the target org exists in the
        // mock (most routes return 404 with empty internalQuery defaults).
        // The contract this test guards is "platform admin clears the auth
        // gate"; behavioural correctness of each handler is covered
        // elsewhere.
        expect(res.status).not.toBe(403);
        // Hono's default notFound returns text/plain — asserting JSON proves
        // the handler, not a routing miss, produced the response. Without
        // this a typo in ROUTES would let the "not 403" assertion pass
        // vacuously on 404 text.
        expect(res.headers.get("content-type") ?? "").toContain("application/json");
        if (res.status >= 400) {
          const body = (await res.json()) as { error?: string };
          expect(body.error).not.toBe("forbidden_role");
        }
      });
    }

    it("GET / returns 200 with empty list for platform admin", async () => {
      setPlatformAdmin();
      mocks.mockInternalQuery.mockResolvedValue([]);
      const res = await app.fetch(orgsRequest("GET", "/api/v1/admin/organizations"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { organizations: unknown[]; total: number };
      expect(body.organizations).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  describe("self-hosted (mode: none) bypasses the platform gate", () => {
    // platformAdminAuth has a documented carve-out: when authResult.mode is
    // "none" (self-hosted / local dev with no auth configured), the caller
    // is treated as an implicit admin regardless of role. This is
    // load-bearing for self-hosted deploys — removing the carve-out would
    // break every self-hosted installation's access to org lifecycle
    // routes. Lock it in so a future "tighten the gate" refactor surfaces
    // the self-hosted implication.
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} → not 403 when mode="none"`, async () => {
        mocks.mockAuthenticateRequest.mockResolvedValue({
          authenticated: true,
          mode: "none",
        });
        const res = await app.fetch(orgsRequest(route.method, route.path, route.body));
        expect(res.status).not.toBe(403);
      });
    }
  });

  describe("unauthenticated requests are rejected", () => {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} → 401`, async () => {
        mocks.mockAuthenticateRequest.mockResolvedValue({
          authenticated: false,
          mode: "managed",
          status: 401,
          error: "Missing credentials",
        });
        const res = await app.fetch(orgsRequest(route.method, route.path, route.body));
        expect(res.status).toBe(401);
      });
    }
  });

  // #2269 — admin-orgs hits the same checkAbuseStatus divergence as
  // platform-admin; both list + detail must thread abuseLevel.
  describe("abuseLevel surfacing", () => {
    beforeEach(() => {
      setPlatformAdmin();
      mocks.hasInternalDB = true;
    });

    afterEach(() => {
      abuseStatusByWorkspace.clear();
    });

    it("GET / threads checkAbuseStatus into every row", async () => {
      // Stub one suspended workspace so the assertion pins the enum
      // round-trip — a regression that types abuseLevel as
      // `z.string().optional()` would let any value through.
      abuseStatusByWorkspace.set("org-dharma", "suspended");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization") && !sql.includes("member")) {
          return [
            { id: "org-clean", name: "Clean", slug: "clean", logo: null, metadata: null, createdAt: "2026-01-01T00:00:00.000Z", workspace_status: "active", plan_tier: "starter", suspended_at: null, deleted_at: null },
            { id: "org-dharma", name: "Dharma", slug: "dharma", logo: null, metadata: null, createdAt: "2026-01-01T00:00:00.000Z", workspace_status: "active", plan_tier: "starter", suspended_at: null, deleted_at: null },
          ];
        }
        return [];
      });

      const res = await app.fetch(orgsRequest("GET", "/api/v1/admin/organizations"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        organizations: Array<{ id: string; workspaceStatus: string; abuseLevel?: string }>;
      };
      const lookup = Object.fromEntries(body.organizations.map((o) => [o.id, o]));
      expect(lookup["org-clean"].abuseLevel).toBe("none");
      expect(lookup["org-dharma"].workspaceStatus).toBe("active");
      expect(lookup["org-dharma"].abuseLevel).toBe("suspended");
    });

    it("GET /:id threads checkAbuseStatus into the detail response", async () => {
      abuseStatusByWorkspace.set("org-target", "throttled");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [
            { id: "org-target", name: "Target", slug: "target", logo: null, metadata: null, createdAt: "2026-01-01T00:00:00.000Z", workspace_status: "active", plan_tier: "starter", suspended_at: null, deleted_at: null },
          ];
        }
        return [];
      });

      const res = await app.fetch(orgsRequest("GET", "/api/v1/admin/organizations/org-target"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        organization: { id: string; workspaceStatus: string; abuseLevel?: string };
      };
      expect(body.organization.workspaceStatus).toBe("active");
      expect(body.organization.abuseLevel).toBe("throttled");
    });
  });
});
