import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);

const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));

let mockAuthMode = "none";
mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
}));

mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Import after mocks
const {
  PERMISSIONS,
  BUILTIN_ROLES,
  isValidPermission,
  isValidRoleName,
  resolvePermissions,
  hasPermission,
  checkPermission,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  listRoleMembers,
  assignRole,
  seedBuiltinRoles,
  RoleError,
} = await import("./roles");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

function resetMocks() {
  ee.reset();
  mockAuthMode = "none";
}

function makeRoleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "role-1",
    org_id: "org-1",
    name: "analyst",
    description: "Can query data and view audit logs",
    permissions: JSON.stringify(["query", "query:raw_data", "admin:audit"]),
    is_builtin: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    mode: "managed" as const,
    label: "test@example.com",
    role: "admin" as const,
    activeOrganizationId: "org-1",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Permission validation", () => {
  it("validates known permissions", () => {
    expect(isValidPermission("query")).toBe(true);
    expect(isValidPermission("query:raw_data")).toBe(true);
    expect(isValidPermission("admin:users")).toBe(true);
    expect(isValidPermission("admin:roles")).toBe(true);
    expect(isValidPermission("invalid")).toBe(false);
    expect(isValidPermission("")).toBe(false);
  });

  it("PERMISSIONS array has expected entries", () => {
    expect(PERMISSIONS).toContain("query");
    expect(PERMISSIONS).toContain("query:raw_data");
    expect(PERMISSIONS).toContain("admin:users");
    expect(PERMISSIONS).toContain("admin:connections");
    expect(PERMISSIONS).toContain("admin:settings");
    expect(PERMISSIONS).toContain("admin:audit");
    expect(PERMISSIONS).toContain("admin:roles");
    expect(PERMISSIONS).toContain("admin:semantic");
    expect(PERMISSIONS.length).toBe(8);
  });
});

describe("Role name validation", () => {
  it("accepts valid role names", () => {
    expect(isValidRoleName("analyst")).toBe(true);
    expect(isValidRoleName("data-engineer")).toBe(true);
    expect(isValidRoleName("team_lead")).toBe(true);
    expect(isValidRoleName("a")).toBe(true);
    expect(isValidRoleName("role123")).toBe(true);
  });

  it("rejects invalid role names", () => {
    expect(isValidRoleName("")).toBe(false);
    expect(isValidRoleName("123abc")).toBe(false); // starts with number
    expect(isValidRoleName("my role")).toBe(false); // space
    // Note: uppercase is accepted because isValidRoleName normalizes to lowercase
    expect(isValidRoleName("-dash")).toBe(false); // starts with dash
  });
});

describe("Built-in roles", () => {
  it("defines admin, analyst, and viewer", () => {
    const names = BUILTIN_ROLES.map((r) => r.name);
    expect(names).toContain("admin");
    expect(names).toContain("analyst");
    expect(names).toContain("viewer");
    expect(names.length).toBe(3);
  });

  it("admin has all permissions", () => {
    const adminRole = BUILTIN_ROLES.find((r) => r.name === "admin");
    expect(adminRole).toBeDefined();
    expect(adminRole!.permissions.length).toBe(PERMISSIONS.length);
  });

  it("viewer has only query permission", () => {
    const viewer = BUILTIN_ROLES.find((r) => r.name === "viewer");
    expect(viewer).toBeDefined();
    expect(viewer!.permissions).toEqual(["query"]);
  });

  it("analyst has query, raw_data, and audit", () => {
    const analyst = BUILTIN_ROLES.find((r) => r.name === "analyst");
    expect(analyst).toBeDefined();
    expect(analyst!.permissions).toContain("query");
    expect(analyst!.permissions).toContain("query:raw_data");
    expect(analyst!.permissions).toContain("admin:audit");
    expect(analyst!.permissions.length).toBe(3);
  });
});

