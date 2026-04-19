import { describe, expect, test } from "bun:test";
import { combineMutationErrors } from "../lib/mutation-errors";
import type { FetchError } from "../lib/fetch-error";

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
});
