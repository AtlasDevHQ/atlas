import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Mocks ───────────────────────────────────────────────────────────

let mockEnterpriseEnabled = false;
let mockEnterpriseLicenseKey: string | undefined = "test-key";

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({
    enterprise: {
      enabled: mockEnterpriseEnabled,
      licenseKey: mockEnterpriseLicenseKey,
    },
  }),
}));

// Mock internal DB
const mockRows: Record<string, unknown>[][] = [];
let queryCallCount = 0;
const capturedQueries: { sql: string; params: unknown[] }[] = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({
    query: async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql, params: params ?? [] });
      const rows = mockRows[queryCallCount] ?? [];
      queryCallCount++;
      return { rows, rowCount: rows.length };
    },
    end: async () => {},
    on: () => {},
  }),
  internalQuery: async (sql: string, params?: unknown[]) => {
    capturedQueries.push({ sql, params: params ?? [] });
    const rows = mockRows[queryCallCount] ?? [];
    queryCallCount++;
    return rows;
  },
  internalExecute: () => {},
  encryptUrl: (v: string) => `encrypted:${v}`,
  decryptUrl: (v: string) => v.startsWith("encrypted:") ? v.slice(10) : v,
  getEncryptionKey: () => Buffer.from("test-key-32-bytes-long-enough!!!"),
  closeInternalDB: async () => {},
  migrateInternalDB: async () => {},
  _resetPool: () => {},
  loadSavedConnections: async () => 0,
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
  listApprovalRules,
  getApprovalRule,
  createApprovalRule,
  updateApprovalRule,
  deleteApprovalRule,
  checkApprovalRequired,
  createApprovalRequest,
  listApprovalRequests,
  reviewApprovalRequest,
  expireStaleRequests,
  getPendingCount,
  ApprovalError,
} = await import("./approval");

// ── Helpers ─────────────────────────────────────────────────────────

function resetMocks() {
  mockRows.length = 0;
  queryCallCount = 0;
  capturedQueries.length = 0;
  mockEnterpriseEnabled = true;
  mockEnterpriseLicenseKey = "test-key";
}

function makeRuleRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "rule-1",
    org_id: "org-1",
    name: "PII table approval",
    rule_type: "table",
    pattern: "users",
    threshold: null,
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeQueueRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "req-1",
    org_id: "org-1",
    rule_id: "rule-1",
    rule_name: "PII table approval",
    requester_id: "user-1",
    requester_email: "user@example.com",
    query_sql: "SELECT * FROM users",
    explanation: "Fetching user data",
    connection_id: "default",
    tables_accessed: '["users"]',
    columns_accessed: '["id","name","email"]',
    status: "pending",
    reviewer_id: null,
    reviewer_email: null,
    review_comment: null,
    reviewed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Rule CRUD Tests ─────────────────────────────────────────────────

describe("listApprovalRules", () => {
  beforeEach(resetMocks);

  it("returns empty array when no rules exist", async () => {
    mockRows.push([]);
    const result = await listApprovalRules("org-1");
    expect(result).toEqual([]);
  });

  it("returns rules for the organization", async () => {
    mockRows.push([makeRuleRow(), makeRuleRow({ id: "rule-2", name: "SSN column" })]);
    const result = await listApprovalRules("org-1");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("PII table approval");
    expect(result[1].name).toBe("SSN column");
  });

  it("throws when enterprise is not enabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(listApprovalRules("org-1")).rejects.toThrow("Enterprise features");
  });
});

describe("getApprovalRule", () => {
  beforeEach(resetMocks);

  it("returns null when rule does not exist", async () => {
    mockRows.push([]);
    const result = await getApprovalRule("org-1", "rule-1");
    expect(result).toBeNull();
  });

  it("returns rule when found", async () => {
    mockRows.push([makeRuleRow()]);
    const result = await getApprovalRule("org-1", "rule-1");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("PII table approval");
    expect(result!.ruleType).toBe("table");
    expect(result!.pattern).toBe("users");
  });
});

