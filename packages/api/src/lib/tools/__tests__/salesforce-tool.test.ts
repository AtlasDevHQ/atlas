/**
 * Tests for the querySalesforce agent tool.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock Salesforce registry
const mockQuery = mock(() =>
  Promise.resolve({
    columns: ["Id", "Name"],
    rows: [
      { Id: "001", Name: "Acme" },
      { Id: "002", Name: "Widget Co" },
    ],
  }),
);

const mockSources = new Map<string, { query: typeof mockQuery; close: () => Promise<void> }>();

mock.module("@atlas/api/lib/db/salesforce", () => ({
  getSalesforceSource: (id: string) => {
    const source = mockSources.get(id);
    if (!source) throw new Error(`Salesforce source "${id}" is not registered.`);
    return source;
  },
  listSalesforceSources: () => Array.from(mockSources.keys()),
}));

// Mock semantic layer
mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["account", "contact", "opportunity"]),
  _resetWhitelists: () => {},
}));

// Mock audit log (no-op)
mock.module("@atlas/api/lib/auth/audit", () => ({
  logQueryAudit: () => {},
}));

const { querySalesforce } = await import("@atlas/api/lib/tools/salesforce");

// Helper to call the tool's execute function
async function executeTool(params: {
  soql: string;
  explanation: string;
  connectionId?: string;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (querySalesforce as any).execute(params);
}

describe("querySalesforce tool", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockImplementation(() =>
      Promise.resolve({
        columns: ["Id", "Name"],
        rows: [
          { Id: "001", Name: "Acme" },
          { Id: "002", Name: "Widget Co" },
        ],
      }),
    );
    mockSources.clear();
    mockSources.set("default", {
      query: mockQuery,
      close: async () => {},
    });
  });

  it("executes a valid query and returns results", async () => {
    const result = await executeTool({
      soql: "SELECT Id, Name FROM Account",
      explanation: "Get all accounts",
    });
    expect(result.success).toBe(true);
    expect(result.columns).toEqual(["Id", "Name"]);
    expect(result.rows).toHaveLength(2);
    expect(result.row_count).toBe(2);
  });

  it("rejects invalid SOQL (mutation)", async () => {
    const result = await executeTool({
      soql: "DELETE FROM Account",
      explanation: "Delete accounts",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Forbidden");
  });

  it("rejects queries against non-whitelisted objects", async () => {
    const result = await executeTool({
      soql: "SELECT Id FROM CustomObject__c",
      explanation: "Get custom objects",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not in the allowed list");
  });

  it("returns error for unregistered connection", async () => {
    const result = await executeTool({
      soql: "SELECT Id FROM Account",
      explanation: "test",
      connectionId: "nonexistent",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not registered");
  });

  it("appends LIMIT when not present", async () => {
    await executeTool({
      soql: "SELECT Id FROM Account",
      explanation: "test",
    });
    // The mockQuery should have been called with a SOQL that includes LIMIT
    const calledWith = (mockQuery.mock.calls as unknown as string[][])[0][0];
    expect(calledWith).toContain("LIMIT");
  });

  it("does not double-append LIMIT", async () => {
    await executeTool({
      soql: "SELECT Id FROM Account LIMIT 5",
      explanation: "test",
    });
    const calledWith = (mockQuery.mock.calls as unknown as string[][])[0][0];
    // Should not have two LIMIT clauses
    const limitCount = (calledWith.match(/LIMIT/gi) ?? []).length;
    expect(limitCount).toBe(1);
  });

  it("scrubs sensitive error messages", async () => {
    mockQuery.mockImplementationOnce(() =>
      Promise.reject(new Error("INVALID_SESSION_ID: Session expired")),
    );
    const result = await executeTool({
      soql: "SELECT Id FROM Account",
      explanation: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("check server logs");
    expect(result.error).not.toContain("INVALID_SESSION_ID");
  });

  it("surfaces non-sensitive errors to the agent", async () => {
    mockQuery.mockImplementationOnce(() =>
      Promise.reject(new Error("INVALID_FIELD: No such column 'Foo'")),
    );
    const result = await executeTool({
      soql: "SELECT Foo FROM Account",
      explanation: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("INVALID_FIELD");
  });
});
