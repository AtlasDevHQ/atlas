import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock control variables
// ---------------------------------------------------------------------------

let mockEnterpriseEnabled = true;
let mockLicenseKey: string | undefined = "test-license-key";
let mockInternalDB = true;
let queryResults: Record<string, unknown>[][] = [];
let queryCallIndex = 0;
let capturedQueries: { sql: string; params?: unknown[] }[] = [];

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
    mockPool.query.mockClear();
  });

  it("returns null when no policy exists", async () => {
    queryResults = [[]];
    const result = await getRetentionPolicy("org-1");
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
    const result = await getRetentionPolicy("org-1");
    expect(result).not.toBeNull();
    expect(result!.orgId).toBe("org-1");
    expect(result!.retentionDays).toBe(90);
    expect(result!.hardDeleteDelayDays).toBe(30);
  });

  it("returns null when no internal DB", async () => {
    mockInternalDB = false;
    const result = await getRetentionPolicy("org-1");
    expect(result).toBeNull();
  });

  it("throws when enterprise is not enabled", async () => {
    mockEnterpriseEnabled = false;
    mockLicenseKey = undefined;
    await expect(getRetentionPolicy("org-1")).rejects.toThrow("Enterprise features");
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
    const result = await setRetentionPolicy("org-1", { retentionDays: 90 }, "user-1");
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
    const result = await setRetentionPolicy("org-1", { retentionDays: null }, "user-1");
    expect(result.retentionDays).toBeNull();
  });

  it("rejects retention days below minimum", async () => {
    await expect(
      setRetentionPolicy("org-1", { retentionDays: 3 }, "user-1"),
    ).rejects.toThrow(`at least ${MIN_RETENTION_DAYS} days`);
  });

  it("rejects non-integer retention days", async () => {
    await expect(
      setRetentionPolicy("org-1", { retentionDays: 10.5 }, "user-1"),
    ).rejects.toThrow(`at least ${MIN_RETENTION_DAYS} days`);
  });

  it("rejects negative hard delete delay", async () => {
    await expect(
      setRetentionPolicy("org-1", { retentionDays: 30, hardDeleteDelayDays: -1 }, "user-1"),
    ).rejects.toThrow("non-negative integer");
  });

  it("throws when no internal DB", async () => {
    mockInternalDB = false;
    await expect(
      setRetentionPolicy("org-1", { retentionDays: 30 }, "user-1"),
    ).rejects.toThrow("Internal database required");
  });

  it("throws RetentionError with correct code for validation", async () => {
    try {
      await setRetentionPolicy("org-1", { retentionDays: 1 }, "user-1");
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
    mockPool.query.mockClear();
  });

  it("returns empty array when no configs exist", async () => {
    queryResults = [[]]; // No retention configs
    const result = await purgeExpiredEntries("org-1");
    expect(result).toEqual([]);
  });

  it("soft-deletes entries for org with retention config", async () => {
    // First query: fetch retention configs
    queryResults = [
      [{ org_id: "org-1", retention_days: 30 }],
    ];
    // Mock pool.query for the UPDATE and metadata update
    mockPool.query.mockImplementation(async () => {
      return { rows: [{ id: "entry-1" }, { id: "entry-2" }] };
    });

    const result = await purgeExpiredEntries("org-1");
    expect(result.length).toBe(1);
    expect(result[0].orgId).toBe("org-1");
    expect(result[0].softDeletedCount).toBe(2);
  });

  it("returns empty when no internal DB", async () => {
    mockInternalDB = false;
    const result = await purgeExpiredEntries();
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
    mockPool.query.mockClear();
  });

  it("deletes entries past hard-delete delay", async () => {
    // First: fetch configs
    queryResults = [
      [{ org_id: "org-1", hard_delete_delay_days: 30 }],
    ];
    // pool.query for DELETE
    mockPool.query.mockImplementation(async () => {
      return { rows: [{ id: "entry-1" }] };
    });

    const result = await hardDeleteExpired();
    expect(result.deletedCount).toBe(1);
  });

  it("returns zero when no internal DB", async () => {
    mockInternalDB = false;
    const result = await hardDeleteExpired();
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

    const result = await exportAuditLog({
      orgId: "org-1",
      format: "json",
    });

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

    const result = await exportAuditLog({
      orgId: "org-1",
      format: "csv",
    });

    expect(result.format).toBe("csv");
    expect(result.content).toContain("id,timestamp,user_id");
    expect(result.content).toContain("entry-1");
  });

  it("validates date formats", async () => {
    await expect(
      exportAuditLog({ orgId: "org-1", format: "json", startDate: "not-a-date" }),
    ).rejects.toThrow("Invalid start_date format");

    await expect(
      exportAuditLog({ orgId: "org-1", format: "json", endDate: "bad" }),
    ).rejects.toThrow("Invalid end_date format");
  });

  it("throws when no internal DB", async () => {
    mockInternalDB = false;
    await expect(
      exportAuditLog({ orgId: "org-1", format: "json" }),
    ).rejects.toThrow("Internal database required");
  });
});
