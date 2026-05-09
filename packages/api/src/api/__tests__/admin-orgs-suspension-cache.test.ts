/**
 * Regression coverage for #2165 — suspended-org state inconsistency.
 *
 * `getCachedWorkspace()` (the user-facing path used by `checkWorkspaceStatus`
 * and `checkPlanLimits`) caches the workspace row for 60s. Pre-fix, the
 * suspend / activate / delete handlers in `admin-orgs.ts` and
 * `platform-admin.ts` mutated `organization.workspace_status` but did not
 * invalidate the in-memory cache, so a user pod could keep serving the
 * pre-suspension state for up to a minute (per pod). Plan-tier mutations
 * already invalidated the cache; status mutations did not.
 *
 * These tests assert that every status-flipping handler forces a fresh
 * read on the next `getCachedWorkspace()` call.
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

interface WorkspaceStub {
  id: string;
  workspace_status: "active" | "suspended" | "deleted";
  plan_tier: "free" | "trial" | "starter" | "pro" | "business";
  byot: boolean;
  stripe_customer_id: string | null;
  trial_ends_at: string | null;
  suspended_at: string | null;
  deleted_at: string | null;
  region: string | null;
  region_assigned_at: string | null;
  createdAt: string;
  name: string;
  slug: string;
}

const mockGetWorkspaceDetails: Mock<
  (orgId: string) => Promise<WorkspaceStub | null>
> = mock(async () => null);
const mockUpdateWorkspaceStatus = mock(async () => true);
const mockCascadeWorkspaceDelete = mock(async () => ({
  conversations: 0,
  semanticEntities: 0,
  learnedPatterns: 0,
  suggestions: 0,
  scheduledTasks: 0,
  settings: 0,
}));

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
    cascadeWorkspaceDelete: mockCascadeWorkspaceDelete,
  },
});

const { app } = await import("../index");
const { getCachedWorkspace, invalidatePlanCache } = await import(
  "@atlas/api/lib/billing/enforcement"
);

afterAll(() => mocks.cleanup());

function makeWorkspace(overrides: Partial<WorkspaceStub> = {}): WorkspaceStub {
  return {
    id: "org-x",
    name: "Test Org",
    slug: "test-org",
    workspace_status: "active",
    plan_tier: "starter",
    byot: false,
    stripe_customer_id: null,
    trial_ends_at: null,
    suspended_at: null,
    deleted_at: null,
    region: null,
    region_assigned_at: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function platformRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  });
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setPlatformAdmin("org-test");
  invalidatePlanCache();
  mockGetWorkspaceDetails.mockReset();
  mockUpdateWorkspaceStatus.mockReset();
  mockUpdateWorkspaceStatus.mockResolvedValue(true);
  mockCascadeWorkspaceDelete.mockReset();
  mockCascadeWorkspaceDelete.mockResolvedValue({
    conversations: 0,
    semanticEntities: 0,
    learnedPatterns: 0,
    suggestions: 0,
    scheduledTasks: 0,
    settings: 0,
  });
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
});

describe("#2165 — suspended-org cache invalidation", () => {
  describe("admin-orgs (POST-FIX) PATCH /:id/suspend", () => {
    it("invalidates getCachedWorkspace so the next read sees 'suspended' immediately", async () => {
      // 1. Pre-populate cache by simulating a user request that lands
      //    while the org is still active.
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-x", workspace_status: "active" }),
      );
      const before = await getCachedWorkspace("org-x");
      expect(before?.workspace_status).toBe("active");

      // 2. Suspend the workspace via the platform-admin handler.
      //    The handler reads `getWorkspaceDetails` twice — once for the
      //    precondition check, once after the status flip for the
      //    response payload.
      mockGetWorkspaceDetails
        .mockResolvedValueOnce(
          makeWorkspace({ id: "org-x", workspace_status: "active" }),
        )
        .mockResolvedValueOnce(
          makeWorkspace({ id: "org-x", workspace_status: "suspended" }),
        );

      const res = await app.fetch(
        platformRequest(
          "PATCH",
          "/api/v1/admin/organizations/org-x/suspend",
        ),
      );
      expect(res.status).toBe(200);

      // 3. The next user-side request must see the new status.
      //    Pre-fix this would still return the cached "active" until
      //    the 60s TTL elapsed — that is exactly the bug.
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-x", workspace_status: "suspended" }),
      );
      const after = await getCachedWorkspace("org-x");
      expect(after?.workspace_status).toBe("suspended");
    });
  });

  describe("admin-orgs (POST-FIX) PATCH /:id/activate", () => {
    it("invalidates getCachedWorkspace so the next read sees 'active' immediately", async () => {
      // Pre-populate cache with a suspended state.
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({
          id: "org-x",
          workspace_status: "suspended",
          suspended_at: new Date().toISOString(),
        }),
      );
      const before = await getCachedWorkspace("org-x");
      expect(before?.workspace_status).toBe("suspended");

      mockGetWorkspaceDetails
        .mockResolvedValueOnce(
          makeWorkspace({
            id: "org-x",
            workspace_status: "suspended",
            suspended_at: new Date().toISOString(),
          }),
        )
        .mockResolvedValueOnce(
          makeWorkspace({ id: "org-x", workspace_status: "active" }),
        );

      const res = await app.fetch(
        platformRequest(
          "PATCH",
          "/api/v1/admin/organizations/org-x/activate",
        ),
      );
      expect(res.status).toBe(200);

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-x", workspace_status: "active" }),
      );
      const after = await getCachedWorkspace("org-x");
      expect(after?.workspace_status).toBe("active");
    });
  });

  describe("admin-orgs (POST-FIX) DELETE /:id", () => {
    it("invalidates getCachedWorkspace so the next read sees 'deleted' immediately", async () => {
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-x", workspace_status: "active" }),
      );
      const before = await getCachedWorkspace("org-x");
      expect(before?.workspace_status).toBe("active");

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-x", workspace_status: "active" }),
      );

      const res = await app.fetch(
        platformRequest("DELETE", "/api/v1/admin/organizations/org-x"),
      );
      expect(res.status).toBe(200);

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({
          id: "org-x",
          workspace_status: "deleted",
          deleted_at: new Date().toISOString(),
        }),
      );
      const after = await getCachedWorkspace("org-x");
      expect(after?.workspace_status).toBe("deleted");
    });
  });

  describe("platform-admin POST /platform/workspaces/:id/suspend", () => {
    it("invalidates getCachedWorkspace so the next read sees 'suspended' immediately", async () => {
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-y", workspace_status: "active" }),
      );
      const before = await getCachedWorkspace("org-y");
      expect(before?.workspace_status).toBe("active");

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-y", workspace_status: "active" }),
      );

      const res = await app.fetch(
        platformRequest(
          "POST",
          "/api/v1/platform/workspaces/org-y/suspend",
        ),
      );
      expect(res.status).toBe(200);

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-y", workspace_status: "suspended" }),
      );
      const after = await getCachedWorkspace("org-y");
      expect(after?.workspace_status).toBe("suspended");
    });
  });

  describe("platform-admin POST /platform/workspaces/:id/unsuspend", () => {
    it("invalidates getCachedWorkspace so the next read sees 'active' immediately", async () => {
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({
          id: "org-y",
          workspace_status: "suspended",
          suspended_at: new Date().toISOString(),
        }),
      );
      const before = await getCachedWorkspace("org-y");
      expect(before?.workspace_status).toBe("suspended");

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({
          id: "org-y",
          workspace_status: "suspended",
          suspended_at: new Date().toISOString(),
        }),
      );

      const res = await app.fetch(
        platformRequest(
          "POST",
          "/api/v1/platform/workspaces/org-y/unsuspend",
        ),
      );
      expect(res.status).toBe(200);

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-y", workspace_status: "active" }),
      );
      const after = await getCachedWorkspace("org-y");
      expect(after?.workspace_status).toBe("active");
    });
  });

  describe("platform-admin DELETE /platform/workspaces/:id", () => {
    it("invalidates getCachedWorkspace so the next read sees 'deleted' immediately", async () => {
      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-y", workspace_status: "active" }),
      );
      const before = await getCachedWorkspace("org-y");
      expect(before?.workspace_status).toBe("active");

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({ id: "org-y", workspace_status: "active" }),
      );

      const res = await app.fetch(
        platformRequest(
          "DELETE",
          "/api/v1/platform/workspaces/org-y",
        ),
      );
      expect(res.status).toBe(200);

      mockGetWorkspaceDetails.mockResolvedValueOnce(
        makeWorkspace({
          id: "org-y",
          workspace_status: "deleted",
          deleted_at: new Date().toISOString(),
        }),
      );
      const after = await getCachedWorkspace("org-y");
      expect(after?.workspace_status).toBe("deleted");
    });
  });
});
