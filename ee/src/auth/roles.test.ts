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
  BUILTIN_ROLES,
  isValidRoleName,
  listRoles,
  getRole,
  getRoleByName,
  createRole,
  updateRole,
  deleteRole,
  listRoleMembers,
  assignRole,
  seedBuiltinRoles,
  RoleError,
} = await import("./roles");
const { PERMISSIONS, isValidPermission } = await import("@atlas/api/lib/auth/permissions");
const { resolvePermissions, hasPermission, checkPermission } = await import("@atlas/api/lib/auth/permission-resolve");

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
    // #5189 — the first non-admin pair. Enforced by
    // `requireWorkspacePermission` outside the admin perimeter, so unlike
    // every flag above them they can GRANT to a non-admin role.
    expect(PERMISSIONS).toContain("dashboards:read");
    expect(PERMISSIONS).toContain("dashboards:write");
    // #5192 — the third, and the only dashboards flag no non-admin built-in
    // holds: it gates minting a link served with no authentication at all.
    expect(PERMISSIONS).toContain("dashboards:share");
    expect(PERMISSIONS.length).toBe(11);
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

  it("viewer can query and VIEW dashboards, and nothing else", () => {
    // #5189 — `viewer` gained `dashboards:read` and deliberately NOT
    // `dashboards:write`: it is the one built-in role that can see a board and
    // cannot author one. Asserting the exact set is what makes an accidental
    // `dashboards:write` here fail rather than quietly grant authoring to the
    // least-privileged role.
    const viewer = BUILTIN_ROLES.find((r) => r.name === "viewer");
    expect(viewer).toBeDefined();
    expect(viewer!.permissions).toEqual(["query", "dashboards:read"]);
  });

  it("admin is the ONLY built-in role carrying dashboards:share", () => {
    // #5192 — the flag's whole value is that it is withheld. `admin` picks it
    // up through the `[...PERMISSIONS]` spread; every other entry is
    // hand-listed, so this reddens the moment someone types it into one.
    expect(
      BUILTIN_ROLES.filter((r) => r.permissions.includes("dashboards:share")).map(
        (r) => r.name,
      ),
    ).toEqual(["admin"]);
  });

  it("analyst has query, raw_data, audit, and both dashboards flags", () => {
    const analyst = BUILTIN_ROLES.find((r) => r.name === "analyst");
    expect(analyst).toBeDefined();
    expect(analyst!.permissions).toContain("query");
    expect(analyst!.permissions).toContain("query:raw_data");
    expect(analyst!.permissions).toContain("admin:audit");
    // #5189 — `analyst` is the persona the issue exists to serve: it can both
    // read and author dashboards, which is what a permission gate outside the
    // admin perimeter finally makes expressible.
    expect(analyst!.permissions).toContain("dashboards:read");
    expect(analyst!.permissions).toContain("dashboards:write");
    // #5192 — and NOT `dashboards:share`. An analyst authors dashboards; they
    // do not publish workspace data to an unauthenticated URL. Asserted
    // explicitly rather than left to the length below, because the length is
    // the assertion someone bumps when they add a flag.
    expect(analyst!.permissions).not.toContain("dashboards:share");
    expect(analyst!.permissions.length).toBe(5);
  });

  /**
   * #5189 — `BUILTIN_ROLES` is not self-enforcing: the DB row wins at resolution
   * time, and a row is only reconciled when `seedBuiltinRoles` runs (call site:
   * `listRoles`). Orgs that never open /admin/roles are repaired by a BACKFILL
   * migration instead, and that migration spells the permission arrays out as
   * SQL literals — correctly, because a migration must mean the same thing
   * whenever it runs.
   *
   * The cost of that correctness is a second copy, so this asserts the newest
   * backfill still agrees with the definitions. Adding a flag to `BUILTIN_ROLES`
   * without writing the next backfill reddens here — which is the whole point,
   * because the alternative is a silent 403 for every already-seeded workspace.
   */
  it("the newest built-in-roles backfill migration matches BUILTIN_ROLES", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL(
      "../../../packages/api/src/lib/db/migrations/",
      import.meta.url,
    ).pathname;

    const backfills = (await readdir(dir))
      .filter((f) => /^\d+_builtin_roles_.*\.sql$/.test(f))
      .sort();
    // A zero-length list would make every assertion below vacuous — the exact
    // shape this test exists to prevent.
    expect(backfills.length).toBeGreaterThan(0);

    const sql = await readFile(`${dir}${backfills[backfills.length - 1]}`, "utf8");

    // Split into statements FIRST, then read each one whole. Scanning the file
    // for `SET permissions = … name = '<role>'` looks equivalent and is not:
    // the gap is non-greedy across statement boundaries, so every role after
    // the first matches the FIRST statement's array. Measured — it reported
    // `analyst` as holding admin's ten flags and passed `admin` by luck of
    // ordering.
    const byRole = new Map<string, string[]>();
    // Strip `--` comments before splitting: the author has already been bitten
    // once by regexing SQL as text, and a comment restating a stale array would
    // otherwise fail this loudly for no reason.
    for (const stmt of sql.replace(/--[^\n]*/g, "").split(";")) {
      const perms = /SET permissions = '(\[[^']*\])'/.exec(stmt);
      // `[a-z0-9_-]`, not `[a-z_]` — `ROLE_NAME_RE` allows digits and hyphens,
      // so a future built-in named `data-engineer` would silently not parse.
      const name = /name = '([a-z0-9_-]+)'/.exec(stmt);
      if (!perms || !name) continue;
      // ⚠️ Assert the SCOPE, not just the payload. Measured: mutating the
      // migration's `WHERE is_builtin = true` to `WHERE true` left this guard
      // GREEN, because it only ever read `SET permissions` and `name`. That
      // clause is the sole thing stopping the backfill rewriting a CUSTOMER's
      // own `custom_roles` row that happens to share a built-in name — the one
      // property here with a customer-data blast radius, and the one the
      // seeder's sibling test does assert.
      expect(stmt, `backfill for "${name[1]}" is not scoped to is_builtin`).toContain(
        "is_builtin = true",
      );
      byRole.set(name[1], JSON.parse(perms[1]) as string[]);
    }

    expect([...byRole.keys()].sort()).toEqual(
      BUILTIN_ROLES.map((r) => r.name).sort(),
    );
    for (const def of BUILTIN_ROLES) {
      expect(byRole.get(def.name)?.sort()).toEqual([...def.permissions].sort());
    }
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
      // seedBuiltinRoles: one upsert per built-in role (3), each consuming one
      // queued result. The SELECT existence probe is gone — see #5189.
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

  it("writes one upsert per built-in role, with no read-then-write race", async () => {
    ee.queueMockRows([], [], []);

    await run(seedBuiltinRoles("org-1"));

    // #5189 — was 3 SELECTs + 3 INSERTs. The existence probe is gone: it made
    // the seeder insert-if-absent, and two callers racing it could both see an
    // empty probe. One upsert per role, and the unique index decides.
    const selects = ee.capturedQueries.filter((q) => q.sql.includes("SELECT"));
    const inserts = ee.capturedQueries.filter((q) => q.sql.includes("INSERT"));
    expect(selects.length).toBe(0);
    expect(inserts.length).toBe(BUILTIN_ROLES.length);
  });

  it("RECONCILES a role that already exists, instead of skipping it", async () => {
    // The behaviour this replaces is the defect: skipping froze a built-in
    // role's permission set at whatever it was when first seeded, and
    // `resolvePermissions` returns that stored set as the live answer while
    // `updateRole` refuses `is_builtin` rows. Adding a flag then silently
    // denied it to every already-seeded workspace (#5189).
    ee.queueMockRows([{ id: "existing" }], [{ id: "existing" }], []);

    await run(seedBuiltinRoles("org-1"));

    const writes = ee.capturedQueries.filter((q) => q.sql.includes("INSERT"));
    expect(writes.length).toBe(BUILTIN_ROLES.length);
    for (const w of writes) {
      expect(w.sql).toContain("ON CONFLICT (org_id, name) DO UPDATE");
      // Scoped to rows we own — a customer's own role named `analyst` is
      // `is_builtin = false` and must survive untouched.
      expect(w.sql).toContain("WHERE custom_roles.is_builtin = true");
    }
  });

  it("sends the CURRENT definition, not a stale one", async () => {
    // Without this the upsert could carry any array and both tests above stay
    // green — they count statements and match SQL text, never the payload.
    ee.queueMockRows([], [], []);

    await run(seedBuiltinRoles("org-1"));

    for (const def of BUILTIN_ROLES) {
      const write = ee.capturedQueries.find(
        (q) => q.sql.includes("INSERT") && q.params?.[1] === def.name,
      );
      expect(write, `no upsert for built-in role "${def.name}"`).toBeDefined();
      expect(JSON.parse(String(write!.params?.[3])).sort()).toEqual(
        [...def.permissions].sort(),
      );
    }
  });
});

