import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ───────────────────────────────────────────────────────────

let mockEnterpriseEnabled = false;
let mockEnterpriseLicenseKey: string | undefined = "test-key";

mock.module("../index", () => ({
  isEnterpriseEnabled: () => mockEnterpriseEnabled,
  getEnterpriseLicenseKey: () => mockEnterpriseLicenseKey,
  requireEnterprise: (feature?: string) => {
    const label = feature ? ` (${feature})` : "";
    if (!mockEnterpriseEnabled) {
      throw new Error(`Enterprise features${label} are not enabled.`);
    }
    if (!mockEnterpriseLicenseKey) {
      throw new Error(`Enterprise features${label} are enabled but no license key is configured.`);
    }
  },
}));

// Mock internal DB
const mockRows: Record<string, unknown>[][] = [];
let queryCallCount = 0;
const capturedQueries: { sql: string; params: unknown[] }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql, params: params ?? [] });
      const rows = mockRows[queryCallCount] ?? [];
      queryCallCount++;
      return { rows };
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params: params ?? [] });
    const rows = mockRows[queryCallCount] ?? [];
    queryCallCount++;
    return rows;
  },
  internalExecute: () => {},
  encryptUrl: (v: string) => `encrypted:${v}`,
  decryptUrl: (v: string) => v.startsWith("encrypted:") ? v.slice(10) : v,
}));

let mockAuthMode = "none";
mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

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

function resetMocks() {
  mockRows.length = 0;
  queryCallCount = 0;
  capturedQueries.length = 0;
  mockEnterpriseEnabled = true;
  mockEnterpriseLicenseKey = "test-key";
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
    const perms = await resolvePermissions(undefined);
    expect(perms.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(perms.has(p)).toBe(true);
    }
  });

  it("returns empty permissions for undefined user in managed auth mode", async () => {
    mockAuthMode = "managed";
    const perms = await resolvePermissions(undefined);
    expect(perms.size).toBe(0);
  });

  it("returns custom role permissions when found in DB", async () => {
    mockRows.push([makeRoleRow({
      permissions: JSON.stringify(["query", "admin:audit"]),
    })]);

    const user = makeUser({ role: "analyst" });
    const perms = await resolvePermissions(user);
    expect(perms.has("query")).toBe(true);
    expect(perms.has("admin:audit")).toBe(true);
    expect(perms.has("admin:users")).toBe(false);
    expect(perms.size).toBe(2);
  });

  it("falls back to legacy for admin role when no custom role in DB", async () => {
    mockRows.push([]); // No custom role found

    const user = makeUser({ role: "admin" });
    const perms = await resolvePermissions(user);
    expect(perms.size).toBe(PERMISSIONS.length);
  });

  it("falls back to legacy for member role when no custom role in DB", async () => {
    mockRows.push([]); // No custom role found

    const user = makeUser({ role: "member" });
    const perms = await resolvePermissions(user);
    expect(perms.has("query")).toBe(true);
    expect(perms.has("query:raw_data")).toBe(true);
    expect(perms.has("admin:users")).toBe(false);
  });

  it("falls back to member permissions for unknown roles", async () => {
    mockRows.push([]); // No custom role found

    const user = makeUser({ role: undefined });
    const perms = await resolvePermissions(user);
    expect(perms.has("query")).toBe(true);
    expect(perms.has("query:raw_data")).toBe(true);
    expect(perms.has("admin:users")).toBe(false);
  });

  it("fails closed with empty permissions on corrupt role data", async () => {
    // Simulate corrupt JSON in permissions column
    mockRows.push([{ id: "r1", org_id: "org-1", name: "test", description: "", permissions: "INVALID_JSON{", is_builtin: false, created_at: "", updated_at: "" }]);

    const user = makeUser({ role: "test" });
    const perms = await resolvePermissions(user);
    // Corrupt data → empty permissions (fail closed), not elevated legacy
    expect(perms.size).toBe(0);
    expect(perms.has("admin:users")).toBe(false);
  });
});