describe("resolvePermissions", () => {
  beforeEach(resetMocks);

  it("returns all permissions for undefined user in no-auth mode", async () => {
    mockAuthMode = "none";
    const perms = await run(resolvePermissions(undefined));
    expect(perms.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(perms.has(p)).toBe(true);
    }
  });

  it("returns empty permissions for undefined user in managed auth mode", async () => {
    mockAuthMode = "managed";
    const perms = await run(resolvePermissions(undefined));
    expect(perms.size).toBe(0);
  });

  it("returns custom role permissions when found in DB", async () => {
    ee.queueMockRows([makeRoleRow({
      permissions: JSON.stringify(["query", "admin:audit"]),
    })]);

    const user = makeUser({ role: "analyst" });
    const perms = await run(resolvePermissions(user));
    expect(perms.has("query")).toBe(true);
    expect(perms.has("admin:audit")).toBe(true);
    expect(perms.has("admin:users")).toBe(false);
    expect(perms.size).toBe(2);
  });

  it("falls back to legacy for admin role when no custom role in DB", async () => {
    ee.queueMockRows([]); // No custom role found

    const user = makeUser({ role: "admin" });
    const perms = await run(resolvePermissions(user));
    expect(perms.size).toBe(PERMISSIONS.length);
  });

  // F-53 made `LEGACY_ROLE_PERMISSIONS` load-bearing — the table now gates
  // route access, not just UI display. Without `platform_admin` in the table
  // (added alongside this fix), platform admins fall through to the
  // `member` default and lose every admin:* flag the moment the route layer
  // starts consulting the table for real. This test locks the entry.
  it("falls back to legacy for platform_admin role with full access", async () => {
    ee.queueMockRows([]); // No custom row → legacy mapping

    const user = makeUser({ role: "platform_admin" });
    const perms = await run(resolvePermissions(user));
    expect(perms.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(perms.has(p)).toBe(true);
    }
  });

  it("falls back to legacy for member role when no custom role in DB", async () => {
    ee.queueMockRows([]); // No custom role found

    const user = makeUser({ role: "member" });
    const perms = await run(resolvePermissions(user));
    expect(perms.has("query")).toBe(true);
    expect(perms.has("query:raw_data")).toBe(true);
    expect(perms.has("admin:users")).toBe(false);
  });

  it("falls back to member permissions for unknown roles", async () => {
    ee.queueMockRows([]); // No custom role found

    const user = makeUser({ role: undefined });
    const perms = await run(resolvePermissions(user));
    expect(perms.has("query")).toBe(true);
    expect(perms.has("query:raw_data")).toBe(true);
    expect(perms.has("admin:users")).toBe(false);
  });

  it("fails closed with empty permissions on corrupt role data", async () => {
    // Simulate corrupt JSON in permissions column
    ee.queueMockRows([{ id: "r1", org_id: "org-1", name: "test", description: "", permissions: "INVALID_JSON{", is_builtin: false, created_at: "", updated_at: "" }]);

    const user = makeUser({ role: "test" });
    const perms = await run(resolvePermissions(user));
    // Corrupt data → empty permissions (fail closed), not elevated legacy
    expect(perms.size).toBe(0);
    expect(perms.has("admin:users")).toBe(false);
  });

  // F-53 — the `Effect.die` branch on unexpected DB errors (and the
  // `Effect.succeed(null)` branch for the "table does not exist" migration
  // case) are exercised end-to-end at the route layer in
  // `packages/api/src/api/routes/__tests__/permission-enforcement.test.ts`
  // ("fail-closed when checkPermission defects"). The `createEEMock` shim
  // doesn't currently support per-test query rejection, so locking the
  // unit-level branch from here would require a shim change out of scope
  // for F-53. The route-level coverage is the load-bearing assertion
  // either way — that's what users see.
});

describe("hasPermission", () => {
  beforeEach(resetMocks);

  it("returns true when user has the permission", async () => {
    ee.queueMockRows([]); // Falls back to legacy admin
    expect(await run(hasPermission(makeUser({ role: "admin" }), "admin:users"))).toBe(true);
  });

  it("returns false when user lacks the permission", async () => {
    ee.queueMockRows([]); // Falls back to legacy member
    expect(await run(hasPermission(makeUser({ role: "member" }), "admin:users"))).toBe(false);
  });
});

