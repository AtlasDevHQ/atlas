/**
 * Tests for admin audit-retention API meta-audit (F-26 / #1781).
 *
 * Every write to the audit-retention surface (policy update, export, manual
 * purge, manual hard-delete) must emit `logAdminAction`. Without these
 * entries a compromised admin could shrink retentionDays to 7 and
 * hard-delete the trail leaving zero record.
 *
 * Tests the `adminAuditRetention` sub-router directly so we can drive the
 * EE retention service via mocks without booting every adjacent admin
 * dependency.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { Effect } from "effect";

// ── Auth + DB stubs (sub-router uses createAdminRouter → adminAuth) ──

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

// ── Audit logger mock — capture every logAdminAction call ─────────────

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

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
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

interface ExportResult {
  content: string;
  format: "csv" | "json";
  rowCount: number;
  totalAvailable: number;
  truncated: boolean;
}

let mockGetPolicyResult: RetentionPolicy | null = null;
let mockGetPolicyError: Error | null = null;
let mockSetPolicyResult: RetentionPolicy | null = null;
let mockSetPolicyError: Error | null = null;
let mockExportResult: ExportResult | null = null;
let mockExportError: Error | null = null;
let mockPurgeResult: { orgId: string; softDeletedCount: number }[] = [];
let mockPurgeError: Error | null = null;
let mockHardDeleteResult: { deletedCount: number } = { deletedCount: 0 };
let mockHardDeleteError: Error | null = null;

const { RetentionError: RealRetentionError } = await import(
  "@atlas/ee/audit/retention"
);

mock.module("@atlas/ee/audit/retention", () => ({
  RetentionError: RealRetentionError,
  getRetentionPolicy: () => {
    if (mockGetPolicyError) return Effect.fail(mockGetPolicyError);
    return Effect.succeed(mockGetPolicyResult);
  },
  setRetentionPolicy: () => {
    if (mockSetPolicyError) return Effect.fail(mockSetPolicyError);
    return Effect.succeed(mockSetPolicyResult);
  },
  exportAuditLog: () => {
    if (mockExportError) return Effect.fail(mockExportError);
    return Effect.succeed(mockExportResult);
  },
  purgeExpiredEntries: () => {
    if (mockPurgeError) return Effect.fail(mockPurgeError);
    return Effect.succeed(mockPurgeResult);
  },
  hardDeleteExpired: () => {
    if (mockHardDeleteError) return Effect.fail(mockHardDeleteError);
    return Effect.succeed(mockHardDeleteResult);
  },
}));

// ── Import sub-router AFTER mocks ─────────────────────────────────────

const { adminAuditRetention } = await import("../routes/admin-audit-retention");

// ── Helpers ───────────────────────────────────────────────────────────

async function request(
  method: string,
  path = "/",
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-key" },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return adminAuditRetention.request(`http://localhost${path}`, init);
}

function resetMocks(): void {
  mockHasInternalDB = true;
  mockGetPolicyResult = null;
  mockGetPolicyError = null;
  mockSetPolicyResult = null;
  mockSetPolicyError = null;
  mockExportResult = null;
  mockExportError = null;
  mockPurgeResult = [];
  mockPurgeError = null;
  mockHardDeleteResult = { deletedCount: 0 };
  mockHardDeleteError = null;
  mockLogAdminAction.mockClear();
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
      },
    }),
  );
}

function makePolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    orgId: "org-1",
    retentionDays: 90,
    hardDeleteDelayDays: 30,
    updatedAt: "2026-04-23T00:00:00Z",
    updatedBy: "admin-1",
    lastPurgeAt: null,
    lastPurgeCount: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("PUT /api/v1/admin/audit/retention — policy_update audit", () => {
  beforeEach(resetMocks);

  it("emits exactly one logAdminAction with policy_update on success", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 365, hardDeleteDelayDays: 30 });
    mockSetPolicyResult = makePolicy({ retentionDays: 90, hardDeleteDelayDays: 30 });

    const res = await request("PUT", "/", {
      retentionDays: 90,
      hardDeleteDelayDays: 30,
    });

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.policy_update");
    expect(entry.targetType).toBe("audit_retention");
    expect(entry.targetId).toBe("org-1");
    expect(entry.status ?? "success").toBe("success");
  });

  it("captures both previous and new retention values for forensic reconstruction", async () => {
    mockGetPolicyResult = makePolicy({
      retentionDays: 365,
      hardDeleteDelayDays: 60,
    });
    mockSetPolicyResult = makePolicy({
      retentionDays: 7,
      hardDeleteDelayDays: 0,
    });

    await request("PUT", "/", { retentionDays: 7, hardDeleteDelayDays: 0 });

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.retentionDays).toBe(7);
    expect(meta.hardDeleteDelayDays).toBe(0);
    expect(meta.previousRetentionDays).toBe(365);
    expect(meta.previousHardDeleteDelayDays).toBe(60);
  });

  it("emits with previous*: null when no prior policy exists", async () => {
    mockGetPolicyResult = null;
    mockSetPolicyResult = makePolicy({ retentionDays: 30, hardDeleteDelayDays: 30 });

    await request("PUT", "/", { retentionDays: 30 });

    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.previousRetentionDays).toBeNull();
    expect(meta.previousHardDeleteDelayDays).toBeNull();
  });

  it("emits failure audit when setRetentionPolicy throws", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 365 });
    mockSetPolicyError = new RealRetentionError({
      message: "Retention period must be at least 7 days or null (unlimited). Got: 3.",
      code: "validation",
    });

    const res = await request("PUT", "/", { retentionDays: 3 });

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.policy_update");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.error).toContain("at least 7 days");
    expect(entry.metadata!.previousRetentionDays).toBe(365);
  });
});

describe("POST /api/v1/admin/audit/retention/export — export audit", () => {
  beforeEach(resetMocks);

  it("emits exactly one logAdminAction with export on success", async () => {
    mockExportResult = {
      content: "id,timestamp\nrow-1,2026-01-01",
      format: "csv",
      rowCount: 1,
      totalAvailable: 1,
      truncated: false,
    };

    const res = await request("POST", "/export", {
      format: "csv",
      startDate: "2026-01-01",
      endDate: "2026-04-01",
    });

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.export");
    expect(entry.targetType).toBe("audit_retention");
    expect(entry.targetId).toBe("org-1");
    expect(entry.status ?? "success").toBe("success");
  });

  it("captures rowCount, format, and date range in metadata", async () => {
    mockExportResult = {
      content: '{"entries":[]}',
      format: "json",
      rowCount: 42,
      totalAvailable: 42,
      truncated: false,
    };

    await request("POST", "/export", {
      format: "json",
      startDate: "2026-01-01",
      endDate: "2026-04-01",
    });

    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.format).toBe("json");
    expect(meta.startDate).toBe("2026-01-01");
    expect(meta.endDate).toBe("2026-04-01");
    expect(meta.rowCount).toBe(42);
  });

  it("never includes exported content in audit metadata", async () => {
    const sensitiveContent = "id,sql\nq-1,SELECT * FROM secret_table";
    mockExportResult = {
      content: sensitiveContent,
      format: "csv",
      rowCount: 1,
      totalAvailable: 1,
      truncated: false,
    };

    await request("POST", "/export", { format: "csv" });

    const entry = mockLogAdminAction.mock.calls[0]![0];
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("secret_table");
    expect(serialized).not.toContain("SELECT *");
    // Catch any field that smuggles raw rows through.
    expect(entry.metadata).not.toHaveProperty("content");
    expect(entry.metadata).not.toHaveProperty("rows");
    expect(entry.metadata).not.toHaveProperty("entries");
  });

  it("emits failure audit when exportAuditLog throws", async () => {
    mockExportError = new RealRetentionError({
      message: 'Invalid start_date format: "not-a-date".',
      code: "validation",
    });

    const res = await request("POST", "/export", {
      format: "csv",
      startDate: "2026-01-01",
    });

    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.export");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.error).toContain("Invalid start_date");
    expect(entry.metadata!.format).toBe("csv");
  });
});

describe("POST /api/v1/admin/audit/retention/purge — manual_purge audit", () => {
  beforeEach(resetMocks);

  it("emits exactly one logAdminAction with manual_purge on success", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 90 });
    mockPurgeResult = [{ orgId: "org-1", softDeletedCount: 17 }];

    const res = await request("POST", "/purge");

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.manual_purge");
    expect(entry.targetType).toBe("audit_retention");
    expect(entry.targetId).toBe("org-1");
    expect(entry.status ?? "success").toBe("success");
  });

  it("captures softDeletedCount and retentionDays in metadata", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 30 });
    mockPurgeResult = [{ orgId: "org-1", softDeletedCount: 5 }];

    await request("POST", "/purge");

    const meta = mockLogAdminAction.mock.calls[0]![0].metadata!;
    expect(meta.softDeletedCount).toBe(5);
    expect(meta.retentionDays).toBe(30);
  });

  it("emits failure audit when purgeExpiredEntries throws", async () => {
    mockGetPolicyResult = makePolicy({ retentionDays: 30 });
    mockPurgeError = new Error("simulated purge failure");

    const res = await request("POST", "/purge");

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.manual_purge");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.error).toContain("simulated purge failure");
    expect(entry.metadata!.retentionDays).toBe(30);
  });
});

describe("POST /api/v1/admin/audit/retention/hard-delete — manual_hard_delete audit", () => {
  beforeEach(resetMocks);

  it("emits exactly one logAdminAction with manual_hard_delete on success", async () => {
    mockHardDeleteResult = { deletedCount: 99 };

    const res = await request("POST", "/hard-delete");

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.manual_hard_delete");
    expect(entry.targetType).toBe("audit_retention");
    expect(entry.targetId).toBe("org-1");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata!.deletedCount).toBe(99);
  });

  it("emits failure audit when hardDeleteExpired throws", async () => {
    mockHardDeleteError = new Error("simulated hard-delete failure");

    const res = await request("POST", "/hard-delete");

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = mockLogAdminAction.mock.calls[0]![0];
    expect(entry.actionType).toBe("audit_retention.manual_hard_delete");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.error).toContain("simulated hard-delete failure");
  });
});

describe("Regression — read endpoints stay quiet", () => {
  beforeEach(resetMocks);

  it("GET /retention does not emit an audit row", async () => {
    mockGetPolicyResult = makePolicy();

    const res = await request("GET", "/");

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
