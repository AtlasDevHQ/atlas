/**
 * Regression coverage for #2165 — suspended-org state inconsistency.
 *
 * `getCachedWorkspace()` (the user-facing path used by `checkWorkspaceStatus`
 * and `checkPlanLimits`) caches the workspace row for the duration of its
 * TTL window. Pre-fix, the suspend / activate / delete handlers in
 * `admin-orgs.ts` and `platform-admin.ts` mutated
 * `organization.workspace_status` but did not invalidate the in-memory
 * cache, so a user pod could keep serving the pre-suspension state for up
 * to a minute (per pod). Plan-tier mutations already invalidated the
 * cache; status mutations did not.
 *
 * These tests assert that every status-flipping handler (and `changePlan`,
 * after the dynamic-import simplification) forces a fresh read on the
 * next `getCachedWorkspace()` call, and that on `updateWorkspaceStatus`
 * failure the cache is *not* invalidated (regression guard against
 * future refactors that move invalidation before the DB write).
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

// Stateful workspace row driven by mock `updateWorkspaceStatus` /
// `updateWorkspacePlanTier`. Every `getWorkspaceDetails` call returns
// whatever the row currently is, so tests don't depend on the precise
// number of internal lookups each handler performs.
let currentRow: WorkspaceStub;

const mockGetWorkspaceDetails: Mock<
  (orgId: string) => Promise<WorkspaceStub | null>
> = mock(async (orgId: string) => ({ ...currentRow, id: orgId }));

const mockUpdateWorkspaceStatus = mock(
  async (_orgId: string, status: "active" | "suspended" | "deleted") => {
    currentRow = {
      ...currentRow,
      workspace_status: status,
      suspended_at: status === "suspended" ? new Date().toISOString() : null,
      deleted_at: status === "deleted" ? new Date().toISOString() : null,
    };
    return true;
  },
);

const mockUpdateWorkspacePlanTier = mock(
  async (_orgId: string, planTier: WorkspaceStub["plan_tier"]) => {
    currentRow = { ...currentRow, plan_tier: planTier };
    return true;
  },
);

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
    updateWorkspacePlanTier: mockUpdateWorkspacePlanTier,
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

function platformRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setPlatformAdmin("org-test");
  invalidatePlanCache();
  currentRow = makeWorkspace({ id: "org-x" });
  mockGetWorkspaceDetails.mockClear();
  mockUpdateWorkspaceStatus.mockClear();
  mockUpdateWorkspacePlanTier.mockClear();
  mockCascadeWorkspaceDelete.mockClear();
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
});

/**
 * Pre-populate the cache with the row's current status, fire the route,
 * then assert the cache reflects `expectedAfter`. Pre-fix the cache
 * would still hold the original status until the TTL elapsed.
 */
async function expectCacheFlip(opts: {
  orgId: string;
  initial: WorkspaceStub;
  fire: () => Request;
  expectedStatus?: WorkspaceStub["workspace_status"];
  expectedPlanTier?: WorkspaceStub["plan_tier"];
}): Promise<void> {
  currentRow = opts.initial;

  const before = await getCachedWorkspace(opts.orgId);
  expect(before?.workspace_status).toBe(opts.initial.workspace_status);
  expect(before?.plan_tier).toBe(opts.initial.plan_tier);

  const res = await app.fetch(opts.fire());
  expect(res.status).toBe(200);

  const after = await getCachedWorkspace(opts.orgId);
  if (opts.expectedStatus !== undefined) {
    expect(after?.workspace_status).toBe(opts.expectedStatus);
  }
  if (opts.expectedPlanTier !== undefined) {
    expect(after?.plan_tier).toBe(opts.expectedPlanTier);
  }
}