describe("checkPermission", () => {
  beforeEach(resetMocks);

  it("returns null when permission is satisfied", async () => {
    ee.queueMockRows([]); // Legacy admin
    const result = await run(checkPermission(makeUser({ role: "admin" }), "admin:users", "req-1"));
    expect(result).toBeNull();
  });

  it("returns error response when permission is denied", async () => {
    ee.queueMockRows([]); // Legacy member
    const result = await run(checkPermission(makeUser({ role: "member" }), "admin:users", "req-1"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.body.error).toBe("insufficient_permissions");
    expect(result!.body.requestId).toBe("req-1");
  });
});

describe("CRUD operations", () => {
  beforeEach(resetMocks);

  describe("listRoles", () => {
    it("throws when enterprise is not enabled", async () => {
      ee.setEnterpriseEnabled(false);
      await expect(run(listRoles("org-1"))).rejects.toThrow("Enterprise features");
    });

    it("returns roles from DB", async () => {
      // seedBuiltinRoles: 3 built-in roles × (SELECT existence check + INSERT if needed)
      // Each SELECT returns a row (already exists), so no INSERT needed
      ee.queueMockRows([{ id: "r1" }]); // admin exists
      ee.queueMockRows([{ id: "r2" }]); // analyst exists
      ee.queueMockRows([{ id: "r3" }]); // viewer exists
      // listRoles query result
      ee.queueMockRows([
        makeRoleRow(),
        makeRoleRow({ id: "role-2", name: "custom", is_builtin: false }),
      ]);

      const roles = await run(listRoles("org-1"));
      expect(roles.length).toBe(2);
      expect(roles[0].name).toBe("analyst");
      expect(roles[1].name).toBe("custom");
    });
  });

  describe("getRole", () => {
    it("returns role when found", async () => {
      ee.queueMockRows([makeRoleRow()]);
      const role = await run(getRole("org-1", "role-1"));
      expect(role).not.toBeNull();
      expect(role!.name).toBe("analyst");
    });

    it("returns null when not found", async () => {
      ee.queueMockRows([]);
      const role = await run(getRole("org-1", "nonexistent"));
      expect(role).toBeNull();
    });
  });

  describe("createRole", () => {
    it("creates a custom role", async () => {
      ee.queueMockRows([]); // uniqueness check
      ee.queueMockRows([makeRoleRow({
        id: "new-role",
        name: "data-engineer",
        is_builtin: false,
        permissions: JSON.stringify(["query", "admin:connections"]),
      })]);

      const role = await run(createRole("org-1", {
        name: "data-engineer",
        description: "Can query and manage connections",
        permissions: ["query", "admin:connections"],
      }));

      expect(role.name).toBe("data-engineer");
      expect(role.isBuiltin).toBe(false);
      expect(role.permissions).toContain("query");
      expect(role.permissions).toContain("admin:connections");
    });

    it("rejects invalid role names", async () => {
      await expect(
        run(createRole("org-1", { name: "123invalid", permissions: ["query"] })),
      ).rejects.toThrow("Invalid role name");
    });

    it("rejects invalid permissions", async () => {
      await expect(
        run(createRole("org-1", { name: "test", permissions: ["nonexistent"] })),
      ).rejects.toThrow("Invalid permissions");
    });

    it("rejects reserved legacy role names", async () => {
      await expect(
        run(createRole("org-1", { name: "member", permissions: ["query"] })),
      ).rejects.toThrow("reserved role name");

      await expect(
        run(createRole("org-1", { name: "owner", permissions: ["query"] })),
      ).rejects.toThrow("reserved role name");
    });

    // Regression test for F-10 (#1752): workspace admin cannot create a
    // custom role named `platform_admin`, which — combined with assignRole
    // — would otherwise promote any org member to cross-org governance.
    it("rejects platform_admin as a reserved role name", async () => {
      await expect(
        run(createRole("org-1", { name: "platform_admin", permissions: ["query"] })),
      ).rejects.toThrow("reserved role name");
    });

    it("rejects every ATLAS_ROLES built-in name (case-insensitive)", async () => {
      const { ATLAS_ROLES } = await import("@atlas/api/lib/auth/types");
      for (const builtin of ATLAS_ROLES) {
        // Lower-cased by the validator before matching, so any case of the
        // reserved name is rejected.
        await expect(
          run(createRole("org-1", { name: builtin.toUpperCase(), permissions: ["query"] })),
        ).rejects.toThrow("reserved role name");
      }
    });

    it("rejects duplicate names", async () => {
      ee.queueMockRows([{ id: "existing" }]); // uniqueness check finds existing

      await expect(
        run(createRole("org-1", { name: "analyst", permissions: ["query"] })),
      ).rejects.toThrow("already exists");
    });
  });

  describe("updateRole", () => {
    it("updates description and permissions", async () => {
      // getRole lookup
      ee.queueMockRows([makeRoleRow({ is_builtin: false })]);
      // UPDATE query
      ee.queueMockRows([makeRoleRow({
        is_builtin: false,
        description: "Updated description",
        permissions: JSON.stringify(["query"]),
      })]);

      const role = await run(updateRole("org-1", "role-1", {
        description: "Updated description",
        permissions: ["query"],
      }));

      expect(role.description).toBe("Updated description");
    });

    it("rejects modification of built-in roles", async () => {
      ee.queueMockRows([makeRoleRow({ is_builtin: true })]);

      await expect(
        run(updateRole("org-1", "role-1", { permissions: ["query"] })),
      ).rejects.toThrow("Built-in roles cannot be modified");
    });

    it("rejects when role not found", async () => {
      ee.queueMockRows([]); // getRole returns nothing

      await expect(
        run(updateRole("org-1", "nonexistent", { permissions: ["query"] })),
      ).rejects.toThrow("not found");
    });
  });

  describe("deleteRole", () => {
    it("deletes a custom role with no active members", async () => {
      // getRole (via internalQuery) returns custom role
      ee.queueMockRows([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: getRole returns the role again
      ee.queueMockRows([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: member table query returns empty (no members)
      ee.queueMockRows([]);
      // DELETE (via getInternalDB().query) returns the deleted row
      ee.queueMockRows([{ id: "role-1" }]);

      const result = await run(deleteRole("org-1", "role-1"));
      expect(result).toBe(true);
    });

    it("rejects deletion when role has active members", async () => {
      ee.queueMockRows([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: getRole
      ee.queueMockRows([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: member table returns 2 members
      ee.queueMockRows([
        { userId: "u1", role: "analyst", createdAt: "2026-01-01" },
        { userId: "u2", role: "analyst", createdAt: "2026-01-01" },
      ]);

      await expect(
        run(deleteRole("org-1", "role-1")),
      ).rejects.toThrow("Cannot delete role with 2 active member(s)");
    });

    it("rejects deletion of built-in roles", async () => {
      ee.queueMockRows([makeRoleRow({ is_builtin: true })]);

      await expect(
        run(deleteRole("org-1", "role-1")),
      ).rejects.toThrow("Built-in roles cannot be deleted");
    });

    it("returns false when role not found", async () => {
      ee.queueMockRows([]); // getRole returns nothing

      const result = await run(deleteRole("org-1", "nonexistent"));
      expect(result).toBe(false);
    });
  });
});

describe("Role assignment", () => {
  beforeEach(resetMocks);

  describe("listRoleMembers", () => {
    it("returns members for a role", async () => {
      // getRole lookup
      ee.queueMockRows([makeRoleRow()]);
      // member query
      ee.queueMockRows([
        { userId: "user-1", role: "analyst", createdAt: "2026-01-01" },
        { userId: "user-2", role: "analyst", createdAt: "2026-01-02" },
      ]);

      const members = await run(listRoleMembers("org-1", "role-1"));
      expect(members.length).toBe(2);
      expect(members[0].userId).toBe("user-1");
    });

    it("throws when role not found", async () => {
      ee.queueMockRows([]); // getRole returns nothing

      await expect(
        run(listRoleMembers("org-1", "nonexistent")),
      ).rejects.toThrow("not found");
    });
  });

  describe("assignRole", () => {
    it("assigns a role to a user", async () => {
      // Role existence check
      ee.queueMockRows([{ id: "role-1" }]);
      // UPDATE member
      ee.queueMockRows([{ userId: "user-1", role: "analyst" }]);

      const result = await run(assignRole("org-1", "user-1", "analyst"));
      expect(result.userId).toBe("user-1");
      expect(result.role).toBe("analyst");
    });

    it("rejects when role does not exist", async () => {
      ee.queueMockRows([]); // role not found

      await expect(
        run(assignRole("org-1", "user-1", "nonexistent")),
      ).rejects.toThrow("does not exist");
    });

    it("rejects when user is not a member", async () => {
      ee.queueMockRows([{ id: "role-1" }]); // role exists
      ee.queueMockRows([]); // member update returns nothing

      await expect(
        run(assignRole("org-1", "user-1", "analyst")),
      ).rejects.toThrow("not a member");
    });

    // Regression test for F-10 (#1752): belt-and-suspenders against a legacy
    // custom_roles row named `platform_admin`. Even if createRole's reservation
    // check was bypassed historically, assignRole refuses to write a built-in
    // role name into member.role from the custom-role path.
    it("rejects any ATLAS_ROLES built-in name as a custom role assignment (case-insensitive)", async () => {
      const { ATLAS_ROLES } = await import("@atlas/api/lib/auth/types");
      for (const builtin of ATLAS_ROLES) {
        await expect(
          run(assignRole("org-1", "user-1", builtin)),
        ).rejects.toThrow("built-in Atlas role");
        await expect(
          run(assignRole("org-1", "user-1", builtin.toUpperCase())),
        ).rejects.toThrow("built-in Atlas role");
      }
    });
  });
});

describe("seedBuiltinRoles", () => {
  beforeEach(resetMocks);

  it("seeds all three built-in roles when none exist", async () => {
    // Three existence checks, all empty
    ee.queueMockRows([], [], []);

    await run(seedBuiltinRoles("org-1"));

    // 3 SELECTs + 3 INSERTs = 6 queries
    const selects = ee.capturedQueries.filter((q) => q.sql.includes("SELECT"));
    const inserts = ee.capturedQueries.filter((q) => q.sql.includes("INSERT"));
    expect(selects.length).toBe(3);
    expect(inserts.length).toBe(3);
  });

  it("skips roles that already exist", async () => {
    // First two exist, third doesn't
    ee.queueMockRows([{ id: "existing" }], [{ id: "existing" }], []);

    await run(seedBuiltinRoles("org-1"));

    const inserts = ee.capturedQueries.filter((q) => q.sql.includes("INSERT"));
    expect(inserts.length).toBe(1);
  });
});

describe("RoleError", () => {
  it("has correct name and code", () => {
    const err = new RoleError({ message: "test message", code: "not_found" });
    expect(err.name).toBe("RoleError");
    expect(err._tag).toBe("RoleError");
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
  });
});