describe("createApprovalRule", () => {
  beforeEach(resetMocks);

  it("creates a table rule", async () => {
    mockRows.push([makeRuleRow()]);
    const result = await createApprovalRule("org-1", {
      name: "PII table approval",
      ruleType: "table",
      pattern: "users",
    });
    expect(result.name).toBe("PII table approval");
    expect(result.ruleType).toBe("table");
    expect(capturedQueries[0].sql).toContain("INSERT INTO approval_rules");
  });

  it("rejects empty name", async () => {
    await expect(
      createApprovalRule("org-1", { name: "", ruleType: "table", pattern: "users" }),
    ).rejects.toThrow("Rule name is required");
  });

  it("rejects invalid rule type", async () => {
    await expect(
      createApprovalRule("org-1", {
        name: "test",
        ruleType: "invalid" as "table",
        pattern: "users",
      }),
    ).rejects.toThrow("Invalid rule type");
  });

  it("rejects cost rule without threshold", async () => {
    await expect(
      createApprovalRule("org-1", { name: "test", ruleType: "cost", pattern: "" }),
    ).rejects.toThrow("Cost rules require a positive threshold");
  });

  it("rejects table rule without pattern", async () => {
    await expect(
      createApprovalRule("org-1", { name: "test", ruleType: "table", pattern: "" }),
    ).rejects.toThrow('Pattern is required for "table" rules');
  });
});

describe("updateApprovalRule", () => {
  beforeEach(resetMocks);

  it("updates rule name", async () => {
    // getApprovalRule call
    mockRows.push([makeRuleRow()]);
    // UPDATE RETURNING
    mockRows.push([makeRuleRow({ name: "Updated name" })]);
    const result = await updateApprovalRule("org-1", "rule-1", { name: "Updated name" });
    expect(result.name).toBe("Updated name");
  });

  it("throws not_found for missing rule", async () => {
    mockRows.push([]); // getApprovalRule returns nothing
    await expect(updateApprovalRule("org-1", "missing", { name: "x" })).rejects.toThrow("not found");
  });

  it("returns existing rule when no changes", async () => {
    mockRows.push([makeRuleRow()]);
    const result = await updateApprovalRule("org-1", "rule-1", {});
    expect(result.name).toBe("PII table approval");
  });
});

describe("deleteApprovalRule", () => {
  beforeEach(resetMocks);

  it("returns true when rule is deleted", async () => {
    // getInternalDB().query returns rowCount based on rows array length
    mockRows.push([{ deleted: true }]); // simulate 1 affected row
    const result = await deleteApprovalRule("org-1", "rule-1");
    expect(result).toBe(true);
  });
});

// ── Matching Tests ──────────────────────────────────────────────────

describe("checkApprovalRequired", () => {
  beforeEach(resetMocks);

  it("returns false when no org ID", async () => {
    const result = await checkApprovalRequired(undefined, ["users"], ["id"]);
    expect(result.required).toBe(false);
  });

  it("returns false when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    const result = await checkApprovalRequired("org-1", ["users"], ["id"]);
    expect(result.required).toBe(false);
  });

  it("returns false when no rules exist", async () => {
    mockRows.push([]); // empty rules
    const result = await checkApprovalRequired("org-1", ["users"], ["id"]);
    expect(result.required).toBe(false);
  });

  it("matches table rule", async () => {
    mockRows.push([makeRuleRow({ rule_type: "table", pattern: "users" })]);
    const result = await checkApprovalRequired("org-1", ["users"], ["id"]);
    expect(result.required).toBe(true);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].name).toBe("PII table approval");
  });

  it("matches table rule case-insensitively", async () => {
    mockRows.push([makeRuleRow({ rule_type: "table", pattern: "Users" })]);
    const result = await checkApprovalRequired("org-1", ["users"], ["id"]);
    expect(result.required).toBe(true);
  });

  it("matches column rule", async () => {
    mockRows.push([makeRuleRow({ rule_type: "column", pattern: "ssn" })]);
    const result = await checkApprovalRequired("org-1", ["users"], ["ssn"]);
    expect(result.required).toBe(true);
  });

  it("does not match when table is not accessed", async () => {
    mockRows.push([makeRuleRow({ rule_type: "table", pattern: "secret_data" })]);
    const result = await checkApprovalRequired("org-1", ["orders"], ["id"]);
    expect(result.required).toBe(false);
  });

  it("matches schema-qualified table name", async () => {
    mockRows.push([makeRuleRow({ rule_type: "table", pattern: "users" })]);
    const result = await checkApprovalRequired("org-1", ["public.users"], ["id"]);
    expect(result.required).toBe(true);
  });
});

