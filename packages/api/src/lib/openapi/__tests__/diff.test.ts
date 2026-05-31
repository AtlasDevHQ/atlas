/**
 * Unit tests for `diffOperationGraphs` (#2976) — the pure spec-drift diff over
 * two normalized {@link OperationGraph}s.
 *
 * The contract under test (PRD #2868, v0.0.3 — Spec Lifecycle):
 *   - DETERMINISTIC + ORDER-INSENSITIVE: the same two graphs always produce the
 *     same changeset, regardless of map insertion order. Every output list is
 *     sorted by a stable key.
 *   - STRUCTURED: added / removed / changed operations + added / removed / retyped
 *     schema fields, plus operation-level attribute changes (method/path/security/
 *     side-effecting) the agent's routing depends on.
 *   - AGENT-RELEVANT SURFACE (AC4): the operation set, `$ref` joins, inline/custom
 *     fields, and query-pattern params — NOT cosmetic prose (summary/description).
 *   - EMPTY BASELINE: diffing against an empty graph (the shape a first-ever
 *     discovery would compare against) reports every operation + schema as added.
 *
 * Graphs are built from tiny OpenAPI docs through the real `buildOperationGraph`
 * so the diff is exercised against the genuine normalized shape (ref pointers,
 * merged params), not a hand-rolled `OperationGraph` literal that could drift
 * from what the parser actually emits.
 */
import { describe, it, expect } from "bun:test";
import { buildOperationGraph } from "../spec";
import type { OperationGraph } from "../types";
import {
  diffOperationGraphs,
  summarizeSpecDiffRecord,
  unparseablePriorDiffRecord,
  type SpecDiffRecord,
  type FieldChange,
  type FieldChangeKind,
} from "../diff";

// ── Fixture shape (mutable, so each scenario can edit a clone freely) ─────────

interface SchemaNode {
  type?: string;
  format?: string;
  $ref?: string;
  required?: string[];
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
}
interface MediaType {
  schema: SchemaNode;
}
interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema?: SchemaNode;
}
interface ResponseObj {
  description: string;
  content?: Record<string, MediaType>;
}
interface Op {
  operationId: string;
  summary?: string;
  parameters?: Param[];
  requestBody?: { required: boolean; content: Record<string, MediaType> };
  responses: Record<string, ResponseObj>;
  "x-atlas-side-effecting"?: boolean;
}
interface PathItem {
  get?: Op;
  post?: Op;
  put?: Op;
  delete?: Op;
}
interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, SchemaNode> };
}

/** Deep-clone a doc so each scenario can mutate freely. */
function clone(doc: OpenApiDoc): OpenApiDoc {
  return JSON.parse(JSON.stringify(doc)) as OpenApiDoc;
}

function graph(doc: OpenApiDoc): OperationGraph {
  return buildOperationGraph(doc);
}

/** An empty graph — the baseline a first-ever discovery diffs against. */
function emptyGraph(): OperationGraph {
  return {
    operations: new Map(),
    schemas: new Map(),
    security: new Map(),
    servers: [],
    info: { title: "", version: "", openapiVersion: "3.0.0" },
  };
}

/**
 * Find a field change by path, assert its kind, and narrow the discriminated
 * {@link FieldChange} union to that arm so `before`/`after` are accessible without
 * a cast at every call site.
 */
function expectChange<K extends FieldChangeKind>(
  changes: ReadonlyArray<FieldChange>,
  path: string,
  kind: K,
): Extract<FieldChange, { kind: K }> {
  const change = changes.find((f) => f.path === path);
  expect(change?.kind).toBe(kind);
  return change as Extract<FieldChange, { kind: K }>;
}

/** A small but realistic CRM spec: list + get people, with a `$ref` join. */
const BASE_DOC: OpenApiDoc = {
  openapi: "3.0.0",
  info: { title: "CRM", version: "1.0.0" },
  paths: {
    "/people": {
      get: {
        operationId: "listPeople",
        summary: "List people",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PersonList" } },
            },
          },
        },
      },
    },
    "/people/{id}": {
      get: {
        operationId: "getPerson",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Person" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Person: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          company: { $ref: "#/components/schemas/Company" },
        },
      },
      Company: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      PersonList: {
        type: "object",
        properties: { records: { type: "array", items: { $ref: "#/components/schemas/Person" } } },
      },
      // Unreferenced on purpose — lets a test exercise schema removal without
      // tripping the parser's unresolved-`$ref` guard.
      Unused: { type: "object", properties: { foo: { type: "string" } } },
    },
  },
};

