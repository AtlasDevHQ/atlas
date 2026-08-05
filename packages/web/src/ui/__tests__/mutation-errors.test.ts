import { describe, expect, test } from "bun:test";
import { combineMutationErrors } from "../lib/mutation-errors";
import { serverMessage, type FetchError } from "../lib/fetch-error";

function err(message: string, overrides: Partial<FetchError> = {}): FetchError {
  return { message, ...overrides };
}

describe("combineMutationErrors", () => {
  test("returns null when all slots are empty", () => {
    expect(combineMutationErrors([])).toBeNull();
    expect(combineMutationErrors([null, undefined])).toBeNull();
    expect(combineMutationErrors([null, undefined, err("")])).toBeNull();
  });

  test("returns the single FetchError when only one slot is set", () => {
    const e = err("boom", { status: 500, requestId: "req-1" });
    expect(combineMutationErrors([null, e, undefined])).toEqual(e);
  });

  test("appends a '+N more' suffix when multiple distinct messages are present", () => {
    expect(combineMutationErrors([err("one"), err("two")])?.message).toBe(
      "one (+1 more)",
    );
    expect(
      combineMutationErrors([err("one"), err("two"), err("three")])?.message,
    ).toBe("one (+2 more)");
  });

  test("deduplicates identical messages so the suffix reflects distinct failures", () => {
    expect(combineMutationErrors([err("same"), err("same")])?.message).toBe("same");
    expect(
      combineMutationErrors([err("a"), err("b"), err("a")])?.message,
    ).toBe("a (+1 more)");
  });

  test("skips empty strings and keeps the first real message as primary", () => {
    expect(
      combineMutationErrors([err(""), err("first"), err(""), err("second")])
        ?.message,
    ).toBe("first (+1 more)");
  });

  test("preserves insertion order across the banner", () => {
    expect(
      combineMutationErrors([err("later"), err("earlier")])?.message,
    ).toBe("later (+1 more)");
  });

  test("preserves structured fields from the first distinct error", () => {
    const first = err("gated", {
      status: 403,
      code: "enterprise_required",
      requestId: "req-abc",
    });
    const second = err("other", { status: 500 });
    const combined = combineMutationErrors([first, second]);
    expect(combined).toEqual({
      message: "gated (+1 more)",
      status: 403,
      code: "enterprise_required",
      requestId: "req-abc",
    });
  });

  test("does not decorate a synthesized placeholder into something that reads as server prose (#5068)", () => {
    // `"HTTP 403"` suffixed to `"HTTP 403 (+1 more)"` no longer matches
    // `serverMessage`'s sentinels, so every downstream surface takes it for
    // the server's own words — and since #5068 the gated placeholders render
    // exactly that string as their only line of copy. The combiner is the one
    // place that transforms a message, so it is the one place that has to
    // know. Reachable today from `custom-domain`, `residency`, `cache`,
    // `sandbox` and `email-provider`, all of which combine then gate.
    const combined = combineMutationErrors([
      err("HTTP 403", { status: 403, requestId: "req-x" }),
      err("something else", { status: 500 }),
    ]);
    expect(combined?.message).toBe("Request failed (+1 more)");
    expect(serverMessage(combined!)).toBe("Request failed (+1 more)");
    // The status echo must not survive into the combined message at all.
    expect(combined?.message).not.toContain("HTTP 403");
  });

  test("still builds the suffix onto a REAL server message", () => {
    // The complement — without it the fix above could throw away every
    // message and still pass.
    const combined = combineMutationErrors([
      err("Platform admin role required.", { status: 403 }),
      err("other", { status: 500 }),
    ]);
    expect(combined?.message).toBe("Platform admin role required. (+1 more)");
  });
});
