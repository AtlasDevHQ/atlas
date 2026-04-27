/**
 * Tests for admin-action retention + erasure API meta-audit (F-36 Phase 2).
 *
 * Mirrors `admin-audit-retention.test.ts`. Every write to the admin-action
 * retention + erasure surface must emit `logAdminAction` (policy update,
 * manual purge) or rely on the library's own emission (`user.erase` for
 * erasure success — see `anonymizeUserAdminActions` contract in
 * ee/src/audit/retention.ts).
 *
 * Failure-path regression: when the library throws on an erasure request,
 * the route still emits a `user.erase` status:failure row so a compliance
 * reviewer sees the attempt even though the scrub never landed.
 *
 * Tests the sub-routers directly so we can drive the EE retention service
 * via mocks without booting every adjacent admin dependency.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";

// ── Auth + DB stubs (sub-routers use createAdminRouter → adminAuth) ──

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { twoFactorEnabled: true },
      },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "managed",
  resetAuthModeCache: () => {},
}));

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({
    query: () => Promise.resolve({ rows: [] }),
    end: async () => {},
    on: () => {},
  }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: mock(() => {}),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => null,
}));

// ── Audit logger mock — capture every audit emission ──────────────────

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(
  () => {},
);
let mockLogAdminActionAwaitError: Error | null = null;
const mockLogAdminActionAwait: Mock<(entry: CapturedAuditEntry) => Promise<void>> =
  mock(async (entry) => {
    mockLogAdminAction(entry);
    if (mockLogAdminActionAwaitError) throw mockLogAdminActionAwaitError;
  });

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mockLogAdminActionAwait,
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// ── EE retention mock — driven per test ───────────────────────────────

interface RetentionPolicy {
  orgId: string;
  retentionDays: number | null;
  hardDeleteDelayDays: number;
  updatedAt: string;
  updatedBy: string | null;
  lastPurgeAt: string | null;
  lastPurgeCount: number | null;
}

interface AdminActionPurgeResult {
  orgId: string;
  deletedCount: number;
}

let mockGetPolicyResult: RetentionPolicy | null = null;
let mockGetPolicyError: Error | null = null;
let mockSetPolicyResult: RetentionPolicy | null = null;
let mockSetPolicyError: Error | null = null;
let mockPurgeResult: AdminActionPurgeResult[] = [];
let mockPurgeError: Error | null = null;
let mockPreviewResult: { anonymizableRowCount: number } = { anonymizableRowCount: 0 };
let mockPreviewError: Error | null = null;
let mockAnonymizeResult: { anonymizedRowCount: number } = { anonymizedRowCount: 0 };
let mockAnonymizeError: Error | null = null;
const mockEeCallOrder: string[] = [];

const { RetentionError: RealRetentionError } = await import(
  "@atlas/ee/audit/retention"
);

mock.module("@atlas/ee/audit/retention", () => ({
  RetentionError: RealRetentionError,
  getAdminActionRetentionPolicy: () => {
    mockEeCallOrder.push("getAdminActionRetentionPolicy");
    if (mockGetPolicyError) return Effect.fail(mockGetPolicyError);
    return Effect.succeed(mockGetPolicyResult);
  },
  setAdminActionRetentionPolicy: () => {
    mockEeCallOrder.push("setAdminActionRetentionPolicy");
    if (mockSetPolicyError) return Effect.fail(mockSetPolicyError);
    return Effect.succeed(mockSetPolicyResult);
  },
  purgeAdminActionExpired: () => {
    mockEeCallOrder.push("purgeAdminActionExpired");
    if (mockPurgeError) return Effect.fail(mockPurgeError);
    return Effect.succeed(mockPurgeResult);
  },
  previewAdminActionErasure: () => {
    mockEeCallOrder.push("previewAdminActionErasure");
    if (mockPreviewError) return Effect.fail(mockPreviewError);
    return Effect.succeed(mockPreviewResult);
  },
  anonymizeUserAdminActions: () => {
    mockEeCallOrder.push("anonymizeUserAdminActions");
    if (mockAnonymizeError) return Effect.fail(mockAnonymizeError);
    return Effect.succeed(mockAnonymizeResult);
  },
}));

// ── Import sub-routers AFTER mocks ────────────────────────────────────

const { adminActionRetention, adminEraseUser } = await import(
  "../routes/admin-action-retention"
);

// ── Helpers ───────────────────────────────────────────────────────────

async function request(
  router: typeof adminActionRetention,
  method: string,
  path = "/",
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return await router.request(`http://localhost${path}`, init);
}

function resetMocks(): void {
  mockHasInternalDB = true;
  mockGetPolicyResult = null;
  mockGetPolicyError = null;
  mockSetPolicyResult = null;
  mockSetPolicyError = null;
  mockPurgeResult = [];
  mockPurgeError = null;
  mockPreviewResult = { anonymizableRowCount: 0 };
  mockPreviewError = null;
  mockAnonymizeResult = { anonymizedRowCount: 0 };
  mockAnonymizeError = null;
  mockLogAdminActionAwaitError = null;
  mockLogAdminAction.mockClear();
  mockLogAdminActionAwait.mockClear();
  mockEeCallOrder.length = 0;
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        mode: "managed",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-1",
        claims: { twoFactorEnabled: true },
      },
    }),
  );
}

function makePolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    orgId: "org-1",
    retentionDays: 2555,
    hardDeleteDelayDays: 30,
    updatedAt: "2026-04-23T00:00:00Z",
    updatedBy: "admin-1",
    lastPurgeAt: null,
    lastPurgeCount: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("PUT /api/v1/admin/audit/admin-action-retention — policy_update audit", () => {
  beforeEach(resetMocks);

  it("emits exactly one logAdminAction with policy_update on success", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 2555, hardDeleteDelayDays: 30 });
    mockSetPolicyResult = makePolicy({ retentionDays: 365, hardDeleteDelayDays: 30 });

    const res = await request(adminActionRetention, "PUT", "/", {
      retentionDays: 365,
      hardDeleteDelayDays: 30,
    });

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("admin_action_retention.policy_update");
    expect(entry.targetType).toBe("admin_action_retention");
    expect(entry.targetId).toBe("org-1");
    expect(entry.status ?? "success").toBe("success");
  });

  it("captures both previous and new retention values for forensic reconstruction", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 2555, hardDeleteDelayDays: 60 });
    mockSetPolicyResult = makePolicy({ retentionDays: 7, hardDeleteDelayDays: 0 });

    await request(adminActionRetention, "PUT", "/", { retentionDays: 7, hardDeleteDelayDays: 0 });

    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.retentionDays).toBe(7);
    expect(meta.hardDeleteDelayDays).toBe(0);
    expect(meta.previousRetentionDays).toBe(2555);
    expect(meta.previousHardDeleteDelayDays).toBe(60);
  });

  it("emits with previous*: null when no prior policy exists", async () => {
    mockGetPolicyResult = null;
    mockSetPolicyResult = makePolicy({ retentionDays: 90, hardDeleteDelayDays: 30 });

    await request(adminActionRetention, "PUT", "/", { retentionDays: 90 });

    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.previousRetentionDays).toBeNull();
    expect(meta.previousHardDeleteDelayDays).toBeNull();
  });

  it("emits failure audit when setAdminActionRetentionPolicy throws — preserves RetentionError discriminator", async () => {
    // Body passes Zod (retentionDays: 365 >= 7); the simulated RetentionError
    // comes from a library-only invariant that the route-edge schema can't
    // catch (e.g., a future constraint only validated after enterprise
    // entitlement check). Tests the route-layer failure-audit path with the
    // RetentionError discriminator surfaced via `errorContext`.
    mockGetPolicyResult = makePolicy({ retentionDays: 2555 });
    mockSetPolicyError = new RealRetentionError({
      message: "Simulated library-side validation failure.",
      code: "validation",
    });

    const res = await request(adminActionRetention, "PUT", "/", { retentionDays: 365 });

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("admin_action_retention.policy_update");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.message).toContain("Simulated library-side");
    expect(entry.metadata!.code).toBe("validation");
    expect(entry.metadata!.tag).toBe("RetentionError");
    expect(entry.metadata!.previousRetentionDays).toBe(2555);
  });

  it("Zod edge rejects retentionDays < 7 before the library is called", async () => {
    // `.int().min(7)` on UpdateRetentionBodySchema.retentionDays shifts
    // validation left from the library (MIN_RETENTION_DAYS = 7) so 400s
    // carry a structured Zod error and the library is never reached.
    const res = await request(adminActionRetention, "PUT", "/", { retentionDays: 3 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockEeCallOrder).not.toContain("setAdminActionRetentionPolicy");
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("Zod edge rejects negative hardDeleteDelayDays", async () => {
    const res = await request(adminActionRetention, "PUT", "/", {
      retentionDays: 365,
      hardDeleteDelayDays: -1,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockEeCallOrder).not.toContain("setAdminActionRetentionPolicy");
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("reads the prior policy BEFORE writing — order guard against snapshot drift", async () => {
    // Future refactor risk: moving getAdminActionRetentionPolicy after
    // setAdminActionRetentionPolicy would make `previousRetentionDays`
    // capture the new value, silently hiding shrinks in the audit row.
    mockGetPolicyResult = makePolicy({ retentionDays: 2555 });
    mockSetPolicyResult = makePolicy({ retentionDays: 90 });

    await request(adminActionRetention, "PUT", "/", { retentionDays: 90 });

    expect(mockEeCallOrder).toEqual([
      "getAdminActionRetentionPolicy",
      "setAdminActionRetentionPolicy",
    ]);
  });

  it("emits stage:policy_read failure audit when getAdminActionRetentionPolicy throws", async () => {
    mockGetPolicyError = new Error("transient PG failure during read");

    const res = await request(adminActionRetention, "PUT", "/", { retentionDays: 90 });

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.stage).toBe("policy_read");
    expect(entry.metadata!.message).toContain("transient PG failure");
    expect(entry.metadata!.previousRetentionDays).toBeNull();
  });
});

describe("POST /api/v1/admin/audit/admin-action-retention/purge — manual_purge audit", () => {
  beforeEach(resetMocks);

  it("emits exactly one logAdminAction with manual_purge on success", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 90 });
    mockPurgeResult = [{ orgId: "org-1", deletedCount: 17 }];

    const res = await request(adminActionRetention, "POST", "/purge");

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("admin_action_retention.manual_purge");
    expect(entry.targetType).toBe("admin_action_retention");
    expect(entry.targetId).toBe("org-1");
    expect(entry.status ?? "success").toBe("success");
  });

  it("captures deletedCount + retentionDays in metadata", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 30 });
    mockPurgeResult = [{ orgId: "org-1", deletedCount: 5 }];

    await request(adminActionRetention, "POST", "/purge");

    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.deletedCount).toBe(5);
    expect(meta.retentionDays).toBe(30);
  });

  it("never includes per-row purge results in audit metadata", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 30 });
    mockPurgeResult = [{ orgId: "org-1", deletedCount: 5 }];

    await request(adminActionRetention, "POST", "/purge");

    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.metadata).not.toHaveProperty("results");
    expect(entry.metadata).not.toHaveProperty("rows");
    expect(entry.metadata).not.toHaveProperty("ids");
  });

  it("emits failure audit when purgeAdminActionExpired throws", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 30 });
    mockPurgeError = new Error("simulated purge failure");

    const res = await request(adminActionRetention, "POST", "/purge");

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("admin_action_retention.manual_purge");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.message).toContain("simulated purge failure");
    expect(entry.metadata!.retentionDays).toBe(30);
  });

  it("emits stage:policy_read failure when getAdminActionRetentionPolicy throws before purge", async () => {
    mockGetPolicyError = new Error("transient PG failure during read");

    const res = await request(adminActionRetention, "POST", "/purge");

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("admin_action_retention.manual_purge");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.stage).toBe("policy_read");
    expect(entry.metadata!.message).toContain("transient PG failure");
  });
});

describe("POST /api/v1/admin/audit/erase-user — user.erase audit", () => {
  beforeEach(resetMocks);

  it("delegates to anonymizeUserAdminActions without emitting its own success row", async () => {
    // Phase 1 contract (ee/src/audit/retention.ts::anonymizeUserAdminActions
    // docstring): the library owns success emission unconditionally. A
    // route-layer emission here would be a double-audit.
    mockAnonymizeResult = { anonymizedRowCount: 7 };

    const res = await request(adminEraseUser, "POST", "/", {
      userId: "user-42",
      initiatedBy: "dsr_request",
    });

    expect(res.status).toBe(200);
    expect(mockEeCallOrder).toContain("anonymizeUserAdminActions");
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns anonymizedRowCount from the library result", async () => {
    mockAnonymizeResult = { anonymizedRowCount: 3 };

    const res = await request(adminEraseUser, "POST", "/", {
      userId: "user-42",
      initiatedBy: "self_request",
    });

    const body = (await res.json()) as { anonymizedRowCount: number };
    expect(body.anonymizedRowCount).toBe(3);
  });

  it("emits user.erase failure audit when anonymizeUserAdminActions throws", async () => {
    // Failure path is the only route-layer emission: a UPDATE failure
    // inside the library skips the library's own emit, leaving zero
    // forensic trace without this tapError.
    mockAnonymizeError = new Error("simulated erasure DB failure");

    const res = await request(adminEraseUser, "POST", "/", {
      userId: "user-42",
      initiatedBy: "dsr_request",
    });

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("user.erase");
    expect(entry.targetType).toBe("user");
    expect(entry.targetId).toBe("user-42");
    expect(entry.status).toBe("failure");
    expect(entry.scope).toBe("platform");
    expect(entry.metadata!.targetUserId).toBe("user-42");
    expect(entry.metadata!.initiatedBy).toBe("dsr_request");
    expect(entry.metadata!.message).toContain("simulated erasure");
  });

  it("propagates RetentionError validation discriminator on invalid initiatedBy", async () => {
    mockAnonymizeError = new RealRetentionError({
      message: `Invalid initiatedBy "scheduled_retention". Expected one of: self_request, dsr_request, scheduled_retention.`,
      code: "validation",
    });

    const res = await request(adminEraseUser, "POST", "/", {
      userId: "user-42",
      // Zod accepts dsr_request/self_request at the route edge; simulate a
      // library-rejected case by letting the library fail after a valid
      // body parse (e.g., a downstream schema change).
      initiatedBy: "dsr_request",
    });

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.metadata!.tag).toBe("RetentionError");
    expect(entry.metadata!.code).toBe("validation");
  });

  it("rejects an empty userId at the Zod edge without reaching the library", async () => {
    const res = await request(adminEraseUser, "POST", "/", {
      userId: "",
      initiatedBy: "dsr_request",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockEeCallOrder).not.toContain("anonymizeUserAdminActions");
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("rejects unexpected initiatedBy values at the Zod edge", async () => {
    const res = await request(adminEraseUser, "POST", "/", {
      userId: "user-42",
      initiatedBy: "scheduled_retention",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockEeCallOrder).not.toContain("anonymizeUserAdminActions");
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/admin/audit/erase-user/preview — read-only count", () => {
  beforeEach(resetMocks);

  it("returns the anonymizableRowCount without emitting an audit row", async () => {
    mockPreviewResult = { anonymizableRowCount: 12 };

    const res = await request(adminEraseUser, "GET", "/preview?userId=user-42");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { anonymizableRowCount: number };
    expect(body.anonymizableRowCount).toBe(12);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("propagates RetentionError as 400 on invalid userId", async () => {
    mockPreviewError = new RealRetentionError({
      message: "Invalid userId: must be a non-empty string.",
      code: "validation",
    });

    const res = await request(adminEraseUser, "GET", "/preview?userId=%20");

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

describe("Synchronous audit-write contract", () => {
  beforeEach(resetMocks);

  it("PUT / surfaces 500 when audit row fails to commit", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 2555 });
    mockSetPolicyResult = makePolicy({ retentionDays: 90 });
    mockLogAdminActionAwaitError = new Error("admin_action_log INSERT failed");

    const res = await request(adminActionRetention, "PUT", "/", { retentionDays: 90 });

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalled();
  });

  it("POST /purge surfaces 500 when audit row fails to commit", async () => {
    // The purge success path uses `emitAudit` (not best-effort) inside
    // Effect.tap — a regression that flips it to emitAuditBestEffort
    // would silently return 200 with no row. This test pins the F-26
    // invariant on the purge side too.
    mockGetPolicyResult = makePolicy({ retentionDays: 90 });
    mockPurgeResult = [{ orgId: "org-1", deletedCount: 3 }];
    mockLogAdminActionAwaitError = new Error("admin_action_log INSERT failed");

    const res = await request(adminActionRetention, "POST", "/purge");

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalled();
  });
});

describe("Forensic plumbing — ipAddress is captured on audit rows", () => {
  beforeEach(resetMocks);

  async function requestWithIp(
    router: typeof adminActionRetention,
    method: string,
    path: string,
    ip: string,
    body?: unknown,
  ): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: { Authorization: "Bearer test-key", "x-forwarded-for": ip },
    };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return await router.request(`http://localhost${path}`, init);
  }

  it("PUT / — policy_update success row carries x-forwarded-for", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 2555 });
    mockSetPolicyResult = makePolicy({ retentionDays: 90 });

    await requestWithIp(adminActionRetention, "PUT", "/", "203.0.113.7", { retentionDays: 90 });

    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.ipAddress).toBe("203.0.113.7");
  });

  it("POST /purge — manual_purge success row carries x-forwarded-for (leftmost client)", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 90 });
    mockPurgeResult = [{ orgId: "org-1", deletedCount: 2 }];

    await requestWithIp(
      adminActionRetention,
      "POST",
      "/purge",
      "198.51.100.4, 10.0.0.1",
    );

    const entry = mockLogAdminAction.mock.calls[0]![0];
    // x-forwarded-for is comma-joined under multi-hop proxies; the
    // leftmost entry is the original client. Regression guard for the
    // `clientIpFrom` split-and-trim.
    expect(entry.ipAddress).toBe("198.51.100.4");
  });

  it("POST /erase-user — failure row carries x-forwarded-for", async () => {
    mockAnonymizeError = new Error("simulated erasure DB failure");

    await requestWithIp(adminEraseUser, "POST", "/", "203.0.113.42", {
      userId: "user-42",
      initiatedBy: "dsr_request",
    });

    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.ipAddress).toBe("203.0.113.42");
  });
});

describe("Regression — read endpoints stay quiet", () => {
  beforeEach(resetMocks);

  it("GET /admin-action-retention does not emit an audit row", async () => {
    mockGetPolicyResult = makePolicy();

    const res = await request(adminActionRetention, "GET", "/");

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

describe("Regression — pre-handler rejections do not emit audit", () => {
  beforeEach(resetMocks);

  it("missing activeOrganizationId short-circuits before any audit emission (PUT)", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "Admin",
          role: "admin",
          activeOrganizationId: undefined,
        claims: { twoFactorEnabled: true },
        },
      }),
    );

    const res = await request(adminActionRetention, "PUT", "/", { retentionDays: 90 });

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("missing activeOrganizationId short-circuits the erase route", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "admin-1",
          mode: "managed",
          label: "Admin",
          role: "admin",
          activeOrganizationId: undefined,
        claims: { twoFactorEnabled: true },
        },
      }),
    );

    const res = await request(adminEraseUser, "POST", "/", {
      userId: "user-42",
      initiatedBy: "dsr_request",
    });

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockEeCallOrder).not.toContain("anonymizeUserAdminActions");
  });

  it("422 Zod validation rejection does not emit audit", async () => {
    const res = await request(adminActionRetention, "PUT", "/", { retentionDays: "abc" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
