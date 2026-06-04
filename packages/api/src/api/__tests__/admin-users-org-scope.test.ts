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
    logAdminActionAwait: mock(async () => {}),
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
    user: {
      id: "admin-1",
      mode: "managed",
      label: "Admin",
      role: "admin",
      activeOrganizationId: orgId,
      claims: { twoFactorEnabled: true },
    },
  });
}

/** Set auth to a workspace owner in `orgId` (effectiveRole = owner). */
function setWorkspaceOwner(orgId = "org-1"): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: {
      id: "owner-1",
      mode: "managed",
      label: "Owner",
      role: "owner",
      activeOrganizationId: orgId,
      claims: { twoFactorEnabled: true },
    },
  });
}

/**
 * Set auth to a platform admin. `orgId` is optional: ban/unban/delete are
 * cross-tenant (no org needed), but role changes write `member.role` and so
 * require an active workspace (#2890) — pass an org for those.
 */
function setPlatformAdmin(orgId?: string): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: {
      id: "platform-1",
      mode: "managed",
      label: "Platform Admin",
      role: "platform_admin",
      ...(orgId ? { activeOrganizationId: orgId } : {}),
      claims: { twoFactorEnabled: true },
    },
  });
}

/**
 * Configure mockInternalQuery to return membership results.
 * When the member lookup query is called for `allowedUserId` in org, it returns a row.
 * All other member lookups return empty (user not in org).
 *
 * Covers the three member-table queries `changeUserRole` issues: the
 * `verifyOrgMembership` SELECT and the previous-role SELECT (userId is $1),
 * and the role-write `UPDATE member ... RETURNING "userId"` (userId is $2).
 */
function mockMembershipFor(allowedUserId: string): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    // changeUserRole's member-role write: UPDATE member SET role=$1 WHERE userId=$2 ...
    if (/UPDATE\s+member/i.test(sql)) {
      return params?.[1] === allowedUserId ? [{ userId: allowedUserId }] : [];
    }
    // Match the verifyOrgMembership / previous-role SELECTs (userId is $1)
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

