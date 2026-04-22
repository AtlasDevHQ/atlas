/**
 * Tests for GET /api/v1/admin/approval/queue — exercises the
 * @hono/zod-openapi query validation on `?status=` and the shared
 * `validationHook` which surfaces zod errors as 422 (see
 * packages/api/src/api/routes/validation-hook.ts).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Data, Effect } from "effect";

// Declared at module scope so `mock.module()` factories — which run before
// imported module code — can capture this class reference. An inline require()
// inside the factory would violate the @typescript-eslint/no-require-imports rule.
class MockApprovalError extends Data.TaggedError("ApprovalError")<{
  message: string;
  code: "validation" | "not_found" | "conflict" | "expired";
}> {}

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  internalExecute: async () => {},
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

const defaultAuthResponse = () =>
  Promise.resolve({
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      mode: "managed",
      label: "admin@test.dev",
      role: "admin",
      activeOrganizationId: "org-test",
    },
  });

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () => defaultAuthResponse(),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
}));

// --- EE approval mock -----------------------------------------------------

const mockListApprovalRequests: Mock<(orgId: string, status?: string) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed([]),
);

const mockExpireStaleRequests: Mock<(orgId: string) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed(0),
);

mock.module("@atlas/ee/governance/approval", () => {
  return {
    ApprovalError: MockApprovalError,
    listApprovalRules: () => Effect.succeed([]),
    createApprovalRule: () => Effect.succeed({}),
    updateApprovalRule: () => Effect.succeed({}),
    deleteApprovalRule: () => Effect.succeed(true),
    listApprovalRequests: mockListApprovalRequests,
    getApprovalRequest: () => Effect.succeed(null),
    reviewApprovalRequest: () => Effect.succeed({}),
    expireStaleRequests: mockExpireStaleRequests,
    getPendingCount: () => Effect.succeed(0),
  };
});

// --- Audit mock -----------------------------------------------------------

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: () => {},
  ADMIN_ACTIONS: {
    approval: { approve: "approval.approve", deny: "approval.deny" },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { adminApproval } = await import("../admin-approval");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /queue — ?status= query validation", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockImplementation(defaultAuthResponse);
    mockListApprovalRequests.mockClear();
    mockListApprovalRequests.mockImplementation(() => Effect.succeed([]));
  });

  it("returns 422 validation_error when status is not a valid enum value", async () => {
    const res = await adminApproval.request("/queue?status=frobozz");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string; details: unknown[] };
    expect(body.error).toBe("validation_error");
    expect(body.message).toContain("query");
    expect(Array.isArray(body.details)).toBe(true);
    // listApprovalRequests should NOT have been called — validation fails before the handler
    expect(mockListApprovalRequests).not.toHaveBeenCalled();
  });

  it("accepts status=pending and passes it to listApprovalRequests", async () => {
    const res = await adminApproval.request("/queue?status=pending");
    expect(res.status).toBe(200);
    expect(mockListApprovalRequests).toHaveBeenCalledTimes(1);
    const [orgId, status] = mockListApprovalRequests.mock.calls[0]!;
    expect(orgId).toBe("org-test");
    expect(status).toBe("pending");
  });

  it("accepts all four valid statuses", async () => {
    for (const status of ["pending", "approved", "denied", "expired"]) {
      mockListApprovalRequests.mockClear();
      const res = await adminApproval.request(`/queue?status=${status}`);
      expect(res.status).toBe(200);
      expect(mockListApprovalRequests).toHaveBeenCalledTimes(1);
      expect(mockListApprovalRequests.mock.calls[0]![1]).toBe(status);
    }
  });

  it("omits the status filter when no ?status= is provided", async () => {
    const res = await adminApproval.request("/queue");
    expect(res.status).toBe(200);
    expect(mockListApprovalRequests).toHaveBeenCalledTimes(1);
    const [orgId, status] = mockListApprovalRequests.mock.calls[0]!;
    expect(orgId).toBe("org-test");
    expect(status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /expire — org scope (F-13, 1.2.3 phase 2)
//
// Regression guard: before F-13 the /expire route was registered BEFORE
// `requireOrgContext` + called `expireStaleRequests()` with no args, so any
// workspace admin could trigger a cross-tenant UPDATE that expired every
// pending row. The fix moves the route below `requireOrgContext` and
// threads the caller's active orgId into the scoped UPDATE.
// ---------------------------------------------------------------------------

describe("POST /expire — org scope (F-13)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockImplementation(defaultAuthResponse);
    mockExpireStaleRequests.mockClear();
    mockExpireStaleRequests.mockImplementation(() => Effect.succeed(0));
  });

  it("forwards the caller's active orgId to expireStaleRequests", async () => {
    const res = await adminApproval.request("/expire", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockExpireStaleRequests).toHaveBeenCalledTimes(1);
    const [orgId] = mockExpireStaleRequests.mock.calls[0]!;
    expect(orgId).toBe("org-test");
  });

  it("rejects callers without an active org (requireOrgContext)", async () => {
    mockAuthenticateRequest.mockImplementationOnce(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: { id: "admin-1", mode: "managed", label: "admin@test.dev", role: "admin" },
      }),
    );

    const res = await adminApproval.request("/expire", { method: "POST" });
    expect(res.status).toBe(400);
    expect(mockExpireStaleRequests).not.toHaveBeenCalled();
  });
});
