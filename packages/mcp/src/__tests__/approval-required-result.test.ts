/**
 * #4199 — `approvalRequiredResult` (the ONE validated MCP approval payload
 * builder).
 *
 * Contract test for the approval-resume payload every governance surface
 * emits — `executeSQL`, `runMetric`, `query`, and dispatch-gate gate-4 all
 * consume this builder, so this file pins the shared contract:
 *
 *   1. the payload carries `approval_required: true`, the request id, the
 *      matched rules, and a `message` that always ends with the resume hint
 *      (#3750 — re-call the identical tool once approved);
 *   2. text block and `structuredContent` are built from the same object so
 *      they can never drift (#3498);
 *   3. malformed internal fields (non-string id, non-array rules) are
 *      stripped rather than thrown (#3584 — SDK output-schema validation must
 *      never break the dispatch and lose the approval signal);
 *   4. a null/undefined request id is OMITTED (never `approval_request_id:
 *      null`, which would fail the declared output schemas);
 *   5. the payload validates against every consuming tool's declared
 *      output schema (executeSQL / runMetric / query approval branch).
 */

import { describe, it, expect } from "bun:test";
import {
  approvalRequiredResult,
  MCP_APPROVAL_RESUME_HINT,
  executeSqlOutputSchema,
  runMetricOutputSchema,
  queryOutputSchema,
} from "../structured-output.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text content block");
  }
  return first.text;
}

describe("approvalRequiredResult (#4199)", () => {
  it("builds the full non-error approval payload with the resume hint appended", () => {
    const result = approvalRequiredResult({
      approvalRequestId: "appr_abc123",
      matchedRules: ["PII rule"],
      message: "Approval required. Rule: PII rule.",
    });

    expect(result.isError).toBeUndefined();
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.approval_required).toBe(true);
    expect(body.approval_request_id).toBe("appr_abc123");
    expect(body.matched_rules).toEqual(["PII rule"]);
    expect(body.message).toBe(
      `Approval required. Rule: PII rule. ${MCP_APPROVAL_RESUME_HINT}`,
    );
  });

  it("text block and structuredContent are the same object serialized (#3498)", () => {
    const result = approvalRequiredResult({
      approvalRequestId: "appr_1",
      matchedRules: ["r"],
      message: "m",
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("omits approval_request_id entirely when null/undefined (never a null field)", () => {
    for (const id of [null, undefined]) {
      const result = approvalRequiredResult({
        approvalRequestId: id,
        matchedRules: ["r"],
        message: "m",
      });
      const body = result.structuredContent as Record<string, unknown>;
      expect(body.approval_required).toBe(true);
      expect("approval_request_id" in body).toBe(false);
      expect(textOf(result)).not.toContain("approval_request_id");
    }
  });

  it("strips malformed fields (#3584) instead of throwing, keeping the valid ones", () => {
    const result = approvalRequiredResult({
      // Non-string id — a malformed internal payload from an older gateway.
      approvalRequestId: 12345,
      matchedRules: ["still-valid rule"],
      message: "approval needed",
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.approval_required).toBe(true);
    expect("approval_request_id" in body).toBe(false);
    // The valid matched_rules survive (better than the old per-site fallback,
    // which dropped them wholesale).
    expect(body.matched_rules).toEqual(["still-valid rule"]);
    expect(String(body.message)).toContain(MCP_APPROVAL_RESUME_HINT);

    const nonArrayRules = approvalRequiredResult({
      approvalRequestId: "appr_ok",
      matchedRules: "not-an-array",
      message: "approval needed",
    });
    const body2 = nonArrayRules.structuredContent as Record<string, unknown>;
    expect(body2.approval_required).toBe(true);
    expect(body2.approval_request_id).toBe("appr_ok");
    expect("matched_rules" in body2).toBe(false);
  });

  it("tolerates a missing upstream message — the resume hint is always present", () => {
    const result = approvalRequiredResult({
      approvalRequestId: "appr_1",
      matchedRules: [],
      message: undefined,
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.message).toBe(MCP_APPROVAL_RESUME_HINT);
  });

  it("never double-appends the hint when the upstream message already carries it", () => {
    const already = `parked ${MCP_APPROVAL_RESUME_HINT}`;
    const result = approvalRequiredResult({
      approvalRequestId: "appr_1",
      message: already,
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.message).toBe(already);
  });

  it("carries tool-specific leading fields via `extra` (runMetric id / query answer+sql)", () => {
    const result = approvalRequiredResult({
      approvalRequestId: "appr_1",
      matchedRules: ["r"],
      message: "m",
      extra: { id: "revenue_mtd" },
    });
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.id).toBe("revenue_mtd");
    expect(body.approval_required).toBe(true);
  });

  it("structured: false returns a text-only result (gate-4 tools declare no outputSchema)", () => {
    const result = approvalRequiredResult({
      approvalRequestId: "req_stub",
      matchedRules: ["MCP destructive"],
      message: "This action requires approval before execution.",
      structured: false,
    });
    expect("structuredContent" in result).toBe(false);
    const body = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(body.approval_required).toBe(true);
    expect(body.approval_request_id).toBe("req_stub");
    expect(String(body.message)).toContain(MCP_APPROVAL_RESUME_HINT);
  });

  it("the payload validates against every consuming tool's declared output schema", () => {
    const base = approvalRequiredResult({
      approvalRequestId: "appr_1",
      matchedRules: ["r"],
      message: "m",
    }).structuredContent;
    expect(executeSqlOutputSchema.safeParse(base).success).toBe(true);
    expect(queryOutputSchema.safeParse(base).success).toBe(true);

    const metric = approvalRequiredResult({
      approvalRequestId: "appr_1",
      matchedRules: ["r"],
      message: "m",
      extra: { id: "revenue_mtd" },
    }).structuredContent;
    expect(runMetricOutputSchema.safeParse(metric).success).toBe(true);

    const query = approvalRequiredResult({
      approvalRequestId: "appr_1",
      matchedRules: ["r"],
      message: "m",
      extra: { answer: "parked", sql: ["SELECT 1"] },
    }).structuredContent;
    expect(queryOutputSchema.safeParse(query).success).toBe(true);
  });
});
