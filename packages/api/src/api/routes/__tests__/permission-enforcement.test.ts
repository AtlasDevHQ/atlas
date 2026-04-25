/**
 * Tests for F-53 — custom-role permission flag enforcement at the route layer.
 *
 * `adminAuth` middleware accepts any user whose role ∈ {admin, owner,
 * platform_admin}. Before F-53 nothing further refined this gate, so a custom
 * role authored with `["query", "query:raw_data"]` (no admin flags) was still
 * blocked by the role check, but a custom role authored with admin flags AND
 * a stripped-down permission set still got full admin access at the route
 * boundary — the permission set was a UI display feature with no security
 * effect.
 *
 * F-53 wires `checkPermission()` from `@atlas/ee/auth/roles` into every admin
 * route per the audit's mapping table. These tests verify:
 *
 * 1. Each admin route invokes `checkPermission()` with the correct permission
 *    flag (the one the audit mapping calls for, NOT a different flag).
 * 2. When the user's resolved permission set lacks that flag the request
 *    surfaces 403 with `error: insufficient_permissions` BEFORE the handler
 *    body runs (no audit row, no DB write).
 * 3. When the user's resolved permission set carries the flag the request
 *    proceeds normally (positive path).
 *
 * The intent here is wire correctness, not the resolution logic in
 * `resolvePermissions` — that is exercised by `ee/__tests__/roles.test.ts`.
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

// ── Mocks ───────────────────────────────────────────────────────────

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-perm",
  },
});

// `checkPermission` is the F-53 chokepoint. Default success (null = allow)
// keeps unrelated routes happy; per-test overrides install a typed 403
// response to drive the negative path.
const denialFor = (permission: string, requestId = "test-req"): { body: Record<string, unknown>; status: 403 } => ({
  body: {
    error: "insufficient_permissions",
    message: `This action requires the "${permission}" permission.`,
    requestId,
  },
  status: 403,
});

type CheckPermissionResult = { body: Record<string, unknown>; status: 403 } | null;
const mockCheckPermission: Mock<(user: unknown, permission: string, requestId: string) => Effect.Effect<CheckPermissionResult>> =
  mock(() => Effect.succeed(null as CheckPermissionResult));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally generic
const mockListRoles: Mock<(orgId: string) => Effect.Effect<any, any>> = mock(() => Effect.succeed([]));

class MockRoleError extends Error {
  public readonly _tag = "RoleError" as const;
  public readonly code: "not_found" | "conflict" | "validation" | "builtin_protected";
  constructor(message: string, code: "not_found" | "conflict" | "validation" | "builtin_protected") {
    super(message);
    this.name = "RoleError";
    this.code = code;
  }
}

mock.module("@atlas/ee/auth/roles", () => ({
  RoleError: MockRoleError,
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
  checkPermission: mockCheckPermission,
  listRoles: mockListRoles,
  getRole: mock(() => Effect.succeed(null)),
  getRoleByName: mock(() => Effect.succeed(null)),
  createRole: mock(() => Effect.die(new Error("not configured"))),
  updateRole: mock(() => Effect.die(new Error("not configured"))),
  deleteRole: mock(() => Effect.succeed(true)),
  listRoleMembers: mock(() => Effect.succeed([])),
  assignRole: mock(() => Effect.die(new Error("not configured"))),
  seedBuiltinRoles: mock(() => Effect.succeed(undefined)),
}));

// EE governance modules used by audit / connections sub-routers — keep these
// as no-op Effect succeeds so handlers reach the end of their happy path.
mock.module("@atlas/ee/governance/audit", () => ({
  listAuditLog: mock(() => Effect.succeed({ rows: [], total: 0 })),
  getAuditStats: mock(() => Effect.succeed({})),
  getAuditFacets: mock(() => Effect.succeed({})),
  getAuditVolume: mock(() => Effect.succeed([])),
  getSlowQueries: mock(() => Effect.succeed([])),
  getFrequentQueries: mock(() => Effect.succeed([])),
  getErrorQueries: mock(() => Effect.succeed([])),
  getTopUsers: mock(() => Effect.succeed([])),
  exportAuditCsv: mock(() => Effect.succeed("")),
  AuditError: class extends Error {
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "AuditError";
      this.code = code;
    }
  },
}));

// ── Audit (logAdminAction) ──────────────────────────────────────────

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: new Proxy(
    {},
    { get: () => new Proxy({}, { get: (_, k) => String(k) }) },
  ),
}));

// ── Import app AFTER mocks ──────────────────────────────────────────

const { app } = await import("../../index");

// ── Helpers ─────────────────────────────────────────────────────────

function adminRequest(urlPath: string, method = "GET", body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${urlPath}`, opts);
}

afterAll(() => mocks.cleanup());

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-perm");
  mockCheckPermission.mockReset();
  mockCheckPermission.mockImplementation(() => Effect.succeed(null));
  mockListRoles.mockReset();
  mockListRoles.mockImplementation(() => Effect.succeed([]));
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

// ---------------------------------------------------------------------------
// Permission → Route mapping
// ---------------------------------------------------------------------------

interface MappingCase {
  name: string;
  url: string;
  method?: string;
  body?: unknown;
  permission:
    | "admin:users"
    | "admin:roles"
    | "admin:connections"
    | "admin:audit"
    | "admin:semantic"
    | "admin:settings";
}

/**
 * Single sample route per (permission flag × handler file). Handler files
 * route every endpoint through the same `requirePermission()` middleware so
 * one sample is enough to verify wiring; the full route inventory is the
 * source of truth in admin-roles.ts / admin-connections.ts / etc.
 */
