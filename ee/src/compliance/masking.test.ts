import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";

// ── Isolate from .env — enterprise flag must be controlled by mock ──
const savedEnterpriseEnabled = process.env.ATLAS_ENTERPRISE_ENABLED;
beforeAll(() => { delete process.env.ATLAS_ENTERPRISE_ENABLED; });
afterAll(() => {
  if (savedEnterpriseEnabled !== undefined) process.env.ATLAS_ENTERPRISE_ENABLED = savedEnterpriseEnabled;
});

// ── Mock external dependencies ──────────────────────────────────

let mockEnterpriseEnabled = false;
let mockHasInternalDB = false;
const mockQueryRows: Record<string, unknown>[][] = [];

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () =>
    mockEnterpriseEnabled
      ? { enterprise: { enabled: true, licenseKey: "test-key" } }
      : null,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => mockQueryRows.shift() ?? [],
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
  maskValue,
  partialMask,
  applyMasking,
  savePIIClassification,
  updatePIIClassification,
  deletePIIClassification,
  listPIIClassifications,
  invalidateClassificationCache,
  ComplianceError,
  _resetComplianceState,
} = await import("./masking");

// ── maskValue ───────────────────────────────────────────────────

describe("maskValue", () => {
  it("returns null for null input", () => {
    expect(maskValue(null, "full", "full")).toBeNull();
  });

  it("returns undefined for undefined input", () => {
    expect(maskValue(undefined, "full", "full")).toBeUndefined();
  });

  it("returns empty string for empty string input", () => {
    expect(maskValue("", "full", "full")).toBe("");
  });

  it("applies full mask", () => {
    expect(maskValue("sensitive data", "full", "full")).toBe("***");
  });

  it("applies partial mask", () => {
    const result = maskValue("alice@example.com", "partial", "partial");
    expect(result).toBe("a***@example.com");
  });

  it("applies hash mask for analyst", () => {
    const result = maskValue("test value", "hash", "partial") as string;
    expect(result).toHaveLength(16);
    // Same input should produce same hash
    expect(maskValue("test value", "hash", "partial")).toBe(result);
  });

  it("applies redact mask for analyst", () => {
    expect(maskValue("sensitive", "redact", "partial")).toBe("[REDACTED]");
  });

  it("converts numbers to string before masking", () => {
    expect(maskValue(12345, "full", "full")).toBe("***");
  });

  it("analyst role overrides full to partial", () => {
    const result = maskValue("alice@example.com", "full", "partial");
    // Analysts get partial even when column strategy is full
    expect(result).toBe("a***@example.com");
  });

  it("viewer role keeps full mask", () => {
    expect(maskValue("alice@example.com", "full", "full")).toBe("***");
  });
});

// ── partialMask ─────────────────────────────────────────────────

describe("partialMask", () => {
  it("masks email preserving first char and domain", () => {
    expect(partialMask("alice@example.com")).toBe("a***@example.com");
    expect(partialMask("bob@corp.io")).toBe("b***@corp.io");
  });

  it("masks SSN showing only last 4 digits", () => {
    expect(partialMask("123-45-6789")).toBe("***-**-6789");
  });

  it("masks credit card showing last 4 digits", () => {
    expect(partialMask("4111-1111-1111-1111")).toBe("****-****-****-1111");
    expect(partialMask("4111 1111 1111 1111")).toBe("****-****-****-1111");
  });

  it("masks phone showing area code and last 4", () => {
    expect(partialMask("555-123-4567")).toBe("555-***-4567");
  });

  it("applies generic masking for short strings", () => {
    expect(partialMask("abc")).toBe("***");
    expect(partialMask("abcd")).toBe("***");
  });

  it("applies generic masking for longer strings", () => {
    expect(partialMask("abcdefgh")).toBe("ab***gh");
    expect(partialMask("Hello World")).toBe("He***ld");
  });
});

// ── applyMasking ────────────────────────────────────────────────

