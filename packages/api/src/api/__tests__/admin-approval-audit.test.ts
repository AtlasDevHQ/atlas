/**
 * Audit regression suite for `admin-approval.ts` — F-29 (#1784).
 *
 * Before this PR, `admin-approval.ts` only audited review decisions
 * (`approval.approve` / `approval.deny`). The rule CRUD + expire-sweep
 * surfaces were silent — a workspace admin could disable the gate, run
 * the action the gate was protecting, and re-enable — end-to-end
 * invisible. This suite pins the four new emissions:
 *
 *   - `POST /rules` → `approval.rule_create`
 *   - `PUT /rules/:id` → `approval.rule_update`
 *   - `DELETE /rules/:id` → `approval.rule_delete`
 *   - `POST /expire` → `approval.expire_sweep`
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
import { Effect, Data } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Mocks — declared before the app import
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

class MockApprovalError extends Data.TaggedError("ApprovalError")<{
  message: string;
  code: "validation" | "not_found" | "conflict" | "expired";
}> {}

// Approval service mocks. Happy-path returns so the route reaches the
// audit call. Per-test overrides exercise the 404 / failure branches.
const mockCreateApprovalRule: Mock<(orgId: string, input: unknown) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed({ id: "rule-123", orgId: "org-alpha", ruleType: "cost", name: "Flag cost", enabled: true }),
);
const mockUpdateApprovalRule: Mock<(orgId: string, id: string, body: unknown) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed({ id: "rule-123", orgId: "org-alpha", ruleType: "cost", name: "Flag cost (updated)", enabled: true }),
);
const mockDeleteApprovalRule: Mock<(orgId: string, id: string) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed(true),
);
const mockExpireStaleRequests: Mock<(orgId: string) => ReturnType<typeof Effect.succeed>> = mock(
  () => Effect.succeed(0),
);

mock.module("@atlas/ee/governance/approval", () => ({
  ApprovalError: MockApprovalError,
  listApprovalRules: () => Effect.succeed([]),
  createApprovalRule: mockCreateApprovalRule,
  updateApprovalRule: mockUpdateApprovalRule,
  deleteApprovalRule: mockDeleteApprovalRule,
  listApprovalRequests: () => Effect.succeed([]),
  getApprovalRequest: () => Effect.succeed(null),
  reviewApprovalRequest: () => Effect.succeed({}),
  expireStaleRequests: mockExpireStaleRequests,
  getPendingCount: () => Effect.succeed(0),
}));

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

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown): Request {
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

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mockLogAdminAction.mockClear();
  mockCreateApprovalRule.mockClear();
  mockCreateApprovalRule.mockImplementation(() =>
    Effect.succeed({ id: "rule-123", orgId: "org-alpha", ruleType: "cost", name: "Flag cost", enabled: true }),
  );
  mockUpdateApprovalRule.mockClear();
  mockUpdateApprovalRule.mockImplementation(() =>
    Effect.succeed({ id: "rule-123", orgId: "org-alpha", ruleType: "cost", name: "Flag cost (updated)", enabled: true }),
  );
  mockDeleteApprovalRule.mockClear();
  mockDeleteApprovalRule.mockImplementation(() => Effect.succeed(true));
  mockExpireStaleRequests.mockClear();
  mockExpireStaleRequests.mockImplementation(() => Effect.succeed(0));
});

// ---------------------------------------------------------------------------
// POST /rules — create
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/approval/rules — audit emission (F-29)", () => {
  it("emits approval.rule_create with name + ruleType metadata", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/approval/rules", {
        ruleType: "cost",
        name: "Flag cost",
        threshold: 1000,
      }),
    );

    expect(res.status).toBe(201);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("approval.rule_create");
    expect(entry.targetType).toBe("approval");
    expect(entry.targetId).toBe("rule-123");
    expect(entry.metadata).toMatchObject({ name: "Flag cost", ruleType: "cost" });
  });
});

// ---------------------------------------------------------------------------
// PUT /rules/:id — update
// ---------------------------------------------------------------------------

describe("PUT /api/v1/admin/approval/rules/:id — audit emission (F-29)", () => {
  it("emits approval.rule_update with keysChanged metadata (values omitted)", async () => {
    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/approval/rules/rule-123", {
        name: "Renamed",
        enabled: false,
      }),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("approval.rule_update");
    expect(entry.targetType).toBe("approval");
    expect(entry.targetId).toBe("rule-123");
    const keys = entry.metadata?.keysChanged;
    expect(Array.isArray(keys)).toBe(true);
    expect((keys as string[]).sort()).toEqual(["enabled", "name"]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /rules/:id — delete
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/admin/approval/rules/:id — audit emission (F-29)", () => {
  it("emits approval.rule_delete when the rule existed", async () => {
    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/approval/rules/rule-123"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("approval.rule_delete");
    expect(entry.targetType).toBe("approval");
    expect(entry.targetId).toBe("rule-123");
    expect(entry.metadata).toMatchObject({ ruleId: "rule-123" });
  });

  it("does not emit when the rule did not exist (404)", async () => {
    mockDeleteApprovalRule.mockImplementation(() => Effect.succeed(false));

    const res = await app.fetch(
      adminRequest("DELETE", "/api/v1/admin/approval/rules/ghost"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /expire — expire-sweep
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/approval/expire — audit emission (F-29)", () => {
  it("emits approval.expire_sweep with expiredCount metadata", async () => {
    mockExpireStaleRequests.mockImplementation(() => Effect.succeed(7));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/approval/expire"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("approval.expire_sweep");
    expect(entry.targetType).toBe("approval");
    expect(entry.targetId).toBe("org-alpha");
    expect(entry.metadata).toMatchObject({ expiredCount: 7 });
  });
});
