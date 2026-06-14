import { describe, expect, test } from "bun:test";
import {
  ENTITY_YAML_KEYS,
  ENTITY_YAML_JOIN_KEYS,
  ENTITY_YAML_DIMENSION_KEYS,
  REST_ENTITY_TYPE_TAG,
  SharedEntityYamlSchema,
} from "../semantic-entity-yaml";

describe("shared entity-YAML vocabulary contract", () => {
  test("canonical key names are the load-bearing literals both renderers emit", () => {
    // These values are consumed (as computed object keys) by BOTH the DB
    // renderer (`generate/yaml.ts`) and the REST renderer
    // (`openapi/semantic-generator.ts`). Pinning them here makes a rename a
    // deliberate, reviewed change rather than a silent drift.
    expect(ENTITY_YAML_KEYS.dimensions).toBe("dimensions");
    expect(ENTITY_YAML_KEYS.joins).toBe("joins");
    expect(ENTITY_YAML_KEYS.queryPatterns).toBe("query_patterns");
    expect(ENTITY_YAML_KEYS.measures).toBe("measures");
    expect(ENTITY_YAML_KEYS.type).toBe("type");
    expect(ENTITY_YAML_JOIN_KEYS.targetEntity).toBe("target_entity");
    expect(ENTITY_YAML_JOIN_KEYS.relationship).toBe("relationship");
    expect(ENTITY_YAML_DIMENSION_KEYS.primaryKey).toBe("primary_key");
    expect(REST_ENTITY_TYPE_TAG).toBe("rest_resource");
  });

  test("accepts a doc using the canonical vocabulary plus renderer-specific extras", () => {
    const ok = SharedEntityYamlSchema.safeParse({
      name: "Person",
      type: REST_ENTITY_TYPE_TAG,
      description: "A person",
      resource: "people", // REST-specific extra — allowed via .loose()
      dimensions: [
        { name: "id", type: "string", primary_key: true },
        { name: "amount", type: "number", sql: "amount" }, // SQL-specific `sql`
      ],
      joins: [{ target_entity: "Company", relationship: "many_to_one", via: "company" }],
      query_patterns: [{ description: "list people", sql: "SELECT 1" }],
    });
    expect(ok.success).toBe(true);
  });

  test("a renamed section key is NOT promoted to the canonical key", () => {
    // The schema is `.loose()`, so a drifted `columns` key passes as an extra —
    // the schema does NOT reject it. The drift GUARD is that the canonical
    // `dimensions` key is then absent: the cross-renderer contract test
    // (entity-yaml-vocabulary-contract.test.ts) asserts `dimensions` IS present
    // in each renderer's output, so a renderer that emitted `columns` instead
    // would fail there. This case documents that the schema alone won't catch a
    // rename — the key-presence assertion is what does.
    const drifted = SharedEntityYamlSchema.safeParse({
      type: "fact_table",
      columns: [{ name: "id", type: "string" }],
    });
    expect(drifted.success).toBe(true);
    expect((drifted as { data: Record<string, unknown> }).data.dimensions).toBeUndefined();
  });

  test("rejects a join missing the canonical target_entity key", () => {
    const bad = SharedEntityYamlSchema.safeParse({
      type: "fact_table",
      joins: [{ target: "Company", relationship: "many_to_one" }],
    });
    expect(bad.success).toBe(false);
  });

  test("requires the entity type tag", () => {
    const noType = SharedEntityYamlSchema.safeParse({ name: "X" });
    expect(noType.success).toBe(false);
  });
});