describe("applyMasking", () => {
  beforeEach(() => {
    _resetComplianceState();
    mockEnterpriseEnabled = false;
    mockHasInternalDB = false;
    mockQueryRows.length = 0;
  });

  it("returns unmodified rows when enterprise is disabled", async () => {
    const rows = [{ email: "alice@test.com", id: 1 }];
    const result = await applyMasking({
      columns: ["email", "id"],
      rows,
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "viewer",
    });
    expect(result).toBe(rows); // Same reference — no copy
  });

  it("returns unmodified rows for admin role", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    const rows = [{ email: "alice@test.com" }];
    const result = await applyMasking({
      columns: ["email"],
      rows,
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "admin",
    });
    expect(result).toBe(rows);
  });

  it("returns unmodified rows for owner role", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    const rows = [{ email: "alice@test.com" }];
    const result = await applyMasking({
      columns: ["email"],
      rows,
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "owner",
    });
    expect(result).toBe(rows);
  });

  it("returns unmodified rows when no internal DB", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = false;
    const rows = [{ email: "alice@test.com" }];
    const result = await applyMasking({
      columns: ["email"],
      rows,
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "viewer",
    });
    expect(result).toBe(rows);
  });

  it("returns empty array for empty rows", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    const result = await applyMasking({
      columns: ["email"],
      rows: [],
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "viewer",
    });
    expect(result).toEqual([]);
  });

  it("masks PII columns for viewer role", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    // First call: ensureTable (CREATE TABLE), second: getClassificationsForOrg
    mockQueryRows.push([]); // CREATE TABLE returns empty
    mockQueryRows.push([
      {
        id: "cls-1",
        org_id: "org-1",
        table_name: "users",
        column_name: "email",
        connection_id: "default",
        category: "email",
        confidence: "high",
        masking_strategy: "partial",
        reviewed: true,
        dismissed: false,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const result = await applyMasking({
      columns: ["email", "id"],
      rows: [
        { email: "alice@example.com", id: 1 },
        { email: "bob@test.io", id: 2 },
      ],
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "viewer",
    });

    // Viewer gets full mask (overrides partial → full for viewer)
    expect(result[0].email).toBe("***");
    expect(result[0].id).toBe(1); // Non-PII column unchanged
    expect(result[1].email).toBe("***");
  });

  it("applies partial mask for analyst role", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([
      {
        id: "cls-1",
        org_id: "org-1",
        table_name: "users",
        column_name: "email",
        connection_id: "default",
        category: "email",
        confidence: "high",
        masking_strategy: "full",
        reviewed: true,
        dismissed: false,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const result = await applyMasking({
      columns: ["email"],
      rows: [{ email: "alice@example.com" }],
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "analyst",
    });

    // Analyst overrides full → partial
    expect(result[0].email).toBe("a***@example.com");
  });

  it("does not mutate original rows", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.push([]);
    mockQueryRows.push([
      {
        id: "cls-1",
        org_id: "org-1",
        table_name: "users",
        column_name: "email",
        connection_id: "default",
        category: "email",
        confidence: "high",
        masking_strategy: "full",
        reviewed: true,
        dismissed: false,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const originalRows = [{ email: "alice@example.com" }];
    await applyMasking({
      columns: ["email"],
      rows: originalRows,
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: "viewer",
    });

    expect(originalRows[0].email).toBe("alice@example.com");
  });

  it("defaults to viewer masking when role is undefined", async () => {
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.push([]);
    mockQueryRows.push([
      {
        id: "cls-1",
        org_id: "org-1",
        table_name: "users",
        column_name: "email",
        connection_id: "default",
        category: "email",
        confidence: "high",
        masking_strategy: "partial",
        reviewed: false,
        dismissed: false,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const result = await applyMasking({
      columns: ["email"],
      rows: [{ email: "alice@example.com" }],
      tablesAccessed: ["users"],
      orgId: "org-1",
      userRole: undefined,
    });

    // Undefined role defaults to viewer (full mask)
    expect(result[0].email).toBe("***");
  });
});

// ── ComplianceError ─────────────────────────────────────────────

describe("ComplianceError", () => {
  it("has correct name and code", () => {
    const err = new ComplianceError("test message", "validation");
    expect(err.name).toBe("ComplianceError");
    expect(err.code).toBe("validation");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ComplianceError).toBe(true);
  });

  it("supports all error codes", () => {
    for (const code of ["validation", "not_found", "conflict"] as const) {
      const err = new ComplianceError(`test ${code}`, code);
      expect(err.code).toBe(code);
    }
  });
});

// ── CRUD operations ─────────────────────────────────────────────

describe("savePIIClassification", () => {
  beforeEach(() => {
    _resetComplianceState();
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.length = 0;
  });

  it("saves a classification and returns it", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([{
      id: "cls-new",
      org_id: "org-1",
      table_name: "users",
      column_name: "email",
      connection_id: "default",
      category: "email",
      confidence: "high",
      masking_strategy: "partial",
      reviewed: false,
      dismissed: false,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    }]);

    const result = await savePIIClassification(
      "org-1", "users", "email", "default", "email", "high", "partial",
    );
    expect(result.id).toBe("cls-new");
    expect(result.category).toBe("email");
    expect(result.maskingStrategy).toBe("partial");
  });

  it("throws on invalid category", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    await expect(
      savePIIClassification("org-1", "t", "c", "default", "invalid" as "email", "high"),
    ).rejects.toThrow("Invalid PII category");
  });

  it("throws on invalid masking strategy", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    await expect(
      savePIIClassification("org-1", "t", "c", "default", "email", "high", "invalid" as "full"),
    ).rejects.toThrow("Invalid masking strategy");
  });

  it("throws when enterprise is disabled", async () => {
    mockEnterpriseEnabled = false;
    await expect(
      savePIIClassification("org-1", "t", "c", "default", "email", "high"),
    ).rejects.toThrow("Enterprise features");
  });

  it("throws when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    await expect(
      savePIIClassification("org-1", "t", "c", "default", "email", "high"),
    ).rejects.toThrow("Internal database not available");
  });
});

describe("updatePIIClassification", () => {
  beforeEach(() => {
    _resetComplianceState();
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.length = 0;
  });

  it("updates and returns the classification", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([{
      id: "cls-1",
      org_id: "org-1",
      table_name: "users",
      column_name: "email",
      connection_id: "default",
      category: "phone",
      confidence: "high",
      masking_strategy: "full",
      reviewed: true,
      dismissed: false,
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
    }]);

    const result = await updatePIIClassification("org-1", "cls-1", {
      category: "phone",
      maskingStrategy: "full",
      reviewed: true,
    });
    expect(result.category).toBe("phone");
    expect(result.maskingStrategy).toBe("full");
    expect(result.reviewed).toBe(true);
  });

  it("throws not_found when classification does not exist", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([]); // empty result

    try {
      await updatePIIClassification("org-1", "nonexistent", { reviewed: true });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof ComplianceError).toBe(true);
      expect((err as InstanceType<typeof ComplianceError>).code).toBe("not_found");
    }
  });
});

