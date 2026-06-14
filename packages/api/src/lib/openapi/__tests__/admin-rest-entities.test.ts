/**
 * REST-derived admin entity helpers (#3628) — pure mapping + key round-trip.
 *
 * The resolver-backed `listRestAdminEntities` / `getRestAdminEntityDetail`
 * orchestrators are covered by the route-level suites; here we pin the pure,
 * routing-critical logic: the namespaced storage key (so detail/raw can resolve
 * the exact datasource) and the GeneratedEntity → admin shapes.
 */
import { describe, it, expect } from "bun:test";
import {
  makeRestEntityKey,
  parseRestEntityKey,
  summarizeEntity,
  toDetailEntity,
  REST_ENTITY_KEY_DELIMITER,
} from "../admin-rest-entities";
import type { GeneratedEntity } from "../semantic-generator";
import type { RestDatasource } from "../datasource";
import { REST_ENTITY_TYPE_TAG } from "@useatlas/schemas/semantic-entity-yaml";

const entity: GeneratedEntity = {
  name: "Person",
  resource: "people",
  recordSchema: "Person",
  description: "A person",
  operations: [],
  columns: [
    { name: "id", type: "string", primaryKey: true, description: "id" },
    { name: "name", type: "string" },
  ],
  joins: [{ via: "company", targetEntity: "Company", relationship: "many_to_one", description: "owner" }],
  queryPatterns: [{ name: "search", description: "search" }],
};

const ds = {
  id: "install-123",
  displayName: "Twenty",
  groupId: undefined,
  graph: {} as RestDatasource["graph"],
  baseUrl: "https://example.com",
  auth: { kind: "none" } as RestDatasource["auth"],
  representationMode: "operation-graph",
  writeAllowlist: new Set<string>(),
  sideEffectingOperations: new Set<string>(),
} as RestDatasource;

describe("REST admin entity key", () => {
  it("round-trips install id + entity name", () => {
    const key = makeRestEntityKey("install-123", "Person");
    expect(key).toBe(`install-123${REST_ENTITY_KEY_DELIMITER}Person`);
    expect(parseRestEntityKey(key)).toEqual({ installId: "install-123", entityName: "Person" });
  });

  it("returns null for a non-REST (delimiter-less) key", () => {
    expect(parseRestEntityKey("orders")).toBeNull();
    expect(parseRestEntityKey("public.orders")).toBeNull();
  });

  it("returns null when either side is empty", () => {
    expect(parseRestEntityKey("::Person")).toBeNull();
    expect(parseRestEntityKey("install::")).toBeNull();
  });
});

describe("summarizeEntity", () => {
  it("produces a read-only published summary keyed by install id", () => {
    const summary = summarizeEntity(ds, entity);
    expect(summary.name).toBe(makeRestEntityKey("install-123", "Person"));
    expect(summary.displayName).toBe("Person");
    expect(summary.table).toBe("people");
    expect(summary.columnCount).toBe(2);
    expect(summary.joinCount).toBe(1);
    expect(summary.readOnly).toBe(true);
    expect(summary.status).toBe("published");
    expect(summary.sourceKind).toBe("rest");
    expect(summary.type).toBe(REST_ENTITY_TYPE_TAG);
    // Workspace-global datasource → ungrouped (default section).
    expect(summary.connectionId).toBeNull();
  });

  it("places a group-scoped datasource's entities under its group", () => {
    const scoped = { ...ds, groupId: "eu-prod" } as RestDatasource;
    const summary = summarizeEntity(scoped, entity);
    expect(summary.connectionId).toBe("eu-prod");
    expect(summary.source).toBe("eu-prod");
  });
});

describe("toDetailEntity", () => {
  it("maps columns→dimensions and joins→web Join shape", () => {
    const detail = toDetailEntity(entity);
    expect(detail.type).toBe(REST_ENTITY_TYPE_TAG);
    expect(detail.readOnly).toBe(true);
    expect(detail.dimensions).toHaveLength(2);
    expect(detail.dimensions[0]).toMatchObject({ name: "id", type: "string", primary_key: true });
    expect(detail.joins[0]).toMatchObject({ to: "Company", relationship: "many_to_one" });
    expect(detail.measures).toHaveLength(0);
    expect(detail.query_patterns[0]).toMatchObject({ name: "search", description: "search" });
  });
});