const cases: MappingCase[] = [
  // admin:roles → admin-roles.ts (CRUD + role assignment)
  { name: "GET /admin/roles (list custom roles)", url: "/api/v1/admin/roles", permission: "admin:roles" },
  {
    name: "POST /admin/roles (create custom role)",
    url: "/api/v1/admin/roles",
    method: "POST",
    body: { name: "auditor", permissions: ["query"] },
    permission: "admin:roles",
  },
  {
    name: "PUT /admin/roles/users/:userId/role (assign role)",
    url: "/api/v1/admin/roles/users/user_abc123/role",
    method: "PUT",
    body: { role: "auditor" },
    permission: "admin:roles",
  },

  // admin:connections → admin-connections.ts
  { name: "GET /admin/connections", url: "/api/v1/admin/connections", permission: "admin:connections" },

  // admin:audit → admin-audit.ts + admin-audit-retention.ts + admin-action-retention.ts
  { name: "GET /admin/audit", url: "/api/v1/admin/audit", permission: "admin:audit" },
  {
    name: "GET /admin/audit/retention",
    url: "/api/v1/admin/audit/retention",
    permission: "admin:audit",
  },
  {
    name: "GET /admin/audit/admin-action-retention",
    url: "/api/v1/admin/audit/admin-action-retention",
    permission: "admin:audit",
  },

  // admin:semantic → admin-semantic-improve.ts
  {
    name: "GET /admin/semantic-improve/sessions",
    url: "/api/v1/admin/semantic-improve/sessions",
    permission: "admin:semantic",
  },

  // admin:settings → admin-branding/domains/email-provider/sandbox/residency/model-config.ts
  { name: "GET /admin/branding", url: "/api/v1/admin/branding", permission: "admin:settings" },
  { name: "GET /admin/domain", url: "/api/v1/admin/domain", permission: "admin:settings" },
  { name: "GET /admin/email-provider", url: "/api/v1/admin/email-provider", permission: "admin:settings" },
  { name: "GET /admin/sandbox", url: "/api/v1/admin/sandbox", permission: "admin:settings" },
  { name: "GET /admin/residency", url: "/api/v1/admin/residency", permission: "admin:settings" },
  { name: "GET /admin/model-config", url: "/api/v1/admin/model-config", permission: "admin:settings" },
];

