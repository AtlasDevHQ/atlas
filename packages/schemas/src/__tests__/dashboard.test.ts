import { describe, expect, test } from "bun:test";
import {
  dashboardParameterSchema,
  dashboardParametersSchema,
  dashboardCardKindSchema,
  dashboardTextCardContentSchema,
  dashboardTextCardSchema,
  DASHBOARD_TEXT_CARD_CONTENT_MAX,
} from "../dashboard";

describe("dashboardParameterSchema", () => {
  test("accepts a well-formed date parameter (ISO + relative defaults)", () => {
    expect(
      dashboardParameterSchema.safeParse({ key: "date_from", type: "date", default: "now - 30 days", label: "From" })
        .success,
    ).toBe(true);
    expect(
      dashboardParameterSchema.safeParse({ key: "date_to", type: "date", default: "2026-01-01", label: "To" }).success,
    ).toBe(true);
    expect(
      dashboardParameterSchema.safeParse({ key: "d", type: "date", default: "now()", label: "D" }).success,
    ).toBe(true);
  });

  test("accepts number/text/null defaults of the right type", () => {
    expect(dashboardParameterSchema.safeParse({ key: "n", type: "number", default: 10, label: "N" }).success).toBe(true);
    expect(dashboardParameterSchema.safeParse({ key: "q", type: "text", default: "us", label: "Q" }).success).toBe(true);
    expect(dashboardParameterSchema.safeParse({ key: "q", type: "text", default: null, label: "Q" }).success).toBe(true);
  });

  test("rejects a string default on a number parameter", () => {
    expect(dashboardParameterSchema.safeParse({ key: "n", type: "number", default: "abc", label: "N" }).success).toBe(
      false,
    );
  });

  test("rejects a numeric default on a text parameter", () => {
    expect(dashboardParameterSchema.safeParse({ key: "q", type: "text", default: 42, label: "Q" }).success).toBe(false);
  });

  test("rejects a malformed date default", () => {
    expect(
      dashboardParameterSchema.safeParse({ key: "d", type: "date", default: "last tuesday", label: "D" }).success,
    ).toBe(false);
    expect(dashboardParameterSchema.safeParse({ key: "d", type: "date", default: 42, label: "D" }).success).toBe(false);
  });

  test("rejects a non-identifier key", () => {
    expect(dashboardParameterSchema.safeParse({ key: "Date From", type: "date", default: null, label: "x" }).success).toBe(
      false,
    );
  });
});

describe("dashboardParametersSchema", () => {
  test("rejects duplicate keys", () => {
    const result = dashboardParametersSchema.safeParse([
      { key: "date_from", type: "date", default: "now", label: "A" },
      { key: "date_from", type: "date", default: "now", label: "B" },
    ]);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Text / section cards (#3138)
// ---------------------------------------------------------------------------

describe("dashboardCardKindSchema", () => {
  test("accepts the two card kinds and rejects anything else", () => {
    expect(dashboardCardKindSchema.safeParse("chart").success).toBe(true);
    expect(dashboardCardKindSchema.safeParse("text").success).toBe(true);
    expect(dashboardCardKindSchema.safeParse("kpi").success).toBe(false);
  });
});

describe("dashboardTextCardSchema", () => {
  test("round-trips a well-formed text card", () => {
    const card = { kind: "text" as const, content: "## Top of funnel\n\nLeads → MQLs → SQLs." };
    const parsed = dashboardTextCardSchema.parse(card);
    // Parse is a no-op transform — the validated value equals the input.
    expect(parsed).toEqual(card);
  });

  test("rejects empty content", () => {
    expect(dashboardTextCardContentSchema.safeParse("").success).toBe(false);
    expect(dashboardTextCardSchema.safeParse({ kind: "text", content: "" }).success).toBe(false);
  });

  test("rejects whitespace-only content (would render as a blank band)", () => {
    expect(dashboardTextCardContentSchema.safeParse("   ").success).toBe(false);
    expect(dashboardTextCardContentSchema.safeParse("\n\n\t").success).toBe(false);
  });

  test("rejects content past the length cap", () => {
    const tooLong = "a".repeat(DASHBOARD_TEXT_CARD_CONTENT_MAX + 1);
    expect(dashboardTextCardContentSchema.safeParse(tooLong).success).toBe(false);
  });

  test("rejects the wrong kind literal", () => {
    expect(dashboardTextCardSchema.safeParse({ kind: "chart", content: "x" }).success).toBe(false);
  });
});
