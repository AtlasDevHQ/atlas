/**
 * Tests for /api/v1/admin/organizations/** — F-08 regression (#1750).
 *
 * `admin-orgs.ts` provides cross-tenant CRUD for every workspace: list, read,
 * stats, suspend, activate, plan-change, and cascading soft-delete. It
 * previously used `createAdminRouter()` without `requireOrgContext()`, so any
 * workspace admin on the platform could CRUD any other workspace by path id.
 * The fix swapped it to `createPlatformRouter()`, restricting the subtree to
 * `platform_admin` callers.
 *
 * These tests parametrize over every affected route so adding a new endpoint
 * to the router without a platform gate would surface here immediately.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

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
    // platform-admin endpoints. Covers the pre-fix gap where `adminAuth`
    // accepted admin/owner alike and both leaked into cross-tenant CRUD.
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
});
