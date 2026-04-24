/**
 * Parity suite: every `admin-orgs.ts` workspace write must emit the same
 * canonical `admin_action_log` fields (`action_type`, `target_type`,
 * `target_id`, `scope`) as the matching `/api/v1/platform/workspaces`
 * route. Each surface is tested standalone for shape + failure silence,
 * then the parity block hits both back-to-back and compares entries
 * directly. Future drift on either router breaks the suite.
 *
 * Backstory: F-31 (#1786) of the 1.2.3 security sweep.
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

// ---------------------------------------------------------------------------
// Mocks — set up before app import
// ---------------------------------------------------------------------------

/**
 * We manage `getWorkspaceDetails`, `updateWorkspaceStatus`,
 * `updateWorkspacePlanTier`, and `cascadeWorkspaceDelete` ourselves so tests
 * can stage a resolvable workspace for each route. Everything else stays on
 * the shared factory defaults.
 */
interface WorkspaceStub {
  id: string;
  workspace_status: "active" | "suspended" | "deleted";
  plan_tier: string;
  [key: string]: unknown;
}

const mockGetWorkspaceDetails: Mock<
  (orgId: string) => Promise<WorkspaceStub | null>
> = mock(async () => null);
const mockUpdateWorkspaceStatus = mock(async () => true);
const mockUpdateWorkspacePlanTier = mock(async () => true);
const mockCascadeWorkspaceDelete = mock(async () => ({
  conversations: 3,
  semanticEntities: 2,
  learnedPatterns: 1,
  suggestions: 0,
  scheduledTasks: 0,
  settings: 0,
}));

// Pool mocks are overridable per-test so the delete-handler `poolsDrained`
// / `warnings` metadata branches can be exercised. Default: pooling off
// (matches the rest of the factory defaults so existing assertions hold).
const mockIsOrgPoolingEnabled: Mock<() => boolean> = mock(() => false);
const mockDrainOrg: Mock<(orgId: string) => Promise<{ drained: number }>> = mock(
  async () => ({ drained: 0 }),
);

const mocks = createApiTestMocks({
  authUser: {
    id: "platform-admin-1",
    mode: "managed",
    label: "platform@test.com",
    role: "platform_admin",
    activeOrganizationId: "org-test",
  },
  authMode: "managed",
  internal: {
    getWorkspaceDetails: mockGetWorkspaceDetails,
    updateWorkspaceStatus: mockUpdateWorkspaceStatus,
    updateWorkspacePlanTier: mockUpdateWorkspacePlanTier,
    cascadeWorkspaceDelete: mockCascadeWorkspaceDelete,
  },
  connection: {
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [{ id: "default", dbType: "postgres" }],
      healthCheck: mock(() =>
        Promise.resolve({ status: "healthy", latencyMs: 1, checkedAt: new Date() }),
      ),
      register: mock(() => {}),
      unregister: mock(() => {}),
      has: mock(() => false),
      getForOrg: () => null,
      isOrgPoolingEnabled: mockIsOrgPoolingEnabled,
      drainOrg: mockDrainOrg,
    },
    resolveDatasourceUrl: () => "postgresql://stub",
  },
});

