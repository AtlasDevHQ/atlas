/**
 * Pure-function coverage for index awareness (#3634, slice A-2):
 *
 *  - `deriveColumnIndexFlags` — index grouping + leading-vs-trailing derivation
 *    over fixture catalog rows (no DB).
 *  - `generateEntityYAML` — per-dimension `indexed`/`index_type`, entity-level
 *    `indexes[]`, and `filter_hint` for non-sargable (trailing) dimensions.
 *
 * The real-Postgres/real-MySQL harvest coverage lives in
 * `lib/__tests__/profiler-index-harvest-pg.test.ts` (gated on DB env vars).
 */
import { describe, it, expect } from "bun:test";
import * as yaml from "js-yaml";
import {
  analyzeTableProfiles,
  deriveColumnIndexFlags,
  isCompositeOrPartialIndex,
} from "../analyze";
import { generateEntityYAML } from "../yaml";
import type { ColumnProfile, IndexProfile, TableProfile } from "@useatlas/types";

function col(name: string, overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    name,
    type: "text",
    nullable: true,
    unique_count: null,
    null_count: null,
    sample_values: [],
    is_primary_key: false,
    is_foreign_key: false,
    fk_target_table: null,
    fk_target_column: null,
    is_enum_like: false,
    profiler_notes: [],
    ...overrides,
  };
}

function table(
  name: string,
  columns: ColumnProfile[],
  indexes: IndexProfile[],
): TableProfile {
  return {
    table_name: name,
    object_type: "table",
    row_count: 100,
    columns,
    primary_key_columns: columns.filter((c) => c.is_primary_key).map((c) => c.name),
    foreign_keys: [],
    inferred_foreign_keys: [],
    indexes,
    profiler_notes: [],
    table_flags: { possibly_abandoned: false, possibly_denormalized: false },
  };
}

const idx = (over: Partial<IndexProfile> & Pick<IndexProfile, "name" | "columns">): IndexProfile => ({
  index_type: "btree",
  is_unique: false,
  is_primary: false,
  is_partial: false,
  predicate: null,
  ...over,
});

describe("deriveColumnIndexFlags — leading vs trailing", () => {
  it("flags a single-column btree index member as leading/sargable", () => {
    const t = table("orders", [col("id", { is_primary_key: true }), col("status")], [
      idx({ name: "orders_status_idx", columns: ["status"] }),
    ]);
    deriveColumnIndexFlags([t]);
    const status = t.columns.find((c) => c.name === "status")!;
    expect(status.indexed).toBe(true);
    expect(status.index_position).toBe("leading");
  });

  it("marks the leading column of a composite btree leading and the rest trailing", () => {
    const t = table(
      "events",
      [col("tenant_id"), col("created_at"), col("kind")],
      [idx({ name: "events_tenant_created_idx", columns: ["tenant_id", "created_at"] })],
    );
    deriveColumnIndexFlags([t]);
    const tenant = t.columns.find((c) => c.name === "tenant_id")!;
    const created = t.columns.find((c) => c.name === "created_at")!;
    const kind = t.columns.find((c) => c.name === "kind")!;
    expect(tenant.indexed).toBe(true);
    expect(tenant.index_position).toBe("leading");
    expect(created.indexed).toBe(true);
    expect(created.index_position).toBe("trailing"); // only a trailing btree member
    expect(kind.indexed).toBeUndefined(); // not in any index
  });

  it("promotes a column to leading if it leads ANY index even when trailing in another", () => {
    const t = table(
      "events",
      [col("a"), col("b")],
      [
        idx({ name: "ab_idx", columns: ["a", "b"] }),
        idx({ name: "b_idx", columns: ["b"] }),
      ],
    );
    deriveColumnIndexFlags([t]);
    expect(t.columns.find((c) => c.name === "b")!.index_position).toBe("leading");
  });

  it("treats every member of a non-btree (GIN) index as leading regardless of position", () => {
    const t = table(
      "docs",
      [col("title"), col("body")],
      [idx({ name: "docs_gin", columns: ["title", "body"], index_type: "gin" })],
    );
    deriveColumnIndexFlags([t]);
    expect(t.columns.find((c) => c.name === "title")!.index_position).toBe("leading");
    expect(t.columns.find((c) => c.name === "body")!.index_position).toBe("leading");
  });

  it("attributes an expression-index member to the single column it wraps", () => {
    const t = table("users", [col("email")], [
      idx({ name: "users_lower_email_idx", columns: ["lower(email)"] }),
    ]);
    deriveColumnIndexFlags([t]);
    const email = t.columns.find((c) => c.name === "email")!;
    expect(email.indexed).toBe(true);
    expect(email.index_position).toBe("leading");
  });

  it("does not flag an expression member that references multiple columns", () => {
    const t = table("users", [col("first"), col("last")], [
      idx({ name: "users_full", columns: ["(first || last)"] }),
    ]);
    deriveColumnIndexFlags([t]);
    expect(t.columns.find((c) => c.name === "first")!.indexed).toBeUndefined();
    expect(t.columns.find((c) => c.name === "last")!.indexed).toBeUndefined();
  });

  it("is a no-op for tables without harvested indexes", () => {
    const t = table("plain", [col("x")], []);
    deriveColumnIndexFlags([t]);
    expect(t.columns[0].indexed).toBeUndefined();
  });
});