describe("hasPermission", () => {
  beforeEach(resetMocks);

  it("returns true when user has the permission", async () => {
    mockRows.push([]); // Falls back to legacy admin
    expect(await hasPermission(makeUser({ role: "admin" }), "admin:users")).toBe(true);
  });

  it("returns false when user lacks the permission", async () => {
    mockRows.push([]); // Falls back to legacy member
    expect(await hasPermission(makeUser({ role: "member" }), "admin:users")).toBe(false);
  });
});

describe("checkPermission", () => {
  beforeEach(resetMocks);

  it("returns null when permission is satisfied", async () => {
    mockRows.push([]); // Legacy admin
    const result = await checkPermission(makeUser({ role: "admin" }), "admin:users", "req-1");
    expect(result).toBeNull();
  });

  it("returns error response when permission is denied", async () => {
    mockRows.push([]); // Legacy member
    const result = await checkPermission(makeUser({ role: "member" }), "admin:users", "req-1");
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
      mockEnterpriseEnabled = false;
      await expect(listRoles("org-1")).rejects.toThrow("Enterprise features");
    });

    it("returns roles from DB", async () => {
      mockRows.push([
        makeRoleRow(),
        makeRoleRow({ id: "role-2", name: "custom", is_builtin: false }),
      ]);

      const roles = await listRoles("org-1");
      expect(roles.length).toBe(2);
      expect(roles[0].name).toBe("analyst");
      expect(roles[1].name).toBe("custom");
    });
  });

  describe("getRole", () => {
    it("returns role when found", async () => {
      mockRows.push([makeRoleRow()]);
      const role = await getRole("org-1", "role-1");
      expect(role).not.toBeNull();
      expect(role!.name).toBe("analyst");
    });

    it("returns null when not found", async () => {
      mockRows.push([]);
      const role = await getRole("org-1", "nonexistent");
      expect(role).toBeNull();
    });
  });

  describe("createRole", () => {
    it("creates a custom role", async () => {
      mockRows.push([]); // uniqueness check
      mockRows.push([makeRoleRow({
        id: "new-role",
        name: "data-engineer",
        is_builtin: false,
        permissions: JSON.stringify(["query", "admin:connections"]),
      })]);

      const role = await createRole("org-1", {
        name: "data-engineer",
        description: "Can query and manage connections",
        permissions: ["query", "admin:connections"],
      });

      expect(role.name).toBe("data-engineer");
      expect(role.isBuiltin).toBe(false);
      expect(role.permissions).toContain("query");
      expect(role.permissions).toContain("admin:connections");
    });

    it("rejects invalid role names", async () => {
      await expect(
        createRole("org-1", { name: "123invalid", permissions: ["query"] }),
      ).rejects.toThrow("Invalid role name");
    });

    it("rejects invalid permissions", async () => {
      await expect(
        createRole("org-1", { name: "test", permissions: ["nonexistent"] }),
      ).rejects.toThrow("Invalid permissions");
    });

    it("rejects duplicate names", async () => {
      mockRows.push([{ id: "existing" }]); // uniqueness check finds existing

      await expect(
        createRole("org-1", { name: "analyst", permissions: ["query"] }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("updateRole", () => {
    it("updates description and permissions", async () => {
      // getRole lookup
      mockRows.push([makeRoleRow({ is_builtin: false })]);
      // UPDATE query
      mockRows.push([makeRoleRow({
        is_builtin: false,
        description: "Updated description",
        permissions: JSON.stringify(["query"]),
      })]);

      const role = await updateRole("org-1", "role-1", {
        description: "Updated description",
        permissions: ["query"],
      });

      expect(role.description).toBe("Updated description");
    });

    it("rejects modification of built-in roles", async () => {
      mockRows.push([makeRoleRow({ is_builtin: true })]);

      await expect(
        updateRole("org-1", "role-1", { permissions: ["query"] }),
      ).rejects.toThrow("Built-in roles cannot be modified");
    });

    it("rejects when role not found", async () => {
      mockRows.push([]); // getRole returns nothing

      await expect(
        updateRole("org-1", "nonexistent", { permissions: ["query"] }),
      ).rejects.toThrow("not found");
    });
  });

  describe("deleteRole", () => {
    it("deletes a custom role with no active members", async () => {
      // getRole (via internalQuery) returns custom role
      mockRows.push([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: getRole returns the role again
      mockRows.push([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: member table query returns empty (no members)
      mockRows.push([]);
      // DELETE (via getInternalDB().query) returns the deleted row
      mockRows.push([{ id: "role-1" }]);

      const result = await deleteRole("org-1", "role-1");
      expect(result).toBe(true);
    });

    it("rejects deletion when role has active members", async () => {
      mockRows.push([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: getRole
      mockRows.push([makeRoleRow({ is_builtin: false })]);
      // listRoleMembers: member table returns 2 members
      mockRows.push([
        { userId: "u1", role: "analyst", createdAt: "2026-01-01" },
        { userId: "u2", role: "analyst", createdAt: "2026-01-01" },
      ]);

      await expect(
        deleteRole("org-1", "role-1"),
      ).rejects.toThrow("Cannot delete role with 2 active member(s)");
    });

    it("rejects deletion of built-in roles", async () => {
      mockRows.push([makeRoleRow({ is_builtin: true })]);

      await expect(
        deleteRole("org-1", "role-1"),
      ).rejects.toThrow("Built-in roles cannot be deleted");
    });

    it("returns false when role not found", async () => {
      mockRows.push([]); // getRole returns nothing

      const result = await deleteRole("org-1", "nonexistent");
      expect(result).toBe(false);
    });
  });
});

describe("Role assignment", () => {
  beforeEach(resetMocks);

  describe("listRoleMembers", () => {
    it("returns members for a role", async () => {
      // getRole lookup
      mockRows.push([makeRoleRow()]);
      // member query
      mockRows.push([
        { userId: "user-1", role: "analyst", createdAt: "2026-01-01" },
        { userId: "user-2", role: "analyst", createdAt: "2026-01-02" },
      ]);

      const members = await listRoleMembers("org-1", "role-1");
      expect(members.length).toBe(2);
      expect(members[0].userId).toBe("user-1");
    });

    it("throws when role not found", async () => {
      mockRows.push([]); // getRole returns nothing

      await expect(
        listRoleMembers("org-1", "nonexistent"),
      ).rejects.toThrow("not found");
    });
  });

  describe("assignRole", () => {
    it("assigns a role to a user", async () => {
      // Role existence check
      mockRows.push([{ id: "role-1" }]);
      // UPDATE member
      mockRows.push([{ userId: "user-1", role: "analyst" }]);

      const result = await assignRole("org-1", "user-1", "analyst");
      expect(result.userId).toBe("user-1");
      expect(result.role).toBe("analyst");
    });

    it("rejects when role does not exist", async () => {
      mockRows.push([]); // role not found

      await expect(
        assignRole("org-1", "user-1", "nonexistent"),
      ).rejects.toThrow("does not exist");
    });

    it("rejects when user is not a member", async () => {
      mockRows.push([{ id: "role-1" }]); // role exists
      mockRows.push([]); // member update returns nothing

      await expect(
        assignRole("org-1", "user-1", "analyst"),
      ).rejects.toThrow("not a member");
    });
  });
});

describe("seedBuiltinRoles", () => {
  beforeEach(resetMocks);

  it("seeds all three built-in roles when none exist", async () => {
    // Three existence checks, all empty
    mockRows.push([], [], []);

    await seedBuiltinRoles("org-1");

    // 3 SELECTs + 3 INSERTs = 6 queries
    const selects = capturedQueries.filter((q) => q.sql.includes("SELECT"));
    const inserts = capturedQueries.filter((q) => q.sql.includes("INSERT"));
    expect(selects.length).toBe(3);
    expect(inserts.length).toBe(3);
  });

  it("skips roles that already exist", async () => {
    // First two exist, third doesn't
    mockRows.push([{ id: "existing" }], [{ id: "existing" }], []);

    await seedBuiltinRoles("org-1");

    const inserts = capturedQueries.filter((q) => q.sql.includes("INSERT"));
    expect(inserts.length).toBe(1);
  });
});

describe("RoleError", () => {
  it("has correct name and code", () => {
    const err = new RoleError("test message", "not_found");
    expect(err.name).toBe("RoleError");
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
  });
});
