import { describe, it, expect } from "bun:test";
import { parsePagination, isValidId, MAX_ID_LENGTH, PaginationQuerySchema } from "../routes/shared-schemas";

// Minimal Hono-like context stub for parsePagination
function fakeContext(query: Record<string, string> = {}): Parameters<typeof parsePagination>[0] {
  return { req: { query: (k: string) => query[k] } } as Parameters<typeof parsePagination>[0];
}

// ---------------------------------------------------------------------------
// parsePagination
// ---------------------------------------------------------------------------

describe("parsePagination", () => {
  it("returns defaults when no query params", () => {
    const result = parsePagination(fakeContext());
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  it("returns custom defaults when specified", () => {
    const result = parsePagination(fakeContext(), { limit: 20, maxLimit: 100 });
    expect(result).toEqual({ limit: 20, offset: 0 });
  });

  it("parses valid limit and offset", () => {
    const result = parsePagination(fakeContext({ limit: "25", offset: "10" }));
    expect(result).toEqual({ limit: 25, offset: 10 });
  });

  it("clamps limit to maxLimit", () => {
    const result = parsePagination(fakeContext({ limit: "999" }));
    expect(result.limit).toBe(200);
  });

  it("clamps limit to custom maxLimit", () => {
    const result = parsePagination(fakeContext({ limit: "999" }), { maxLimit: 100 });
    expect(result.limit).toBe(100);
  });

  it("falls back to default for limit=0", () => {
    const result = parsePagination(fakeContext({ limit: "0" }));
    expect(result.limit).toBe(50);
  });

  it("falls back to default for negative limit", () => {
    const result = parsePagination(fakeContext({ limit: "-5" }));
    expect(result.limit).toBe(50);
  });

  it("falls back to default for non-numeric limit", () => {
    const result = parsePagination(fakeContext({ limit: "banana" }));
    expect(result.limit).toBe(50);
  });

  it("falls back to default for NaN limit", () => {
    const result = parsePagination(fakeContext({ limit: "NaN" }));
    expect(result.limit).toBe(50);
  });

  it("falls back to default for Infinity limit", () => {
    const result = parsePagination(fakeContext({ limit: "Infinity" }));
    expect(result.limit).toBe(50); // parseInt("Infinity", 10) → NaN → default
  });

  it("falls back to 0 for negative offset", () => {
    const result = parsePagination(fakeContext({ offset: "-1" }));
    expect(result.offset).toBe(0);
  });

  it("falls back to 0 for non-numeric offset", () => {
    const result = parsePagination(fakeContext({ offset: "xyz" }));
    expect(result.offset).toBe(0);
  });

  it("accepts offset=0", () => {
    const result = parsePagination(fakeContext({ offset: "0" }));
    expect(result.offset).toBe(0);
  });

  it("accepts limit=1 (minimum valid)", () => {
    const result = parsePagination(fakeContext({ limit: "1" }));
    expect(result.limit).toBe(1);
  });

  it("accepts limit equal to maxLimit", () => {
    const result = parsePagination(fakeContext({ limit: "200" }));
    expect(result.limit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// isValidId
// ---------------------------------------------------------------------------

describe("isValidId", () => {
  it("returns true for a normal id", () => {
    expect(isValidId("abc-123")).toBe(true);
  });

  it("returns true for a single character", () => {
    expect(isValidId("x")).toBe(true);
  });

  it("returns true for exactly MAX_ID_LENGTH characters", () => {
    expect(isValidId("a".repeat(MAX_ID_LENGTH))).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isValidId(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidId("")).toBe(false);
  });

  it("returns false for string exceeding MAX_ID_LENGTH", () => {
    expect(isValidId("a".repeat(MAX_ID_LENGTH + 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PaginationQuerySchema
// ---------------------------------------------------------------------------

describe("PaginationQuerySchema", () => {
  it("parses valid values", () => {
    const result = PaginationQuerySchema.parse({ limit: "25", offset: "10" });
    expect(result).toEqual({ limit: 25, offset: 10 });
  });

  it("applies defaults for missing values", () => {
    const result = PaginationQuerySchema.parse({});
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  it("rejects limit below 1", () => {
    expect(() => PaginationQuerySchema.parse({ limit: "0" })).toThrow();
  });

  it("rejects limit above 500", () => {
    expect(() => PaginationQuerySchema.parse({ limit: "501" })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => PaginationQuerySchema.parse({ offset: "-1" })).toThrow();
  });
});
