import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mock external dependencies ──────────────────────────────────

let mockEnterpriseEnabled = false;
let mockHasInternalDB = false;
const mockQueryResults: Record<string, unknown>[][] = [];

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () =>
    mockEnterpriseEnabled
      ? { enterprise: { enabled: true, licenseKey: "test-key" } }
      : null,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => mockQueryResults.shift() ?? [],
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks
const {
  generateDataAccessReport,
  generateUserActivityReport,
  dataAccessReportToCSV,
  userActivityReportToCSV,
  ReportError,
} = await import("./reports");

const BASE_FILTERS = {
  startDate: "2026-01-01",
  endDate: "2026-03-01",
};

// ── Enterprise gate ─────────────────────────────────────────────

describe("enterprise gate", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = false;
    mockHasInternalDB = true;
    mockQueryResults.length = 0;
  });

  it("data access report throws when enterprise disabled", async () => {
    await expect(
      generateDataAccessReport("org-1", BASE_FILTERS),
    ).rejects.toThrow(/Enterprise features/);
  });

  it("user activity report throws when enterprise disabled", async () => {
    await expect(
      generateUserActivityReport("org-1", BASE_FILTERS),
    ).rejects.toThrow(/Enterprise features/);
  });
});

// ── Data Access Report ──────────────────────────────────────────

describe("generateDataAccessReport", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryResults.length = 0;
  });

  it("throws when internal DB unavailable", async () => {
    mockHasInternalDB = false;
    await expect(
      generateDataAccessReport("org-1", BASE_FILTERS),
    ).rejects.toThrow("Internal database not available");
  });

  it("validates date range", async () => {
    await expect(
      generateDataAccessReport("org-1", { startDate: "invalid", endDate: "2026-03-01" }),
    ).rejects.toThrow(/Invalid startDate/);
  });

  it("validates endDate before startDate", async () => {
    await expect(
      generateDataAccessReport("org-1", { startDate: "2026-03-01", endDate: "2026-01-01" }),
    ).rejects.toThrow(/startDate must be before endDate/);
  });

  it("returns empty report with no data", async () => {
    // Main query returns empty
    mockQueryResults.push([]);
    // PII enrichment query
    mockQueryResults.push([]);

    const report = await generateDataAccessReport("org-1", BASE_FILTERS);
    expect(report.rows).toHaveLength(0);
    expect(report.summary.totalQueries).toBe(0);
    expect(report.summary.uniqueUsers).toBe(0);
    expect(report.summary.uniqueTables).toBe(0);
    expect(report.filters).toEqual(BASE_FILTERS);
    expect(report.generatedAt).toBeTruthy();
  });

  it("generates report from audit data", async () => {
    // Main query
    mockQueryResults.push([
      {
        table_name: "orders",
        user_id: "user-1",
        user_email: "alice@test.com",
        query_count: "5",
        all_columns: ["id", "total"],
        first_access: "2026-01-05T00:00:00Z",
        last_access: "2026-02-15T00:00:00Z",
      },
      {
        table_name: "users",
        user_id: "user-1",
        user_email: "alice@test.com",
        query_count: "3",
        all_columns: ["email", "name"],
        first_access: "2026-01-10T00:00:00Z",
        last_access: "2026-02-10T00:00:00Z",
      },
    ]);
    // Role enrichment
    mockQueryResults.push([{ user_id: "user-1", role: "admin" }]);
    // PII enrichment
    mockQueryResults.push([{ table_name: "users" }]);

    const report = await generateDataAccessReport("org-1", BASE_FILTERS);
    expect(report.rows).toHaveLength(2);
    expect(report.summary.totalQueries).toBe(8);
    expect(report.summary.uniqueUsers).toBe(1);
    expect(report.summary.uniqueTables).toBe(2);
    expect(report.summary.piiTablesAccessed).toBe(1);
    expect(report.rows[0].userRole).toBe("admin");
    expect(report.rows[1].hasPII).toBe(true);
  });

  it("filters by role after enrichment", async () => {
    mockQueryResults.push([
      {
        table_name: "orders",
        user_id: "user-1",
        user_email: "alice@test.com",
        query_count: "5",
        all_columns: [],
        first_access: "2026-01-05T00:00:00Z",
        last_access: "2026-02-15T00:00:00Z",
      },
      {
        table_name: "orders",
        user_id: "user-2",
        user_email: "bob@test.com",
        query_count: "2",
        all_columns: [],
        first_access: "2026-01-06T00:00:00Z",
        last_access: "2026-02-10T00:00:00Z",
      },
    ]);
    // Role enrichment: user-1=admin, user-2=member
    mockQueryResults.push([
      { user_id: "user-1", role: "admin" },
      { user_id: "user-2", role: "member" },
    ]);
    // PII enrichment
    mockQueryResults.push([]);

    const report = await generateDataAccessReport("org-1", {
      ...BASE_FILTERS,
      role: "admin",
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].userId).toBe("user-1");
  });
});

