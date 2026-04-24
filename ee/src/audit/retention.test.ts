import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect, Exit, Cause } from "effect";

// ── Effect runner helper ──────────────────────────────────────────
const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

// ---------------------------------------------------------------------------
// Mock control variables
// ---------------------------------------------------------------------------

let mockEnterpriseEnabled = true;
let mockLicenseKey: string | undefined = "test-license-key";
let mockInternalDB = true;
let queryResults: Record<string, unknown>[][] = [];
let queryCallIndex = 0;
let capturedQueries: { sql: string; params?: unknown[] }[] = [];
let auditCalls: Array<Record<string, unknown>> = [];
let mockHasRequestUser = false;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({
    enterprise: {
      enabled: mockEnterpriseEnabled,
      licenseKey: mockLicenseKey,
    },
  }),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  // Shaped like the real getRequestContext return. The library suppresses
  // its self-audit when an HTTP user is in context (F-26 route handles it).
  getRequestContext: () =>
    mockHasRequestUser
      ? { requestId: "req-test", user: { id: "admin-1", label: "admin@test.com" } }
      : undefined,
  withRequestContext: <T,>(_ctx: unknown, fn: () => T): T => fn(),
}));

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: (entry: Record<string, unknown>) => {
    auditCalls.push(entry);
  },
  ADMIN_ACTIONS: {
    audit_log: { purgeCycle: "audit_log.purge_cycle" },
    audit_retention: {
      policyUpdate: "audit_retention.policy_update",
      export: "audit_retention.export",
      manualPurge: "audit_retention.manual_purge",
      manualHardDelete: "audit_retention.manual_hard_delete",
      hardDelete: "audit_retention.hard_delete",
    },
  },
}));

// NOTE: this literal must stay in sync with the real
// AUDIT_PURGE_SCHEDULER_ACTOR exported by purge-scheduler.ts.
// `purge-scheduler.test.ts` pins the production literal directly, so a
// rename of the constant fails that test first — update both places
// together. See F-27.
mock.module("./purge-scheduler", () => ({
  AUDIT_PURGE_SCHEDULER_ACTOR: "system:audit-purge-scheduler",
}));

const mockPool = {
  query: mock(async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params });
    const result = queryResults[queryCallIndex] ?? [];
    queryCallIndex++;
    return { rows: result };
  }),
  end: mock(async () => {}),
  on: mock(() => {}),
};

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockInternalDB,
  internalQuery: async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params });
    const result = queryResults[queryCallIndex] ?? [];
    queryCallIndex++;
    return result;
  },
  getInternalDB: () => mockPool,
  internalExecute: (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params });
  },
}));

mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!mockInternalDB) { if (factory) throw factory(); throw new Error(`Internal database required for ${label}.`); }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return mockInternalDB ? Effect.void : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));

// Import after mocks
const {
  getRetentionPolicy,
  setRetentionPolicy,
  purgeExpiredEntries,
  hardDeleteExpired,
  exportAuditLog,
  MIN_RETENTION_DAYS,
  RetentionError,
} = await import("./retention");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRetentionPolicy", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("returns null when no policy exists", async () => {
    queryResults = [[]];
    const result = await run(getRetentionPolicy("org-1"));
    expect(result).toBeNull();
  });

  it("returns policy when one exists", async () => {
    queryResults = [[{
      id: "cfg-1",
      org_id: "org-1",
      retention_days: 90,
      hard_delete_delay_days: 30,
      updated_at: "2026-03-20T00:00:00Z",
      updated_by: "user-1",
      last_purge_at: null,
      last_purge_count: null,
    }]];
    const result = await run(getRetentionPolicy("org-1"));
    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-1");
    expect(result!.retentionDays).toBe(90);
    expect(result!.hardDeleteDelayDays).toBe(30);
  });

  it("returns null when no internal DB", async () => {
    mockInternalDB = false;
    const result = await run(getRetentionPolicy("org-1"));
    expect(result).toBeNull();
  });

  it("throws when enterprise is not enabled", async () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    await expect(run(getRetentionPolicy("org-1"))).rejects.toThrow("Enterprise features");
  });
});

