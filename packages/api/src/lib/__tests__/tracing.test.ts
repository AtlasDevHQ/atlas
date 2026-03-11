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

  test("withSpan calls setResultAttributes on success", async () => {
    const result = await withSpan(
      "test.attrs",
      { initial: "value" },
      async () => ({ rows: [1, 2, 3], columns: ["a", "b"] }),
      (r) => ({ "row_count": r.rows.length, "col_count": r.columns.length }),
    );
    expect(result).toEqual({ rows: [1, 2, 3], columns: ["a", "b"] });
  });

  test("withSpan does not call setResultAttributes on error", async () => {
    let called = false;
    await expect(
      withSpan(
        "test.attrs.error",
        {},
        async () => { throw new Error("boom"); },
        () => { called = true; return {}; },
      ),
    ).rejects.toThrow("boom");
    expect(called).toBe(false);
  });

  test("withSpan works without setResultAttributes (backward compat)", async () => {
    const result = await withSpan("test.compat", {}, async () => "ok");
    expect(result).toBe("ok");
  });
});