describe("#2165 — workspace cache invalidation across admin paths", () => {
  describe("admin-orgs PATCH /:id/suspend", () => {
    it("forces a fresh read so the next user-side call sees 'suspended'", async () => {
      await expectCacheFlip({
        orgId: "org-x",
        initial: makeWorkspace({ id: "org-x", workspace_status: "active" }),
        fire: () =>
          platformRequest(
            "PATCH",
            "/api/v1/admin/organizations/org-x/suspend",
          ),
        expectedStatus: "suspended",
      });
    });
  });

  describe("admin-orgs PATCH /:id/activate", () => {
    it("forces a fresh read so the next user-side call sees 'active'", async () => {
      await expectCacheFlip({
        orgId: "org-x",
        initial: makeWorkspace({
          id: "org-x",
          workspace_status: "suspended",
          suspended_at: new Date().toISOString(),
        }),
        fire: () =>
          platformRequest(
            "PATCH",
            "/api/v1/admin/organizations/org-x/activate",
          ),
        expectedStatus: "active",
      });
    });
  });

  describe("admin-orgs DELETE /:id", () => {
    it("forces a fresh read so the next user-side call sees 'deleted'", async () => {
      await expectCacheFlip({
        orgId: "org-x",
        initial: makeWorkspace({ id: "org-x", workspace_status: "active" }),
        fire: () =>
          platformRequest("DELETE", "/api/v1/admin/organizations/org-x"),
        expectedStatus: "deleted",
      });
    });
  });

  describe("platform-admin POST /platform/workspaces/:id/suspend", () => {
    it("forces a fresh read so the next user-side call sees 'suspended'", async () => {
      await expectCacheFlip({
        orgId: "org-y",
        initial: makeWorkspace({ id: "org-y", workspace_status: "active" }),
        fire: () =>
          platformRequest("POST", "/api/v1/platform/workspaces/org-y/suspend"),
        expectedStatus: "suspended",
      });
    });
  });

  describe("platform-admin POST /platform/workspaces/:id/unsuspend", () => {
    it("forces a fresh read so the next user-side call sees 'active'", async () => {
      await expectCacheFlip({
        orgId: "org-y",
        initial: makeWorkspace({
          id: "org-y",
          workspace_status: "suspended",
          suspended_at: new Date().toISOString(),
        }),
        fire: () =>
          platformRequest(
            "POST",
            "/api/v1/platform/workspaces/org-y/unsuspend",
          ),
        expectedStatus: "active",
      });
    });
  });

  describe("platform-admin DELETE /platform/workspaces/:id", () => {
    it("forces a fresh read so the next user-side call sees 'deleted'", async () => {
      await expectCacheFlip({
        orgId: "org-y",
        initial: makeWorkspace({ id: "org-y", workspace_status: "active" }),
        fire: () =>
          platformRequest("DELETE", "/api/v1/platform/workspaces/org-y"),
        expectedStatus: "deleted",
      });
    });
  });

  describe("platform-admin PATCH /platform/workspaces/:id/plan (changePlan)", () => {
    // Covers the dynamic-import → static-call simplification in
    // `changePlanRoute`. Pre-PR the call was wrapped in
    // `Effect.tryPromise`; post-PR it's a plain synchronous call.
    // This test guards against a future regression where the
    // invalidation goes missing (the wrapping never returned a
    // failing path in practice, so removing it can't lose coverage).
    it("forces a fresh read so the next user-side call sees the new plan tier", async () => {
      await expectCacheFlip({
        orgId: "org-z",
        initial: makeWorkspace({
          id: "org-z",
          workspace_status: "active",
          plan_tier: "starter",
        }),
        fire: () =>
          platformRequest(
            "PATCH",
            "/api/v1/platform/workspaces/org-z/plan",
            { planTier: "pro" },
          ),
        expectedPlanTier: "pro",
      });
    });
  });

  // ── Failure-path regression guard ────────────────────────────────────

  // (Integration through the user-facing `checkWorkspaceStatus` is
  // covered indirectly: `workspace.test.ts` already pins
  // `checkWorkspaceStatus` → `getCachedWorkspace` for every status, and
  // these tests pin the route → `getCachedWorkspace` direction. The
  // composition is sound without a third test that spans both, which
  // would require wiring around `createApiTestMocks`'s passthrough mock
  // of the workspace module.)

  describe("when updateWorkspaceStatus fails", () => {
    // Invalidation is intentionally placed AFTER the DB write so a DB
    // failure leaves the cache untouched (the `active` row in cache
    // matches the `active` row in the DB — no divergence). A future
    // refactor that moves invalidation before the await would silently
    // wipe the cache on a failure path, leading to a re-read that hits
    // the DB and re-caches the unchanged value — a wasted round-trip
    // at best, an inconsistency under concurrent mutations at worst.
    // This test pins the ordering invariant.
    it("does not invalidate the cache when the suspend DB write rejects", async () => {
      currentRow = makeWorkspace({ id: "org-x", workspace_status: "active" });

      // Pre-populate the cache.
      const before = await getCachedWorkspace("org-x");
      expect(before?.workspace_status).toBe("active");

      // Make the DB write fail.
      mockUpdateWorkspaceStatus.mockImplementationOnce(async () => {
        throw new Error("simulated DB failure");
      });

      const res = await app.fetch(
        platformRequest("PATCH", "/api/v1/admin/organizations/org-x/suspend"),
      );
      expect(res.status).toBeGreaterThanOrEqual(500);

      // currentRow was never flipped (the mock threw before mutating
      // it), so a fresh getWorkspaceDetails would still see "active".
      // What we care about: the cache wasn't dropped — a re-read
      // returns the cached entry without re-invoking
      // getWorkspaceDetails. We verify by checking call count: only
      // the original cache-populate call happened.
      const callsBefore = mockGetWorkspaceDetails.mock.calls.length;
      const after = await getCachedWorkspace("org-x");
      expect(after?.workspace_status).toBe("active");
      expect(mockGetWorkspaceDetails.mock.calls.length).toBe(callsBefore);
    });
  });
});