// Capture `logAdminAction` calls. Pass through the real `ADMIN_ACTIONS`
// catalog so assertions pin to canonical string values — a drift in the
// catalog would break this suite before hitting the audited route.
interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// Import the app AFTER mocks.
const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function platformRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      ...extraHeaders,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function makeWorkspace(overrides: Partial<WorkspaceStub> = {}): WorkspaceStub {
  return {
    id: "org-parity",
    workspace_status: "active",
    plan_tier: "starter",
    name: "Parity Co",
    slug: "parity-co",
    ...overrides,
  };
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

// Core parity invariants — every emission must agree on these fields
// regardless of the surface. `metadata` is compared separately per route
// because per-action-type metadata legitimately differs (e.g. `cleanup` on
// delete vs. `previousPlan` on changePlan) but must match platform-admin's.
function assertCoreAuditShape(entry: AuditEntry, expected: {
  actionType: string;
  targetId: string;
}): void {
  expect(entry.actionType).toBe(expected.actionType);
  expect(entry.targetType).toBe("workspace");
  expect(entry.targetId).toBe(expected.targetId);
  expect(entry.scope).toBe("platform");
  expect(entry.status ?? "success").toBe("success");
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setPlatformAdmin("org-test");
  mockLogAdminAction.mockClear();
  mockGetWorkspaceDetails.mockReset();
  mockUpdateWorkspaceStatus.mockReset();
  mockUpdateWorkspacePlanTier.mockReset();
  mockCascadeWorkspaceDelete.mockReset();
  mockUpdateWorkspaceStatus.mockResolvedValue(true);
  mockUpdateWorkspacePlanTier.mockResolvedValue(true);
  mockCascadeWorkspaceDelete.mockResolvedValue({
    conversations: 3,
    semanticEntities: 2,
    learnedPatterns: 1,
    suggestions: 0,
    scheduledTasks: 0,
    settings: 0,
  });
  mockIsOrgPoolingEnabled.mockReset();
  mockIsOrgPoolingEnabled.mockReturnValue(false);
  mockDrainOrg.mockReset();
  mockDrainOrg.mockResolvedValue({ drained: 0 });
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/organizations/:id/suspend
// ---------------------------------------------------------------------------

describe("admin-orgs PATCH /:id/suspend — audit emission (F-31)", () => {
  it("emits workspace.suspend with platform scope and targetId", async () => {
    mockGetWorkspaceDetails
      .mockResolvedValueOnce(makeWorkspace({ id: "org-parity", workspace_status: "active" }))
      .mockResolvedValueOnce(makeWorkspace({ id: "org-parity", workspace_status: "suspended" }));

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-parity/suspend"),
    );
    expect(res.status).toBe(200);

    const entry = lastAuditCall();
    assertCoreAuditShape(entry, {
      actionType: "workspace.suspend",
      targetId: "org-parity",
    });
  });

  it("does not emit when the workspace is already suspended (409)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "suspended" }),
    );

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-parity/suspend"),
    );
    expect(res.status).toBe(409);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });

  it("does not emit when the workspace is not found (404)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(null);

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-missing/suspend"),
    );
    expect(res.status).toBe(404);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });

  it("threads x-forwarded-for into ipAddress", async () => {
    mockGetWorkspaceDetails
      .mockResolvedValueOnce(makeWorkspace({ id: "org-parity", workspace_status: "active" }))
      .mockResolvedValueOnce(makeWorkspace({ id: "org-parity", workspace_status: "suspended" }));

    const res = await app.fetch(
      platformRequest(
        "PATCH",
        "/api/v1/admin/organizations/org-parity/suspend",
        undefined,
        { "x-forwarded-for": "203.0.113.5" },
      ),
    );
    expect(res.status).toBe(200);
    expect(lastAuditCall().ipAddress).toBe("203.0.113.5");
  });

  it("emits the audit row even when pool drain fails after the mutation commits", async () => {
    // The motivating bug for F-31: if `updateWorkspaceStatus` commits
    // and `drainOrg` then throws, the workspace is suspended in the DB
    // but no audit row is emitted. Proved by placing the audit call
    // BEFORE the drain in the handler — a drain rejection still fails
    // the response but the `admin_action_log` row has landed.
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "active" }),
    );
    mockIsOrgPoolingEnabled.mockReturnValue(true);
    mockDrainOrg.mockRejectedValue(new Error("pool stuck"));

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-parity/suspend"),
    );
    // Drain failure still surfaces as a 500 — the caller retries —
    // but the audit row must persist regardless.
    expect(res.status).toBe(500);
    expect(mockLogAdminAction.mock.calls.length).toBe(1);
    expect(lastAuditCall().actionType).toBe("workspace.suspend");
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith(
      "org-parity",
      "suspended",
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/organizations/:id/activate
// ---------------------------------------------------------------------------

describe("admin-orgs PATCH /:id/activate — audit emission (F-31)", () => {
  it("emits workspace.unsuspend (not workspace.activate) with platform scope", async () => {
    mockGetWorkspaceDetails
      .mockResolvedValueOnce(makeWorkspace({ id: "org-parity", workspace_status: "suspended" }))
      .mockResolvedValueOnce(makeWorkspace({ id: "org-parity", workspace_status: "active" }));

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-parity/activate"),
    );
    expect(res.status).toBe(200);

    // The canonical action_type is `workspace.unsuspend` (matching
    // platform-admin.ts) — NOT `workspace.activate`. Compliance queries
    // filtering on `action_type = 'workspace.unsuspend'` depend on this.
    assertCoreAuditShape(lastAuditCall(), {
      actionType: "workspace.unsuspend",
      targetId: "org-parity",
    });
  });

  it("does not emit when workspace is already active (409)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "active" }),
    );

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-parity/activate"),
    );
    expect(res.status).toBe(409);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });

  it("does not emit when the workspace is not found (404)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(null);

    const res = await app.fetch(
      platformRequest("PATCH", "/api/v1/admin/organizations/org-missing/activate"),
    );
    expect(res.status).toBe(404);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/admin/organizations/:id/plan
// ---------------------------------------------------------------------------

describe("admin-orgs PATCH /:id/plan — audit emission (F-31)", () => {
  it("emits workspace.change_plan with { previousPlan, newPlan } metadata", async () => {
    mockGetWorkspaceDetails
      .mockResolvedValueOnce(
        makeWorkspace({ id: "org-parity", workspace_status: "active", plan_tier: "starter" }),
      )
      .mockResolvedValueOnce(
        makeWorkspace({ id: "org-parity", workspace_status: "active", plan_tier: "pro" }),
      );

    const res = await app.fetch(
      platformRequest(
        "PATCH",
        "/api/v1/admin/organizations/org-parity/plan",
        { planTier: "pro" },
      ),
    );
    expect(res.status).toBe(200);

    const entry = lastAuditCall();
    assertCoreAuditShape(entry, {
      actionType: "workspace.change_plan",
      targetId: "org-parity",
    });
    // Metadata shape mirrors platform-admin.ts:
    //   { previousPlan: <old tier>, newPlan: <new tier> }
    expect(entry.metadata).toEqual({ previousPlan: "starter", newPlan: "pro" });
  });

  it("does not emit on invalid plan tier (400)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "active", plan_tier: "starter" }),
    );

    const res = await app.fetch(
      platformRequest(
        "PATCH",
        "/api/v1/admin/organizations/org-parity/plan",
        { planTier: "not-a-tier" },
      ),
    );
    expect(res.status).toBe(400);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });

  it("does not emit when workspace is deleted (409)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "deleted", plan_tier: "starter" }),
    );

    const res = await app.fetch(
      platformRequest(
        "PATCH",
        "/api/v1/admin/organizations/org-parity/plan",
        { planTier: "pro" },
      ),
    );
    expect(res.status).toBe(409);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/organizations/:id
// ---------------------------------------------------------------------------

describe("admin-orgs DELETE /:id — audit emission (F-31)", () => {
  it("emits workspace.delete with cleanup metadata after a successful cascade", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "active" }),
    );

    const res = await app.fetch(
      platformRequest("DELETE", "/api/v1/admin/organizations/org-parity"),
    );
    expect(res.status).toBe(200);

    const entry = lastAuditCall();
    assertCoreAuditShape(entry, {
      actionType: "workspace.delete",
      targetId: "org-parity",
    });
    // `cleanup` matches platform-admin.ts — the cascade return shape flows
    // into metadata.cleanup verbatim.
    expect(entry.metadata).toMatchObject({
      cleanup: {
        conversations: 3,
        semanticEntities: 2,
        learnedPatterns: 1,
        suggestions: 0,
        scheduledTasks: 0,
        settings: 0,
      },
    });
  });

  it("does not emit when workspace is already deleted (409)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "deleted" }),
    );

    const res = await app.fetch(
      platformRequest("DELETE", "/api/v1/admin/organizations/org-parity"),
    );
    expect(res.status).toBe(409);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });

  it("does not emit when the workspace is not found (404)", async () => {
    mockGetWorkspaceDetails.mockResolvedValue(null);

    const res = await app.fetch(
      platformRequest("DELETE", "/api/v1/admin/organizations/org-missing"),
    );
    expect(res.status).toBe(404);
    expect(mockLogAdminAction.mock.calls.length).toBe(0);
  });

  it("records poolsDrained in metadata when org pooling is enabled", async () => {
    // Default mock has pooling off, so the happy-path test above never
    // exercises the `poolsDrained` branch. Turn pooling on here and
    // assert the count flows from `drainOrg`'s return into metadata —
    // catches a rename of this metadata key.
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "active" }),
    );
    mockIsOrgPoolingEnabled.mockReturnValue(true);
    mockDrainOrg.mockResolvedValue({ drained: 3 });

    const res = await app.fetch(
      platformRequest("DELETE", "/api/v1/admin/organizations/org-parity"),
    );
    expect(res.status).toBe(200);
    expect(mockDrainOrg).toHaveBeenCalledWith("org-parity");

    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ poolsDrained: 3 });
    // `warnings` only appears on drain failure — happy path omits it.
    expect(entry.metadata).not.toHaveProperty("warnings");
  });

  it("records a warnings array in metadata when drainOrg fails", async () => {
    // The delete handler is fail-open on drain (distinct from suspend,
    // which is fail-closed): the cascade still commits, the status
    // still flips to "deleted", and the audit row records a
    // `pool_drain_failed: <message>` warning so partial cleanup is
    // visible in the trail.
    mockGetWorkspaceDetails.mockResolvedValue(
      makeWorkspace({ id: "org-parity", workspace_status: "active" }),
    );
    mockIsOrgPoolingEnabled.mockReturnValue(true);
    mockDrainOrg.mockRejectedValue(new Error("pool was stuck"));

    const res = await app.fetch(
      platformRequest("DELETE", "/api/v1/admin/organizations/org-parity"),
    );
    expect(res.status).toBe(200);

    const entry = lastAuditCall();
    expect(entry.metadata).toHaveProperty("warnings");
    const warnings = (entry.metadata as { warnings: unknown }).warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^pool_drain_failed: /);
    expect(warnings[0]).toContain("pool was stuck");
    // poolsDrained still recorded (stays 0 on failure).
    expect(entry.metadata).toMatchObject({ poolsDrained: 0 });
  });
});