describe("setRetentionPolicy", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("creates a new policy via upsert", async () => {
    queryResults = [[{
      id: "cfg-1",
      org_id: "org-1",
      retention_days: 90,
      hard_delete_delay_days: 30,
      updated_at: "2026-03-20T00:00:00Z",
      updated_by: "user-1",
      last_purge_at: null,
      last_purge_count: null,
    }]];
    const result = await run(setRetentionPolicy("org-1", { retentionDays: 90 }, "user-1"));
    expect(result.retentionDays).toBe(90);
    expect(result.hardDeleteDelayDays).toBe(30);
  });

  it("allows null retention days (unlimited)", async () => {
    queryResults = [[{
      id: "cfg-1",
      org_id: "org-1",
      retention_days: null,
      hard_delete_delay_days: 30,
      updated_at: "2026-03-20T00:00:00Z",
      updated_by: "user-1",
      last_purge_at: null,
      last_purge_count: null,
    }]];
    const result = await run(setRetentionPolicy("org-1", { retentionDays: null }, "user-1"));
    expect(result.retentionDays).toBeNull();
  });

  it("rejects retention days below minimum", async () => {
    await expect(
      run(setRetentionPolicy("org-1", { retentionDays: 3 }, "user-1")),
    ).rejects.toThrow(`at least ${MIN_RETENTION_DAYS} days`);
  });

  it("rejects non-integer retention days", async () => {
    await expect(
      run(setRetentionPolicy("org-1", { retentionDays: 10.5 }, "user-1")),
    ).rejects.toThrow(`at least ${MIN_RETENTION_DAYS} days`);
  });

  it("rejects negative hard delete delay", async () => {
    await expect(
      run(setRetentionPolicy("org-1", { retentionDays: 30, hardDeleteDelayDays: -1 }, "user-1")),
    ).rejects.toThrow("non-negative integer");
  });

  it("throws when no internal DB", async () => {
    mockInternalDB = false;
    await expect(
      run(setRetentionPolicy("org-1", { retentionDays: 30 }, "user-1")),
    ).rejects.toThrow("Internal database required");
  });

  it("throws RetentionError with correct code for validation", async () => {
    try {
      await run(setRetentionPolicy("org-1", { retentionDays: 1 }, "user-1"));
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(RetentionError);
      expect((err as InstanceType<typeof RetentionError>).code).toBe("validation");
    }
  });
});

describe("purgeExpiredEntries", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("returns empty array when no configs exist", async () => {
    queryResults = [[]]; // No retention configs
    const result = await run(purgeExpiredEntries("org-1"));
    expect(result).toEqual([]);
  });

  it("soft-deletes entries for org with retention config", async () => {
    // First query: fetch retention configs
    queryResults = [
      [{ org_id: "org-1", retention_days: 30 }],
    ];
    // Mock pool.query for the UPDATE CTE and metadata update
    mockPool.query.mockImplementation(async () => {
      return { rows: [{ cnt: 2 }] };
    });

    const result = await run(purgeExpiredEntries("org-1"));
    expect(result.length).toBe(1);
    expect(result[0].orgId).toBe("org-1");
    expect(result[0].softDeletedCount).toBe(2);
  });

  it("returns empty when no internal DB", async () => {
    mockInternalDB = false;
    const result = await run(purgeExpiredEntries());
    expect(result).toEqual([]);
  });
});

describe("hardDeleteExpired", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("deletes entries past hard-delete delay", async () => {
    // First: fetch configs
    queryResults = [
      [{ org_id: "org-1", hard_delete_delay_days: 30 }],
    ];
    // pool.query for DELETE — CTE returns count
    mockPool.query.mockImplementation(async () => {
      return { rows: [{ cnt: 1 }] };
    });

    const result = await run(hardDeleteExpired());
    expect(result.deletedCount).toBe(1);
  });

  it("returns zero when no internal DB", async () => {
    mockInternalDB = false;
    const result = await run(hardDeleteExpired());
    expect(result.deletedCount).toBe(0);
  });
});

describe("exportAuditLog", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("exports JSON format", async () => {
    queryResults = [
      [{ count: "1" }], // count query
      [{ // data query
        id: "entry-1",
        timestamp: "2026-03-20T00:00:00Z",
        user_id: "user-1",
        user_label: "Admin",
        auth_mode: "managed",
        sql: "SELECT 1",
        duration_ms: 5,
        row_count: 1,
        success: true,
        error: null,
        source_id: "default",
        source_type: "postgres",
        target_host: "localhost",
        tables_accessed: null,
        columns_accessed: null,
        org_id: "org-1",
        user_email: "admin@test.com",
      }],
    ];

    const result = await run(exportAuditLog({
      orgId: "org-1",
      format: "json",
    }));

    expect(result.format).toBe("json");
    expect(result.rowCount).toBe(1);
    const parsed = JSON.parse(result.content);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].sql).toBe("SELECT 1");
  });

  it("exports CSV format", async () => {
    queryResults = [
      [{ count: "1" }],
      [{
        id: "entry-1",
        timestamp: "2026-03-20T00:00:00Z",
        user_id: "user-1",
        user_label: "Admin",
        auth_mode: "managed",
        sql: "SELECT 1",
        duration_ms: 5,
        row_count: 1,
        success: true,
        error: null,
        source_id: null,
        source_type: null,
        target_host: null,
        tables_accessed: null,
        columns_accessed: null,
        org_id: "org-1",
        user_email: null,
      }],
    ];

    const result = await run(exportAuditLog({
      orgId: "org-1",
      format: "csv",
    }));

    expect(result.format).toBe("csv");
    expect(result.content).toContain("id,timestamp,user_id");
    expect(result.content).toContain("entry-1");
  });

  it("validates date formats", async () => {
    await expect(
      run(exportAuditLog({ orgId: "org-1", format: "json", startDate: "not-a-date" })),
    ).rejects.toThrow("Invalid start_date format");

    await expect(
      run(exportAuditLog({ orgId: "org-1", format: "json", endDate: "bad" })),
    ).rejects.toThrow("Invalid end_date format");
  });

  it("throws when no internal DB", async () => {
    mockInternalDB = false;
    await expect(
      run(exportAuditLog({ orgId: "org-1", format: "json" })),
    ).rejects.toThrow("Internal database required");
  });
});