// ── Queue Management Tests ──────────────────────────────────────────

describe("createApprovalRequest", () => {
  beforeEach(resetMocks);

  it("creates an approval request", async () => {
    mockRows.push([makeQueueRow()]);
    const result = await createApprovalRequest({
      orgId: "org-1",
      ruleId: "rule-1",
      ruleName: "PII table approval",
      requesterId: "user-1",
      requesterEmail: "user@example.com",
      querySql: "SELECT * FROM users",
      explanation: "Fetching user data",
      connectionId: "default",
      tablesAccessed: ["users"],
      columnsAccessed: ["id", "name", "email"],
    });
    expect(result.id).toBe("req-1");
    expect(result.status).toBe("pending");
    expect(result.tablesAccessed).toEqual(["users"]);
    expect(capturedQueries[0].sql).toContain("INSERT INTO approval_queue");
  });
});

describe("listApprovalRequests", () => {
  beforeEach(resetMocks);

  it("returns all requests", async () => {
    mockRows.push([makeQueueRow(), makeQueueRow({ id: "req-2" })]);
    const result = await listApprovalRequests("org-1");
    expect(result).toHaveLength(2);
  });

  it("filters by status", async () => {
    mockRows.push([makeQueueRow({ status: "approved" })]);
    const result = await listApprovalRequests("org-1", "approved");
    expect(result).toHaveLength(1);
    expect(capturedQueries[0].sql).toContain("AND status = $2");
  });
});

describe("reviewApprovalRequest", () => {
  beforeEach(resetMocks);

  it("approves a pending request", async () => {
    // getApprovalRequest call
    mockRows.push([makeQueueRow()]);
    // UPDATE RETURNING
    mockRows.push([makeQueueRow({ status: "approved", reviewer_id: "admin-1", reviewed_at: "2026-01-01T12:00:00Z" })]);
    const result = await reviewApprovalRequest("org-1", "req-1", "admin-1", "admin@example.com", "approve", "Looks good");
    expect(result.status).toBe("approved");
  });

  it("denies a pending request", async () => {
    mockRows.push([makeQueueRow()]);
    mockRows.push([makeQueueRow({ status: "denied", reviewer_id: "admin-1", reviewed_at: "2026-01-01T12:00:00Z" })]);
    const result = await reviewApprovalRequest("org-1", "req-1", "admin-1", "admin@example.com", "deny");
    expect(result.status).toBe("denied");
  });

  it("throws not_found for missing request", async () => {
    mockRows.push([]); // getApprovalRequest returns nothing
    await expect(
      reviewApprovalRequest("org-1", "missing", "admin-1", null, "approve"),
    ).rejects.toThrow("not found");
  });

  it("throws conflict for already-reviewed request", async () => {
    mockRows.push([makeQueueRow({ status: "approved" })]);
    await expect(
      reviewApprovalRequest("org-1", "req-1", "admin-1", null, "approve"),
    ).rejects.toThrow("Cannot approve request");
  });

  it("auto-expires and throws for expired request", async () => {
    // Return a pending request that's already past its expiry
    mockRows.push([makeQueueRow({ expires_at: "2020-01-01T00:00:00Z" })]);
    // For the UPDATE to expired status
    mockRows.push([]);
    await expect(
      reviewApprovalRequest("org-1", "req-1", "admin-1", null, "approve"),
    ).rejects.toThrow("expired");
  });
});

describe("expireStaleRequests", () => {
  beforeEach(resetMocks);

  it("returns 0 when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    const result = await expireStaleRequests();
    expect(result).toBe(0);
  });
});

describe("getPendingCount", () => {
  beforeEach(resetMocks);

  it("returns 0 when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    const result = await getPendingCount("org-1");
    expect(result).toBe(0);
  });

  it("returns count from database", async () => {
    mockRows.push([{ count: "5" }]);
    const result = await getPendingCount("org-1");
    expect(result).toBe(5);
  });
});

describe("ApprovalError", () => {
  it("has correct name and code", () => {
    const err = new ApprovalError("test", "validation");
    expect(err.name).toBe("ApprovalError");
    expect(err.code).toBe("validation");
    expect(err.message).toBe("test");
  });
});