// ── Unchanged ──────────────────────────────────────────────────────────────

describe("diffOperationGraphs — unchanged", () => {
  it("reports `unchanged` with empty lists when nothing moved", () => {
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(clone(BASE_DOC)));
    expect(diff.unchanged).toBe(true);
    expect(diff.operations.added).toEqual([]);
    expect(diff.operations.removed).toEqual([]);
    expect(diff.operations.changed).toEqual([]);
    expect(diff.schemas.added).toEqual([]);
    expect(diff.schemas.removed).toEqual([]);
    expect(diff.schemas.changed).toEqual([]);
    expect(diff.counts.fieldsAdded).toBe(0);
    expect(diff.counts.fieldsRemoved).toBe(0);
    expect(diff.counts.fieldsRetyped).toBe(0);
  });

  it("is order-insensitive — operation/property insertion order does not matter", () => {
    // Reorder the paths object and a schema's properties; the normalized diff
    // must be identical (unchanged).
    const reordered = clone(BASE_DOC);
    const paths = reordered.paths;
    reordered.paths = { "/people/{id}": paths["/people/{id}"], "/people": paths["/people"] };
    const person = reordered.components.schemas.Person;
    person.properties = {
      company: person.properties!.company,
      name: person.properties!.name,
      id: person.properties!.id,
    };
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(reordered));
    expect(diff.unchanged).toBe(true);
  });
});

// ── Operations added / removed ───────────────────────────────────────────────

describe("diffOperationGraphs — operation set", () => {
  it("detects an added operation", () => {
    const next = clone(BASE_DOC);
    next.paths["/companies"] = {
      get: {
        operationId: "listCompanies",
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Company" } } },
          },
        },
      },
    };
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    expect(diff.unchanged).toBe(false);
    expect(diff.operations.added.map((o) => o.operationId)).toEqual(["listCompanies"]);
    expect(diff.operations.added[0]).toMatchObject({ method: "GET", path: "/companies" });
    expect(diff.operations.removed).toEqual([]);
    expect(diff.counts.operationsAdded).toBe(1);
  });

  it("detects a removed operation the agent relied on", () => {
    const next = clone(BASE_DOC);
    delete next.paths["/people/{id}"];
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    expect(diff.operations.removed.map((o) => o.operationId)).toEqual(["getPerson"]);
    expect(diff.operations.removed[0]).toMatchObject({ method: "GET", path: "/people/{id}" });
    expect(diff.counts.operationsRemoved).toBe(1);
  });
});

// ── Operation changed — fields + attributes ──────────────────────────────────

describe("diffOperationGraphs — changed operations", () => {
  it("flags a retyped query-pattern param", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters![0].schema!.type = "string"; // limit: integer -> string
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    expect(diff.operations.changed.map((c) => c.operationId)).toEqual(["listPeople"]);
    const change = diff.operations.changed[0];
    const limit = expectChange(change.fields, "param:query:limit", "retyped");
    expect(limit.before).toMatchObject({ type: "integer" });
    expect(limit.after).toMatchObject({ type: "string" });
    expect(diff.counts.fieldsRetyped).toBe(1);
  });

  it("flags an added query-pattern param", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters!.push({
      name: "q",
      in: "query",
      schema: { type: "string" },
    });
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const change = diff.operations.changed.find((c) => c.operationId === "listPeople");
    expect(change?.fields.find((f) => f.path === "param:query:q")?.kind).toBe("added");
    expect(diff.counts.fieldsAdded).toBe(1);
  });

  it("flags an operation-level attribute change (GET -> POST) without touching fields", () => {
    const next = clone(BASE_DOC);
    // Same operationId, different method: move the operation from GET to POST.
    next.paths["/people"].post = next.paths["/people"].get;
    delete next.paths["/people"].get;
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const change = diff.operations.changed.find((c) => c.operationId === "listPeople");
    expect(change?.attributes.find((a) => a.name === "method")).toMatchObject({
      before: "GET",
      after: "POST",
    });
  });

  it("detects an added request-body field", () => {
    const withBody = clone(BASE_DOC);
    withBody.paths["/people"].post = {
      operationId: "createPerson",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      },
      responses: {
        "200": {
          description: "ok",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Person" } } },
        },
      },
    };
    const next = clone(withBody);
    next.paths["/people"].post!.requestBody!.content["application/json"].schema.properties!.email = {
      type: "string",
    };

    const diff = diffOperationGraphs(graph(withBody), graph(next));
    const change = diff.operations.changed.find((c) => c.operationId === "createPerson");
    expect(change).toBeDefined();
    const added = expectChange(change!.fields, "requestBody:application/json.email", "added");
    expect(added.after).toMatchObject({ type: "string" });
  });
});