// ---------------------------------------------------------------------------
// Parity with /api/v1/platform/workspaces — same action_type per surface
// ---------------------------------------------------------------------------

describe("admin-orgs ↔ platform-admin parity (F-31)", () => {
  const SURFACES: ReadonlyArray<{
    name: string;
    adminOrgs: { method: string; path: (id: string) => string; body?: unknown };
    platform: { method: string; path: (id: string) => string; body?: unknown };
    expected: { actionType: string; metadataKeys?: ReadonlyArray<string> };
    preFetchCount: number;
  }> = [
    {
      name: "suspend",
      adminOrgs: {
        method: "PATCH",
        path: (id) => `/api/v1/admin/organizations/${id}/suspend`,
      },
      platform: {
        method: "POST",
        path: (id) => `/api/v1/platform/workspaces/${id}/suspend`,
      },
      expected: { actionType: "workspace.suspend" },
      preFetchCount: 2,
    },
    {
      name: "unsuspend / activate",
      adminOrgs: {
        method: "PATCH",
        path: (id) => `/api/v1/admin/organizations/${id}/activate`,
      },
      platform: {
        method: "POST",
        path: (id) => `/api/v1/platform/workspaces/${id}/unsuspend`,
      },
      expected: { actionType: "workspace.unsuspend" },
      preFetchCount: 2,
    },
    {
      name: "change plan",
      adminOrgs: {
        method: "PATCH",
        path: (id) => `/api/v1/admin/organizations/${id}/plan`,
        body: { planTier: "pro" },
      },
      platform: {
        method: "PATCH",
        path: (id) => `/api/v1/platform/workspaces/${id}/plan`,
        body: { planTier: "pro" },
      },
      expected: {
        actionType: "workspace.change_plan",
        metadataKeys: ["previousPlan", "newPlan"],
      },
      preFetchCount: 2,
    },
    {
      name: "delete",
      adminOrgs: {
        method: "DELETE",
        path: (id) => `/api/v1/admin/organizations/${id}`,
      },
      platform: {
        method: "DELETE",
        path: (id) => `/api/v1/platform/workspaces/${id}`,
      },
      expected: {
        actionType: "workspace.delete",
        metadataKeys: ["cleanup"],
      },
      preFetchCount: 1,
    },
  ];

  for (const surface of SURFACES) {
    it(`${surface.name} emits identical action_type + scope on both surfaces`, async () => {
      // ── Call admin-orgs surface ────────────────────────────────
      const wsForAdminOrgs: WorkspaceStub =
        surface.name === "unsuspend / activate"
          ? makeWorkspace({
              id: "org-parity",
              workspace_status: "suspended",
              plan_tier: "starter",
            })
          : makeWorkspace({
              id: "org-parity",
              workspace_status: "active",
              plan_tier: "starter",
            });

      mockGetWorkspaceDetails.mockReset();
      // admin-orgs pre-fetches the workspace; suspend/activate/plan also
      // re-fetch after the mutation for the response body.
      for (let i = 0; i < surface.preFetchCount; i++) {
        mockGetWorkspaceDetails.mockResolvedValueOnce(wsForAdminOrgs);
      }
      mockLogAdminAction.mockClear();

      const res1 = await app.fetch(
        platformRequest(
          surface.adminOrgs.method,
          surface.adminOrgs.path("org-parity"),
          surface.adminOrgs.body,
        ),
      );
      expect(res1.status).toBe(200);
      const adminOrgsEntry = lastAuditCall();

      // ── Call platform-admin surface ────────────────────────────
      mockGetWorkspaceDetails.mockReset();
      mockGetWorkspaceDetails.mockResolvedValue(wsForAdminOrgs);
      mockLogAdminAction.mockClear();

      const res2 = await app.fetch(
        platformRequest(
          surface.platform.method,
          surface.platform.path("org-parity"),
          surface.platform.body,
        ),
      );
      expect(res2.status).toBe(200);
      const platformEntry = lastAuditCall();

      // Snapshot the canonical fields from each surface and compare
      // entries DIRECTLY. Per-route describe blocks above already pin
      // each surface to its expected literal values — this block pins
      // the two surfaces to each other so a one-sided regression where
      // both agree on the wrong value (e.g. both scope: "workspace")
      // still breaks the suite.
      const canonical = (entry: AuditEntry) => ({
        actionType: entry.actionType,
        targetType: entry.targetType,
        targetId: entry.targetId,
        scope: entry.scope,
        status: entry.status ?? "success",
      });
      expect(canonical(adminOrgsEntry)).toEqual(canonical(platformEntry));

      // Metadata-key + value parity for canonical keys. Both surfaces
      // read the same pre-mutation workspace stub and call the same
      // cascade mock, so canonical metadata values must be identical;
      // a surface-specific divergence on e.g. `previousPlan` capture
      // point would break this.
      if (surface.expected.metadataKeys) {
        for (const k of surface.expected.metadataKeys) {
          expect(adminOrgsEntry.metadata).toHaveProperty(k);
          expect(platformEntry.metadata).toHaveProperty(k);
          expect(
            (adminOrgsEntry.metadata as Record<string, unknown>)[k],
          ).toEqual(
            (platformEntry.metadata as Record<string, unknown>)[k],
          );
        }
      }
    });
  }
});