// ── User Activity Report ────────────────────────────────────────

describe("generateUserActivityReport", () => {
  beforeEach(() => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryResults.length = 0;
  });

  it("throws when internal DB unavailable", async () => {
    mockHasInternalDB = false;
    await expect(
      generateUserActivityReport("org-1", BASE_FILTERS),
    ).rejects.toThrow("Internal database not available");
  });

  it("returns empty report with no data", async () => {
    mockQueryResults.push([]);

    const report = await generateUserActivityReport("org-1", BASE_FILTERS);
    expect(report.rows).toHaveLength(0);
    expect(report.summary.totalUsers).toBe(0);
    expect(report.summary.activeUsers).toBe(0);
  });

  it("generates report from audit and session data", async () => {
    // Main query
    mockQueryResults.push([
      {
        user_id: "user-1",
        user_email: "alice@test.com",
        total_queries: "10",
        tables_list: ["orders", "users"],
        last_active_at: "2026-02-15T00:00:00Z",
      },
    ]);
    // Session query (last login)
    mockQueryResults.push([
      { user_id: "user-1", last_login: "2026-02-14T00:00:00Z" },
    ]);
    // Role query
    mockQueryResults.push([{ user_id: "user-1", role: "admin" }]);

    const report = await generateUserActivityReport("org-1", BASE_FILTERS);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].totalQueries).toBe(10);
    expect(report.rows[0].lastLoginAt).toBe("2026-02-14T00:00:00Z");
    expect(report.rows[0].role).toBe("admin");
    expect(report.rows[0].tablesAccessed).toEqual(["orders", "users"]);
    expect(report.summary.totalUsers).toBe(1);
    expect(report.summary.activeUsers).toBe(1);
    expect(report.summary.totalQueries).toBe(10);
  });
});

// ── CSV export ──────────────────────────────────────────────────

describe("dataAccessReportToCSV", () => {
  it("generates CSV with header and rows", () => {
    const report: import("@useatlas/types").DataAccessReport = {
      rows: [
        {
          tableName: "orders",
          userId: "user-1",
          userEmail: "alice@test.com",
          userRole: "admin",
          queryCount: 5,
          uniqueColumns: ["id", "total"],
          hasPII: false,
          firstAccess: "2026-01-05",
          lastAccess: "2026-02-15",
        },
      ],
      summary: { totalQueries: 5, uniqueUsers: 1, uniqueTables: 1, piiTablesAccessed: 0 },
      filters: BASE_FILTERS,
      generatedAt: "2026-03-01T00:00:00Z",
    };

    const csv = dataAccessReportToCSV(report);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("table_name,user_id,user_email,user_role,query_count,unique_columns,has_pii,first_access,last_access");
    expect(lines[1]).toContain("orders");
    expect(lines[1]).toContain("alice@test.com");
    expect(lines[1]).toContain("id; total");
  });

  it("escapes CSV fields with commas", () => {
    const report: import("@useatlas/types").DataAccessReport = {
      rows: [
        {
          tableName: "my,table",
          userId: "user-1",
          userEmail: null,
          userRole: null,
          queryCount: 1,
          uniqueColumns: [],
          hasPII: false,
          firstAccess: "2026-01-05",
          lastAccess: "2026-02-15",
        },
      ],
      summary: { totalQueries: 1, uniqueUsers: 1, uniqueTables: 1, piiTablesAccessed: 0 },
      filters: BASE_FILTERS,
      generatedAt: "2026-03-01T00:00:00Z",
    };

    const csv = dataAccessReportToCSV(report);
    expect(csv).toContain('"my,table"');
  });
});

describe("userActivityReportToCSV", () => {
  it("generates CSV with header and rows", () => {
    const report: import("@useatlas/types").UserActivityReport = {
      rows: [
        {
          userId: "user-1",
          userEmail: "alice@test.com",
          role: "admin",
          totalQueries: 10,
          tablesAccessed: ["orders", "users"],
          lastActiveAt: "2026-02-15",
          lastLoginAt: "2026-02-14",
        },
      ],
      summary: { totalUsers: 1, activeUsers: 1, totalQueries: 10 },
      filters: BASE_FILTERS,
      generatedAt: "2026-03-01T00:00:00Z",
    };

    const csv = userActivityReportToCSV(report);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("user_id,user_email,role,total_queries,tables_accessed,last_active_at,last_login_at");
    expect(lines[1]).toContain("orders; users");
  });
});

// ── ReportError ─────────────────────────────────────────────────

describe("ReportError", () => {
  it("has correct name and code", () => {
    const err = new ReportError("test", "validation");
    expect(err.name).toBe("ReportError");
    expect(err.code).toBe("validation");
    expect(err.message).toBe("test");
  });
});