/**
 * F-27 — library-layer self-audit emissions. The library emits an audit row
 * only when called WITHOUT an HTTP request context (scheduler, CLI). The
 * HTTP route path emits its own richer row (F-26), so we suppress here to
 * avoid a double-audit when Route → setRetentionPolicy/hardDeleteExpired.
 */
describe("setRetentionPolicy — library self-audit (F-27)", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("emits policy_update audit row when called without HTTP context", async () => {
    queryResults = [[{
      id: "cfg-1",
      org_id: "org-1",
      retention_days: 90,
      hard_delete_delay_days: 30,
      updated_at: "2026-03-20T00:00:00Z",
      updated_by: null,
      last_purge_at: null,
      last_purge_count: null,
    }]];
    await run(setRetentionPolicy("org-1", { retentionDays: 90 }, null));
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].actionType).toBe("audit_retention.policy_update");
    expect(auditCalls[0].systemActor).toBe("system:audit-purge-scheduler");
    expect(auditCalls[0].scope).toBe("platform");
    expect(auditCalls[0].targetId).toBe("org-1");
  });

  it("suppresses library emission when an HTTP user is in request context (dedup vs F-26 route)", async () => {
    mockHasRequestUser = true;
    queryResults = [[{
      id: "cfg-1",
      org_id: "org-1",
      retention_days: 90,
      hard_delete_delay_days: 30,
      updated_at: "2026-03-20T00:00:00Z",
      updated_by: "user-1",
      last_purge_at: null,
      last_purge_count: null,
    }]];
    await run(setRetentionPolicy("org-1", { retentionDays: 90 }, "user-1"));
    expect(auditCalls).toHaveLength(0);
  });
});

describe("hardDeleteExpired — library self-audit (F-27)", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockLicenseKey = "test-key";
    mockInternalDB = true;
    queryResults = [];
    queryCallIndex = 0;
    capturedQueries = [];
    auditCalls = [];
    mockHasRequestUser = false;
    mockPool.query.mockClear();
  });

  it("emits hard_delete audit row when count > 0 outside HTTP context", async () => {
    queryResults = [
      [
        { org_id: "org-1", hard_delete_delay_days: 30 },
        { org_id: "org-2", hard_delete_delay_days: 30 },
      ],
    ];
    mockPool.query.mockImplementation(async () => ({ rows: [{ cnt: 4 }] }));

    const result = await run(hardDeleteExpired());
    expect(result.deletedCount).toBe(8);
    const hardRows = auditCalls.filter((c) => c.actionType === "audit_retention.hard_delete");
    expect(hardRows).toHaveLength(1);
    expect(hardRows[0].systemActor).toBe("system:audit-purge-scheduler");
    expect(hardRows[0].scope).toBe("platform");
    const meta = hardRows[0].metadata as {
      deletedCount: number;
      orgCount: number;
      affectedOrgs: Array<{ orgId: string; deletedCount: number }>;
    };
    expect(meta.deletedCount).toBe(8);
    expect(meta.orgCount).toBe(2);
    // Per-org breakdown lets a reviewer answer "which tenants lost data?"
    expect(meta.affectedOrgs).toEqual([
      { orgId: "org-1", deletedCount: 4 },
      { orgId: "org-2", deletedCount: 4 },
    ]);
  });

  it("emits NO audit row when count === 0 (zero-row floods would dwarf cycle rows)", async () => {
    queryResults = [
      [{ org_id: "org-1", hard_delete_delay_days: 30 }],
    ];
    mockPool.query.mockImplementation(async () => ({ rows: [{ cnt: 0 }] }));

    const result = await run(hardDeleteExpired());
    expect(result.deletedCount).toBe(0);
    const hardRows = auditCalls.filter((c) => c.actionType === "audit_retention.hard_delete");
    expect(hardRows).toHaveLength(0);
  });

  it("suppresses library emission under HTTP context (route emits manual_hard_delete instead)", async () => {
    mockHasRequestUser = true;
    queryResults = [
      [{ org_id: "org-1", hard_delete_delay_days: 30 }],
    ];
    mockPool.query.mockImplementation(async () => ({ rows: [{ cnt: 2 }] }));

    const result = await run(hardDeleteExpired("org-1"));
    expect(result.deletedCount).toBe(2);
    const hardRows = auditCalls.filter((c) => c.actionType === "audit_retention.hard_delete");
    expect(hardRows).toHaveLength(0);
  });
});
