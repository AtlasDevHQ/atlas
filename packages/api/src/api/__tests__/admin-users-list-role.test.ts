/**
 * #3165 — the cross-tenant `/platform/users` list must surface each user's
 * EFFECTIVE workspace `member.role`, not the raw user-level `user.role` (which
 * only ever holds `platform_admin` after #2890). Otherwise a workspace owner
 * renders as `member`, and the role dropdown treats an owner→admin change as a
 * promotion — skipping the demotion-confirm dialog.
 *
 * Covers the pure `highestMemberRole` summarizer and the enriched list route.
 *
 * #3159 — the global user list is now a direct `SELECT … FROM "user"` query
 * (`listPlatformUsers`) rather than the Better Auth admin plugin's `listUsers`,
 * so the rows are seeded through `mockInternalQuery` instead of a plugin mock.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { highestMemberRole } from "../routes/admin";

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-1",
    mode: "managed",
    label: "Platform Admin",
    role: "platform_admin",
  },
  authMode: "managed",
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function adminRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
  });
}

function setPlatformAdmin(): void {
  mocks.mockAuthenticateRequest.mockResolvedValue({
    authenticated: true,
    mode: "managed",
    user: {
      id: "platform-1",
      mode: "managed",
      label: "Platform Admin",
      role: "platform_admin",
      claims: { twoFactorEnabled: true },
    },
  });
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

/**
 * Route the two queries `listPlatformUsers` issues (the paged `SELECT … FROM
 * "user"` and its `COUNT(*)`) plus the `#3165` member-enrichment lookup through
 * one `mockInternalQuery` implementation. `memberRows === null` makes the
 * member lookup throw (the fail-closed path).
 */
function seedUsersAndMembers(
  users: UserRow[],
  memberRows: Array<{ userId: string; role: string }> | null,
): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
    if (/count\(\*\)/i.test(sql) && /from "user"/i.test(sql)) {
      return [{ count: String(users.length) }];
    }
    if (/from "user"/i.test(sql)) {
      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: u.createdAt,
      }));
    }
    if (/from member where "userid" = any/i.test(sql)) {
      if (memberRows === null) throw new Error("DB down");
      return memberRows;
    }
    return [];
  });
}

describe("highestMemberRole (#3165)", () => {
  it("returns undefined for no memberships", () => {
    expect(highestMemberRole([])).toBeUndefined();
  });
  it("returns the only role for a single membership", () => {
    expect(highestMemberRole(["member"])).toBe("member");
    expect(highestMemberRole(["owner"])).toBe("owner");
  });
  it("returns the highest-ranked role across workspaces", () => {
    expect(highestMemberRole(["member", "owner"])).toBe("owner");
    expect(highestMemberRole(["admin", "member"])).toBe("admin");
    expect(highestMemberRole(["member", "admin", "owner"])).toBe("owner");
  });
  it("ranks an unknown role above owner so the UI fail-closes (always confirms) on it", () => {
    expect(highestMemberRole(["member", "billing-admin"])).toBe("billing-admin");
    expect(highestMemberRole(["owner", "weird"])).toBe("weird");
  });
});

describe("GET /api/v1/admin/users — effective workspace role (#3165)", () => {
  beforeEach(() => {
    mocks.mockAuthenticateRequest.mockReset();
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    mocks.hasInternalDB = true;
    setPlatformAdmin();
  });

  it("surfaces each user's highest member.role; platform_admin stays as-is", async () => {
    seedUsersAndMembers(
      [
        // The user-level role: owners/admins look like plain members here
        // (only platform_admin survives on user.role post-#2890).
        { id: "u-owner", email: "owner@x.dev", name: "O", role: "member", createdAt: "2026-01-01" },
        { id: "u-multi", email: "multi@x.dev", name: "M", role: "member", createdAt: "2026-01-02" },
        { id: "u-pa", email: "pa@x.dev", name: "P", role: "platform_admin", createdAt: "2026-01-03" },
        { id: "u-none", email: "none@x.dev", name: "N", role: "member", createdAt: "2026-01-04" },
      ],
      [
        { userId: "u-owner", role: "owner" },
        { userId: "u-multi", role: "member" },
        { userId: "u-multi", role: "admin" },
        { userId: "u-pa", role: "owner" }, // ignored — u-pa is platform_admin
      ],
    );

    const res = await app.fetch(adminRequest("GET", "/api/v1/admin/users"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string; role: string }> };
    const roleById = Object.fromEntries(body.users.map((u) => [u.id, u.role]));

    expect(roleById["u-owner"]).toBe("owner"); // was "member" pre-fix
    expect(roleById["u-multi"]).toBe("admin"); // highest of {member, admin}
    expect(roleById["u-pa"]).toBe("platform_admin"); // user-level role preserved
    expect(roleById["u-none"]).toBe("member"); // no memberships → falls back
  });

  it("degrades tenant roles to the 'unknown' sentinel (fail-closed), still 200s, when the member lookup fails", async () => {
    // Falling back to user.role would render an owner as "member" and silently
    // skip the demotion confirm (the very #3165 bug). The unknown sentinel makes
    // the web's isDemotion fail-closed (always confirm) while the lookup is broken.
    seedUsersAndMembers(
      [
        { id: "u-1", email: "a@x.dev", name: "A", role: "member", createdAt: "2026-01-01" },
        { id: "u-pa", email: "pa@x.dev", name: "P", role: "platform_admin", createdAt: "2026-01-02" },
      ],
      null, // member lookup throws
    );

    const res = await app.fetch(adminRequest("GET", "/api/v1/admin/users"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string; role: string }> };
    const roleById = Object.fromEntries(body.users.map((u) => [u.id, u.role]));
    expect(roleById["u-1"]).toBe("unknown"); // NOT "member" — fail-closed
    expect(roleById["u-pa"]).toBe("platform_admin"); // user-level role unaffected by the lookup
  });
});
