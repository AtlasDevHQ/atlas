import { describe, expect, test } from "bun:test";
import { withSpan } from "../tracing";

describe("tracing", () => {
  test("withSpan runs fn and returns result when OTel not initialized", async () => {
    const result = await withSpan("test.span", { key: "value" }, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test("withSpan propagates thrown errors", async () => {
    const error = new Error("test error");
    await expect(
      withSpan("test.error", {}, async () => {
        throw error;
      }),
    ).rejects.toThrow("test error");
  });

  test("withSpan works with async functions", async () => {
    const result = await withSpan("test.async", {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return "async-result";
    });
    expect(result).toBe("async-result");
  });
});
