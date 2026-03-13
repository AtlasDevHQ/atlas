import { describe, expect, test } from "bun:test";
import { isActionToolResult } from "./action";

describe("isActionToolResult", () => {
  // ── Valid variants ──────────────────────────────────────────────────

  test("pending_approval with summary", () => {
    expect(
      isActionToolResult({ status: "pending_approval", actionId: "a1", summary: "Do the thing" }),
    ).toBe(true);
  });

  test("approved with result", () => {
    expect(
      isActionToolResult({ status: "approved", actionId: "a2", result: { rows: 5 } }),
    ).toBe(true);
  });

  test("executed with result", () => {
    expect(
      isActionToolResult({ status: "executed", actionId: "a3", result: "ok" }),
    ).toBe(true);
  });

  test("auto_approved with result", () => {
    expect(
      isActionToolResult({ status: "auto_approved", actionId: "a4", result: null }),
    ).toBe(true);
  });

  test("denied without optional reason", () => {
    expect(isActionToolResult({ status: "denied", actionId: "a5" })).toBe(true);
  });

  test("denied with optional reason", () => {
    expect(
      isActionToolResult({ status: "denied", actionId: "a5", reason: "nope" }),
    ).toBe(true);
  });

  test("failed with error", () => {
    expect(
      isActionToolResult({ status: "failed", actionId: "a6", error: "boom" }),
    ).toBe(true);
  });

  test("rolled_back", () => {
    expect(isActionToolResult({ status: "rolled_back", actionId: "a7" })).toBe(true);
  });

  test("timed_out", () => {
    expect(isActionToolResult({ status: "timed_out", actionId: "a8" })).toBe(true);
  });

  // ── Missing variant-specific required fields ────────────────────────

  test("pending_approval missing summary", () => {
    expect(isActionToolResult({ status: "pending_approval", actionId: "a1" })).toBe(false);
  });

  test("approved missing result", () => {
    expect(isActionToolResult({ status: "approved", actionId: "a2" })).toBe(false);
  });

  test("executed missing result", () => {
    expect(isActionToolResult({ status: "executed", actionId: "a3" })).toBe(false);
  });

  test("auto_approved missing result", () => {
    expect(isActionToolResult({ status: "auto_approved", actionId: "a4" })).toBe(false);
  });

  test("failed missing error", () => {
    expect(isActionToolResult({ status: "failed", actionId: "a6" })).toBe(false);
  });

  // ── Wrong types for required fields ─────────────────────────────────

  test("pending_approval with non-string summary", () => {
    expect(
      isActionToolResult({ status: "pending_approval", actionId: "a1", summary: 42 }),
    ).toBe(false);
  });

  test("failed with non-string error", () => {
    expect(
      isActionToolResult({ status: "failed", actionId: "a6", error: true }),
    ).toBe(false);
  });

  // ── Base field validation ───────────────────────────────────────────

  test("missing actionId", () => {
    expect(isActionToolResult({ status: "denied" })).toBe(false);
  });

  test("non-string actionId", () => {
    expect(isActionToolResult({ status: "denied", actionId: 123 })).toBe(false);
  });

  test("empty string actionId", () => {
    expect(isActionToolResult({ status: "denied", actionId: "" })).toBe(false);
  });

  test("invalid status", () => {
    expect(isActionToolResult({ status: "unknown", actionId: "a1" })).toBe(false);
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  test("null", () => {
    expect(isActionToolResult(null)).toBe(false);
  });

  test("undefined", () => {
    expect(isActionToolResult(undefined)).toBe(false);
  });

  test("string", () => {
    expect(isActionToolResult("not an object")).toBe(false);
  });

  test("number", () => {
    expect(isActionToolResult(42)).toBe(false);
  });

  test("empty object", () => {
    expect(isActionToolResult({})).toBe(false);
  });

  test("array", () => {
    expect(isActionToolResult([{ status: "denied", actionId: "a1" }])).toBe(false);
  });

  test("result with undefined value still has key", () => {
    expect(
      isActionToolResult({ status: "approved", actionId: "a2", result: undefined }),
    ).toBe(true);
  });
});
