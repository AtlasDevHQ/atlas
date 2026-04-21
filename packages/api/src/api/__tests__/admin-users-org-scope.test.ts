/**
 * Tests for org-scoped user write operations (#983).
 *
 * Verifies that workspace admins can only modify (role change, ban, unban,
 * delete, revoke sessions) users within their own organization. Platform
 * admins bypass the check. Returns 404 (not 403) when the target user is
 * not in the caller's org to avoid revealing existence across tenants.
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
    mode: "managed",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
  authMode: "managed",
});

// --- Test-specific overrides: Better Auth admin API ---

const mockSetRole: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockBanUser: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockUnbanUser: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockRemoveUser: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));
const mockRevokeSessions: Mock<(opts: unknown) => Promise<unknown>> = mock(() => Promise.resolve({}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: {
      listUsers: mock(() => Promise.resolve({ users: [], total: 0 })),
      setRole: mockSetRole,
      banUser: mockBanUser,
      unbanUser: mockUnbanUser,
      removeUser: mockRemoveUser,
      revokeSessions: mockRevokeSessions,
    },
  }),
}));

// --- Import app after mocks ---

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// --- Helpers ---

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

/** Set auth to a workspace admin in org-1 (non-platform). */
function setWorkspaceAdmin(orgId = "org-1"): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin", activeOrganizationId: orgId },
  });
}

/** Set auth to a platform admin (no org boundary). */
function setPlatformAdmin(): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: { id: "platform-1", mode: "managed", label: "Platform Admin", role: "platform_admin" },
  });
}

/**
 * Configure mockInternalQuery to return membership results.
 * When the member lookup query is called for `allowedUserId` in org, it returns a row.
 * All other member lookups return empty (user not in org).
 */
function mockMembershipFor(allowedUserId: string): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    // Match the verifyOrgMembership query
    if (sql.includes("member") && sql.includes("userId") && sql.includes("organizationId")) {
      const targetId = params?.[0];
      if (targetId === allowedUserId) {
        return [{ userId: allowedUserId }];
      }
      return [];
    }
    // Default: return empty for any other query (IP allowlist, admin count, etc.)
    return [];
  });
}

// --- Tests ---

describe("Org-scoped user write operations (#983)", () => {
  beforeEach(() => {
    mocks.mockAuthenticateRequest.mockReset();
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    mockSetRole.mockClear();
    mockBanUser.mockClear();
    mockUnbanUser.mockClear();
    mockRemoveUser.mockClear();
    mockRevokeSessions.mockClear();
    mocks.hasInternalDB = true;
  });

  describe("PATCH /api/v1/admin/users/:id/role", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-2/role", { role: "member" }),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockSetRole).not.toHaveBeenCalled();
    });

    it("allows role change when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });

    it("platform admin can change role for any user regardless of org", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-any-org/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });

    // Regression test for F-10 (#1752): workspace admin cannot escalate an org
    // member to platform_admin via the role-change endpoint. The endpoint now
    // accepts only org-level roles; platform_admin must be granted through a
    // platform-admin-gated endpoint.
    it("rejects platform_admin role (workspace admin cannot escalate to platform admin)", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "platform_admin" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("invalid_request");
      expect(body.message).toMatch(/platform_admin/);
      expect(mockSetRole).not.toHaveBeenCalled();
    });

    it("rejects platform_admin even when caller is already platform admin (must use platform endpoint)", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-any-org/role", { role: "platform_admin" }),
      );
      expect(res.status).toBe(400);
      expect(mockSetRole).not.toHaveBeenCalled();
    });

    for (const role of ["member", "admin", "owner"] as const) {
      it(`accepts org role "${role}"`, async () => {
        setWorkspaceAdmin("org-1");
        mockMembershipFor("user-in-org-1");

        const res = await app.fetch(
          adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role }),
        );
        expect(res.status).toBe(200);
        expect(mockSetRole).toHaveBeenCalled();
      });
    }
  });

  describe("POST /api/v1/admin/users/:id/ban", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-2/ban", {}),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockBanUser).not.toHaveBeenCalled();
    });

    it("allows ban when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/ban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockBanUser).toHaveBeenCalled();
    });

    it("platform admin can ban any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/ban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockBanUser).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/admin/users/:id/unban", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-2/unban", {}),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockUnbanUser).not.toHaveBeenCalled();
    });

    it("allows unban when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/unban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockUnbanUser).toHaveBeenCalled();
    });

    it("platform admin can unban any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/unban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockUnbanUser).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/v1/admin/users/:id", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-2"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });

    it("allows delete when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-1"),
      );
      expect(res.status).toBe(200);
      expect(mockRemoveUser).toHaveBeenCalled();
    });

    it("platform admin can delete any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-any-org"),
      );
      expect(res.status).toBe(200);
      expect(mockRemoveUser).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/admin/users/:id/revoke", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-2/revoke"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(mockRevokeSessions).not.toHaveBeenCalled();
    });

    it("allows session revocation when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/revoke"),
      );
      expect(res.status).toBe(200);
      expect(mockRevokeSessions).toHaveBeenCalled();
    });

    it("platform admin can revoke sessions for any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/revoke"),
      );
      expect(res.status).toBe(200);
      expect(mockRevokeSessions).toHaveBeenCalled();
    });
  });

  describe("DELETE /api/v1/admin/sessions/user/:userId", () => {
    it("returns 404 when target user is not in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/sessions/user/user-in-org-2"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("allows session deletion when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/sessions/user/user-in-org-1"),
      );
      // 200 or 404 (no sessions found) — both are acceptable, not a cross-org leak
      expect([200, 404]).toContain(res.status);
    });
  });

  describe("self-hosted (no org context)", () => {
    it("allows role change without org scoping when no activeOrganizationId", async () => {
      // Self-hosted: no org context
      mocks.mockAuthenticateRequest.mockResolvedValue({
        authenticated: true,
        mode: "managed",
        user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin" },
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });
  });

  describe("DB error in membership check", () => {
    it("returns 500 when internalQuery throws during org membership check", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("member") && sql.includes("userId") && sql.includes("organizationId")) {
          throw new Error("DB connection timeout");
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      // Should fail closed — 500, not 200
      expect(res.status).toBe(500);
      expect(mockSetRole).not.toHaveBeenCalled();
    });
  });

  describe("hasInternalDB = false bypass", () => {
    it("bypasses membership check when no internal DB is available", async () => {
      setWorkspaceAdmin("org-1");
      mocks.hasInternalDB = false;

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(mockSetRole).toHaveBeenCalled();
    });
  });
});
