import { describe, expect, test } from "bun:test";
import {
  ALL_STATUSES,
  isActionToolResult,
  RESOLVED_STATUSES,
} from "../lib/action-types";

/* ------------------------------------------------------------------ */
/*  safeStringify (re-implemented — not exported from the component)   */
/* ------------------------------------------------------------------ */

/**
 * Mirror of the safeStringify helper in action-approval-card.tsx.
 * We re-implement it here because the component does not export it.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unable to display]";
  }
}

describe("safeStringify", () => {
  test("normal object stringifies correctly", () => {
    expect(safeStringify({ a: 1, b: "hello" })).toBe(
      JSON.stringify({ a: 1, b: "hello" }, null, 2),
    );
  });

  test("nested object stringifies correctly", () => {
    const obj = { user: { name: "Alice", roles: ["admin", "editor"] } };
    expect(safeStringify(obj)).toBe(JSON.stringify(obj, null, 2));
  });

  test("array stringifies correctly", () => {
    expect(safeStringify([1, 2, 3])).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  test("circular reference returns fallback instead of throwing", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    expect(safeStringify(obj)).toBe("[Unable to display]");
  });

  test("null stringifies to 'null'", () => {
    expect(safeStringify(null)).toBe("null");
  });

  test("undefined returns undefined (JSON.stringify quirk — never called this way in practice)", () => {
    // JSON.stringify(undefined, null, 2) returns undefined at runtime.
    // The component never calls safeStringify(undefined) because it guards with != null.
    const result = safeStringify(undefined);
    expect(result).toBeUndefined();
  });

  test("string stringifies with quotes", () => {
    expect(safeStringify("hello")).toBe('"hello"');
  });

  test("number stringifies correctly", () => {
    expect(safeStringify(42)).toBe("42");
  });

  test("boolean stringifies correctly", () => {
    expect(safeStringify(true)).toBe("true");
  });

  test("empty object stringifies correctly", () => {
    expect(safeStringify({})).toBe("{}");
  });
});

/* ------------------------------------------------------------------ */
/*  Error classification logic                                         */
/* ------------------------------------------------------------------ */

/**
 * Mirror of the error classification in handleApprove / handleDeny.
 * TypeError -> network error message
 * Error    -> err.message
 * other    -> String(err)
 */
function classifyError(err: unknown): string {
  if (err instanceof TypeError) {
    return "Network error \u2014 could not reach the server.";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

describe("error classification", () => {
  test("TypeError produces network error message", () => {
    expect(classifyError(new TypeError("Failed to fetch"))).toBe(
      "Network error \u2014 could not reach the server.",
    );
  });

  test("TypeError with any message still produces the fixed network message", () => {
    expect(classifyError(new TypeError("some other type error"))).toBe(
      "Network error \u2014 could not reach the server.",
    );
  });

  test("standard Error uses err.message", () => {
    expect(classifyError(new Error("Server responded 500: Internal Server Error"))).toBe(
      "Server responded 500: Internal Server Error",
    );
  });

  test("RangeError (Error subclass) uses err.message, not network error", () => {
    expect(classifyError(new RangeError("out of range"))).toBe("out of range");
  });

  test("thrown string uses String(err)", () => {
    expect(classifyError("something broke")).toBe("something broke");
  });

  test("thrown number uses String(err)", () => {
    expect(classifyError(404)).toBe("404");
  });

  test("thrown null uses String(err)", () => {
    expect(classifyError(null)).toBe("null");
  });

  test("thrown undefined uses String(err)", () => {
    expect(classifyError(undefined)).toBe("undefined");
  });

  test("thrown object uses String(err)", () => {
    expect(classifyError({ code: "ERR" })).toBe("[object Object]");
  });
});

/* ------------------------------------------------------------------ */
/*  ALL_STATUSES / RESOLVED_STATUSES / VALID_STATUSES consistency      */
/* ------------------------------------------------------------------ */

describe("status set consistency", () => {
  test("ALL_STATUSES has exactly 8 entries", () => {
    expect(ALL_STATUSES).toHaveLength(8);
  });

  test("RESOLVED_STATUSES has exactly 7 entries (all except pending_approval)", () => {
    expect(RESOLVED_STATUSES.size).toBe(7);
  });

  test("every entry in RESOLVED_STATUSES is a valid ActionDisplayStatus", () => {
    for (const status of RESOLVED_STATUSES) {
      // If it is a valid status, isActionToolResult should accept it
      expect(
        isActionToolResult({ status, actionId: "act_test" }),
      ).toBe(true);
    }
  });

  test("RESOLVED_STATUSES + pending_approval covers the same set as ALL_STATUSES", () => {
    const combined = new Set<string>(RESOLVED_STATUSES);
    combined.add("pending_approval");
    const allSet = new Set<string>(ALL_STATUSES);
    expect(combined).toEqual(allSet);
  });

  test("RESOLVED_STATUSES does not include pending_approval", () => {
    expect(RESOLVED_STATUSES.has("pending_approval")).toBe(false);
  });

  test("ALL_STATUSES contains no duplicates", () => {
    const unique = new Set(ALL_STATUSES);
    expect(unique.size).toBe(ALL_STATUSES.length);
  });
});

/* ------------------------------------------------------------------ */
/*  isActionToolResult edge cases                                       */
/* ------------------------------------------------------------------ */

describe("isActionToolResult edge cases", () => {
  test("object with extra properties passes (permissive)", () => {
    expect(
      isActionToolResult({
        status: "pending_approval",
        actionId: "act_1",
        summary: "Send email",
        details: { to: "bob@example.com" },
        result: { messageId: "msg_1" },
        reason: "User requested",
        error: null,
        extraField: "should be ignored",
        anotherExtra: 42,
      }),
    ).toBe(true);
  });

  test("deeply nested object with valid shape passes", () => {
    expect(
      isActionToolResult({
        status: "executed",
        actionId: "act_deep",
        details: {
          level1: {
            level2: {
              level3: {
                data: [1, 2, 3],
                meta: { nested: true },
              },
            },
          },
        },
        result: {
          response: {
            body: { items: [{ id: 1 }, { id: 2 }] },
          },
        },
      }),
    ).toBe(true);
  });

  test("object with valid status but non-string actionId fails", () => {
    expect(
      isActionToolResult({ status: "approved", actionId: { id: "act_1" } }),
    ).toBe(false);
  });

  test("object with valid actionId but status as number fails", () => {
    expect(
      isActionToolResult({ status: 1, actionId: "act_1" }),
    ).toBe(false);
  });

  test("array is not an action result", () => {
    expect(isActionToolResult([{ status: "approved", actionId: "act_1" }])).toBe(false);
  });

  test("object with empty string actionId passes (type guard only checks typeof)", () => {
    expect(
      isActionToolResult({ status: "approved", actionId: "" }),
    ).toBe(true);
  });

  test("every ALL_STATUSES value produces a valid action result", () => {
    for (const status of ALL_STATUSES) {
      expect(
        isActionToolResult({ status, actionId: `act_${status}` }),
      ).toBe(true);
    }
  });
});
