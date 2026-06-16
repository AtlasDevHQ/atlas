import { describe, it, expect } from "bun:test";
import { formatEntity, type ParsedEntity } from "../search";

// Pure-function tests for the composite-aware index markers (#3634, slice A-2),
// building on the A-1 cardinality-fragment pipeline. They feed in-memory entity
// objects carrying the profiler's per-dimension `indexed`/`index_type`/
// `filter_hint` and entity-level `indexes[]` fields, asserting the prompt text
// `formatEntity` emits in both modes — no YAML loader, no disk.

describe("formatEntity — index markers", () => {
  const entity: ParsedEntity = {
    name: "events",
    table: "events",
    type: "fact_table",
    dimensions: [
      { name: "tenant_id", type: "uuid", indexed: true, index_type: "btree" },
      {
        name: "created_at",
        type: "timestamp",
        indexed: true,
        index_type: "btree",
        filter_hint:
          "Indexed only as a trailing member of composite index events_tenant_created_idx (tenant_id, created_at); filtering on created_at alone is not sargable — also filter on tenant_id to use the index.",
      },
      { name: "body", type: "text", indexed: true, index_type: "gin" },
      { name: "notes", type: "text" }, // not indexed
    ],
    indexes: [
      {
        name: "events_tenant_created_idx",
        columns: ["tenant_id", "created_at"],
        type: "btree",
      },
      {
        name: "events_active",
        columns: ["status"],
        type: "btree",
        predicate: "deleted_at IS NULL",
      },
    ],
  };

  describe("full mode", () => {
    const out = formatEntity(entity, true, null);

    it("marks an independently sargable indexed column 'indexed'", () => {
      expect(out).toContain("- tenant_id (uuid, indexed)");
    });

    it("marks a non-btree index member with its access method", () => {
      expect(out).toContain("- body (text, indexed gin)");
    });

    it("warns that a trailing composite member is not sargable alone", () => {
      expect(out).toContain("created_at (timestamp, indexed (composite — not sargable alone))");
    });

    it("leaves un-indexed columns untouched", () => {
      expect(out).toContain("- notes (text)");
      expect(out).not.toContain("notes (text,");
    });

    it("emits an entity-level indexes block with leading order + partial predicate", () => {
      expect(out).toContain("Indexes (leading column is sargable");
      expect(out).toContain("- events_tenant_created_idx: (tenant_id, created_at) btree");
      expect(out).toContain("- events_active: (status) btree WHERE deleted_at IS NULL (partial");
    });
  });

  describe("summary mode", () => {
    const out = formatEntity(entity, false, null);

    it("lists the leading column of each composite/partial index", () => {
      expect(out).toContain("indexes lead: tenant_id, status");
    });
  });

  it("emits nothing index-related when no dimension is indexed and no indexes[] present", () => {
    const bare: ParsedEntity = {
      table: "plain",
      dimensions: [{ name: "a", type: "text" }],
    };
    const full = formatEntity(bare, true, null);
    expect(full).not.toContain("indexed");
    expect(full).not.toContain("Indexes (");
    expect(formatEntity(bare, false, null)).not.toContain("indexes lead:");
  });
});