/**
 * Inline-guard write-path coverage. These routes live in admin.ts (and
 * admin-invitations.ts / admin-semantic.ts via callback) where the gate is
 * applied as `adminAuthAndContext(c, "<flag>")` rather than as middleware.
 * The middleware vs inline paths are separate code lanes — a future contributor
 * adding a handler that copies the inline pattern but forgets the second
 * `adminAuthAndContext` arg would silently regress unless this mirror suite
 * exists.
 */
const inlineWriteCases: MappingCase[] = [
  // admin:users — admin.ts user-mutation handlers + admin-invitations.ts
  {
    name: "PATCH /admin/users/:id/role (changeUserRole)",
    url: "/api/v1/admin/users/user_abc123/role",
    method: "PATCH",
    body: { role: "admin" },
    permission: "admin:users",
  },
  {
    name: "POST /admin/users/:id/ban (banUser)",
    url: "/api/v1/admin/users/user_abc123/ban",
    method: "POST",
    body: { reason: "test" },
    permission: "admin:users",
  },
  {
    name: "DELETE /admin/users/:id/membership (removeMembership)",
    url: "/api/v1/admin/users/user_abc123/membership",
    method: "DELETE",
    permission: "admin:users",
  },
  {
    name: "POST /admin/users/invite (invite member)",
    url: "/api/v1/admin/users/invite",
    method: "POST",
    body: { email: "x@example.com", role: "member" },
    permission: "admin:users",
  },
  {
    name: "POST /admin/users/:id/unban (unbanUser)",
    url: "/api/v1/admin/users/user_abc123/unban",
    method: "POST",
    permission: "admin:users",
  },
  {
    name: "DELETE /admin/users/:id (deleteUser)",
    url: "/api/v1/admin/users/user_abc123",
    method: "DELETE",
    permission: "admin:users",
  },
  {
    name: "POST /admin/users/:id/revoke (revokeUserSessions)",
    url: "/api/v1/admin/users/user_abc123/revoke",
    method: "POST",
    permission: "admin:users",
  },

  // admin:settings — admin.ts settings write handlers
  {
    name: "PUT /admin/settings/:key (update setting)",
    url: "/api/v1/admin/settings/foo",
    method: "PUT",
    body: { value: "true" },
    permission: "admin:settings",
  },
  {
    name: "DELETE /admin/settings/:key (reset setting)",
    url: "/api/v1/admin/settings/foo",
    method: "DELETE",
    permission: "admin:settings",
  },

  // admin:semantic — admin-semantic.ts (registerSemanticEditorRoutes shim)
  // and admin.ts org-scoped entity CRUD + import handlers.
  {
    name: "PUT /admin/semantic/entities/edit/:name (semantic editor save)",
    url: "/api/v1/admin/semantic/entities/edit/users",
    method: "PUT",
    body: { table: "users", description: "test", connectionId: "default" },
    permission: "admin:semantic",
  },
  {
    name: "DELETE /admin/semantic/org/entities/:name (deleteOrgEntity)",
    url: "/api/v1/admin/semantic/org/entities/users?type=entity",
    method: "DELETE",
    permission: "admin:semantic",
  },
  {
    name: "POST /admin/semantic/org/import (importOrgEntities)",
    url: "/api/v1/admin/semantic/org/import",
    method: "POST",
    body: { entities: [] },
    permission: "admin:semantic",
  },
];

describe("F-53 — admin route invokes checkPermission with the correct permission flag", () => {
  for (const tc of cases) {
    it(`${tc.name} → checkPermission("${tc.permission}")`, async () => {
      await app.fetch(adminRequest(tc.url, tc.method ?? "GET", tc.body));
      expect(mockCheckPermission).toHaveBeenCalled();
      // The first call's permission arg must match the audit mapping.
      const observedPermissions = mockCheckPermission.mock.calls.map((call) => call[1]);
      expect(observedPermissions).toContain(tc.permission);
    });
  }
});

describe("F-53 — admin route 403s when role lacks the required permission", () => {
  for (const tc of cases) {
    it(`${tc.name} → 403 insufficient_permissions when ${tc.permission} is denied`, async () => {
      mockCheckPermission.mockImplementation((_user, permission, requestId) => {
        if (permission === tc.permission) {
          return Effect.succeed(denialFor(permission, requestId));
        }
        return Effect.succeed(null);
      });

      const res = await app.fetch(adminRequest(tc.url, tc.method ?? "GET", tc.body));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("insufficient_permissions");
      expect(body.message).toContain(tc.permission);
    });
  }
});

