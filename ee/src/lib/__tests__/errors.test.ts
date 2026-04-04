import { describe, expect, test } from "bun:test";
import { EEError } from "../errors";

// ── Test subclass (mirrors the pattern used across all EE modules) ──

type TestErrorCode = "not_found" | "conflict" | "validation";

class TestError extends EEError<TestErrorCode> {
  readonly name = "TestError";
}

// ── Tests ───────────────────────────────────────────────────────────

describe("EEError base class", () => {
  test("sets message, code, and name", () => {
    const err = new TestError("thing not found", "not_found");
    expect(err.message).toBe("thing not found");
    expect(err.code).toBe("not_found");
    expect(err.name).toBe("TestError");
  });

  test("instanceof Error", () => {
    const err = new TestError("oops", "conflict");
    expect(err).toBeInstanceOf(Error);
  });

  test("instanceof EEError", () => {
    const err = new TestError("oops", "validation");
    expect(err).toBeInstanceOf(EEError);
  });

  test("instanceof the specific subclass", () => {
    const err = new TestError("oops", "not_found");
    expect(err).toBeInstanceOf(TestError);
  });

  test("different subclasses are not instanceof each other", () => {
    class OtherError extends EEError<"other"> {
      readonly name = "OtherError";
    }
    const test1 = new TestError("a", "not_found");
    const other = new OtherError("b", "other");
    expect(test1).not.toBeInstanceOf(OtherError);
    expect(other).not.toBeInstanceOf(TestError);
  });

  test("stack trace is captured", () => {
    const err = new TestError("trace me", "conflict");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("trace me");
  });
});
