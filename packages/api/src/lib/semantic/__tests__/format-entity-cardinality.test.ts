import { describe, it, expect } from "bun:test";
import { formatEntity, type ParsedEntity } from "../search";

// Pure-function tests for the column-cardinality markers (#3630). They feed
// in-memory entity objects carrying the profiler's `unique_count` / `null_count`
// fields and assert the prompt text `formatEntity` emits in both modes — no YAML
// loader, no disk.

describe("formatEntity — cardinality markers", () => {
  const entity: ParsedEntity = {
    name: "orders",
    table: "orders",
    type: "fact_table",
    dimensions: [
      { name: "id", type: "uuid", primary_key: true, unique_count: 1000, null_count: 0 },
      { name: "status", type: "text", unique_count: 6, null_count: 0, description: "order status" },
      { name: "region", type: "text", unique_count: 50, null_count: 12 },
      // No profiled stats — must render exactly as before.
      { name: "notes", type: "text" },
    ],
  };

  describe("full mode", () => {
    const out = formatEntity(entity, true, null);

    it("emits distinct + null-free marker inside the type parenthetical", () => {
      expect(out).toContain("- status (text, ~6 distinct, no nulls) — order status");
    });

    it("reports a non-zero null count as an absolute count", () => {
      expect(out).toContain("- region (text, ~50 distinct, 12 null)");
    });

    it("keeps the PK marker alongside the cardinality fragments", () => {
      expect(out).toContain("- id (uuid PK, ~1000 distinct, no nulls)");
    });

    it("leaves columns without profiled stats untouched", () => {
      expect(out).toContain("- notes (text)");
      expect(out).not.toContain("notes (text,");
    });
  });

  describe("summary mode", () => {
    const out = formatEntity(entity, false, null);

    it("emits a compact distinct-count form for profiled real columns", () => {
      expect(out).toContain("cardinality: id(~1000), status(~6), region(~50)");
    });

    it("does not list unprofiled columns in the compact form", () => {
      expect(out).not.toContain("notes(~");
    });
  });

  it("omits the cardinality marker entirely when no dimension is profiled", () => {
    const bare: ParsedEntity = {
      table: "plain",
      dimensions: [{ name: "a", type: "text" }, { name: "b", type: "int" }],
    };
    expect(formatEntity(bare, true, null)).toContain("- a (text)");
    expect(formatEntity(bare, false, null)).not.toContain("cardinality:");
  });

  it("caps the compact summary form and reports the overflow count", () => {
    const wide: ParsedEntity = {
      table: "wide",
      dimensions: Array.from({ length: 10 }, (_, i) => ({
        name: `c${i}`,
        type: "text",
        unique_count: i,
      })),
    };
    const out = formatEntity(wide, false, null);
    expect(out).toContain("c0(~0)");
    expect(out).toContain("c7(~7)");
    // 10 profiled columns, cap of 8 → 2 hidden.
    expect(out).toContain("+2 more");
    expect(out).not.toContain("c8(~8)");
  });
});
