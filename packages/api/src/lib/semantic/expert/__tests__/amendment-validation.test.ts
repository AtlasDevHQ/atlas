/**
 * The Amendment validation seam (#4513) — pure gates shared by the propose seam
 * and the apply seam. Tests pin external behavior: which payloads a type
 * accepts, which embedded SQL is collected + how it is wrapped for the shared
 * validator, the post-apply EntityShape gate, and the declared mutable-field set
 * that replaces the blind `Object.assign`.
 */

import { describe, it, expect, mock, type Mock } from "bun:test";

// validateEmbeddedSql dynamically imports validateSQL from tools/sql — mock it
// so this file never pulls the heavy SQL module or touches a DB.
const mockValidateSQL: Mock<(sql: string, connectionId?: string, workspaceId?: string) => Promise<{ valid: boolean; error?: string }>> =
  mock(async () => ({ valid: true }));
void mock.module("@atlas/api/lib/tools/sql", () => ({ validateSQL: mockValidateSQL }));

const {
  validateAmendmentPayload,
  collectEmbeddedSql,
  validateEmbeddedSql,
  parseEntityShapeOrError,
  parseGlossaryShapeOrError,
  AMENDMENT_MUTABLE_FIELDS,
} = await import("../amendment-validation");

describe("validateAmendmentPayload", () => {
  it("accepts a well-formed add_dimension (sql optional)", () => {
    expect(
      validateAmendmentPayload("add_dimension", { name: "region", type: "string", description: "Region" }),
    ).toBeNull();
  });

  it("tolerates extra entity attributes on an ADD type (passthrough)", () => {
    expect(
      validateAmendmentPayload("add_dimension", { name: "region", sql: "region", format: "upper", unit: "n/a" }),
    ).toBeNull();
  });

  it("rejects add_measure with no sql — the tool result names the field", () => {
    const err = validateAmendmentPayload("add_measure", { name: "revenue" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/sql/i);
  });

  it("rejects a non-object payload", () => {
    expect(validateAmendmentPayload("add_dimension", "not an object")).toMatch(/must be an object/i);
  });

  it("rejects update_dimension that smuggles a sql change — containment (ADR-0032)", () => {
    const err = validateAmendmentPayload("update_dimension", { name: "status", sql: "lower(status)" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/sql/i);
  });

  it("accepts update_dimension touching only its declared fields (type, sample_values)", () => {
    expect(
      validateAmendmentPayload("update_dimension", { name: "status", type: "string", sample_values: ["a", "b"] }),
    ).toBeNull();
  });

  it("accepts a well-formed add_glossary_term (#4518)", () => {
    expect(
      validateAmendmentPayload("add_glossary_term", { term: "MRR", definition: "Monthly Recurring Revenue" }),
    ).toBeNull();
  });

  it("accepts update_glossary_term touching only definition/ambiguous (#4518)", () => {
    expect(
      validateAmendmentPayload("update_glossary_term", { term: "churn", definition: "attrition", ambiguous: true }),
    ).toBeNull();
  });

  it("rejects update_glossary_term with an undeclared field — glossary containment (#4518)", () => {
    const err = validateAmendmentPayload("update_glossary_term", {
      term: "churn", definition: "x", possible_mappings: ["a.b"],
    });
    expect(err).not.toBeNull();
    expect(err).toMatch(/possible_mappings/);
  });

  it("rejects update_glossary_term with no term (the selector is required)", () => {
    const err = validateAmendmentPayload("update_glossary_term", { definition: "x" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/term/);
  });
});

describe("AMENDMENT_MUTABLE_FIELDS.update_dimension", () => {
  it("declares type/sample_values/description and protects name + sql", () => {
    const fields = AMENDMENT_MUTABLE_FIELDS.update_dimension ?? [];
    expect(fields).toContain("type");
    expect(fields).toContain("sample_values");
    expect(fields).toContain("description");
    expect(fields).not.toContain("name");
    expect(fields).not.toContain("sql");
  });
});

describe("collectEmbeddedSql", () => {
  it("returns a full-query entry for add_query_pattern", () => {
    expect(collectEmbeddedSql("add_query_pattern", { name: "p", sql: "SELECT 1 FROM orders" })).toEqual([
      { field: "sql", sql: "SELECT 1 FROM orders", kind: "query" },
    ]);
  });

  it("returns an expression entry for measure / dimension / virtual dimension", () => {
    for (const type of ["add_measure", "add_dimension", "add_virtual_dimension"] as const) {
      expect(collectEmbeddedSql(type, { name: "m", sql: "SUM(amount)" })).toEqual([
        { field: "sql", sql: "SUM(amount)", kind: "expression" },
      ]);
    }
  });

  it("collects nothing for types with no standalone SQL (glossary, update_dimension, join)", () => {
    expect(collectEmbeddedSql("add_glossary_term", { term: "MRR", definition: "x" })).toEqual([]);
    expect(collectEmbeddedSql("update_dimension", { name: "status", type: "string" })).toEqual([]);
    expect(collectEmbeddedSql("add_join", { sql: "a.id = b.id" })).toEqual([]);
  });
});

describe("validateEmbeddedSql", () => {
  it("wraps an expression as SELECT <expr> before validation", async () => {
    mockValidateSQL.mockClear();
    mockValidateSQL.mockResolvedValue({ valid: true });
    const err = await validateEmbeddedSql("add_measure", { name: "m", sql: "SUM(amount)" }, "conn-1", "org-1");
    expect(err).toBeNull();
    expect(mockValidateSQL).toHaveBeenCalledTimes(1);
    expect(mockValidateSQL.mock.calls[0][0]).toBe("SELECT SUM(amount)");
    // The amendment's own connection + workspace are threaded through.
    expect(mockValidateSQL.mock.calls[0][1]).toBe("conn-1");
    expect(mockValidateSQL.mock.calls[0][2]).toBe("org-1");
  });

  it("passes a query pattern through as-is (not wrapped)", async () => {
    mockValidateSQL.mockClear();
    mockValidateSQL.mockResolvedValue({ valid: true });
    await validateEmbeddedSql("add_query_pattern", { name: "p", sql: "SELECT * FROM orders" }, "conn-1");
    expect(mockValidateSQL.mock.calls[0][0]).toBe("SELECT * FROM orders");
  });

  it("surfaces a validation failure with the offending field", async () => {
    mockValidateSQL.mockClear();
    mockValidateSQL.mockResolvedValue({ valid: false, error: "Forbidden SQL operation detected" });
    const err = await validateEmbeddedSql("add_virtual_dimension", { name: "v", sql: "pg_read_file('x')" }, "conn-1");
    expect(err).toMatch(/sql/i);
    expect(err).toMatch(/Forbidden/);
  });

  it("never touches the SQL validator when there is no embedded SQL", async () => {
    mockValidateSQL.mockClear();
    const err = await validateEmbeddedSql("add_glossary_term", { term: "MRR", definition: "x" });
    expect(err).toBeNull();
    expect(mockValidateSQL).not.toHaveBeenCalled();
  });
});

describe("parseEntityShapeOrError", () => {
  it("accepts a document that still parses as a semantic entity", () => {
    expect(parseEntityShapeOrError({ table: "orders", dimensions: [] })).toBeNull();
  });

  it("rejects a document that lost its table field", () => {
    const err = parseEntityShapeOrError({ name: "orders", dimensions: [] });
    expect(err).not.toBeNull();
    expect(err).toMatch(/table/i);
  });
});

describe("AMENDMENT_MUTABLE_FIELDS.update_glossary_term (#4518)", () => {
  it("declares definition/ambiguous and protects term (the selector)", () => {
    const fields = AMENDMENT_MUTABLE_FIELDS.update_glossary_term ?? [];
    expect(fields).toContain("definition");
    expect(fields).toContain("ambiguous");
    expect(fields).not.toContain("term");
  });
});

describe("parseGlossaryShapeOrError (#4518)", () => {
  it("accepts the object-form glossary (canonical)", () => {
    expect(parseGlossaryShapeOrError({ terms: { MRR: { definition: "x" } } })).toBeNull();
  });

  it("accepts the legacy array-form glossary", () => {
    expect(parseGlossaryShapeOrError({ terms: [{ term: "MRR", definition: "x" }] })).toBeNull();
  });

  it("accepts an empty (new) glossary — terms is optional", () => {
    expect(parseGlossaryShapeOrError({})).toBeNull();
  });

  it("rejects a corrupted glossary whose terms is a scalar", () => {
    const err = parseGlossaryShapeOrError({ terms: "not a map" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/glossary/i);
  });
});
