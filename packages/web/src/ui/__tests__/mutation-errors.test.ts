import { describe, expect, test } from "bun:test";
import { combineMutationErrors } from "../lib/mutation-errors";

describe("combineMutationErrors", () => {
  test("returns null when all slots are empty", () => {
    expect(combineMutationErrors([])).toBeNull();
    expect(combineMutationErrors([null, undefined])).toBeNull();
    expect(combineMutationErrors([null, undefined, ""])).toBeNull();
  });

  test("returns the single message when only one slot is set", () => {
    expect(combineMutationErrors([null, "boom", undefined])).toBe("boom");
  });

  test("appends a '+N more' suffix when multiple distinct messages are present", () => {
    expect(combineMutationErrors(["one", "two"])).toBe("one (+1 more)");
    expect(combineMutationErrors(["one", "two", "three"])).toBe("one (+2 more)");
  });

  test("deduplicates identical messages so the suffix reflects distinct failures", () => {
    expect(combineMutationErrors(["same", "same"])).toBe("same");
    expect(combineMutationErrors(["a", "b", "a"])).toBe("a (+1 more)");
  });

  test("skips empty strings and keeps the first real message as primary", () => {
    expect(combineMutationErrors(["", "first", "", "second"])).toBe(
      "first (+1 more)",
    );
  });

  test("preserves insertion order across the banner", () => {
    expect(combineMutationErrors(["later", "earlier"])).toBe("later (+1 more)");
  });
});
