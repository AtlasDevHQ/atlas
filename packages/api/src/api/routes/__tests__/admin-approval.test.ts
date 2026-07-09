/**
 * Tests for GET /api/v1/admin/approval/queue — exercises the
 * @hono/zod-openapi query validation on `?status=` and the shared
 * `validationHook` which surfaces zod errors as 422 (see
 * packages/api/src/api/routes/validation-hook.ts).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Data, Effect } from "effect";
import {
  isFeatureEntitlementQuery,
  workspaceTierRows,
} from "@atlas/api/testing/api-test-mocks";

// Declared at module scope so `mock.module()` factories — which run before
// imported module code — can capture this class reference. An inline require()
// inside the factory would violate the no-require-imports rule.
class MockApprovalError extends Data.TaggedError("ApprovalError")<{
  message: string;
  code: "validation" | "not_found" | "conflict" | "expired";
}> {}

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockHasInternalDB = true;

// WS1 (#3987) — the per-tier feature-entitlement guard now runs before every
// approval handler and reads the workspace's `plan_tier` / `is_operator_workspace`
// off the `organization` table via `internalQuery`. This test forces enterprise
// on (below) so deploy mode resolves to `saas` and the guard actually fires;
// approvals gate to Business, so the entitlement query must read back `business`
// or every route 403s with `plan_upgrade_required`. All other queries keep
// returning []. The SQL-shape coupling lives in the shared
// `isFeatureEntitlementQuery` helper so the regex has one definition.
let mockWorkspaceTier: string | null = "business";
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async (sql: string) =>
    isFeatureEntitlementQuery(sql) ? workspaceTierRows(mockWorkspaceTier) : [],
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
      claims: { twoFactorEnabled: true },
    },
  });

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () => defaultAuthResponse(),
);

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

// #3748 — capture error-level logs so the approval-park "failed re-arm" alarm is assertable.
const loggedErrors: Array<{ obj: unknown; msg: string }> = [];
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const recordError = (obj: unknown, msg?: string) => {
    loggedErrors.push({ obj, msg: msg ?? (typeof obj === "string" ? obj : "") });
  };
  const logger = { info: noop, warn: noop, error: recordError, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

void mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

void mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

void mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
}));

// --- EE approval mock -----------------------------------------------------

const mockListApprovalRequests: Mock<(orgId: string, status?: string) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed([]),
);

const mockExpireStaleRequests: Mock<(orgId: string) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed(0),
);

// #3748 — review (approve/deny) returns the reviewed request; the route then
// calls resolveApprovalPark to re-arm any parked turn waiting on it.
const mockReviewApprovalRequest: Mock<(...args: unknown[]) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed({ id: "req-1", status: "approved", origin: null } as never),
);
const mockResolveApprovalPark: Mock<(...args: unknown[]) => Promise<{ status: string; runId?: string }>> = mock(
  async () => ({ status: "none" }),
);

// Mock the durable-resume seam the review route calls. All value exports
// stubbed (the route only uses resolveApprovalPark; prepare/finishResume are
// the rest of the module's surface).
void mock.module("@atlas/api/lib/durable-resume", () => ({
  prepareResume: async () => ({ status: "none" as const }),
  finishResume: () => {},
  resolveApprovalPark: mockResolveApprovalPark,
}));

// #3750 — the chat resume-delivery glue the route invokes after a `resumed`
// re-arm. Mocked so the route test stays at the DB-free seam (the glue itself
// is covered in lib/chat-plugin/__tests__/resume-delivery.test.ts).
const mockDeliverChatResume: Mock<(conversationId: string, decision: string) => Promise<string>> = mock(
  async () => "no_pending",
);
void mock.module("@atlas/api/lib/chat-plugin/resume-delivery", () => ({
  deliverChatResumeIfPending: mockDeliverChatResume,
}));

// Force enterprise on so `ConditionalEELayer` lazy-imports the mocked
// `@atlas/ee/layers` aggregator below.
// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_ENTERPRISE_ENABLED ??= "true";
// WS1 (#3987) — pin SaaS deploy mode so the per-tier feature-entitlement guard
// fires deterministically (it is a no-op off the SaaS path), regardless of the
// ambient ATLAS_DEPLOY_MODE / ATLAS_DEPLOY_ENV.
process.env.ATLAS_DEPLOY_MODE ??= "saas";

// Core ApprovalError class mock so the route's `domainError(ApprovalError, ...)`
// mapping matches the test's `MockApprovalError`.
void mock.module("@atlas/api/lib/governance/errors", () => ({
  ApprovalError: MockApprovalError,
}));

// Stubs for the other core error modules — `EnterpriseLayer`'s no-op
// defaults lazy-require them, even when only ApprovalGate is exercised.
void mock.module("@atlas/api/lib/residency/errors", () => ({
  ResidencyError: class extends Error { public readonly _tag = "ResidencyError" as const; },
}));
void mock.module("@atlas/api/lib/compliance/errors", () => ({
  ComplianceError: class extends Error { public readonly _tag = "ComplianceError" as const; },
  ReportError: class extends Error { public readonly _tag = "ReportError" as const; },
}));
void mock.module("@atlas/api/lib/model-routing/errors", () => ({
  ModelConfigError: class extends Error { public readonly _tag = "ModelConfigError" as const; },
  ModelConfigDecryptError: class extends Error { public readonly _tag = "ModelConfigDecryptError" as const; },
}));

void mock.module("@atlas/ee/layers", () => {
  // oxlint-disable-next-line @typescript-eslint/no-require-imports
  const { Layer, Effect: E } = require("effect") as typeof import("effect");
  return {
    EELayer: Layer.unwrapEffect(
      E.sync(() => {
        // oxlint-disable-next-line @typescript-eslint/no-require-imports
        const services = require("@atlas/api/lib/effect/services") as typeof import("@atlas/api/lib/effect/services");
        return Layer.succeed(services.ApprovalGate, {
          available: true,
          checkApprovalRequired: () => Effect.succeed({ required: false, matchedRules: [] }),
          hasApprovedRequest: () => Effect.succeed(false),
          createApprovalRequest: () => Effect.succeed({} as never),
          listApprovalRules: () => Effect.succeed([]),
          createApprovalRule: () => Effect.succeed({} as never),
          updateApprovalRule: () => Effect.succeed({} as never),
          deleteApprovalRule: () => Effect.succeed(true),
          listApprovalRequests: mockListApprovalRequests as never,
          getApprovalRequest: () => Effect.succeed(null),
          reviewApprovalRequest: mockReviewApprovalRequest as never,
          expireStaleRequests: mockExpireStaleRequests as never,
          getPendingCount: () => Effect.succeed(0),
        } as never);
      }),
    ),
  };
});

// Legacy module-mock stub for any transitive resolver that still
// reaches the old path.
void mock.module("@atlas/ee/governance/approval", () => ({
  ApprovalError: MockApprovalError,
}));

// --- Audit mock -----------------------------------------------------------

void mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: () => {},
  logAdminActionAwait: async () => {},
  // Keep in sync with `ADMIN_ACTIONS.approval` in
  // `packages/api/src/lib/audit/actions.ts` — adding a new action there and
  // forgetting to update this mock leaves route audit calls writing
  // `actionType: undefined` at test time. The parity test in
  // `admin-approval-audit.test.ts` (F-29) enforces the real catalog.
  ADMIN_ACTIONS: {
    approval: {
      approve: "approval.approve",
      deny: "approval.deny",
      ruleCreate: "approval.rule_create",
      ruleUpdate: "approval.rule_update",
      ruleDelete: "approval.rule_delete",
      expireSweep: "approval.expire_sweep",
    },
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
        user: { id: "admin-1", mode: "managed", label: "admin@test.dev", role: "admin", claims: { twoFactorEnabled: true } },
      }),
    );

    const res = await adminApproval.request("/expire", { method: "POST" });
    expect(res.status).toBe(400);
    expect(mockExpireStaleRequests).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /queue/:id — review → approval-park resolution (#3748)
//
// The review endpoint records the decision (reviewApprovalRequest) and then
// re-arms any parked turn waiting on it (resolveApprovalPark). This is the only
// end-to-end seam from a human decision to a parked turn, so pin: (a) the
// resolver is invoked with the right (itemId, action, reviewer) after a
// successful review, and (b) it is fail-soft — a resolver throw must NOT turn an
// already-recorded decision into a 500.
// ---------------------------------------------------------------------------

function reviewRequest(id: string, body: { action: string; comment?: string }) {
  return adminApproval.request(`/queue/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /queue/:id — approval-park resolution (#3748)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockImplementation(defaultAuthResponse);
    mockReviewApprovalRequest.mockClear();
    mockReviewApprovalRequest.mockImplementation(() =>
      Effect.succeed({ id: "req-1", status: "approved", origin: null } as never),
    );
    mockResolveApprovalPark.mockClear();
    mockResolveApprovalPark.mockImplementation(async () => ({ status: "none" }));
    mockDeliverChatResume.mockClear();
    mockDeliverChatResume.mockImplementation(async () => "no_pending");
    loggedErrors.length = 0;
  });

  it("approve: records the decision and re-arms the parked turn with (id, action, reviewer)", async () => {
    const res = await reviewRequest("req-123", { action: "approve", comment: "ok for audit" });
    expect(res.status).toBe(200);
    expect(mockReviewApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mockResolveApprovalPark).toHaveBeenCalledTimes(1);
    const [itemId, action, opts] = mockResolveApprovalPark.mock.calls[0]!;
    expect(itemId).toBe("req-123");
    expect(action).toBe("approve");
    expect(opts).toEqual({ reviewerLabel: "admin@test.dev", comment: "ok for audit" });
  });

  it("deny: forwards the deny decision to the resolver", async () => {
    const res = await reviewRequest("req-456", { action: "deny", comment: "prod frozen" });
    expect(res.status).toBe(200);
    expect(mockResolveApprovalPark.mock.calls[0]![1]).toBe("deny");
    expect(mockResolveApprovalPark.mock.calls[0]![2]).toEqual({
      reviewerLabel: "admin@test.dev",
      comment: "prod frozen",
    });
  });

  it("passes comment: null to the resolver when none is supplied", async () => {
    await reviewRequest("req-789", { action: "approve" });
    expect(mockResolveApprovalPark.mock.calls[0]![2]).toEqual({
      reviewerLabel: "admin@test.dev",
      comment: null,
    });
  });

  it("is fail-soft: a resolver throw does NOT fail the already-recorded review (still 200) and is logged at error", async () => {
    mockResolveApprovalPark.mockImplementationOnce(async () => {
      throw new Error("durable store exploded");
    });
    const res = await reviewRequest("req-boom", { action: "approve" });
    // The decision was recorded; the resume-arm failure is swallowed (200) but NOT
    // silent — it surfaces at error severity so an operator can act.
    expect(res.status).toBe(200);
    expect(mockReviewApprovalRequest).toHaveBeenCalledTimes(1);
    expect(loggedErrors.some((e) => e.msg.includes("approval-park"))).toBe(true);
  });

  it("logs an actionable error when the resolver reports a parked turn it could NOT re-arm (still 200)", async () => {
    // A recorded decision whose parked turn can't be re-armed (stale transcript or
    // DB blip) must not be silent: the route binds the `failed` outcome and alarms
    // rather than discarding it. The review itself still succeeds.
    mockResolveApprovalPark.mockImplementationOnce(async () => ({ status: "failed", runId: "run-stuck" }));
    const res = await reviewRequest("req-stuck", { action: "approve" });
    expect(res.status).toBe(200);
    const alarm = loggedErrors.find((e) => e.msg.includes("NOT re-armed"));
    expect(alarm).toBeDefined();
    expect((alarm!.obj as { runId?: string }).runId).toBe("run-stuck");
  });

  it("stays quiet on a benign outcome — no error log when there was simply no parked turn", async () => {
    mockResolveApprovalPark.mockImplementationOnce(async () => ({ status: "none" }));
    const res = await reviewRequest("req-quiet", { action: "approve" });
    expect(res.status).toBe(200);
    expect(loggedErrors).toHaveLength(0);
  });

  // #3750 — when a parked turn is re-armed, the route triggers chat resume
  // delivery for its conversation (a no-op for web turns / no coordinates).
  it("triggers chat resume delivery with the re-armed conversation when resolveApprovalPark resumes", async () => {
    mockResolveApprovalPark.mockImplementationOnce(async () => ({
      status: "resumed",
      conversationId: "conv-slack-1",
      runId: "run-1",
    }));
    const res = await reviewRequest("req-chat", { action: "approve" });
    expect(res.status).toBe(200);
    expect(mockDeliverChatResume).toHaveBeenCalledTimes(1);
    expect(mockDeliverChatResume.mock.calls[0]![0]).toBe("conv-slack-1");
    expect(mockDeliverChatResume.mock.calls[0]![1]).toBe("approve");
  });

  it("does NOT trigger chat resume delivery when nothing was re-armed (none)", async () => {
    mockResolveApprovalPark.mockImplementationOnce(async () => ({ status: "none" }));
    await reviewRequest("req-none", { action: "approve" });
    expect(mockDeliverChatResume).not.toHaveBeenCalled();
  });

  it("does NOT trigger chat resume delivery when the re-arm failed", async () => {
    mockResolveApprovalPark.mockImplementationOnce(async () => ({ status: "failed", runId: "run-x" }));
    await reviewRequest("req-failed", { action: "approve" });
    expect(mockDeliverChatResume).not.toHaveBeenCalled();
  });

  it("is fail-soft: a chat resume-delivery throw does NOT fail the recorded review (still 200)", async () => {
    mockResolveApprovalPark.mockImplementationOnce(async () => ({
      status: "resumed",
      conversationId: "conv-2",
      runId: "run-2",
    }));
    mockDeliverChatResume.mockImplementationOnce(async () => {
      throw new Error("delivery exploded");
    });
    const res = await reviewRequest("req-deliver-boom", { action: "approve" });
    expect(res.status).toBe(200);
    expect(loggedErrors.some((e) => e.msg.includes("chat resume delivery threw"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-tier feature-entitlement gating (WS1 #3987)
//
// Proves the approval-workflow surface is gated at the route/handler layer
// (not UI-only): on the SaaS per-tier ladder a below-Business workspace is
// denied with 403 `plan_upgrade_required` even though the deployment is
// enterprise-enabled (the EE ApprovalGate mock is live), and a Business
// workspace passes through to the gate. `approvals` defaults to Business in
// the FEATURE_ENTITLEMENTS SSOT.
// ---------------------------------------------------------------------------

describe("admin approval — per-tier entitlement gate (#3987)", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockWorkspaceTier = "business";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockImplementation(defaultAuthResponse);
    mockListApprovalRequests.mockClear();
    mockListApprovalRequests.mockImplementation(() => Effect.succeed([]));
    mockExpireStaleRequests.mockClear();
    mockExpireStaleRequests.mockImplementation(() => Effect.succeed(0));
    mockReviewApprovalRequest.mockClear();
    mockReviewApprovalRequest.mockImplementation(() =>
      Effect.succeed({ id: "req-1", status: "approved", origin: null } as never),
    );
  });

  it("denies a below-tier (Pro) workspace listing rules with 403 plan_upgrade_required", async () => {
    mockWorkspaceTier = "pro";
    const res = await adminApproval.request("/rules");
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      required_plan: string;
      current_plan: string;
    };
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.required_plan).toBe("business");
    expect(body.current_plan).toBe("pro");
  });

  it("denies a below-tier (Starter) workspace reviewing a request", async () => {
    mockWorkspaceTier = "starter";
    const res = await reviewRequest("req-1", { action: "approve" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "plan_upgrade_required",
    );
    // The gate fires BEFORE the EE service — the decision must never be recorded.
    expect(mockReviewApprovalRequest).not.toHaveBeenCalled();
  });

  it("denies the queue listing for a below-tier workspace", async () => {
    mockWorkspaceTier = "free";
    const res = await adminApproval.request("/queue");
    expect(res.status).toBe(403);
    expect(mockListApprovalRequests).not.toHaveBeenCalled();
  });

  it("allows a Business workspace through to the approval gate", async () => {
    mockWorkspaceTier = "business";
    const res = await adminApproval.request("/queue");
    expect(res.status).toBe(200);
    expect(mockListApprovalRequests).toHaveBeenCalledTimes(1);
  });
});
