import { describe, expect, test, mock } from "bun:test";
import { coerceRollbackWarning, logUnsurfacedRollbackWarning } from "../rollback-warning";

describe("coerceRollbackWarning", () => {
  test("returns null for null/undefined", () => {
    expect(coerceRollbackWarning(null)).toBeNull();
    expect(coerceRollbackWarning(undefined)).toBeNull();
  });

  test("returns trimmed string when non-empty", () => {
    expect(coerceRollbackWarning("rollback may not have reversed")).toBe(
      "rollback may not have reversed",
    );
    expect(coerceRollbackWarning("  padded  ")).toBe("padded");
  });

  test("returns null for empty / whitespace-only string", () => {
    expect(coerceRollbackWarning("")).toBeNull();
    expect(coerceRollbackWarning("   ")).toBeNull();
  });

  test("extracts .message from an object shape", () => {
    expect(
      coerceRollbackWarning({ code: "partial_reversal", message: "external API has no undo" }),
    ).toBe("external API has no undo");
  });

  test("returns fallback when object has no usable message", () => {
    expect(coerceRollbackWarning({ code: "x" })).toContain("unrecognized shape");
    expect(coerceRollbackWarning({ message: 42 })).toContain("unrecognized shape");
    expect(coerceRollbackWarning({ message: "   " })).toContain("unrecognized shape");
  });

  test("returns fallback for arrays", () => {
    expect(coerceRollbackWarning(["a", "b"])).toContain("unrecognized shape");
  });

  test("returns fallback for primitives that aren't strings", () => {
    expect(coerceRollbackWarning(42)).toContain("unrecognized shape");
    expect(coerceRollbackWarning(true)).toContain("unrecognized shape");
  });

  test("never returns empty string for non-null input", () => {
    // Compliance contract: if the server said "warning", the operator must
    // see something in the banner. Returning "" would hide the signal.
    const inputs = [{}, [], 0, false, { message: "" }];
    for (const input of inputs) {
      const result = coerceRollbackWarning(input);
      expect(result === null || (typeof result === "string" && result.length > 0)).toBe(true);
    }
  });
});

describe("logUnsurfacedRollbackWarning", () => {
  test("does not log null / undefined (no warning to drift)", () => {
    const logger = mock(() => {});
    logUnsurfacedRollbackWarning(null, logger);
    logUnsurfacedRollbackWarning(undefined, logger);
    expect(logger).not.toHaveBeenCalled();
  });

  test("does not log well-formed non-empty strings (surfaced verbatim)", () => {
    const logger = mock(() => {});
    logUnsurfacedRollbackWarning("rollback may not have reversed", logger);
    expect(logger).not.toHaveBeenCalled();
  });

  test("logs non-string shapes with the raw value (schema-drift signal)", () => {
    const logger = mock(() => {});
    logUnsurfacedRollbackWarning({ code: "partial", message: "x" }, logger);
    expect(logger).toHaveBeenCalledTimes(1);
    const [msg, value] = logger.mock.calls[0] ?? [];
    expect(msg).toBe("handleRollback: non-string warning shape");
    expect(value).toEqual({ code: "partial", message: "x" });
  });

  test("logs blank strings separately from non-string shapes", () => {
    const logger = mock(() => {});
    logUnsurfacedRollbackWarning("   ", logger);
    logUnsurfacedRollbackWarning("", logger);
    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls.every((call) => call[0] === "handleRollback: blank warning string")).toBe(true);
  });

  test("logs arrays as non-string shape (not blank string)", () => {
    const logger = mock(() => {});
    logUnsurfacedRollbackWarning(["a", "b"], logger);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]?.[0]).toBe("handleRollback: non-string warning shape");
  });
});