// ── Schema (named component) diff: fields + $ref joins ───────────────────────

describe("diffOperationGraphs — schema fields + $ref joins", () => {
  it("detects an added inline field on a named component", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.properties!.phone = { type: "string" };
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const personChange = diff.schemas.changed.find((s) => s.name === "Person");
    expect(personChange?.fields.find((f) => f.path === "phone")?.kind).toBe("added");
    expect(diff.counts.schemasChanged).toBe(1);
  });

  it("detects a retyped field (format change) on a named component", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.properties!.id.format = "int64"; // uuid -> int64
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const personChange = diff.schemas.changed.find((s) => s.name === "Person");
    expect(personChange).toBeDefined();
    const idField = expectChange(personChange!.fields, "id", "retyped");
    expect(idField.before).toMatchObject({ format: "uuid" });
    expect(idField.after).toMatchObject({ format: "int64" });
  });

  it("detects a re-targeted `$ref` join as a retyped field", () => {
    // Person.company stops pointing at Company and points at a new Org schema.
    const next = clone(BASE_DOC);
    next.components.schemas.Org = {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
    };
    next.components.schemas.Person.properties!.company = { $ref: "#/components/schemas/Org" };
    delete next.components.schemas.Company;

    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const personChange = diff.schemas.changed.find((s) => s.name === "Person");
    expect(personChange).toBeDefined();
    const join = expectChange(personChange!.fields, "company", "retyped");
    expect(join.before).toMatchObject({ ref: "Company" });
    expect(join.after).toMatchObject({ ref: "Org" });
    // The component set also moved.
    expect(diff.schemas.added).toContain("Org");
    expect(diff.schemas.removed).toContain("Company");
  });

  it("detects an added and a removed named component", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Extra = { type: "object", properties: { x: { type: "string" } } };
    delete next.components.schemas.Unused;
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    expect(diff.schemas.added).toContain("Extra");
    expect(diff.schemas.removed).toContain("Unused");
  });
});

// ── Composition branches (allOf / oneOf / anyOf) — order-insensitive ─────────

