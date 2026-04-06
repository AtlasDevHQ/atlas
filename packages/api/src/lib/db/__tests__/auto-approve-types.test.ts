import { describe, it, expect, beforeEach } from "bun:test";
import { getAutoApproveThreshold, getAutoApproveTypes } from "../internal";

describe("getAutoApproveTypes", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES;
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
});

describe("insertSemanticAmendment type eligibility", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD;
    delete process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES;
  });

  it("auto-approves when confidence meets threshold AND type is allowed", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

    const threshold = getAutoApproveThreshold();
    const allowedTypes = getAutoApproveTypes();
    const confidence = 0.9;
    const amendmentType = "update_description";

    const typeEligible = allowedTypes.has(amendmentType);
    const status = confidence >= threshold && typeEligible ? "approved" : "pending";

    expect(threshold).toBe(0.8);
    expect(typeEligible).toBe(true);
    expect(status).toBe("approved");
  });

  it("queues when confidence meets threshold but type is NOT allowed", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

    const threshold = getAutoApproveThreshold();
    const allowedTypes = getAutoApproveTypes();
    const confidence = 0.95;
    const amendmentType = "add_join";

    const typeEligible = allowedTypes.has(amendmentType);
    const status = confidence >= threshold && typeEligible ? "approved" : "pending";

    expect(threshold).toBe(0.8);
    expect(typeEligible).toBe(false);
    expect(status).toBe("pending");
  });

  it("queues when type is allowed but confidence is below threshold", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.8";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "update_description,add_dimension";

    const threshold = getAutoApproveThreshold();
    const allowedTypes = getAutoApproveTypes();
    const confidence = 0.5;
    const amendmentType = "update_description";

    const typeEligible = allowedTypes.has(amendmentType);
    const status = confidence >= threshold && typeEligible ? "approved" : "pending";

    expect(threshold).toBe(0.8);
    expect(typeEligible).toBe(true);
    expect(status).toBe("pending");
  });

  it("queues all types when ATLAS_EXPERT_AUTO_APPROVE_TYPES is empty", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";
    process.env.ATLAS_EXPERT_AUTO_APPROVE_TYPES = "";

    const allowedTypes = getAutoApproveTypes();
    const confidence = 0.9;
    const amendmentType = "update_description";

    const typeEligible = allowedTypes.has(amendmentType);
    const status = confidence >= 0.5 && typeEligible ? "approved" : "pending";

    expect(allowedTypes.size).toBe(0);
    expect(status).toBe("pending");
  });

  it("higher-risk types always queue with default settings", () => {
    process.env.ATLAS_EXPERT_AUTO_APPROVE_THRESHOLD = "0.5";

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
