/**
 * F-57 — admin user-mutation route × SCIM provenance enforcement.
 *
 * Verifies that the six user-mutation handlers from `admin.ts` and
 * `admin-roles.ts` consult `evaluateSCIMGuard*` BEFORE the underlying
 * mutation runs, and that:
 *
 * 1. **Strict policy** (default) — when the target is SCIM-provisioned the
 *    handler short-circuits with 409 + `{ error: "scim_managed", code:
 *    "SCIM_MANAGED", ... }`. No upstream mutation, no audit row for the
 *    mutation action — the IdP stays canonical.
 * 2. **Override policy** — the mutation proceeds AND the audit row carries
 *    `metadata.scim_override = true` so the manual deviation is
 *    reconstructable post-sync.
 * 3. **Non-SCIM target** — handler runs unchanged (sanity check that the
 *    guard is a no-op for the bulk of users).
 *
 * Per-handler shape rather than a parameterised loop because each route's
 * setup (org-membership pre-check, body parsing, last-admin guard) varies
 * — a single fixture would either be too coarse to exercise the guard or
 * too brittle to read.
 *
 * The wire-correctness tests in `permission-enforcement.test.ts` cover the
 * F-53 chokepoint; this suite covers the F-57 chokepoint that runs after.
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
    activeOrganizationId: "org-scim",
  },
});

// SCIM provenance guard — driven per-test. Default `non_scim` keeps
// unrelated routes unaffected; the suite below installs targeted
// implementations to drive block / override paths.
type GuardDecision =
  | { kind: "non_scim" }
  | { kind: "override" }
  | { kind: "block"; status: 409; body: { error: "scim_managed"; code: "SCIM_MANAGED"; message: string; requestId: string } };

const SCIM_BLOCK_BODY = (requestId: string) => ({
  error: "scim_managed" as const,
  code: "SCIM_MANAGED" as const,
  message:
    "This user is provisioned via SCIM and is owned by the identity provider. The change you make will be reverted on the next sync.",
  requestId,
});

const mockEvaluateSCIMGuardAsync: Mock<(opts: { userId: string; orgId?: string; requestId: string }) => Promise<GuardDecision>> = mock(
  async () => ({ kind: "non_scim" }),
);

const mockEvaluateSCIMGuard: Mock<(opts: { userId: string; orgId?: string; requestId: string }) => Effect.Effect<GuardDecision>> = mock(
  () => Effect.succeed({ kind: "non_scim" } as GuardDecision),
);

mock.module("@atlas/api/lib/auth/scim-provenance", () => ({
  evaluateSCIMGuardAsync: mockEvaluateSCIMGuardAsync,
  evaluateSCIMGuard: mockEvaluateSCIMGuard,
  // Re-export the shared block-body factory so tests assert the same shape
  // the helper would produce in production.
  scimManagedBlockBody: SCIM_BLOCK_BODY,
  isSCIMProvisioned: () => Effect.succeed(false),
  getSCIMOverridePolicy: () => "strict",
  parseSCIMOverridePolicy: (raw: string | undefined) => (raw === "override" ? "override" : "strict"),
  DEFAULT_SCIM_OVERRIDE_POLICY: "strict",
  SCIM_OVERRIDE_POLICIES: ["strict", "override"] as const,
  SCIM_OVERRIDE_POLICY_SETTING_KEY: "ATLAS_SCIM_OVERRIDE_POLICY",
}));

// Audit logger — capture per-test so we can assert metadata.scim_override.
const mockLogAdminAction: Mock<(entry: { metadata?: Record<string, unknown>; actionType?: string; status?: string }) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mockLogAdminAction,
  logAdminActionAwait: mock(async () => {}),
  ADMIN_ACTIONS: new Proxy(
    {},
    { get: () => new Proxy({}, { get: (_, k) => String(k) }) },
  ),
}));

// Better Auth admin API — the mutation hooks the routes call after the
// guard passes. Default to no-op so the override / non-scim paths reach
// `logAdminAction` without a real Better Auth instance.
const mockSetRole = mock(async () => ({}));
const mockBanUser = mock(async () => ({}));
const mockRemoveUser = mock(async () => ({}));
const mockRevokeSessions = mock(async () => ({}));

mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    api: {
      setRole: mockSetRole,
      banUser: mockBanUser,
      removeUser: mockRemoveUser,
      revokeSessions: mockRevokeSessions,
      unbanUser: mock(async () => ({})),
    },
  }),
  listAllUsers: mock(() => Promise.resolve([])),
  setUserRole: mock(async () => {}),
  setBanStatus: mock(async () => {}),
  setPasswordChangeRequired: mock(async () => {}),
  deleteUser: mock(async () => {}),
}));

// EE roles — admin-roles.ts assignRoleRoute path. Default to a successful
// assignment; the F-57 guard runs BEFORE assignRole so the block path
// must surface 409 without assignRole ever being invoked.
const mockAssignRole = mock(() =>
  Effect.succeed({ userId: "user-scim-1", role: "auditor" }),
);
const mockGetRoleByName = mock(() =>
  Effect.succeed({ id: "role_auditor", name: "auditor" }),
);

mock.module("@atlas/ee/auth/roles", () => ({
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
  listRoles: mock(() => Effect.succeed([])),
  getRole: mock(() => Effect.succeed(null)),
  getRoleByName: mockGetRoleByName,
  createRole: mock(() => Effect.die(new Error("not configured"))),
  updateRole: mock(() => Effect.die(new Error("not configured"))),
  deleteRole: mock(() => Effect.succeed(true)),
  listRoleMembers: mock(() => Effect.succeed([])),
  assignRole: mockAssignRole,
  seedBuiltinRoles: mock(() => Effect.succeed(undefined)),
  RoleError: class extends Error {
    public readonly _tag = "RoleError" as const;
    public readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "RoleError";
      this.code = code;
    }
  },
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
  mocks.setOrgAdmin("org-scim");
  mockEvaluateSCIMGuardAsync.mockReset();
  mockEvaluateSCIMGuardAsync.mockImplementation(async () => ({ kind: "non_scim" }));
  mockEvaluateSCIMGuard.mockReset();
  mockEvaluateSCIMGuard.mockImplementation(() => Effect.succeed({ kind: "non_scim" } as GuardDecision));
  mockLogAdminAction.mockReset();
  mockSetRole.mockReset();
  mockSetRole.mockImplementation(async () => ({}));
  mockBanUser.mockReset();
  mockBanUser.mockImplementation(async () => ({}));
  mockRemoveUser.mockReset();
  mockRemoveUser.mockImplementation(async () => ({}));
  mockRevokeSessions.mockReset();
  mockRevokeSessions.mockImplementation(async () => ({}));
  mockAssignRole.mockReset();
  mockAssignRole.mockImplementation(() =>
    Effect.succeed({ userId: "user-scim-1", role: "auditor" }),
  );
  mockGetRoleByName.mockReset();
  mockGetRoleByName.mockImplementation(() =>
    Effect.succeed({ id: "role_auditor", name: "auditor" }),
  );
  mocks.mockInternalQuery.mockReset();
  // Default internal-query stubs — admin handlers chain through these.
  // Last-admin guard returns "member" so demote/delete proceed; org-
  // membership lookup returns a row so 404 doesn't short-circuit.
  mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
    const s = sql.toLowerCase();
    if (s.includes('from member where "userid"') && s.includes('"organizationid"')) {
      return [{ userId: "user-scim-1", role: "member" }];
    }
    if (s.includes('from "user"') && s.includes("role")) {
      return [{ role: "member" }];
    }
    if (s.includes("count(*)")) return [{ count: "0" }];
    if (s.includes("delete from member")) return [{ id: "membership-1" }];
    return [];
  });
});

// ---------------------------------------------------------------------------
// changeUserRoleRoute (PATCH /admin/users/:id/role)
// ---------------------------------------------------------------------------

describe("F-57 — PATCH /admin/users/:id/role (changeUserRole)", () => {
  it("strict policy → 409 SCIM_MANAGED + no upstream mutation", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async ({ requestId }) => ({
      kind: "block",
      status: 409,
      body: SCIM_BLOCK_BODY(requestId),
    }));

    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/users/user-scim-1/role",
        "PATCH",
        { role: "member" },
      ),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("scim_managed");
    expect(body.code).toBe("SCIM_MANAGED");
    // The mutation must NOT have run — the F-57 contract is "block before
    // the side effect", not "block after the change persisted".
    expect(mockSetRole).not.toHaveBeenCalled();
  });

  it("override policy → mutation proceeds + audit metadata.scim_override = true", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async () => ({ kind: "override" }));

    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/users/user-scim-1/role",
        "PATCH",
        { role: "member" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mockSetRole).toHaveBeenCalled();
    const auditCall = mockLogAdminAction.mock.calls.find(
      (call) => call[0]?.metadata && (call[0].metadata as Record<string, unknown>).scim_override === true,
    );
    expect(auditCall).toBeDefined();
  });

  it("non-SCIM target → handler runs unchanged + no override marker", async () => {
    // default mock returns non_scim
    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/users/user-scim-1/role",
        "PATCH",
        { role: "member" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mockSetRole).toHaveBeenCalled();
    const overrideMarker = mockLogAdminAction.mock.calls.some(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(overrideMarker).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// banUserRoute (POST /admin/users/:id/ban)  — platform_admin only
// ---------------------------------------------------------------------------

describe("F-57 — POST /admin/users/:id/ban (banUser)", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin("org-scim");
  });

  it("strict policy → 409 SCIM_MANAGED + no Better Auth ban call", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async ({ requestId }) => ({
      kind: "block",
      status: 409,
      body: SCIM_BLOCK_BODY(requestId),
    }));

    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/users/user-scim-1/ban",
        "POST",
        { reason: "phishing" },
      ),
    );

    expect(res.status).toBe(409);
    expect(mockBanUser).not.toHaveBeenCalled();
  });

  it("override policy → ban proceeds + audit metadata.scim_override = true", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async () => ({ kind: "override" }));

    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/users/user-scim-1/ban",
        "POST",
        { reason: "phishing" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mockBanUser).toHaveBeenCalled();
    const auditCall = mockLogAdminAction.mock.calls.find(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(auditCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// removeMembershipRoute (DELETE /admin/users/:id/membership)
// ---------------------------------------------------------------------------

describe("F-57 — DELETE /admin/users/:id/membership (removeMembership)", () => {
  it("strict policy → 409 SCIM_MANAGED + no DB delete", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async ({ requestId }) => ({
      kind: "block",
      status: 409,
      body: SCIM_BLOCK_BODY(requestId),
    }));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/users/user-scim-1/membership", "DELETE"),
    );

    expect(res.status).toBe(409);
    // No DELETE FROM member should have fired.
    const sawDelete = mocks.mockInternalQuery.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].toLowerCase().includes("delete from member"),
    );
    expect(sawDelete).toBe(false);
  });

  it("override policy → membership row removed + audit metadata.scim_override = true", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async () => ({ kind: "override" }));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/users/user-scim-1/membership", "DELETE"),
    );

    expect(res.status).toBe(200);
    const auditCall = mockLogAdminAction.mock.calls.find(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(auditCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deleteUserRoute (DELETE /admin/users/:id)
// ---------------------------------------------------------------------------

describe("F-57 — DELETE /admin/users/:id (deleteUser)", () => {
  it("strict policy → 409 SCIM_MANAGED + no Better Auth removeUser", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async ({ requestId }) => ({
      kind: "block",
      status: 409,
      body: SCIM_BLOCK_BODY(requestId),
    }));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/users/user-scim-1", "DELETE"),
    );

    expect(res.status).toBe(409);
    expect(mockRemoveUser).not.toHaveBeenCalled();
  });

  it("override policy → delete proceeds + audit metadata.scim_override = true", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async () => ({ kind: "override" }));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/users/user-scim-1", "DELETE"),
    );

    expect(res.status).toBe(200);
    expect(mockRemoveUser).toHaveBeenCalled();
    const auditCall = mockLogAdminAction.mock.calls.find(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(auditCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// revokeUserSessionsRoute (POST /admin/users/:id/revoke)
// ---------------------------------------------------------------------------

describe("F-57 — POST /admin/users/:id/revoke (revokeUserSessions)", () => {
  it("strict policy → 409 SCIM_MANAGED + no Better Auth revokeSessions", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async ({ requestId }) => ({
      kind: "block",
      status: 409,
      body: SCIM_BLOCK_BODY(requestId),
    }));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/users/user-scim-1/revoke", "POST"),
    );

    expect(res.status).toBe(409);
    expect(mockRevokeSessions).not.toHaveBeenCalled();
  });

  it("override policy → revoke proceeds + audit metadata.scim_override = true", async () => {
    mockEvaluateSCIMGuardAsync.mockImplementationOnce(async () => ({ kind: "override" }));

    const res = await app.fetch(
      adminRequest("/api/v1/admin/users/user-scim-1/revoke", "POST"),
    );

    expect(res.status).toBe(200);
    expect(mockRevokeSessions).toHaveBeenCalled();
    const auditCall = mockLogAdminAction.mock.calls.find(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(auditCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// assignRoleRoute (PUT /admin/roles/users/:userId/role) — Effect path
// ---------------------------------------------------------------------------

describe("F-57 — PUT /admin/roles/users/:userId/role (assignRole)", () => {
  it("strict policy → 409 SCIM_MANAGED + assignRole never invoked", async () => {
    mockEvaluateSCIMGuard.mockImplementationOnce(({ requestId }) =>
      Effect.succeed({
        kind: "block",
        status: 409,
        body: SCIM_BLOCK_BODY(requestId),
      } as GuardDecision),
    );

    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/roles/users/user-scim-1/role",
        "PUT",
        { role: "auditor" },
      ),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("scim_managed");
    expect(body.code).toBe("SCIM_MANAGED");
    // The assignRole mutation must not have run — the F-57 guard runs
    // before any DB write so the block path is observable as "no audit
    // action emitted for the role.assign verb."
    expect(mockAssignRole).not.toHaveBeenCalled();
  });

  it("override policy → assignment proceeds + audit metadata.scim_override = true", async () => {
    mockEvaluateSCIMGuard.mockImplementationOnce(() =>
      Effect.succeed({ kind: "override" } as GuardDecision),
    );

    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/roles/users/user-scim-1/role",
        "PUT",
        { role: "auditor" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mockAssignRole).toHaveBeenCalled();
    const auditCall = mockLogAdminAction.mock.calls.find(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(auditCall).toBeDefined();
  });

  it("non-SCIM target → handler runs unchanged + no override marker", async () => {
    const res = await app.fetch(
      adminRequest(
        "/api/v1/admin/roles/users/user-scim-1/role",
        "PUT",
        { role: "auditor" },
      ),
    );

    expect(res.status).toBe(200);
    expect(mockAssignRole).toHaveBeenCalled();
    const overrideMarker = mockLogAdminAction.mock.calls.some(
      (call) => (call[0]?.metadata as Record<string, unknown> | undefined)?.scim_override === true,
    );
    expect(overrideMarker).toBe(false);
  });
});