describe("F-53 — inline-guard write paths (admin.ts / admin-invitations.ts / admin-semantic.ts)", () => {
  for (const tc of inlineWriteCases) {
    it(`${tc.name} → calls checkPermission("${tc.permission}")`, async () => {
      await app.fetch(adminRequest(tc.url, tc.method ?? "GET", tc.body));
      const observedPermissions = mockCheckPermission.mock.calls.map((call) => call[1]);
      expect(observedPermissions).toContain(tc.permission);
    });

    it(`${tc.name} → 403 when ${tc.permission} is denied`, async () => {
      mockCheckPermission.mockImplementation((_user, permission, requestId) => {
        if (permission === tc.permission) {
          return Effect.succeed(denialFor(permission, requestId));
        }
        return Effect.succeed(null);
      });

      const res = await app.fetch(adminRequest(tc.url, tc.method ?? "GET", tc.body));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("insufficient_permissions");
      expect(body.message).toContain(tc.permission);
    });
  }
});

describe("F-53 — carve-outs that intentionally skip the permission check", () => {
  it("GET /admin/overview does not invoke checkPermission (general dashboard)", async () => {
    mockCheckPermission.mockClear();
    const res = await app.fetch(adminRequest("/api/v1/admin/overview"));
    // Status not 404 — distinguishes "route reached, carve-out honored"
    // from "route 404 so handler never ran". Without this, a future
    // refactor that unmounts /overview would let the test pass falsely.
    // We don't lock the exact 2xx/5xx status because overview's downstream
    // dependencies (semantic dir, plugin registry) vary per test fixture;
    // the F-53 contract is "checkPermission was not called", not "the
    // dashboard renders cleanly".
    expect(res.status).not.toBe(404);
    const observedPermissions = mockCheckPermission.mock.calls.map((call) => call[1]);
    // overview is intentionally ungated — every authenticated admin sees the
    // dashboard regardless of which admin:* flags their role carries. If a
    // future change wires it through `adminAuthAndContext(c, "<flag>")` the
    // contract changes silently; this test locks the carve-out.
    expect(observedPermissions).not.toContain("admin:semantic");
    expect(observedPermissions).not.toContain("admin:users");
    expect(observedPermissions).not.toContain("admin:settings");
  });

  it("GET /admin/me/password-status does not invoke checkPermission (self-service)", async () => {
    mockCheckPermission.mockClear();
    // The password-status path runs its own light auth (NOT adminAuthAndContext)
    // and never crosses the F-53 chokepoint — every authenticated user can
    // check their own password state.
    const res = await app.fetch(adminRequest("/api/v1/admin/me/password-status"));
    // 200 confirms the route was reached AND the handler ran successfully.
    // A 404 here would mean the test is asserting the absence of a
    // checkPermission call against a route that never ran — defeating the
    // carve-out lock. Password-status has no downstream deps that vary by
    // fixture (light auth + return), so 200 is stable to assert.
    expect(res.status).toBe(200);
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });
});