describe("analyzeTableProfiles wires in the derivation", () => {
  it("derives flags on the analyzed clone without mutating input", () => {
    const input = table("t", [col("a"), col("b")], [
      idx({ name: "ab", columns: ["a", "b"] }),
    ]);
    const [out] = analyzeTableProfiles([input]);
    expect(out.columns.find((c) => c.name === "a")!.index_position).toBe("leading");
    expect(out.columns.find((c) => c.name === "b")!.index_position).toBe("trailing");
    // Input untouched (analyze clones).
    expect(input.columns.find((c) => c.name === "a")!.indexed).toBeUndefined();
  });
});

describe("isCompositeOrPartialIndex", () => {
  it("keeps composite and partial indexes, drops single-column non-partial", () => {
    expect(isCompositeOrPartialIndex(idx({ name: "c", columns: ["a", "b"] }))).toBe(true);
    expect(
      isCompositeOrPartialIndex(
        idx({ name: "p", columns: ["a"], is_partial: true, predicate: "deleted_at IS NULL" }),
      ),
    ).toBe(true);
    expect(isCompositeOrPartialIndex(idx({ name: "s", columns: ["a"] }))).toBe(false);
  });
});

describe("generateEntityYAML — index awareness emission", () => {
  function parse(t: TableProfile): Record<string, unknown> {
    const [analyzed] = analyzeTableProfiles([t]);
    return yaml.load(generateEntityYAML(analyzed, [analyzed], "postgres")) as Record<string, unknown>;
  }

  it("emits per-dimension indexed + index_type for a sargable column", () => {
    const t = table("orders", [col("id", { is_primary_key: true }), col("status")], [
      idx({ name: "orders_status_idx", columns: ["status"] }),
    ]);
    const entity = parse(t);
    const dims = entity.dimensions as Record<string, unknown>[];
    const status = dims.find((d) => d.name === "status")!;
    expect(status.indexed).toBe(true);
    expect(status.index_type).toBe("btree");
    expect(status.filter_hint).toBeUndefined();
  });

  it("emits a filter_hint on a trailing composite member and no index_type duplication", () => {
    const t = table(
      "events",
      [col("tenant_id"), col("created_at")],
      [idx({ name: "events_tenant_created_idx", columns: ["tenant_id", "created_at"] })],
    );
    const entity = parse(t);
    const dims = entity.dimensions as Record<string, unknown>[];
    const created = dims.find((d) => d.name === "created_at")!;
    expect(created.indexed).toBe(true);
    expect(typeof created.filter_hint).toBe("string");
    expect(created.filter_hint as string).toContain("tenant_id");
    expect(created.filter_hint as string).toContain("events_tenant_created_idx");
  });

  it("emits an entity-level indexes[] block for composite + partial indexes only", () => {
    const t = table(
      "events",
      [col("tenant_id"), col("created_at"), col("status")],
      [
        idx({ name: "events_composite", columns: ["tenant_id", "created_at"] }),
        idx({
          name: "events_active",
          columns: ["status"],
          is_partial: true,
          predicate: "deleted_at IS NULL",
        }),
        idx({ name: "events_status_solo", columns: ["status"] }), // single-column → omitted
      ],
    );
    const entity = parse(t);
    const indexes = entity.indexes as Record<string, unknown>[];
    expect(indexes).toHaveLength(2);
    const composite = indexes.find((i) => i.name === "events_composite")!;
    expect(composite.columns).toEqual(["tenant_id", "created_at"]);
    expect(composite.type).toBe("btree");
    const partial = indexes.find((i) => i.name === "events_active")!;
    expect(partial.predicate).toBe("deleted_at IS NULL");
  });

  it("omits index fields entirely for profiles without harvested indexes", () => {
    const t = table("plain", [col("x")], []);
    const entity = parse(t);
    expect(entity.indexes).toBeUndefined();
    const dims = entity.dimensions as Record<string, unknown>[];
    expect(dims.find((d) => d.name === "x")!.indexed).toBeUndefined();
  });
});
