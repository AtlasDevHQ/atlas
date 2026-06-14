/**
 * Shared entity-YAML vocabulary contract (#3628).
 *
 * Atlas keeps TWO entity-YAML renderers separate by design (ADR-0017):
 *  - DB / profiled: `lib/semantic/generate/yaml.ts` (`generateEntityYAML`)
 *  - REST / spec-derived: `lib/openapi/semantic-generator.ts` (`renderEntityYaml`)
 *
 * They overlap only in field vocabulary. This test pins that overlap: both
 * renderers' output must speak the canonical key names from
 * `@useatlas/schemas/semantic-entity-yaml`. A field-name drift in either
 * renderer (e.g. `dimensions` → `columns`, `target_entity` → `target`) fails
 * here — the "drift is a test failure" half of the contract.
 */
import { describe, it, expect } from "bun:test";
import type { TableProfile, ColumnProfile } from "@useatlas/types";
import * as yaml from "js-yaml";
import {
  ENTITY_YAML_KEYS,
  ENTITY_YAML_JOIN_KEYS,
  ENTITY_YAML_DIMENSION_KEYS,
  REST_ENTITY_TYPE_TAG,
  SharedEntityYamlSchema,
} from "@useatlas/schemas/semantic-entity-yaml";
import { generateEntityYAML } from "../generate/yaml";
import { renderEntityYaml } from "../../openapi/semantic-generator";
import type { GeneratedEntity } from "../../openapi/semantic-generator";

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
    table_flags: over.table_flags ?? { possibly_abandoned: false, possibly_denormalized: false },
  };
}

const restEntity: GeneratedEntity = {
  name: "Person",
  resource: "people",
  recordSchema: "Person",
  description: "A person record",
  operations: [
    {
      operationId: "listPeople",
      method: "GET",
      path: "/people",
      kind: "list",
      writes: false,
      parameters: [{ name: "filter", in: "query", required: false }],
    },
  ],
  columns: [
    { name: "id", type: "string", primaryKey: true, description: "Identifier" },
    { name: "name", type: "string" },
  ],
  joins: [
    { via: "company", targetEntity: "Company", relationship: "many_to_one", description: "owner" },
  ],
  queryPatterns: [{ name: "search", description: "search people via filter" }],
};

describe("entity-YAML vocabulary contract — both renderers speak it", () => {
  it("DB renderer (generateEntityYAML) output validates against the shared contract", () => {
    const orders = profile({
      table_name: "orders",
      primary_key_columns: ["id"],
      foreign_keys: [
        { from_column: "customer_id", to_table: "customers", to_column: "id", source: "constraint" },
      ],
      columns: [
        col({ name: "id", type: "integer", is_primary_key: true }),
        col({ name: "customer_id", type: "integer", is_foreign_key: true, fk_target_table: "customers" }),
        col({ name: "total", type: "numeric" }),
        col({ name: "status", type: "text", is_enum_like: true, sample_values: ["paid", "pending"] }),
      ],
    });

    const doc = yaml.load(generateEntityYAML(orders, [orders], "postgres")) as Record<string, unknown>;
    expect(SharedEntityYamlSchema.safeParse(doc).success).toBe(true);

    // Canonical key names present (not a drifted alias).
    expect(doc[ENTITY_YAML_KEYS.dimensions]).toBeDefined();
    expect(doc).not.toHaveProperty("columns");
    const joins = doc[ENTITY_YAML_KEYS.joins] as Array<Record<string, unknown>>;
    expect(joins[0]).toHaveProperty(ENTITY_YAML_JOIN_KEYS.targetEntity);
    expect(joins[0]).toHaveProperty(ENTITY_YAML_JOIN_KEYS.relationship);
    const dims = doc[ENTITY_YAML_KEYS.dimensions] as Array<Record<string, unknown>>;
    expect(dims.find((d) => d[ENTITY_YAML_DIMENSION_KEYS.primaryKey] === true)).toBeDefined();
  });

  it("REST renderer (renderEntityYaml) output validates against the shared contract", () => {
    const doc = yaml.load(renderEntityYaml(restEntity)) as Record<string, unknown>;
    expect(SharedEntityYamlSchema.safeParse(doc).success).toBe(true);

    expect(doc[ENTITY_YAML_KEYS.type]).toBe(REST_ENTITY_TYPE_TAG);
    expect(doc[ENTITY_YAML_KEYS.dimensions]).toBeDefined();
    expect(doc).not.toHaveProperty("columns");
    const joins = doc[ENTITY_YAML_KEYS.joins] as Array<Record<string, unknown>>;
    expect(joins[0]).toHaveProperty(ENTITY_YAML_JOIN_KEYS.targetEntity);
    expect(joins[0]).toHaveProperty(ENTITY_YAML_JOIN_KEYS.relationship);
    expect(doc[ENTITY_YAML_KEYS.queryPatterns]).toBeDefined();
  });

  it("both renderers agree on the shared section key names", () => {
    const dbDoc = yaml.load(
      generateEntityYAML(
        profile({
          table_name: "orders",
          primary_key_columns: ["id"],
          foreign_keys: [{ from_column: "customer_id", to_table: "customers", to_column: "id", source: "constraint" }],
          columns: [col({ name: "id", type: "integer", is_primary_key: true })],
        }),
        [],
        "postgres",
      ),
    ) as Record<string, unknown>;
    const restDoc = yaml.load(renderEntityYaml(restEntity)) as Record<string, unknown>;

    for (const key of [ENTITY_YAML_KEYS.dimensions, ENTITY_YAML_KEYS.joins] as const) {
      expect(dbDoc).toHaveProperty(key);
      expect(restDoc).toHaveProperty(key);
    }
  });
});