describe("F-53 — admin route 403s on /api/v1/admin/users (admin:users via inline guard)", () => {
  it("calls checkPermission with admin:users", async () => {
    await app.fetch(adminRequest("/api/v1/admin/users"));
    const observedPermissions = mockCheckPermission.mock.calls.map((call) => call[1]);
    expect(observedPermissions).toContain("admin:users");
  });

  it("returns 403 when admin:users is denied", async () => {
    mockCheckPermission.mockImplementation((_user, permission, requestId) => {
      if (permission === "admin:users") {
        return Effect.succeed(denialFor(permission, requestId));
      }
      return Effect.succeed(null);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/users"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("insufficient_permissions");
    expect(body.message).toContain("admin:users");
  });
});

describe("F-53 — admin /settings routes use admin:settings (inline guard in admin.ts)", () => {
  it("GET /admin/settings calls checkPermission with admin:settings", async () => {
    await app.fetch(adminRequest("/api/v1/admin/settings"));
    const observedPermissions = mockCheckPermission.mock.calls.map((call) => call[1]);
    expect(observedPermissions).toContain("admin:settings");
  });

  it("returns 403 when admin:settings is denied for GET /admin/settings", async () => {
    mockCheckPermission.mockImplementation((_user, permission, requestId) => {
      if (permission === "admin:settings") {
        return Effect.succeed(denialFor(permission, requestId));
      }
      return Effect.succeed(null);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/settings"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_permissions");
  });
});

describe("F-53 — admin /semantic GET routes use admin:semantic (inline guard in admin.ts)", () => {
  it("GET /admin/semantic/entities calls checkPermission with admin:semantic", async () => {
    await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    const observedPermissions = mockCheckPermission.mock.calls.map((call) => call[1]);
    expect(observedPermissions).toContain("admin:semantic");
  });

  it("returns 403 when admin:semantic is denied", async () => {
    mockCheckPermission.mockImplementation((_user, permission, requestId) => {
      if (permission === "admin:semantic") {
        return Effect.succeed(denialFor(permission, requestId));
      }
      return Effect.succeed(null);
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/semantic/entities"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_permissions");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed coverage: a defect inside `checkPermission` must surface as
// 503 `permissions_unavailable`, NOT a misleading 403
// `insufficient_permissions`. The misleading-403 case was the silent-failure
// finding the F-53 review surfaced — a transient DB blip during role lookup
// would land an admin on a permissions-error UX pointing them at their role
// config when the actual fault is the authorization layer.
// ---------------------------------------------------------------------------

describe("F-53 — fail-closed when checkPermission defects", () => {
  it("middleware path returns 503 permissions_unavailable when checkPermission Effect.die's (DB-error-equivalent path)", async () => {
    // `resolvePermissions` defects via `Effect.die` on unexpected DB errors.
    // The runPromise rejection that defect produces must surface as 503
    // through `requirePermission`'s try/catch — not as the synchronous
    // throw shape (which the next test exercises). Using a real
    // `Effect.die` here covers the actual production path, not just the
    // shape that happens to share the same outer catch.
    mockCheckPermission.mockImplementation(() =>
      Effect.die(new Error("simulated DB failure during role lookup")),
    );

    const res = await app.fetch(adminRequest("/api/v1/admin/roles"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("permissions_unavailable");
    // Body must NOT pretend the user lacks the permission — the user's
    // role might be perfectly fine, the lookup just failed.
    expect(body.message).not.toContain("insufficient");
  });

  it("inline path (admin.ts) returns 503 permissions_unavailable when checkPermission throws synchronously", async () => {
    mockCheckPermission.mockImplementation(() => {
      throw new Error("simulated authorization layer crash");
    });

    const res = await app.fetch(adminRequest("/api/v1/admin/users"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("permissions_unavailable");
    expect(body.message).not.toContain("insufficient");
  });
});

// ---------------------------------------------------------------------------
// Negative cross-check: built-in admin roles + permissive checkPermission
// must continue to pass through (regression guard for the legacy fallback).
// ---------------------------------------------------------------------------

describe("F-53 — built-in admin role retains full access when checkPermission allows", () => {
  it("GET /admin/roles allows when checkPermission returns null", async () => {
    mockCheckPermission.mockImplementation(() => Effect.succeed(null));
    mockListRoles.mockImplementation(() =>
      Effect.succeed([
        {
          id: "role_admin",
          orgId: "org-perm",
          name: "admin",
          description: "Full access",
          permissions: ["admin:roles"],
          isBuiltin: true,
          createdAt: "now",
          updatedAt: "now",
        },
      ]),
    );

    const res = await app.fetch(adminRequest("/api/v1/admin/roles"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: unknown[]; permissions: unknown[] };
    expect(body.roles).toHaveLength(1);
    expect(Array.isArray(body.permissions)).toBe(true);
  });
});
