/**
 * Tests for admin custom-role audit emission (F-25 / #1780).
 *
 * Covers the four write routes under /api/v1/admin/roles:
 *   - POST   /                          (role.create)
 *   - PUT    /{id}                      (role.update)
 *   - DELETE /{id}                      (role.delete)
 *   - PUT    /users/{userId}/role       (role.assign)
 *
 * Verifies that every write handler emits exactly one logAdminAction with
 * the correct action type + metadata shape on success, that the three
 * mutation-with-prior-state paths (update / delete / assign) pre-fetch state
 * so the audit row captures what was removed or replaced, and that RoleError
 * / defect / EnterpriseError paths all produce a failure-status audit row.
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
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
// Real ADMIN_ACTIONS values so assertions pin to the canonical strings,
// not hand-typed copies that drift when the catalog changes.
import { ADMIN_ACTIONS as REAL_ADMIN_ACTIONS } from "@atlas/api/lib/audit/actions";

// ── Unified mocks ───────────────────────────────────────────────────

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
});

// ── Audit mock ──────────────────────────────────────────────────────

const mockLogAdminAction: Mock<(entry: Record<string, unknown>) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: REAL_ADMIN_ACTIONS,
}));

// ── EE roles mock ───────────────────────────────────────────────────

// Stable RoleError stand-in. `domainError()` uses `instanceof`, so the class
// referenced by the route at module-load time must match the instances the
// mocks throw. `_tag: "RoleError"` mirrors the real `Data.TaggedError` shape.
class MockRoleError extends Error {
  public readonly _tag = "RoleError" as const;
  public readonly code: "not_found" | "conflict" | "validation" | "builtin_protected";
  constructor(
    message: string,
    code: "not_found" | "conflict" | "validation" | "builtin_protected",
  ) {
    super(message);
    this.name = "RoleError";
    this.code = code;
  }
}

class MockEnterpriseError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EnterpriseError";
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocks flex across success/failure Effects
const mockListRoles: Mock<(orgId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed([]),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockGetRole: Mock<(orgId: string, roleId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed(null),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockGetRoleByName: Mock<(orgId: string, name: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed(null),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockCreateRole: Mock<(orgId: string, input: Record<string, unknown>) => Effect.Effect<any, any>> = mock(
  () => Effect.die(new Error("not configured")),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockUpdateRole: Mock<(orgId: string, roleId: string, input: Record<string, unknown>) => Effect.Effect<any, any>> = mock(
  () => Effect.die(new Error("not configured")),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockDeleteRole: Mock<(orgId: string, roleId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed(true),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockListRoleMembers: Mock<(orgId: string, roleId: string) => Effect.Effect<any, any>> = mock(
  () => Effect.succeed([]),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const mockAssignRole: Mock<(orgId: string, userId: string, roleName: string) => Effect.Effect<any, any>> = mock(
  () => Effect.die(new Error("not configured")),
);

mock.module("@atlas/ee/auth/roles", () => ({
  RoleError: MockRoleError,
  listRoles: mockListRoles,
  getRole: mockGetRole,
  getRoleByName: mockGetRoleByName,
  createRole: mockCreateRole,
  updateRole: mockUpdateRole,
  deleteRole: mockDeleteRole,
  listRoleMembers: mockListRoleMembers,
  assignRole: mockAssignRole,
  PERMISSIONS: [
    "query",
    "query:raw_data",
    "admin:users",
    "admin:connections",
    "admin:settings",
    "admin:audit",
    "admin:roles",
    "admin:semantic",
  ] as const,
  isValidPermission: () => true,
  isValidRoleName: () => true,
  BUILTIN_ROLES: [],
  resolvePermissions: mock(() => Effect.succeed(new Set())),
  hasPermission: mock(() => Effect.succeed(true)),
  checkPermission: mock(() => Effect.succeed(null)),
  seedBuiltinRoles: mock(() => Effect.succeed(undefined)),
}));

// ── Import app AFTER mocks ──────────────────────────────────────────

const { app } = await import("../index");

// ── Helpers ─────────────────────────────────────────────────────────

function rolesRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${urlPath}`, opts);
}

const existingRole = {
  id: "role_abc123",
  orgId: "org-alpha",
  name: "auditor",
  description: "Read-only audit access",
  permissions: ["query", "admin:audit"],
  isBuiltin: false,
  createdAt: "2026-04-20T00:00:00.000Z",
  updatedAt: "2026-04-20T00:00:00.000Z",
};

// ── Cleanup / reset ─────────────────────────────────────────────────

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mockLogAdminAction.mockReset();
  mockListRoles.mockReset();
  mockGetRole.mockReset();
  mockGetRoleByName.mockReset();
  mockCreateRole.mockReset();
  mockUpdateRole.mockReset();
  mockDeleteRole.mockReset();
  mockListRoleMembers.mockReset();
  mockAssignRole.mockReset();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

// ---------------------------------------------------------------------------
// POST / — role.create
// ---------------------------------------------------------------------------

describe("admin roles — POST / (role.create)", () => {
  it("emits role.create audit on success", async () => {
    const created = { ...existingRole, id: "role_new1", name: "auditor", permissions: ["query", "admin:audit"] };
    mockCreateRole.mockImplementation(() => Effect.succeed(created));

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles", "POST", {
        name: "auditor",
        description: "Read-only audit access",
        permissions: ["query", "admin:audit"],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.create",
      targetType: "role",
      targetId: "role_new1",
      metadata: {
        roleId: "role_new1",
        roleName: "auditor",
        permissions: ["query", "admin:audit"],
      },
    });
    expect(entry.status).toBeUndefined(); // default "success"
  });

  it("emits status:failure audit when RoleError.conflict is thrown", async () => {
    mockCreateRole.mockImplementation(() =>
      Effect.fail(new MockRoleError('Role "auditor" already exists in this organization.', "conflict")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles", "POST", {
        name: "auditor",
        permissions: ["query"],
      }),
    );

    expect(res.status).toBe(409);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.create",
      targetType: "role",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.roleName).toBe("auditor");
    expect(metadata.error).toContain("already exists");
  });

  it("emits failure audit when EE call dies (defect path)", async () => {
    mockCreateRole.mockImplementation(() =>
      Effect.die(new Error("pool exhausted")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles", "POST", {
        name: "auditor",
        permissions: ["query"],
      }),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.create",
      status: "failure",
    });
    expect((entry.metadata as Record<string, unknown>).error).toBe("pool exhausted");
  });
});

// ---------------------------------------------------------------------------
// PUT /{id} — role.update
// ---------------------------------------------------------------------------

describe("admin roles — PUT /{id} (role.update)", () => {
  it("captures previousPermissions AND new permissions", async () => {
    mockGetRole.mockImplementation(() => Effect.succeed(existingRole));
    const updated = { ...existingRole, permissions: ["query", "admin:audit", "admin:users"] };
    mockUpdateRole.mockImplementation(() => Effect.succeed(updated));

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_abc123", "PUT", {
        permissions: ["query", "admin:audit", "admin:users"],
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.update",
      targetType: "role",
      targetId: "role_abc123",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.roleId).toBe("role_abc123");
    expect(metadata.roleName).toBe("auditor");
    // Both old and new captured so forensic reconstruction sees the delta.
    expect(metadata.previousPermissions).toEqual(["query", "admin:audit"]);
    expect(metadata.permissions).toEqual(["query", "admin:audit", "admin:users"]);
    expect(entry.status).toBeUndefined();
  });

  it("emits previousPermissions:null when pre-fetch returns nothing", async () => {
    // Guard case: prior row doesn't exist. Route still emits best-effort audit.
    mockGetRole.mockImplementation(() => Effect.succeed(null));
    mockUpdateRole.mockImplementation(() =>
      Effect.fail(new MockRoleError("Role not found.", "not_found")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_missing", "PUT", {
        permissions: ["query"],
      }),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.update",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.previousPermissions).toBeNull();
  });

  it("emits status:failure audit when updateRole throws RoleError", async () => {
    mockGetRole.mockImplementation(() => Effect.succeed(existingRole));
    mockUpdateRole.mockImplementation(() =>
      Effect.fail(new MockRoleError("Built-in roles cannot be modified.", "builtin_protected")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_abc123", "PUT", {
        permissions: ["query"],
      }),
    );

    expect(res.status).toBe(403);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.update",
      status: "failure",
    });
    // Pre-fetch succeeded → previousPermissions should still be present on failure.
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.previousPermissions).toEqual(["query", "admin:audit"]);
    expect(metadata.error).toContain("Built-in roles");
  });
});

// ---------------------------------------------------------------------------
// DELETE /{id} — role.delete
// ---------------------------------------------------------------------------

describe("admin roles — DELETE /{id} (role.delete)", () => {
  it("pre-fetches and emits metadata with the deleted role's permissions", async () => {
    mockGetRole.mockImplementation(() => Effect.succeed(existingRole));
    mockDeleteRole.mockImplementation(() => Effect.succeed(true));

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_abc123", "DELETE"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);

    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.delete",
      targetType: "role",
      targetId: "role_abc123",
      metadata: {
        roleId: "role_abc123",
        roleName: "auditor",
        permissions: ["query", "admin:audit"],
      },
    });
    expect(entry.status).toBeUndefined();
  });

  it("emits { roleId, found: false } when the role does not exist", async () => {
    mockGetRole.mockImplementation(() => Effect.succeed(null));

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_missing", "DELETE"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.delete",
      targetType: "role",
      targetId: "role_missing",
      metadata: { roleId: "role_missing", found: false },
    });
    // deleteRole should NOT have been invoked when pre-fetch showed nothing.
    expect(mockDeleteRole).not.toHaveBeenCalled();
  });

  it("emits status:failure when deleteRole throws RoleError", async () => {
    mockGetRole.mockImplementation(() => Effect.succeed(existingRole));
    mockDeleteRole.mockImplementation(() =>
      Effect.fail(
        new MockRoleError("Cannot delete role with 3 active member(s). Reassign them first.", "validation"),
      ),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_abc123", "DELETE"),
    );

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.delete",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    // Pre-fetch captured the role even on failure — compliance knows what the
    // attempt was aimed at.
    expect(metadata.roleId).toBe("role_abc123");
    expect(metadata.roleName).toBe("auditor");
    expect(metadata.permissions).toEqual(["query", "admin:audit"]);
    expect(metadata.error).toContain("active member");
  });

  it("emits failure audit when the EE delete dies (defect path)", async () => {
    mockGetRole.mockImplementation(() => Effect.succeed(existingRole));
    mockDeleteRole.mockImplementation(() =>
      Effect.die(new Error("RETURNING row missing")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/role_abc123", "DELETE"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.delete",
      status: "failure",
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /users/{userId}/role — role.assign
// ---------------------------------------------------------------------------

describe("admin roles — PUT /users/{userId}/role (role.assign)", () => {
  it("captures previousRole + roleId + roleName + userId", async () => {
    mockGetRoleByName.mockImplementation(() => Effect.succeed(existingRole));
    // Prior member.role via internalQuery pre-fetch.
    mocks.mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ role: "viewer" }]),
    );
    mockAssignRole.mockImplementation(() =>
      Effect.succeed({ userId: "user_xyz", role: "auditor" }),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/users/user_xyz/role", "PUT", {
        role: "auditor",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.assign",
      targetType: "role",
      targetId: "role_abc123",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.roleId).toBe("role_abc123");
    expect(metadata.roleName).toBe("auditor");
    expect(metadata.userId).toBe("user_xyz");
    expect(metadata.previousRole).toBe("viewer");
    expect(entry.status).toBeUndefined();
  });

  it("emits previousRole:null when the user has no prior role", async () => {
    mockGetRoleByName.mockImplementation(() => Effect.succeed(existingRole));
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    mockAssignRole.mockImplementation(() =>
      Effect.succeed({ userId: "user_xyz", role: "auditor" }),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/users/user_xyz/role", "PUT", {
        role: "auditor",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const metadata = mockLogAdminAction.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata.previousRole).toBeNull();
  });

  it("emits status:failure when assignRole throws RoleError", async () => {
    mockGetRoleByName.mockImplementation(() => Effect.succeed(existingRole));
    mocks.mockInternalQuery.mockImplementation(() =>
      Promise.resolve([{ role: "member" }]),
    );
    mockAssignRole.mockImplementation(() =>
      Effect.fail(new MockRoleError("User is not a member of this organization.", "not_found")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/users/user_gone/role", "PUT", {
        role: "auditor",
      }),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.assign",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.userId).toBe("user_gone");
    expect(metadata.roleName).toBe("auditor");
    expect(metadata.previousRole).toBe("member");
    expect(metadata.error).toContain("not a member");
  });

  it("emits failure audit when the role name does not exist", async () => {
    mockGetRoleByName.mockImplementation(() => Effect.succeed(null));
    mockAssignRole.mockImplementation(() =>
      Effect.fail(
        new MockRoleError('Role "ghost" does not exist in this organization.', "not_found"),
      ),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles/users/user_xyz/role", "PUT", {
        role: "ghost",
      }),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.assign",
      status: "failure",
    });
    const metadata = entry.metadata as Record<string, unknown>;
    // When the role name is unknown the audit row still records the attempt
    // so forensic queries can see "admin tried to grant ghost" — roleId is
    // null because there's no row to reference.
    expect(metadata.roleId).toBeNull();
    expect(metadata.roleName).toBe("ghost");
  });
});

// ---------------------------------------------------------------------------
// Enterprise gate — unlicensed deploys still produce a forensic trail
// ---------------------------------------------------------------------------

describe("admin roles — EnterpriseError emits failure audit", () => {
  it("POST / emits failure audit on license gate", async () => {
    mockCreateRole.mockImplementation(() =>
      Effect.fail(new MockEnterpriseError("enterprise_required", "Custom roles require enterprise.")),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles", "POST", {
        name: "auditor",
        permissions: ["query"],
      }),
    );

    expect(res.status).toBe(403);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0][0];
    expect(entry).toMatchObject({
      actionType: "role.create",
      status: "failure",
    });
  });
});

// ---------------------------------------------------------------------------
// Regression — read routes stay silent
// ---------------------------------------------------------------------------

describe("admin roles — read routes don't emit audit", () => {
  it("GET / does not call logAdminAction", async () => {
    mockListRoles.mockImplementation(() => Effect.succeed([existingRole]));

    const res = await app.fetch(rolesRequest("/api/v1/admin/roles"));
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("GET /{id}/members does not call logAdminAction", async () => {
    mockListRoleMembers.mockImplementation(() => Effect.succeed([]));

    const res = await app.fetch(rolesRequest("/api/v1/admin/roles/role_abc123/members"));
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authorization regression — non-admin calls must NOT emit audit rows
// ---------------------------------------------------------------------------

describe("admin roles — non-admin callers don't emit audit", () => {
  it("POST / returns 403 for a member with no audit row", async () => {
    mocks.setMember("org-alpha");
    mockCreateRole.mockImplementation(() =>
      Effect.succeed({ ...existingRole, id: "role_should_not_hit" }),
    );

    const res = await app.fetch(
      rolesRequest("/api/v1/admin/roles", "POST", {
        name: "auditor",
        permissions: ["query"],
      }),
    );

    expect(res.status).toBe(403);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    // Service was never invoked — a non-admin caller must not trigger a DB
    // write even when the audit emission is already guarded.
    expect(mockCreateRole).not.toHaveBeenCalled();
  });
});