/** Calls to mockInternalQuery that performed a member-role UPDATE. */
function memberRoleUpdateCount(): number {
  return mocks.mockInternalQuery.mock.calls.filter(
    (call) => typeof call[0] === "string" && /UPDATE\s+member/i.test(call[0]),
  ).length;
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
      expect(memberRoleUpdateCount()).toBe(0);
    });

    it("allows role change when target user is in caller's org", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(memberRoleUpdateCount()).toBeGreaterThan(0);
    });

    it("platform admin can change role for a user in their active workspace", async () => {
      // #2890: role changes write member.role, so even a platform admin acts
      // within an active workspace (verifyOrgMembership still bypasses the
      // membership check, but the write is org-scoped). #3157: when the target
      // is a member of the active workspace, resolution uses it — assert the
      // UPDATE targets org-1, not some other resolved org.
      setPlatformAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (/update member/i.test(sql)) {
          expect(params).toEqual(["member", "user-in-any-org", "org-1"]);
          return [{ userId: "user-in-any-org" }];
        }
        if (sql.includes("member") && sql.includes("userId") && sql.includes("organizationId")) {
          return params?.[0] === "user-in-any-org" ? [{ userId: "user-in-any-org" }] : [];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-any-org/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(memberRoleUpdateCount()).toBeGreaterThan(0);
    });

    // #3157 — a platform admin on /platform/users targets users cross-tenant,
    // so the role write must resolve the TARGET's workspace, not the caller's
    // active one. Before #3157 a platform admin with no active org got a 400
    // ("select an active workspace"); now the target's membership is resolved.
    it("platform admin with no active org auto-resolves a single-workspace target (#3157)", async () => {
      setPlatformAdmin(); // no active org
      mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = sql.toLowerCase();
        if (/update member/i.test(sql)) {
          // The write targets the RESOLVED workspace (org-7), not the absent
          // active one.
          expect(params).toEqual(["admin", "user-x", "org-7"]);
          return [{ userId: "user-x" }];
        }
        // Membership resolution — exactly one workspace.
        if (s.includes("left join organization")) return [{ organizationId: "org-7", name: "Org 7" }];
        if (s.includes("count(*)")) return [{ count: "2" }]; // promotion, not a demotion
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "user-x", role: "member" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-x/role", { role: "admin" }),
      );
      expect(res.status).toBe(200);
      expect(memberRoleUpdateCount()).toBeGreaterThan(0);
    });

    it("platform admin gets 404 for a target that belongs to no workspace (#3157)", async () => {
      setPlatformAdmin();
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.toLowerCase().includes("left join organization")) return []; // no memberships
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/ghost/role", { role: "member" }),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(memberRoleUpdateCount()).toBe(0);
    });

    it("platform admin gets 400 workspace_ambiguous with candidates for a multi-workspace target (#3157)", async () => {
      setPlatformAdmin(); // no active org → cannot shortcut to the active workspace
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.toLowerCase().includes("left join organization")) {
          return [
            { organizationId: "org-a", name: "Acme" },
            { organizationId: "org-b", name: "Globex" },
          ];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/multi/role", { role: "admin" }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        workspaces: Array<{ id: string; name: string | null }>;
      };
      expect(body.error).toBe("workspace_ambiguous");
      expect(body.workspaces).toEqual([
        { id: "org-a", name: "Acme" },
        { id: "org-b", name: "Globex" },
      ]);
      expect(memberRoleUpdateCount()).toBe(0);
    });

    it("platform admin honors an explicit organizationId for a multi-workspace target (#3157)", async () => {
      setPlatformAdmin(); // no active org; the page passes the picked workspace
      mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = sql.toLowerCase();
        if (/update member/i.test(sql)) {
          // The write is scoped to the EXPLICIT workspace, not the caller's.
          expect(params).toEqual(["admin", "multi", "org-b"]);
          return [{ userId: "multi" }];
        }
        if (s.includes("count(*)")) return [{ count: "2" }];
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "multi", role: "member" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/multi/role", {
          role: "admin",
          organizationId: "org-b",
        }),
      );
      expect(res.status).toBe(200);
      expect(memberRoleUpdateCount()).toBeGreaterThan(0);
    });

    it("platform admin gets 404 for an explicit workspace the target isn't a member of (#3157)", async () => {
      setPlatformAdmin();
      mocks.mockInternalQuery.mockImplementation(async () => []); // not a member anywhere

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/multi/role", {
          role: "admin",
          organizationId: "org-z",
        }),
      );
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("not_found");
      expect(memberRoleUpdateCount()).toBe(0);
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
      expect(memberRoleUpdateCount()).toBe(0);
    });

    it("rejects platform_admin even when caller is already platform admin (must use platform endpoint)", async () => {
      setPlatformAdmin("org-1");
      mockMembershipFor("user-in-any-org");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-any-org/role", { role: "platform_admin" }),
      );
      expect(res.status).toBe(400);
      expect(memberRoleUpdateCount()).toBe(0);
    });

    // A workspace admin may assign member/admin, but NOT owner (rank guard).
    for (const role of ["member", "admin"] as const) {
      it(`accepts org role "${role}"`, async () => {
        setWorkspaceAdmin("org-1");
        mockMembershipFor("user-in-org-1");

        const res = await app.fetch(
          adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role }),
        );
        expect(res.status).toBe(200);
        expect(memberRoleUpdateCount()).toBeGreaterThan(0);
      });
    }

    // Rank guard (#2890): the direct member.role write must re-assert the org
    // plugin's rule that only an owner can grant/modify the owner role.
    it("workspace admin cannot assign the owner role (rank guard)", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "owner" }),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { message: string };
      expect(body.message).toMatch(/owner/);
      expect(memberRoleUpdateCount()).toBe(0);
    });

    it("workspace owner can assign the owner role", async () => {
      setWorkspaceOwner("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "owner" }),
      );
      expect(res.status).toBe(200);
      expect(memberRoleUpdateCount()).toBeGreaterThan(0);
    });

    it("workspace admin cannot change an existing owner's role (rank guard)", async () => {
      setWorkspaceAdmin("org-1");
      // previousRole resolves to 'owner' for the target.
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        const s = sql.toLowerCase();
        if (/update member/i.test(sql)) return [{ userId: "user-in-org-1" }];
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "user-in-org-1", role: "owner" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "admin" }),
      );
      expect(res.status).toBe(403);
      expect(memberRoleUpdateCount()).toBe(0);
    });

    // Last-admin guard (#2890): demoting the workspace's final owner/admin to
    // member is refused; a co-admin remaining allows it.
    it("refuses to demote the last admin/owner of the workspace", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        const s = sql.toLowerCase();
        if (/update member/i.test(sql)) return [{ userId: "user-in-org-1" }];
        if (s.includes("count(*)")) return [{ count: "1" }];
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "user-in-org-1", role: "admin" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "member" }),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { message: string };
      expect(body.message).toMatch(/last admin/);
      expect(memberRoleUpdateCount()).toBe(0);
    });

    it("allows demoting an admin when another admin/owner remains", async () => {
      setWorkspaceAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        const s = sql.toLowerCase();
        if (/update member/i.test(sql)) return [{ userId: "user-in-org-1" }];
        if (s.includes("count(*)")) return [{ count: "2" }];
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "user-in-org-1", role: "admin" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/user-in-org-1/role", { role: "member" }),
      );
      expect(res.status).toBe(200);
      expect(memberRoleUpdateCount()).toBeGreaterThan(0);
    });

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
        expect(memberRoleUpdateCount()).toBe(0);
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
        expect(memberRoleUpdateCount()).toBe(0);
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

    // Owner-rank guard (mirrors changeUserRoleRoute): a workspace admin must not
    // be able to remove the owner's membership, even when a co-admin remains.
    it("workspace admin cannot remove the workspace owner (rank guard)", async () => {
      setWorkspaceAdmin("org-1");
      let deleteCalled = false;
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT role FROM member")) return [{ role: "owner" }];
        if (sql.includes("SELECT COUNT(*) as count FROM member")) return [{ count: "3" }]; // co-admins remain
        if (sql.includes("DELETE FROM member")) { deleteCalled = true; return [{ id: "mem-1" }]; }
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/the-owner/membership"),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("forbidden");
      expect(body.message).toMatch(/owner/);
      expect(deleteCalled).toBe(false);
    });

    it("workspace owner can remove another owner when a co-admin remains", async () => {
      setWorkspaceOwner("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT role FROM member")) return [{ role: "owner" }];
        if (sql.includes("SELECT COUNT(*) as count FROM member")) return [{ count: "1" }];
        if (sql.includes("DELETE FROM member")) return [{ id: "mem-1" }];
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/co-owner/membership"),
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

  describe("DELETE /api/v1/admin/users/:id (F-14/#2890: platform_admin only)", () => {
    it("returns 403 for a workspace admin — global account delete is platform-only", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-org-1"),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("forbidden");
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });

    it("platform admin can delete any user", async () => {
      setPlatformAdmin();

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-in-any-org"),
      );
      expect(res.status).toBe(200);
      expect(mockRemoveUser).toHaveBeenCalled();
    });

    it("blocks deleting the last admin/owner of the platform admin's active workspace", async () => {
      setPlatformAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        const s = sql.toLowerCase();
        if (s.includes("count(*)")) return [{ count: "1" }];
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "user-x", role: "owner" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-x"),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { message: string };
      expect(body.message).toMatch(/last admin/);
      expect(mockRemoveUser).not.toHaveBeenCalled();
    });

    // #3158 — the guard-passing delete: target is an admin/owner of the active
    // workspace but a co-admin remains (count > 1), so the guard passes and the
    // global account delete (removeUser) MUST run. The guard removes the user
    // from the active workspace under the lock, then removeUser runs after the
    // lock releases. Guards against a regression that returns "ok"/403 without
    // actually deleting the account.
    it("deletes an admin when a co-admin remains, invoking removeUser", async () => {
      setPlatformAdmin("org-1");
      mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
        const s = sql.toLowerCase();
        if (s.includes("count(*)")) return [{ count: "2" }]; // co-admin remains
        if (s.includes("member") && s.includes("userid") && s.includes("organizationid")) {
          return [{ userId: "user-x", role: "admin" }];
        }
        return [];
      });

      const res = await app.fetch(
        adminRequest("DELETE", "/api/v1/admin/users/user-x"),
      );
      expect(res.status).toBe(200);
      expect(mockRemoveUser).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/admin/users/:id/revoke (F-14/#2890: platform_admin only)", () => {
    it("returns 403 for a workspace admin — global session revoke is platform-only", async () => {
      setWorkspaceAdmin("org-1");
      mockMembershipFor("user-in-org-1");

      const res = await app.fetch(
        adminRequest("POST", "/api/v1/admin/users/user-in-org-1/revoke"),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("forbidden");
      expect(mockRevokeSessions).not.toHaveBeenCalled();
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

  describe("no active org (per-org member.role model)", () => {
    it("returns 400 when the caller has no active workspace (#2890)", async () => {
      // #2890: role changes write member.role, which is per-org. A managed
      // caller with no activeOrganizationId has no member row to target, so
      // the endpoint rejects rather than writing a global user.role.
      mocks.mockAuthenticateRequest.mockResolvedValue({
        authenticated: true,
        mode: "managed",
        user: { id: "admin-1", mode: "managed", label: "Admin", role: "admin" },
      });

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("invalid_request");
      expect(memberRoleUpdateCount()).toBe(0);
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
      expect(memberRoleUpdateCount()).toBe(0);
    });
  });

  describe("hasInternalDB = false", () => {
    it("returns 404 when no internal DB is available — member.role write needs it (#2890)", async () => {
      setWorkspaceAdmin("org-1");
      mocks.hasInternalDB = false;

      const res = await app.fetch(
        adminRequest("PATCH", "/api/v1/admin/users/any-user/role", { role: "member" }),
      );
      expect(res.status).toBe(404);
      expect(memberRoleUpdateCount()).toBe(0);
    });
  });
});
