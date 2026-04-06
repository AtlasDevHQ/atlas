import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up BEFORE importing internal.ts
// ---------------------------------------------------------------------------
const mockWarn = mock(() => {});
const mockDebug = mock(() => {});

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: mockWarn,
    error: () => {},
    debug: mockDebug,
  }),
  getRequestContext: () => undefined,
}));

// Stub out heavy deps that internal.ts imports at module level
mock.module("@effect/sql", () => ({ SqlClient: { Tag: () => ({}) } }));
mock.module("@effect/sql-pg", () => ({ PgClient: { layerFromPool: () => ({}) } }));

// NOW import the functions under test
const { getAutoApproveTypes, getAutoApproveThreshold } = await import("../internal");

// ---------------------------------------------------------------------------
// getAutoApproveTypes
// ---------------------------------------------------------------------------

describe("getAutoApproveTypes", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES;
    mockWarn.mockClear();
  });

  it("returns default types when env var is not set", () => {
    const types = getAutoApproveTypes();
    expect(types).toEqual(new Set(["update_description", "add_dimension"]));
  });

  it("parses custom comma-separated types", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "add_measure,add_join,update_description";
    const types = getAutoApproveTypes();
    expect(types).toEqual(new Set(["add_measure", "add_join", "update_description"]));
  });

  it("trims whitespace around types", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = " add_dimension , update_description ";
    const types = getAutoApproveTypes();
    expect(types).toEqual(new Set(["add_dimension", "update_description"]));
  });

  it("filters out empty strings from trailing commas", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,,add_dimension,";
    const types = getAutoApproveTypes();
    expect(types).toEqual(new Set(["update_description", "add_dimension"]));
  });

  it("returns empty set when set to empty string", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "";
    const types = getAutoApproveTypes();
    expect(types).toEqual(new Set());
  });

  it("warns and ignores unrecognized type names", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,typo_type,add_dimension";
    const types = getAutoApproveTypes();
    expect(types).toEqual(new Set(["update_description", "add_dimension"]));
    expect(mockWarn).toHaveBeenCalled();
  });

  it("higher-risk types are not in the default set", () => {
    const allowedTypes = getAutoApproveTypes();
    const higherRisk = [
      "add_join", "add_measure", "update_dimension",
      "add_query_pattern", "add_glossary_term", "add_virtual_dimension",
    ];
    for (const t of higherRisk) {
      expect(allowedTypes.has(t)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Status resolution logic
//
// insertSemanticAmendment uses getAutoApproveThreshold + getAutoApproveTypes +
// typeof guard to determine "approved" vs "pending". We test the exact same
// logic using the real exported helpers (env-var-driven) without needing a DB.
// ---------------------------------------------------------------------------

function resolveStatus(
  confidence: number,
  amendmentPayload: Record<string, unknown>,
): "approved" | "pending" {
  const threshold = getAutoApproveThreshold();
  const allowedTypes = getAutoApproveTypes();
  const rawType = amendmentPayload.amendmentType;
  const amendmentType = typeof rawType === "string" ? rawType : undefined;
  const meetsThreshold = confidence >= threshold;
  const typeEligible = amendmentType !== undefined && allowedTypes.has(amendmentType);
  return meetsThreshold && typeEligible ? "approved" : "pending";
}

describe("amendment auto-approve status resolution", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD;
    delete process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES;
    mockWarn.mockClear();
    mockDebug.mockClear();
  });

  it("auto-approves when confidence meets threshold AND type is allowed", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

    expect(resolveStatus(0.9, { amendmentType: "update_description" })).toBe("approved");
  });

  it("queues when confidence meets threshold but type is NOT allowed", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

    expect(resolveStatus(0.95, { amendmentType: "add_join" })).toBe("pending");
  });

  it("queues when type is allowed but confidence is below threshold", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

    expect(resolveStatus(0.5, { amendmentType: "update_description" })).toBe("pending");
  });

  it("queues when ATLAS_EXPERT_AUTO_APPROVE_TYPES is empty string", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "";

    expect(resolveStatus(0.9, { amendmentType: "update_description" })).toBe("pending");
  });

  it("queues when amendmentType is missing from payload", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";

    expect(resolveStatus(0.9, { entityName: "orders" })).toBe("pending");
  });

  it("queues when amendmentType is not a string", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";

    expect(resolveStatus(0.9, { amendmentType: 42 })).toBe("pending");
  });

  it("queues when amendmentType is null", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";

    expect(resolveStatus(0.9, { amendmentType: null })).toBe("pending");
  });

  it("auto-approves at exact boundary (confidence === threshold)", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description";

    expect(resolveStatus(0.8, { amendmentType: "update_description" })).toBe("approved");
  });
});
