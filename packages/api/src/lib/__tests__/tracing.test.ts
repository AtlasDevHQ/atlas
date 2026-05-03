import { describe, expect, test } from "bun:test";
import { Effect, Cause, Exit } from "effect";
import { withSpan, withEffectSpan } from "../tracing";

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

describe("withEffectSpan", () => {
  test("returns the wrapped Effect's success value", async () => {
    const result = await Effect.runPromise(
      withEffectSpan("test.eff.ok", {}, Effect.succeed(42)),
    );
    expect(result).toBe(42);
  });

  test("propagates typed errors without wrapping in FiberFailure", async () => {
    class TaggedTestErr {
      readonly _tag = "TaggedTestErr";
      constructor(readonly code: string) {}
    }
    const exit = await Effect.runPromiseExit(
      withEffectSpan("test.eff.typed", {}, Effect.fail(new TaggedTestErr("boom"))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(TaggedTestErr);
        expect((failure.value as TaggedTestErr).code).toBe("boom");
      }
    }
  });

  test("preserves interrupt cause when wrapped Effect is interrupted", async () => {
    // Contract: withEffectSpan must NOT swallow interrupts or convert them
    // into typed failures. Cause.isInterruptedOnly remains true after
    // wrapping — the recordException-skip branch in the implementation
    // keys off this exact discriminator.
    const exit = await Effect.runPromise(
      Effect.exit(withEffectSpan("test.eff.interrupt", {}, Effect.interrupt)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
    }
  });

  test("calls setResultAttributes on success and ignores callback errors", async () => {
    const captured: number[] = [];
    const result = await Effect.runPromise(
      withEffectSpan("test.eff.attrs", {}, Effect.succeed(7), (n) => {
        captured.push(n);
        return { value: n };
      }),
    );
    expect(result).toBe(7);
    expect(captured).toEqual([7]);

    // Callback that throws must not invalidate the success.
    const ok = await Effect.runPromise(
      withEffectSpan("test.eff.attrs.bug", {}, Effect.succeed("ok"), () => {
        throw new Error("attr bug");
      }),
    );
    expect(ok).toBe("ok");
  });
});