describe("diffOperationGraphs — composition branches", () => {
  // A response modeled as a `oneOf` of two inline branches. Composition arrays
  // are an unordered set, so reordering them between probes must NOT read as
  // drift — the bug the #3041 review + CodeRabbit/Codex flagged: index-based
  // paths (`…|oneOf[0]`) turned a pure reorder into phantom field churn.
  const ONEOF_DOC: OpenApiDoc = {
    openapi: "3.0.0",
    info: { title: "CRM", version: "1.0.0" },
    paths: {
      "/search": {
        get: {
          operationId: "search",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { type: "object", properties: { a: { type: "string" } } },
                      { type: "object", properties: { b: { type: "integer" } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  };

  /** The `oneOf` array of `/search`'s 200 response, for a scenario to mutate. */
  function oneOfBranches(doc: OpenApiDoc): SchemaNode[] {
    return doc.paths["/search"].get!.responses["200"].content!["application/json"].schema.oneOf!;
  }

  it("reports `unchanged` when oneOf branches are merely reordered", () => {
    const reordered = clone(ONEOF_DOC);
    const branches = oneOfBranches(reordered);
    oneOfBranches(reordered).splice(0, branches.length, branches[1], branches[0]);
    const diff = diffOperationGraphs(graph(clone(ONEOF_DOC)), graph(reordered));
    expect(diff.unchanged).toBe(true);
  });

  it("still detects a genuinely added composition branch", () => {
    const next = clone(ONEOF_DOC);
    oneOfBranches(next).push({ type: "object", properties: { c: { type: "boolean" } } });
    const diff = diffOperationGraphs(graph(clone(ONEOF_DOC)), graph(next));
    expect(diff.unchanged).toBe(false);
    const change = diff.operations.changed.find((c) => c.operationId === "search");
    expect(change).toBeDefined();
    // The new branch's field surfaces as `added` at a composition path.
    expect(change!.fields.some((f) => f.kind === "added" && f.path.includes("|oneOf["))).toBe(true);
  });
});

// ── Required ↔ optional flip ─────────────────────────────────────────────────

describe("diffOperationGraphs — required flip", () => {
  it("reads a property losing `required` as a retype (folded into the descriptor)", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.required = []; // `id` was required
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const personChange = diff.schemas.changed.find((s) => s.name === "Person");
    expect(personChange).toBeDefined();
    const idField = expectChange(personChange!.fields, "id", "retyped");
    expect(idField.before).toMatchObject({ required: true });
    expect(idField.after.required).toBeUndefined();
  });
});

// ── Enum descriptors — sorted, so member order is not drift ──────────────────

describe("diffOperationGraphs — enum descriptors", () => {
  const ENUM_DOC: OpenApiDoc = {
    openapi: "3.0.0",
    info: { title: "CRM", version: "1.0.0" },
    paths: {
      "/people": {
        get: {
          operationId: "listPeople",
          parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["a", "b", "c"] } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: { schemas: {} },
  };

  it("treats enum member reordering as unchanged (members are sorted)", () => {
    const reordered = clone(ENUM_DOC);
    reordered.paths["/people"].get!.parameters![0].schema!.enum = ["c", "a", "b"];
    const diff = diffOperationGraphs(graph(clone(ENUM_DOC)), graph(reordered));
    expect(diff.unchanged).toBe(true);
  });

  it("flags an added enum member as a retype", () => {
    const next = clone(ENUM_DOC);
    next.paths["/people"].get!.parameters![0].schema!.enum = ["a", "b", "c", "d"];
    const diff = diffOperationGraphs(graph(clone(ENUM_DOC)), graph(next));
    const change = diff.operations.changed.find((c) => c.operationId === "listPeople");
    expect(change).toBeDefined();
    const status = expectChange(change!.fields, "param:query:status", "retyped");
    expect(status.before.enum).toEqual(["a", "b", "c"]);
    expect(status.after.enum).toEqual(["a", "b", "c", "d"]);
  });
});

// ── Array element paths ──────────────────────────────────────────────────────

describe("diffOperationGraphs — array element paths", () => {
  it("flags a retyped array element via its `[]` path", () => {
    // PersonList.records is an array of `$ref` Person — retarget the element type.
    const next = clone(BASE_DOC);
    next.components.schemas.PersonList.properties!.records.items = { type: "string" };
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const listChange = diff.schemas.changed.find((s) => s.name === "PersonList");
    expect(listChange).toBeDefined();
    const elem = expectChange(listChange!.fields, "records[]", "retyped");
    expect(elem.before).toMatchObject({ ref: "Person" });
    expect(elem.after).toMatchObject({ type: "string" });
  });
});

// ── Operation attributes — safety-relevant routing facts ─────────────────────

describe("diffOperationGraphs — operation attributes", () => {
  it("flags a sideEffecting escalation (absent → true) as an attribute change", () => {
    const next = clone(BASE_DOC);
    next.paths["/people/{id}"].get!["x-atlas-side-effecting"] = true;
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const change = diff.operations.changed.find((c) => c.operationId === "getPerson");
    expect(change).toBeDefined();
    expect(change!.attributes.find((a) => a.name === "sideEffecting")).toMatchObject({
      before: "false",
      after: "true",
    });
  });
});

// ── Empty baseline (first-ever discovery) ────────────────────────────────────

describe("diffOperationGraphs — empty baseline", () => {
  it("reports every operation and schema as added against an empty graph", () => {
    const diff = diffOperationGraphs(emptyGraph(), graph(clone(BASE_DOC)));
    expect(diff.unchanged).toBe(false);
    expect(diff.operations.added.map((o) => o.operationId).toSorted()).toEqual([
      "getPerson",
      "listPeople",
    ]);
    expect(diff.operations.removed).toEqual([]);
    expect(diff.schemas.added.toSorted()).toEqual(["Company", "Person", "PersonList", "Unused"]);
  });

  it("reports every operation and schema as removed when the next graph is empty", () => {
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), emptyGraph());
    expect(diff.operations.removed.map((o) => o.operationId).toSorted()).toEqual([
      "getPerson",
      "listPeople",
    ]);
    expect(diff.operations.added).toEqual([]);
    expect(diff.schemas.removed.toSorted()).toEqual(["Company", "Person", "PersonList", "Unused"]);
  });
});

// ── summarizeSpecDiffRecord — fail-soft persistence projection ───────────────

describe("summarizeSpecDiffRecord — list/detail projection", () => {
  it("projects a real persisted record to timestamps + counts", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.properties!.phone = { type: "string" };
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(next));
    const record: SpecDiffRecord = {
      previousProbedAt: "2026-05-29T00:00:00.000Z",
      currentProbedAt: "2026-05-30T00:00:00.000Z",
      diff,
    };
    const summary = summarizeSpecDiffRecord(record);
    expect(summary).not.toBeNull();
    expect(summary?.baseline).toBe(false);
    expect(summary?.priorParseFailed).toBe(false);
    expect(summary?.unchanged).toBe(false);
    expect(summary?.previousProbedAt).toBe("2026-05-29T00:00:00.000Z");
    expect(summary?.counts.schemasChanged).toBe(1);
    expect(summary?.counts.fieldsAdded).toBe(1);
  });

  it("marks a null-diff record as a clean first-ever baseline", () => {
    const record: SpecDiffRecord = {
      previousProbedAt: null,
      currentProbedAt: "2026-05-30T00:00:00.000Z",
      diff: null,
    };
    const summary = summarizeSpecDiffRecord(record);
    expect(summary?.baseline).toBe(true);
    expect(summary?.priorParseFailed).toBe(false);
    expect(summary?.unchanged).toBe(false);
    expect(summary?.counts.operationsAdded).toBe(0);
  });

  it("distinguishes an unparseable-prior baseline from a clean one", () => {
    // A prior snapshot existed (timestamp retained) but no longer parsed — the
    // comparison was DROPPED, not absent. The UI must not call this a clean baseline.
    const record = unparseablePriorDiffRecord(
      "2026-05-29T00:00:00.000Z",
      "2026-05-30T00:00:00.000Z",
    );
    const summary = summarizeSpecDiffRecord(record);
    expect(summary?.baseline).toBe(true);
    expect(summary?.priorParseFailed).toBe(true);
    expect(summary?.previousProbedAt).toBe("2026-05-29T00:00:00.000Z");
  });

  it("surfaces an unchanged re-probe", () => {
    const diff = diffOperationGraphs(graph(clone(BASE_DOC)), graph(clone(BASE_DOC)));
    const summary = summarizeSpecDiffRecord({
      previousProbedAt: "2026-05-29T00:00:00.000Z",
      currentProbedAt: "2026-05-30T00:00:00.000Z",
      diff,
    });
    expect(summary?.baseline).toBe(false);
    expect(summary?.unchanged).toBe(true);
  });

  it("returns null for absent / malformed records rather than rendering NaN", () => {
    expect(summarizeSpecDiffRecord(undefined)).toBeNull();
    expect(summarizeSpecDiffRecord(null)).toBeNull();
    expect(summarizeSpecDiffRecord({})).toBeNull(); // no currentProbedAt
    expect(summarizeSpecDiffRecord("nope")).toBeNull();
    // A record whose diff is present but missing its numeric counts → null.
    expect(
      summarizeSpecDiffRecord({ currentProbedAt: "x", diff: { unchanged: false } }),
    ).toBeNull();
  });
});
