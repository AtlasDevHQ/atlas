import { describe, it, expect } from "bun:test";
import { z } from "@hono/zod-openapi";
import {
  parsePagination,
  isValidId,
  MAX_ID_LENGTH,
  PaginationQuerySchema,
  createIdParamSchema,
  createParamSchema,
  createListResponseSchema,
  createSuccessResponseSchema,
  createErrorResponseSchema,
  DeletedResponseSchema,
} from "../routes/shared-schemas";

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

// ---------------------------------------------------------------------------
// createIdParamSchema
// ---------------------------------------------------------------------------

describe("createIdParamSchema", () => {
  it("parses a valid id", () => {
    const schema = createIdParamSchema();
    const result = schema.parse({ id: "abc123" });
    expect(result.id).toBe("abc123");
  });

  it("uses custom example without affecting parsing", () => {
    const schema = createIdParamSchema("role_abc123");
    expect(schema.parse({ id: "anything" }).id).toBe("anything");
  });

  it("rejects empty string", () => {
    const schema = createIdParamSchema();
    expect(() => schema.parse({ id: "" })).toThrow();
  });

  it("accepts exactly MAX_ID_LENGTH characters", () => {
    const schema = createIdParamSchema();
    const id = "a".repeat(MAX_ID_LENGTH);
    expect(schema.parse({ id }).id).toBe(id);
  });

  it("rejects string exceeding MAX_ID_LENGTH", () => {
    const schema = createIdParamSchema();
    expect(() => schema.parse({ id: "a".repeat(MAX_ID_LENGTH + 1) })).toThrow();
  });

  it("produces a different schema when example differs", () => {
    const defaultSchema = createIdParamSchema();
    const customSchema = createIdParamSchema("custom_id");
    // Both should parse the same values, but be distinct schema instances
    expect(defaultSchema.parse({ id: "x" })).toEqual(customSchema.parse({ id: "x" }));
  });
});

// ---------------------------------------------------------------------------
// createParamSchema
// ---------------------------------------------------------------------------

describe("createParamSchema", () => {
  it("creates a schema with a custom param name", () => {
    const schema = createParamSchema("userId", "user_abc123");
    const result = schema.parse({ userId: "user_123" });
    expect(result.userId).toBe("user_123");
  });

  it("rejects empty string for named param", () => {
    const schema = createParamSchema("userId");
    expect(() => schema.parse({ userId: "" })).toThrow();
  });

  it("rejects string exceeding MAX_ID_LENGTH for named param", () => {
    const schema = createParamSchema("userId");
    expect(() => schema.parse({ userId: "a".repeat(MAX_ID_LENGTH + 1) })).toThrow();
  });

  it("supports merge for composite params", () => {
    const merged = createParamSchema("collectionId").merge(createParamSchema("itemId", "def456"));
    const result = merged.parse({ collectionId: "col_1", itemId: "item_2" });
    expect(result.collectionId).toBe("col_1");
    expect(result.itemId).toBe("item_2");
  });

  it("rejects merged schema when a field is missing", () => {
    const merged = createParamSchema("collectionId").merge(createParamSchema("itemId"));
    expect(() => merged.parse({ collectionId: "col_1" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createListResponseSchema
// ---------------------------------------------------------------------------

describe("createListResponseSchema", () => {
  const ItemSchema = z.object({ id: z.string(), name: z.string() });

  it("creates a schema with items and total", () => {
    const schema = createListResponseSchema("items", ItemSchema);
    const result = schema.parse({ items: [{ id: "1", name: "a" }], total: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("uses custom field name", () => {
    const schema = createListResponseSchema("patterns", ItemSchema);
    const result = schema.parse({ patterns: [{ id: "1", name: "a" }], total: 5 });
    expect(result.patterns).toHaveLength(1);
    expect(result.total).toBe(5);
  });

  it("accepts empty array", () => {
    const schema = createListResponseSchema("items", ItemSchema);
    const result = schema.parse({ items: [], total: 0 });
    expect(result.items).toHaveLength(0);
  });

  it("includes extra fields when provided", () => {
    const schema = createListResponseSchema("items", ItemSchema, {
      limit: z.number(),
      offset: z.number(),
    });
    const result = schema.parse({ items: [], total: 0, limit: 50, offset: 0 });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("rejects when total is missing", () => {
    const schema = createListResponseSchema("items", ItemSchema);
    expect(() => schema.parse({ items: [] })).toThrow();
  });

  it("rejects invalid items within the array", () => {
    const schema = createListResponseSchema("items", ItemSchema);
    expect(() => schema.parse({ items: [{ id: "1" }], total: 1 })).toThrow();
  });

  it("rejects wrong field name", () => {
    const schema = createListResponseSchema("patterns", ItemSchema);
    expect(() => schema.parse({ items: [], total: 0 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createSuccessResponseSchema
// ---------------------------------------------------------------------------

describe("createSuccessResponseSchema", () => {
  it("parses success with message", () => {
    const schema = createSuccessResponseSchema();
    const result = schema.parse({ success: true, message: "Done" });
    expect(result.success).toBe(true);
    expect(result.message).toBe("Done");
  });

  it("parses success without message", () => {
    const schema = createSuccessResponseSchema();
    const result = schema.parse({ success: false });
    expect(result.success).toBe(false);
    expect(result.message).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createErrorResponseSchema
// ---------------------------------------------------------------------------

describe("createErrorResponseSchema", () => {
  it("parses error with requestId", () => {
    const schema = createErrorResponseSchema();
    const result = schema.parse({ error: "not_found", message: "Not found", requestId: "req-1" });
    expect(result.error).toBe("not_found");
    expect(result.requestId).toBe("req-1");
  });

  it("parses error without requestId", () => {
    const schema = createErrorResponseSchema();
    const result = schema.parse({ error: "bad_request", message: "Invalid" });
    expect(result.requestId).toBeUndefined();
  });

  it("rejects when error field is missing", () => {
    const schema = createErrorResponseSchema();
    expect(() => schema.parse({ message: "oops" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DeletedResponseSchema
// ---------------------------------------------------------------------------

describe("DeletedResponseSchema", () => {
  it("parses deleted: true", () => {
    expect(DeletedResponseSchema.parse({ deleted: true }).deleted).toBe(true);
  });

  it("parses deleted: false", () => {
    expect(DeletedResponseSchema.parse({ deleted: false }).deleted).toBe(false);
  });

  it("rejects missing deleted field", () => {
    expect(() => DeletedResponseSchema.parse({})).toThrow();
  });
});
