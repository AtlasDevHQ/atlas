/**
 * `generateSemanticLayer` — the shared semantic-layer assembly (#3506).
 *
 * The per-function YAML correctness lives in the profiler/generate suites; this
 * file proves the *assembly* contract the CLI and the `SemanticGenerator`
 * service both depend on: one entity per profile (in order), catalog + glossary
 * present, one metric per measure-bearing profile (views/measureless omitted),
 * filenames derived from the table name, and dialect/schema/sourceId threaded
 * through to the underlying generators.
 */

import { describe, it, expect } from "bun:test";
import type { TableProfile, ColumnProfile } from "@useatlas/types";
import * as yaml from "js-yaml";
import { analyzeTableProfiles } from "../generate";
import { generateSemanticLayer } from "../generate/layer";
import { generateEntityYAML } from "../generate/yaml";

function col(
  over: Partial<ColumnProfile> & Pick<ColumnProfile, "name" | "type">,
): ColumnProfile {
  return {
    name: over.name,
    type: over.type,
    nullable: over.nullable ?? false,
    unique_count: over.unique_count ?? null,
    null_count: over.null_count ?? null,
    sample_values: over.sample_values ?? [],
    is_primary_key: over.is_primary_key ?? false,
    is_foreign_key: over.is_foreign_key ?? false,
    fk_target_table: over.fk_target_table ?? null,
    fk_target_column: over.fk_target_column ?? null,
    is_enum_like: over.is_enum_like ?? false,
    profiler_notes: over.profiler_notes ?? [],
    ...(over.semantic_type ? { semantic_type: over.semantic_type } : {}),
  };
}

function profile(
  over: Partial<TableProfile> & Pick<TableProfile, "table_name">,
): TableProfile {
  return {
    table_name: over.table_name,
    object_type: over.object_type ?? "table",
    row_count: over.row_count ?? 100,
    columns: over.columns ?? [],
    primary_key_columns: over.primary_key_columns ?? [],
    foreign_keys: over.foreign_keys ?? [],
    inferred_foreign_keys: over.inferred_foreign_keys ?? [],
    profiler_notes: over.profiler_notes ?? [],
    table_flags: over.table_flags ?? {
      possibly_abandoned: false,
      possibly_denormalized: false,
    },
  };
}

const orders = profile({
  table_name: "orders",
  primary_key_columns: ["id"],
  columns: [
    col({ name: "id", type: "integer", is_primary_key: true }),
    col({ name: "total", type: "numeric" }),
    col({ name: "status", type: "text", is_enum_like: true, sample_values: ["paid", "pending"] }),
  ],
});

const customers = profile({
  table_name: "customers",
  primary_key_columns: ["id"],
  columns: [
    col({ name: "id", type: "integer", is_primary_key: true }),
    col({ name: "email", type: "text" }),
  ],
});

const ordersView = profile({
  table_name: "orders_summary",
  object_type: "view",
  columns: [col({ name: "id", type: "integer" }), col({ name: "total", type: "numeric" })],
});

describe("generateSemanticLayer", () => {
  it("emits one entity per profile, preserving order", () => {
    const result = generateSemanticLayer([orders, customers], { dbType: "postgres" });

    expect(result.entities.map((e) => e.table)).toEqual(["orders", "customers"]);
    expect(result.entities.map((e) => e.fileName)).toEqual(["orders.yml", "customers.yml"]);
    for (const entity of result.entities) {
      expect(entity.yaml.length).toBeGreaterThan(0);
      // Round-trips as valid YAML with the expected table.
      const parsed = yaml.load(entity.yaml) as { table?: string };
      expect(parsed.table).toBe(entity.table);
    }
  });

  it("includes catalog and glossary", () => {
    const result = generateSemanticLayer([orders, customers], { dbType: "postgres" });
    expect(result.catalog.length).toBeGreaterThan(0);
    expect(result.glossary.length).toBeGreaterThan(0);
    expect(() => yaml.load(result.catalog)).not.toThrow();
    expect(() => yaml.load(result.glossary)).not.toThrow();
  });

  it("derives traversal-safe filenames (basename) for entity and metric artifacts", () => {
    // A profiler that yields a path-laden table name must not let the artifact
    // filename escape the output directory when a caller path.joins it.
    const evil = profile({
      table_name: "../../etc/orders",
      primary_key_columns: ["id"],
      columns: [
        col({ name: "id", type: "integer", is_primary_key: true }),
        col({ name: "total", type: "numeric" }),
      ],
    });
    const result = generateSemanticLayer([evil], { dbType: "postgres" });

    // table: keeps the logical name; fileName: is sanitized to a bare basename.
    expect(result.entities[0].table).toBe("../../etc/orders");
    expect(result.entities[0].fileName).toBe("orders.yml");
    expect(result.entities[0].fileName).not.toContain("/");
    expect(result.metrics[0].fileName).toBe("orders.yml");
    expect(result.metrics[0].fileName).not.toContain("/");
  });

  it("emits a metric only for measure-bearing tables (views/measureless omitted)", () => {
    // `orders` has a numeric non-key column → measure; `customers` has none;
    // a view yields no metric.
    const result = generateSemanticLayer([orders, customers, ordersView], {
      dbType: "postgres",
    });
    expect(result.metrics.map((m) => m.table)).toEqual(["orders"]);
    expect(result.metrics[0].fileName).toBe("orders.yml");
  });

  it("threads dbType, schema, and sourceId through to the entity generator", () => {
    const withSource = generateSemanticLayer([orders], {
      dbType: "postgres",
      schema: "analytics",
      sourceId: "warehouse",
    });
    const direct = generateEntityYAML(orders, [orders], "postgres", "analytics", "warehouse");
    expect(withSource.entities[0].yaml).toBe(direct);

    const parsed = yaml.load(withSource.entities[0].yaml) as {
      group?: string;
      table?: string;
    };
    expect(parsed.group).toBe("warehouse");
    // schema qualification appears in the entity's `table:` for postgres.
    expect(parsed.table).toContain("analytics");
  });

  it("defaults schema to public and omits the group field for the default group", () => {
    const result = generateSemanticLayer([orders], { dbType: "postgres" });
    const parsed = yaml.load(result.entities[0].yaml) as {
      group?: string;
      table?: string;
    };
    expect(parsed.group).toBeUndefined();
  });

  it("matches the legacy inlined loop byte-for-byte (golden reference)", () => {
    // The CLI previously inlined this exact loop; the shared core must produce
    // identical bytes so `atlas init` output never drifts.
    const analyzed = analyzeTableProfiles([orders, customers]);
    const result = generateSemanticLayer(analyzed, { dbType: "postgres", schema: "public" });
    for (const entity of result.entities) {
      const expected = generateEntityYAML(
        analyzed.find((p) => p.table_name === entity.table)!,
        analyzed,
        "postgres",
        "public",
        undefined,
      );
      expect(entity.yaml).toBe(expected);
    }
  });
});