describe("deletePIIClassification", () => {
  beforeEach(() => {
    _resetComplianceState();
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.length = 0;
  });

  it("deletes a classification", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([{ id: "cls-1" }]); // RETURNING id

    await expect(deletePIIClassification("org-1", "cls-1")).resolves.toBeUndefined();
  });

  it("throws not_found when classification does not exist", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([]); // empty result

    try {
      await deletePIIClassification("org-1", "nonexistent");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err instanceof ComplianceError).toBe(true);
      expect((err as InstanceType<typeof ComplianceError>).code).toBe("not_found");
    }
  });

  it("throws when internal DB is unavailable", async () => {
    mockHasInternalDB = false;
    await expect(
      deletePIIClassification("org-1", "cls-1"),
    ).rejects.toThrow("Internal database not available");
  });
});

describe("listPIIClassifications", () => {
  beforeEach(() => {
    _resetComplianceState();
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.length = 0;
  });

  it("returns classifications for an org", async () => {
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([
      {
        id: "cls-1",
        org_id: "org-1",
        table_name: "users",
        column_name: "email",
        connection_id: "default",
        category: "email",
        confidence: "high",
        masking_strategy: "partial",
        reviewed: false,
        dismissed: false,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ]);

    const results = await listPIIClassifications("org-1");
    expect(results).toHaveLength(1);
    expect(results[0].tableName).toBe("users");
    expect(results[0].columnName).toBe("email");
  });

  it("returns empty array when DB is unavailable", async () => {
    mockHasInternalDB = false;
    const results = await listPIIClassifications("org-1");
    expect(results).toEqual([]);
  });
});

// ── Cache behavior ──────────────────────────────────────────────

describe("invalidateClassificationCache", () => {
  beforeEach(() => {
    _resetComplianceState();
    mockEnterpriseEnabled = true;
    mockHasInternalDB = true;
    mockQueryRows.length = 0;
  });

  it("forces re-fetch after invalidation", async () => {
    // First call populates cache
    mockQueryRows.push([]); // CREATE TABLE
    mockQueryRows.push([{
      id: "cls-1", org_id: "org-1", table_name: "users", column_name: "email",
      connection_id: "default", category: "email", confidence: "high",
      masking_strategy: "partial", reviewed: false, dismissed: false,
      created_at: "2026-01-01", updated_at: "2026-01-01",
    }]);

    const result1 = await applyMasking({
      columns: ["email"], rows: [{ email: "test@test.com" }],
      tablesAccessed: ["users"], orgId: "org-1", userRole: "viewer",
    });
    expect(result1[0].email).toBe("***"); // Masked

    // Invalidate cache and provide empty classifications
    invalidateClassificationCache("org-1");
    mockQueryRows.push([]); // Re-fetch returns empty (classification was deleted)

    const result2 = await applyMasking({
      columns: ["email"], rows: [{ email: "test@test.com" }],
      tablesAccessed: ["users"], orgId: "org-1", userRole: "viewer",
    });
    expect(result2[0].email).toBe("test@test.com"); // No longer masked
  });
});
