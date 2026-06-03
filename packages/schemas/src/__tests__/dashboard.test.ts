import { describe, expect, test } from "bun:test";
import {
  dashboardParameterSchema,
  dashboardParametersSchema,
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
