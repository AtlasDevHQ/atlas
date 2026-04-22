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

// --- Audit mock — capture logAdminAction calls to verify the compliance path ---
const mockLogAdminAction: Mock<(entry: unknown) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  // Pass the real ADMIN_ACTIONS enum through so route handlers get correct constants.
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

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
    mockLogAdminAction.mockClear();
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

    // Case-sensitivity and off-tuple fuzz — z.enum is case-sensitive, so any
    // casing other than the literal tuple members is rejected. If someone
    // "helpfully" lowercases the input before validation in the future, these
    // tests fail and surface the regression.
    for (const badRole of ["PLATFORM_ADMIN", "Platform_Admin", " platform_admin ", "superadmin", "ADMIN", "Member"]) {
      it(`rejects off-tuple role string ${JSON.stringify(badRole)}`, async () => {
        setWorkspaceAdmin("org-1");
        mockMembershipFor("user-in-org-1");

        const res = await app.fetch(
          adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: badRole }),
        );
        expect(res.status).toBe(400);
        expect(mockSetRole).not.toHaveBeenCalled();
      });
    }

    for (const badPayload of [{}, { role: null }, { role: 42 }, { role: ["admin"] }, { role: { nested: "admin" } }]) {
      it(`rejects non-string / missing role payload ${JSON.stringify(badPayload)}`, async () => {
        setWorkspaceAdmin("org-1");
        mockMembershipFor("user-in-org-1");

        const res = await app.fetch(
          adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", badPayload),
        );
        expect(res.status).toBe(400);
        expect(mockSetRole).not.toHaveBeenCalled();
      });
    }
  });

  describe("POST /api/v1/admin/users/:id/ban (F-14: platform_admin only)", () => {
    it("returns 403 for workspace admin — ban is now platform-admin only", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/ban", {}),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("/membership");
      expect(mockBanUser).not.toHaveBeenCalled();
    });

    it("platform admin can ban any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/ban", {}),
      );
      expect(res.status).toBe(200);
      expect(mockBanUser).toHaveBeenCalled();
    });

    it("platform admin ban emits logAdminAction with user.ban", async () => {
      setPlatformAdmin();

      await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-any-org/ban", {}),
      );

      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0] as { actionType: string; targetId: string };
      expect(entry.actionType).toBe("user.ban");
      expect(entry.targetId).toBe("user-in-any-org");
    });
  });

  describe("DELETE /api/v1/admin/users/:id/membership (F-14: workspace-scoped removal)", () => {
    it("workspace admin removes member from their own org only", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes("DELETE FROM member")) {
          expect(params).toEqual(["user-in-org-1", "org-1"]);
          return [{ id: "mem-1" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-1/membership"),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it("returns 404 when the target is not a member of the caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("DELETE FROM member")) return [];
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-2/membership"),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("rejects self-removal (400/403)", async () => {
      setWorkspaceAdmin("org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/admin-1/membership"),
      );
      expect(res.status).toBe(403);
    });

    it("refuses to remove the last admin/owner of the workspace", async () => {
      setWorkspaceAdmin("org-1");
      // Target is the only admin. The last-admin guard queries member role
      // then counts remaining admins excluding the target.
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT role FROM member")) return [{ role: "admin" }];
        if (sql.includes("SELECT COUNT(*) as count FROM member")) return [{ count: "0" }];
        if (sql.includes("DELETE FROM member")) return [{ id: "mem-1" }];
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/only-admin/membership"),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("last admin");
    });

    it("allows removing an admin when at least one other admin remains", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT role FROM member")) return [{ role: "admin" }];
        if (sql.includes("SELECT COUNT(*) as count FROM member")) return [{ count: "1" }];
        if (sql.includes("DELETE FROM member")) return [{ id: "mem-1" }];
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/co-admin/membership"),
      );
      expect(res.status).toBe(200);
    });

    it("emits logAdminAction with user.remove_from_workspace action type", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT role FROM member")) return [{ role: "member" }];
        if (sql.includes("DELETE FROM member")) return [{ id: "mem-1" }];
        return [];
      });

      await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-1/membership"),
      );

      expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
      const entry = mockLogAdminAction.mock.calls[0]![0] as {
        actionType: string;
        targetType: string;
        targetId: string;
        metadata: Record<string, unknown>;
      };
      expect(entry.actionType).toBe("user.remove_from_workspace");
      expect(entry.targetType).toBe("user");
      expect(entry.targetId).toBe("user-in-org-1");
      expect(entry.metadata.orgId).toBe("org-1");
      expect(entry.metadata.previousRole).toBe("member");
    });
  });

  describe("POST /api/v1/admin/users/:id/unban (F-14: platform_admin only)", () => {
    it("returns 403 for workspace admin — unban is now platform-admin only", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/unban", {}),
      );
      expect(res.status).toBe(403);
      expect(mockUnbanUser).not.toHaveBeenCalled();
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