// Guards the eeWrite/eeRead adoption (#4200): with no internal DB, writes must
// fail loud (never silently no-op) and reads must short-circuit to their empty
// value — the regression a future eeWrite→eeRead swap (or vice versa) would
// introduce. The gate + DB guard run before any validation, so no valid input
// is needed to reach the guard.
describe("no internal DB", () => {
  beforeEach(() => {
    resetMocks();
    ee.setHasInternalDB(false);
  });

  it("createRole fails loud", async () => {
    await expect(
      run(createRole("org-1", { name: "data-engineer", permissions: ["query"] })),
    ).rejects.toThrow("Internal database required for custom role management.");
  });

  it("updateRole fails loud", async () => {
    await expect(
      run(updateRole("org-1", "role-1", { description: "x" })),
    ).rejects.toThrow("Internal database required for custom role management.");
  });

  it("deleteRole fails loud", async () => {
    await expect(
      run(deleteRole("org-1", "role-1")),
    ).rejects.toThrow("Internal database required for role deletion.");
  });

  it("assignRole fails loud", async () => {
    await expect(
      run(assignRole("org-1", "user-1", "data-engineer")),
    ).rejects.toThrow("Internal database required for role assignment.");
  });

  it("getRoleByName short-circuits to null", async () => {
    expect(await run(getRoleByName("org-1", "analyst"))).toBeNull();
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
