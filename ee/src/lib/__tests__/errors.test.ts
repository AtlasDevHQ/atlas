import { describe, expect, test } from "bun:test";
import { Data, Effect, Equal, Exit } from "effect";

// ── Test subclass (mirrors the pattern used by all EE modules) ──

type TestErrorCode = "not_found" | "conflict" | "validation";

class TestError extends Data.TaggedError("TestError")<{
  message: string;
  code: TestErrorCode;
}> {}

// ── Tests ───────────────────────────────────────────────────────

describe("EE Data.TaggedError pattern", () => {
  test("sets message, code, and _tag", () => {
    const err = new TestError({ message: "thing not found", code: "not_found" });
    expect(err.message).toBe("thing not found");
    expect(err.code).toBe("not_found");
    expect(err._tag).toBe("TestError");
  });

  test("name matches tag", () => {
    const err = new TestError({ message: "oops", code: "conflict" });
    expect(err.name).toBe("TestError");
  });

  test("instanceof Error", () => {
    const err = new TestError({ message: "oops", code: "conflict" });
    expect(err).toBeInstanceOf(Error);
  });

  test("instanceof the specific subclass", () => {
    const err = new TestError({ message: "oops", code: "not_found" });
    expect(err).toBeInstanceOf(TestError);
  });

  test("different subclasses are not instanceof each other", () => {
    class OtherError extends Data.TaggedError("OtherError")<{
      message: string;
      code: "other";
    }> {}
    const test1 = new TestError({ message: "a", code: "not_found" });
    const other = new OtherError({ message: "b", code: "other" });
    expect(test1).not.toBeInstanceOf(OtherError);
    expect(other).not.toBeInstanceOf(TestError);
  });

  test("stack trace is captured", () => {
    const err = new TestError({ message: "trace me", code: "conflict" });
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("trace me");
  });

  test("structural equality (same code + message)", () => {
    const a = new TestError({ message: "same", code: "validation" });
    const b = new TestError({ message: "same", code: "validation" });
    expect(Equal.equals(a, b)).toBe(true);
  });

  test("structural equality ignores message (Effect behavior)", () => {
    const a = new TestError({ message: "one", code: "validation" });
    const b = new TestError({ message: "two", code: "validation" });
    // Data.TaggedError: message is non-enumerable, so Equal.equals ignores it
    expect(Equal.equals(a, b)).toBe(true);
  });

  test("structural inequality when code differs", () => {
    const a = new TestError({ message: "same", code: "validation" });
    const b = new TestError({ message: "same", code: "not_found" });
    expect(Equal.equals(a, b)).toBe(false);
  });

  test("Effect.catchTag catches by _tag", async () => {
    const program = Effect.fail(new TestError({ message: "oops", code: "not_found" })).pipe(
      Effect.catchTag("TestError", (err) => Effect.succeed(`caught: ${err.code}`)),
    );
    const result = await Effect.runPromise(program);
    expect(result).toBe("caught: not_found");
  });

  test("Effect.catchTag does not catch non-matching tag", async () => {
    class OtherError extends Data.TaggedError("OtherError")<{
      message: string;
      code: "other";
    }> {}
    // Widen error type so catchTag accepts "OtherError" as a valid branch
    const fail: Effect.Effect<string, TestError | OtherError> = Effect.fail(
      new TestError({ message: "oops", code: "not_found" }),
    );
    const program = fail.pipe(
      Effect.catchTag("OtherError", () => Effect.succeed("should not reach")),
    );
    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
