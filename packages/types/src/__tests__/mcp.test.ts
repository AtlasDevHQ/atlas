import { describe, expect, test } from "bun:test";
import {
  ATLAS_MCP_TOOL_ERROR_CODES,
  isAtlasMcpToolErrorCode,
  parseAtlasMcpToolError,
  type AtlasMcpToolError,
  type AtlasMcpToolErrorCode,
} from "../index";

describe("AtlasMcpToolErrorCode catalog", () => {
  test("union and runtime list stay in lockstep", () => {
    // satisfies + readonly array force the union to match the literal at
    // compile time; the test pins the size at 8 so accidentally widening
    // the union (e.g. adding "auth_failed" without updating consumers) is
    // caught here too.
    expect(ATLAS_MCP_TOOL_ERROR_CODES).toHaveLength(8);
    const set = new Set<AtlasMcpToolErrorCode>(ATLAS_MCP_TOOL_ERROR_CODES);
    expect(set.size).toBe(ATLAS_MCP_TOOL_ERROR_CODES.length);
  });

  test("isAtlasMcpToolErrorCode accepts each catalog entry", () => {
    for (const code of ATLAS_MCP_TOOL_ERROR_CODES) {
      expect(isAtlasMcpToolErrorCode(code)).toBe(true);
    }
  });

  test("isAtlasMcpToolErrorCode rejects unknown strings", () => {
    expect(isAtlasMcpToolErrorCode("not_a_code")).toBe(false);
    expect(isAtlasMcpToolErrorCode("")).toBe(false);
    expect(isAtlasMcpToolErrorCode("AMBIGUOUS_TERM")).toBe(false);
  });
});

describe("parseAtlasMcpToolError", () => {
  test("parses a minimal envelope", () => {
    const env: AtlasMcpToolError = { code: "unknown_metric", message: "no such metric" };
    const parsed = parseAtlasMcpToolError(env);
    expect(parsed).toEqual(env);
  });

  test("parses a JSON string payload (the on-the-wire form)", () => {
    const wire = JSON.stringify({ code: "rate_limited", message: "slow down", retry_after: 30 });
    const parsed = parseAtlasMcpToolError(wire);
    expect(parsed).toEqual({ code: "rate_limited", message: "slow down", retry_after: 30 });
  });

  test("preserves hint, request_id, retry_after when present", () => {
    const env = {
      code: "internal_error" as const,
      message: "boom",
      hint: "try again later",
      request_id: "req_abc",
      retry_after: 5,
    };
    expect(parseAtlasMcpToolError(env)).toEqual(env);
  });

  test("drops optional fields with the wrong type rather than rejecting the whole frame", () => {
    const parsed = parseAtlasMcpToolError({
      code: "internal_error",
      message: "boom",
      hint: 123,
      request_id: false,
      retry_after: "ten",
    });
    expect(parsed).toEqual({ code: "internal_error", message: "boom" });
  });

  test("returns null on an unknown code (closed catalog)", () => {
    expect(parseAtlasMcpToolError({ code: "wat", message: "huh" })).toBeNull();
  });

  test("returns null when message is missing", () => {
    expect(parseAtlasMcpToolError({ code: "validation_failed" })).toBeNull();
  });

  test("returns null on malformed JSON string", () => {
    expect(parseAtlasMcpToolError("{not json")).toBeNull();
  });

  test("returns null on non-object inputs", () => {
    expect(parseAtlasMcpToolError(null)).toBeNull();
    expect(parseAtlasMcpToolError(undefined)).toBeNull();
    expect(parseAtlasMcpToolError(42)).toBeNull();
    expect(parseAtlasMcpToolError([])).toBeNull();
  });
});
