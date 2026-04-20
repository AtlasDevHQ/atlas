import { describe, expect, test } from "bun:test";
import { ALL_STATUSES, isActionToolResult, RESOLVED_STATUSES } from "../lib/action-types";

/* ------------------------------------------------------------------ */
/*  isActionToolResult                                                  */
/* ------------------------------------------------------------------ */

describe("isActionToolResult", () => {
  test("valid pending result", () => {
    expect(
      isActionToolResult({
        status: "pending",
        actionId: "act_123",
        summary: "Send Slack message to #general",
      }),
    ).toBe(true);
  });

  test("valid executed result", () => {
    expect(
      isActionToolResult({
        status: "executed",
        actionId: "act_456",
        result: { messageId: "msg_789" },
      }),
    ).toBe(true);
  });

  test("valid denied result with reason", () => {
    expect(
      isActionToolResult({
        status: "denied",
        actionId: "act_789",
        reason: "User denied",
      }),
    ).toBe(true);
  });

  test("all valid statuses are accepted", () => {
    const fixtures: Record<string, Record<string, unknown>> = {
      pending: { summary: "Do the thing" },
      approved: { result: "ok" },
      executed: { result: "ok" },
      auto_approved: { result: "ok" },
      failed: { error: "boom" },
      denied: {},
      rolled_back: {},
      timed_out: {},
    };
    for (const [status, extra] of Object.entries(fixtures)) {
      expect(isActionToolResult({ status, actionId: "act_1", ...extra })).toBe(true);
    }
  });

  test("SQL query result (columns + rows) is not an action result", () => {
    expect(
      isActionToolResult({
        success: true,
        columns: ["id", "name"],
        rows: [{ id: 1, name: "Alice" }],
      }),
    ).toBe(false);
  });

  test("null returns false", () => {
    expect(isActionToolResult(null)).toBe(false);
  });

  test("undefined returns false", () => {
    expect(isActionToolResult(undefined)).toBe(false);
  });

  test("string returns false", () => {
    expect(isActionToolResult("pending")).toBe(false);
  });

  test("missing actionId returns false", () => {
    expect(isActionToolResult({ status: "pending" })).toBe(false);
  });

  test("missing status returns false", () => {
    expect(isActionToolResult({ actionId: "act_1" })).toBe(false);
  });

  test("invalid status returns false", () => {
    expect(isActionToolResult({ status: "unknown_status", actionId: "act_1" })).toBe(false);
  });

  test("numeric actionId returns false", () => {
    expect(isActionToolResult({ status: "pending", actionId: 123 })).toBe(false);
  });

  test("empty object returns false", () => {
    expect(isActionToolResult({})).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  RESOLVED_STATUSES                                                   */
/* ------------------------------------------------------------------ */

describe("ALL_STATUSES", () => {
  test("has exactly 8 entries", () => {
    expect(ALL_STATUSES).toHaveLength(8);
  });

  test("includes pending and all resolved statuses", () => {
    expect(ALL_STATUSES).toContain("pending");
    for (const s of RESOLVED_STATUSES) {
      expect(ALL_STATUSES).toContain(s);
    }
  });
});

describe("RESOLVED_STATUSES", () => {
  test("does not include pending", () => {
    expect(RESOLVED_STATUSES.has("pending")).toBe(false);
  });

  test("includes all terminal statuses", () => {
    expect(RESOLVED_STATUSES.has("approved")).toBe(true);
    expect(RESOLVED_STATUSES.has("executed")).toBe(true);
    expect(RESOLVED_STATUSES.has("auto_approved")).toBe(true);
    expect(RESOLVED_STATUSES.has("denied")).toBe(true);
    expect(RESOLVED_STATUSES.has("failed")).toBe(true);
    expect(RESOLVED_STATUSES.has("rolled_back")).toBe(true);
    expect(RESOLVED_STATUSES.has("timed_out")).toBe(true);
  });

  test("has exactly 7 entries", () => {
    expect(RESOLVED_STATUSES.size).toBe(7);
  });

  test("is exactly ALL_STATUSES minus pending", () => {
    expect(RESOLVED_STATUSES.size).toBe(ALL_STATUSES.length - 1);
  });
});
