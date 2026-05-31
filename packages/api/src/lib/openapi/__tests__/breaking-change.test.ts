/**
 * Unit tests for `classifyBreakingChanges` (#2979) — the PURE breaking-vs-additive
 * policy layer over the structured {@link OperationGraphDiff} (#2976/#3041).
 *
 * The contract under test (PRD #2868, v0.0.3 — Spec Lifecycle, AC1):
 *   - A change is BREAKING when something the agent relied on was removed or
 *     retyped, an operation's routing/safety attributes moved under a stable
 *     `operationId`, or a NEW REQUIRED field appeared on a REQUEST surface.
 *   - A change is ADDITIVE (quiet) when it only adds optional/response surface —
 *     new operations, new schemas, added-optional params, added response fields.
 *
 * Diffs are built from tiny OpenAPI docs through the REAL `buildOperationGraph` +
 * `diffOperationGraphs` so the classifier is exercised against the genuine
 * normalized changeset (ref pointers, folded `required`, location-prefixed paths),
 * not a hand-rolled diff literal that could drift from what the diff actually emits.
 */
import { describe, it, expect } from "bun:test";
import { buildOperationGraph } from "../spec";
import { diffOperationGraphs } from "../diff";
import type { OperationGraph } from "../types";
import {
  classifyBreakingChanges,
  resolveDriftAlertWrite,
  projectDriftAlert,
  buildDriftAlertRecord,
  MAX_STORED_DRIFT_REASONS,
  type BreakingReason,
  type BreakingReasonKind,
} from "../breaking-change";
import type { SpecDiffRecord } from "../diff";

// ── Fixture shape (mutable, so each scenario can edit a clone freely) ─────────

interface SchemaNode {
  type?: string;
  format?: string;
  $ref?: string;
  required?: string[];
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
  security?: Array<Record<string, string[]>>;
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
  components: {
    schemas: Record<string, SchemaNode>;
    securitySchemes?: Record<string, { type: string; scheme?: string; in?: string; name?: string }>;
  };
}

function clone(doc: OpenApiDoc): OpenApiDoc {
  return JSON.parse(JSON.stringify(doc)) as OpenApiDoc;
}
function graph(doc: OpenApiDoc): OperationGraph {
  return buildOperationGraph(doc);
}
/** Classify the diff between a clone of BASE and a (mutated) `next`. */
function classify(next: OpenApiDoc) {
  return classifyBreakingChanges(diffOperationGraphs(graph(clone(BASE_DOC)), graph(next)));
}
/** True if a reason of the given kind exists (optionally matching operationId/schema/path). */
function hasReason(
  reasons: ReadonlyArray<BreakingReason>,
  kind: BreakingReasonKind,
  match: { operationId?: string; schema?: string; path?: string } = {},
): boolean {
  return reasons.some(
    (r) =>
      r.kind === kind &&
      (match.operationId === undefined || r.operationId === match.operationId) &&
      (match.schema === undefined || r.schema === match.schema) &&
      (match.path === undefined || r.path === match.path),
  );
}

/** A small CRM spec: list + get + create people, a `$ref` join, an API-key scheme. */
const BASE_DOC: OpenApiDoc = {
  openapi: "3.0.0",
  info: { title: "CRM", version: "1.0.0" },
  paths: {
    "/people": {
      get: {
        operationId: "listPeople",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PersonList" } } },
          },
        },
      },
      post: {
        operationId: "createPerson",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Person" } } },
          },
        },
      },
    },
    "/people/{id}": {
      get: {
        operationId: "getPerson",
        security: [{ apiKey: [] }],
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
      Company: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      PersonList: {
        type: "object",
        properties: { records: { type: "array", items: { $ref: "#/components/schemas/Person" } } },
      },
      Unused: { type: "object", properties: { foo: { type: "string" } } },
    },
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
  },
};

// ── Quiet (additive-only / unchanged) ────────────────────────────────────────

describe("classifyBreakingChanges — additive stays quiet", () => {
  it("reports not-breaking with no reasons when nothing moved", () => {
    const a = classify(clone(BASE_DOC));
    expect(a.breaking).toBe(false);
    expect(a.reasons).toEqual([]);
  });

  it("an added operation is additive", () => {
    const next = clone(BASE_DOC);
    next.paths["/companies"] = {
      get: {
        operationId: "listCompanies",
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Company" } } } },
        },
      },
    };
    expect(classify(next).breaking).toBe(false);
  });

  it("an added named schema is additive", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Extra = { type: "object", properties: { x: { type: "string" } } };
    expect(classify(next).breaking).toBe(false);
  });

  it("an added OPTIONAL request param is additive", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters!.push({ name: "q", in: "query", schema: { type: "string" } });
    expect(classify(next).breaking).toBe(false);
  });

  it("an added RESPONSE field is additive (the agent reads more, not less)", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.properties!.phone = { type: "string" };
    // Person is a response shape here; an added field can't break a read.
    const a = classify(next);
    expect(a.breaking).toBe(false);
  });

  it("an added optional field on a named schema is additive (surface unknown → conservative-quiet)", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Company.properties!.website = { type: "string" };
    expect(classify(next).breaking).toBe(false);
  });
});

// ── Operations removed / re-routed ───────────────────────────────────────────

describe("classifyBreakingChanges — operation set + attributes", () => {
  it("a removed operation is breaking (agent calls vanish)", () => {
    const next = clone(BASE_DOC);
    delete next.paths["/people/{id}"];
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "operation_removed", { operationId: "getPerson" })).toBe(true);
  });

  it("a method change under a stable operationId is breaking (routing moved)", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].put = next.paths["/people"].get; // listPeople GET -> PUT
    delete next.paths["/people"].get;
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "operation_attribute_changed", { operationId: "listPeople" })).toBe(true);
  });

  it("a path change under a stable operationId is breaking", () => {
    const next = clone(BASE_DOC);
    next.paths["/v2/people/{id}"] = next.paths["/people/{id}"]; // getPerson moves path
    delete next.paths["/people/{id}"];
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "operation_attribute_changed", { operationId: "getPerson" })).toBe(true);
  });

  it("a security-requirement change is breaking (auth requirements moved)", () => {
    const next = clone(BASE_DOC);
    // getPerson loses its apiKey requirement (security: [] = no auth).
    next.paths["/people/{id}"].get!.security = [];
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "operation_attribute_changed", { operationId: "getPerson" })).toBe(true);
  });

  it("a sideEffecting escalation (read → write, false → true) is breaking", () => {
    const next = clone(BASE_DOC);
    next.paths["/people/{id}"].get!["x-atlas-side-effecting"] = true;
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "operation_attribute_changed", { operationId: "getPerson" })).toBe(true);
  });
});

// ── Field-level: removed / retyped / required-add ────────────────────────────

describe("classifyBreakingChanges — operation fields", () => {
  it("a retyped query param is breaking (type changed under the agent)", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters![0].schema!.type = "string"; // limit: integer -> string
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_retyped", { operationId: "listPeople", path: "param:query:limit" })).toBe(true);
  });

  it("a removed query param is breaking", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters = [];
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_removed", { operationId: "listPeople", path: "param:query:limit" })).toBe(true);
  });

  it("an added REQUIRED query param is breaking (calls omitting it now fail)", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters!.push({ name: "tenant", in: "query", required: true, schema: { type: "string" } });
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_required_added", { operationId: "listPeople", path: "param:query:tenant" })).toBe(true);
  });

  it("an added REQUIRED request-body field is breaking", () => {
    const next = clone(BASE_DOC);
    const body = next.paths["/people"].post!.requestBody!.content["application/json"].schema;
    body.properties!.email = { type: "string" };
    body.required = ["name", "email"];
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(
      hasReason(a.reasons, "field_required_added", {
        operationId: "createPerson",
        path: "requestBody:application/json.email",
      }),
    ).toBe(true);
  });

  it("an added OPTIONAL request-body field is additive", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].post!.requestBody!.content["application/json"].schema.properties!.nickname = {
      type: "string",
    };
    expect(classify(next).breaking).toBe(false);
  });
});

// ── Named-schema field changes + schema removal ──────────────────────────────

describe("classifyBreakingChanges — schemas", () => {
  it("a removed named schema is breaking", () => {
    const next = clone(BASE_DOC);
    delete next.components.schemas.Unused;
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "schema_removed", { schema: "Unused" })).toBe(true);
  });

  it("a removed schema field is breaking", () => {
    const next = clone(BASE_DOC);
    delete next.components.schemas.Person.properties!.name;
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_removed", { schema: "Person", path: "name" })).toBe(true);
  });

  it("a retyped schema field is breaking (format change)", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.properties!.id.format = "int64"; // uuid -> int64
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_retyped", { schema: "Person", path: "id" })).toBe(true);
  });

  it("a re-targeted `$ref` join (retyped) is breaking", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Org = { type: "object", properties: { id: { type: "string" } } };
    next.components.schemas.Person.properties!.company = { $ref: "#/components/schemas/Org" };
    delete next.components.schemas.Company;
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_retyped", { schema: "Person", path: "company" })).toBe(true);
    // The removed `Company` component is also a breaking reason.
    expect(hasReason(a.reasons, "schema_removed", { schema: "Company" })).toBe(true);
  });

  it("a property losing `required` is a retype → breaking", () => {
    const next = clone(BASE_DOC);
    next.components.schemas.Person.required = []; // id was required
    const a = classify(next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_retyped", { schema: "Person", path: "id" })).toBe(true);
  });
});

// ── Mixed: breaking + additive coexist → breaking, reasons only for breaking ─

describe("classifyBreakingChanges — mixed changesets", () => {
  it("flags breaking even when additive changes are also present", () => {
    const next = clone(BASE_DOC);
    // ADDITIVE: a new optional param + a new operation.
    next.paths["/people"].get!.parameters!.push({ name: "q", in: "query", schema: { type: "string" } });
    next.paths["/orgs"] = {
      get: { operationId: "listOrgs", responses: { "200": { description: "ok" } } },
    };
    // BREAKING: a removed operation.
    delete next.paths["/people/{id}"];
    const a = classify(next);
    expect(a.breaking).toBe(true);
    // The only reasons are the breaking ones — additive adds nothing.
    expect(a.reasons.every((r) => r.kind === "operation_removed")).toBe(true);
    expect(hasReason(a.reasons, "operation_removed", { operationId: "getPerson" })).toBe(true);
  });

  it("an additive-only changeset reports not-breaking with no reasons", () => {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters!.push({ name: "q", in: "query", schema: { type: "string" } });
    next.components.schemas.Person.properties!.phone = { type: "string" };
    const a = classify(next);
    expect(a.breaking).toBe(false);
    expect(a.reasons).toEqual([]);
  });
});

// ── #3050: effective-required gating (optional containers + ref'd components) ─

describe("classifyBreakingChanges — effective-required gating (#3050)", () => {
  /** Classify the diff between two arbitrary docs (not clones of BASE_DOC). */
  function classifyBetween(prev: OpenApiDoc, next: OpenApiDoc) {
    return classifyBreakingChanges(diffOperationGraphs(graph(prev), graph(next)));
  }
  /** A doc with one POST whose request body wraps `bodySchema` at the given requiredness. */
  function postBodyDoc(bodyRequired: boolean, bodySchema: SchemaNode): OpenApiDoc {
    return {
      openapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      paths: {
        "/things": {
          post: {
            operationId: "createThing",
            requestBody: { required: bodyRequired, content: { "application/json": { schema: bodySchema } } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { schemas: {} },
    };
  }

  it("adding a required child to an OPTIONAL request body is additive", () => {
    const prev = postBodyDoc(false, { type: "object", required: ["a"], properties: { a: { type: "string" } } });
    const next = postBodyDoc(false, {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "string" } },
    });
    expect(classifyBetween(prev, next).breaking).toBe(false);
  });

  it("adding a required child under an OPTIONAL ancestor (in a required body) is additive", () => {
    // Body IS required, but `address` is optional → a caller omitting it keeps working.
    const addr = (zipRequired: boolean): SchemaNode => ({
      type: "object",
      ...(zipRequired ? { required: ["zip"] } : {}),
      properties: { street: { type: "string" }, ...(zipRequired ? { zip: { type: "string" } } : {}) },
    });
    const prev = postBodyDoc(true, { type: "object", required: [], properties: { address: addr(false) } });
    const next = postBodyDoc(true, { type: "object", required: [], properties: { address: addr(true) } });
    expect(classifyBetween(prev, next).breaking).toBe(false);
  });

  it("adding a required child under a REQUIRED ancestor (in a required body) IS breaking", () => {
    const addr = (zipRequired: boolean): SchemaNode => ({
      type: "object",
      ...(zipRequired ? { required: ["zip"] } : {}),
      properties: { street: { type: "string" }, ...(zipRequired ? { zip: { type: "string" } } : {}) },
    });
    const prev = postBodyDoc(true, { type: "object", required: ["address"], properties: { address: addr(false) } });
    const next = postBodyDoc(true, { type: "object", required: ["address"], properties: { address: addr(true) } });
    const a = classifyBetween(prev, next);
    expect(a.breaking).toBe(true);
    expect(
      hasReason(a.reasons, "field_required_added", {
        operationId: "createThing",
        path: "requestBody:application/json.address.zip",
      }),
    ).toBe(true);
  });

  /** A doc using `WidgetInput` only on a required request body — request-EXCLUSIVE. */
  function requestOnlyComponentDoc(inputRequired: string[], extraProp?: string): OpenApiDoc {
    const props: Record<string, SchemaNode> = { name: { type: "string" } };
    if (extraProp) props[extraProp] = { type: "string" };
    return {
      openapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      paths: {
        "/widgets": {
          post: {
            operationId: "createWidget",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/WidgetInput" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { schemas: { WidgetInput: { type: "object", required: inputRequired, properties: props } } },
    };
  }

  it("adding a required prop to a request-EXCLUSIVE component IS breaking", () => {
    const prev = requestOnlyComponentDoc(["name"]);
    const next = requestOnlyComponentDoc(["name", "sku"], "sku");
    const a = classifyBetween(prev, next);
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_required_added", { schema: "WidgetInput", path: "sku" })).toBe(true);
  });

  /** A doc using `Widget` on a response (and optionally also a required request body). */
  function widgetDoc(opts: { alsoRequest: boolean; required: string[]; extraProp?: string }): OpenApiDoc {
    const props: Record<string, SchemaNode> = { id: { type: "string" } };
    if (opts.extraProp) props[opts.extraProp] = { type: "string" };
    const paths: Record<string, PathItem> = {
      "/widgets/{id}": {
        get: {
          operationId: "getWidget",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Widget" } } },
            },
          },
        },
      },
    };
    if (opts.alsoRequest) {
      paths["/widgets"] = {
        post: {
          operationId: "createWidget",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Widget" } } },
          },
          responses: { "200": { description: "ok" } },
        },
      };
    }
    return {
      openapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      paths,
      components: { schemas: { Widget: { type: "object", required: opts.required, properties: props } } },
    };
  }

  it("adding a required prop to a RESPONSE-reachable component stays quiet (no false positive)", () => {
    const prev = widgetDoc({ alsoRequest: false, required: ["id"] });
    const next = widgetDoc({ alsoRequest: false, required: ["id", "color"], extraProp: "color" });
    expect(classifyBetween(prev, next).breaking).toBe(false);
  });

  it("a component used by BOTH a required request body AND a response stays quiet on added-required", () => {
    // Response reachability dominates: the conservative policy keeps an ambiguous
    // (read-too) surface quiet rather than nagging on a benign response-shape growth.
    const prev = widgetDoc({ alsoRequest: true, required: ["id"] });
    const next = widgetDoc({ alsoRequest: true, required: ["id", "sku"], extraProp: "sku" });
    expect(classifyBetween(prev, next).breaking).toBe(false);
  });

  // ── chain-propagation edges: items + allOf preserve, oneOf/anyOf break ───────

  it("a required field added under an array's items (in a required body) IS breaking", () => {
    // "array present ⟹ its elements present" — the chain propagates through items.
    const items = (zip: boolean): SchemaNode => ({
      type: "object",
      ...(zip ? { required: ["zip"] } : {}),
      properties: { street: { type: "string" }, ...(zip ? { zip: { type: "string" } } : {}) },
    });
    const body = (zip: boolean): SchemaNode => ({
      type: "object",
      required: ["tags"],
      properties: { tags: { type: "array", items: items(zip) } },
    });
    const a = classifyBetween(postBodyDoc(true, body(false)), postBodyDoc(true, body(true)));
    expect(a.breaking).toBe(true);
    expect(
      hasReason(a.reasons, "field_required_added", {
        operationId: "createThing",
        path: "requestBody:application/json.tags[].zip",
      }),
    ).toBe(true);
  });

  it("a required field added under an allOf branch (in a required body) IS breaking", () => {
    // allOf is an intersection — every branch applies, so the chain is preserved.
    const body = (zip: boolean): SchemaNode => ({
      allOf: [
        { type: "object", ...(zip ? { required: ["zip"] } : {}), properties: zip ? { zip: { type: "string" } } : {} },
      ],
    });
    const a = classifyBetween(postBodyDoc(true, body(false)), postBodyDoc(true, body(true)));
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_required_added", { operationId: "createThing" })).toBe(true);
  });

  it("a required field added under a oneOf branch (in a required body) is additive", () => {
    // oneOf is a union — a branch member is not guaranteed present, so the chain breaks.
    const body = (sku: boolean): SchemaNode => ({
      oneOf: [
        { type: "object", ...(sku ? { required: ["sku"] } : {}), properties: sku ? { sku: { type: "string" } } : {} },
      ],
    });
    expect(classifyBetween(postBodyDoc(true, body(false)), postBodyDoc(true, body(true))).breaking).toBe(false);
  });

  // ── cyclic $ref must terminate (the Twenty Person↔NoteTarget shape) ──────────

  it("a self-referential request-exclusive component terminates AND flags an added-required prop", () => {
    // `Node.child` -> $ref Node is a cycle; the reachability walk's visited-set guard
    // must terminate. Node is request-exclusive (required body $ref, never a response).
    const nodeDoc = (sku: boolean): OpenApiDoc => ({
      openapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      paths: {
        "/nodes": {
          post: {
            operationId: "createNode",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            required: sku ? ["child", "sku"] : ["child"],
            properties: {
              child: { $ref: "#/components/schemas/Node" },
              ...(sku ? { sku: { type: "string" } } : {}),
            },
          },
        },
      },
    });
    const a = classifyBetween(nodeDoc(false), nodeDoc(true));
    expect(a.breaking).toBe(true);
    expect(hasReason(a.reasons, "field_required_added", { schema: "Node", path: "sku" })).toBe(true);
  });

  // ── AC4: a dotted media type must not break the (now path-parse-free) verdict ─

  it("a required field under a dotted media type (application/vnd.api+json) IS breaking", () => {
    // Pins AC4: the verdict reads `effectiveRequired`, never parses the dotted path —
    // a media type containing `.`/`+` can't desync the request-surface determination.
    const doc = (zip: boolean): OpenApiDoc => ({
      openapi: "3.0.0",
      info: { title: "T", version: "1.0.0" },
      paths: {
        "/things": {
          post: {
            operationId: "createThing",
            requestBody: {
              required: true,
              content: {
                "application/vnd.api+json": {
                  schema: {
                    type: "object",
                    required: ["address"],
                    properties: {
                      address: {
                        type: "object",
                        ...(zip ? { required: ["zip"] } : {}),
                        properties: { street: { type: "string" }, ...(zip ? { zip: { type: "string" } } : {}) },
                      },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { schemas: {} },
    });
    const a = classifyBetween(doc(false), doc(true));
    expect(a.breaking).toBe(true);
    expect(
      hasReason(a.reasons, "field_required_added", {
        operationId: "createThing",
        path: "requestBody:application/vnd.api+json.address.zip",
      }),
    ).toBe(true);
  });
});

// ── resolveDriftAlertWrite — the trigger-aware raise/clear/leave lifecycle ────

describe("resolveDriftAlertWrite — signal lifecycle decision", () => {
  const PROBED_AT = "2026-05-31T00:00:00.000Z";
  const RAISED_AT = "2026-05-31T01:00:00.000Z";

  /** A persisted record whose `diff` is the breaking diff of removing getPerson. */
  function breakingRecord(): SpecDiffRecord {
    const next = clone(BASE_DOC);
    delete next.paths["/people/{id}"];
    return { previousProbedAt: "2026-05-30T00:00:00.000Z", currentProbedAt: PROBED_AT, diff: diffOperationGraphs(graph(clone(BASE_DOC)), graph(next)) };
  }
  /** A persisted record whose `diff` is additive-only (a new optional param). */
  function additiveRecord(): SpecDiffRecord {
    const next = clone(BASE_DOC);
    next.paths["/people"].get!.parameters!.push({ name: "q", in: "query", schema: { type: "string" } });
    return { previousProbedAt: "2026-05-30T00:00:00.000Z", currentProbedAt: PROBED_AT, diff: diffOperationGraphs(graph(clone(BASE_DOC)), graph(next)) };
  }
  /** A clean record — re-probe moved nothing. */
  function unchangedRecord(): SpecDiffRecord {
    return { previousProbedAt: "2026-05-30T00:00:00.000Z", currentProbedAt: PROBED_AT, diff: diffOperationGraphs(graph(clone(BASE_DOC)), graph(clone(BASE_DOC))) };
  }
  /** A first-ever / unparseable baseline — no comparison ran. */
  const baselineRecord: SpecDiffRecord = { previousProbedAt: null, currentProbedAt: PROBED_AT, diff: null };

  it("RAISES on breaking drift from the SCHEDULED path", () => {
    const { assessment, write } = resolveDriftAlertWrite(breakingRecord(), "scheduled", RAISED_AT);
    expect(assessment.breaking).toBe(true);
    expect(write.op).toBe("raise");
    if (write.op === "raise") {
      expect(write.record.raisedAt).toBe(RAISED_AT);
      expect(write.record.currentProbedAt).toBe(PROBED_AT);
      expect(write.record.acknowledgedAt).toBeNull();
      expect(write.record.breakingCount).toBeGreaterThan(0);
      expect(write.record.reasons.length).toBeGreaterThan(0);
    }
  });

  it("does NOT raise on breaking drift from the MANUAL path — leaves any standing signal", () => {
    const { assessment, write } = resolveDriftAlertWrite(breakingRecord(), "manual", RAISED_AT);
    expect(assessment.breaking).toBe(true);
    expect(write.op).toBe("leave");
  });

  it("CLEARS on an additive-only refresh (manual and scheduled alike)", () => {
    for (const trigger of ["manual", "scheduled"] as const) {
      const { assessment, write } = resolveDriftAlertWrite(additiveRecord(), trigger, RAISED_AT);
      expect(assessment.breaking).toBe(false);
      expect(write.op).toBe("clear");
    }
  });

  it("CLEARS on a clean (unchanged) refresh", () => {
    const { write } = resolveDriftAlertWrite(unchangedRecord(), "scheduled", RAISED_AT);
    expect(write.op).toBe("clear");
  });

  it("LEAVES a baseline (first-ever / unparseable prior) — no comparison to clear or raise", () => {
    expect(resolveDriftAlertWrite(baselineRecord, "scheduled", RAISED_AT).write.op).toBe("leave");
    expect(resolveDriftAlertWrite(baselineRecord, "manual", RAISED_AT).write.op).toBe("leave");
  });

  it("caps the stored reasons sample while recording the true total in breakingCount", () => {
    // Remove many operations at once → far more breaking reasons than the cap.
    const next = clone(BASE_DOC);
    const big = clone(BASE_DOC);
    for (let i = 0; i < MAX_STORED_DRIFT_REASONS + 10; i++) {
      const id = `extra${i}`;
      big.paths[`/extra${i}`] = { get: { operationId: id, responses: { "200": { description: "ok" } } } };
    }
    // Prior has all the extras; next (BASE) has none → all removed = breaking.
    const record: SpecDiffRecord = {
      previousProbedAt: "2026-05-30T00:00:00.000Z",
      currentProbedAt: PROBED_AT,
      diff: diffOperationGraphs(graph(big), graph(clone(next))),
    };
    const { write } = resolveDriftAlertWrite(record, "scheduled", RAISED_AT);
    expect(write.op).toBe("raise");
    if (write.op === "raise") {
      expect(write.record.reasons.length).toBe(MAX_STORED_DRIFT_REASONS);
      expect(write.record.breakingCount).toBeGreaterThan(MAX_STORED_DRIFT_REASONS);
    }
  });
});

// ── projectDriftAlert — fail-soft JSONB read-back ────────────────────────────

describe("projectDriftAlert — fail-soft persistence projection", () => {
  const VALID: SpecDiffRecord = (() => {
    const next = clone(BASE_DOC);
    delete next.paths["/people/{id}"];
    return { previousProbedAt: "2026-05-30T00:00:00.000Z", currentProbedAt: "2026-05-31T00:00:00.000Z", diff: diffOperationGraphs(graph(clone(BASE_DOC)), graph(next)) };
  })();
  const assessment = classifyBreakingChanges(VALID.diff!);
  const record = buildDriftAlertRecord(VALID, assessment, "2026-05-31T01:00:00.000Z");

  it("projects a freshly-built record round-trip", () => {
    const s = projectDriftAlert(JSON.parse(JSON.stringify(record)));
    expect(s).not.toBeNull();
    expect(s?.acknowledgedAt).toBeNull();
    expect(s?.breakingCount).toBe(assessment.reasons.length);
    expect(s?.reasons.length).toBe(assessment.reasons.length);
    expect(s?.reasons[0].kind).toBe("operation_removed");
  });

  it("carries through an acknowledged timestamp", () => {
    const acked = { ...record, acknowledgedAt: "2026-05-31T02:00:00.000Z" };
    expect(projectDriftAlert(acked)?.acknowledgedAt).toBe("2026-05-31T02:00:00.000Z");
  });

  it("returns null for absent / cleared / malformed values rather than rendering garbage", () => {
    expect(projectDriftAlert(undefined)).toBeNull();
    expect(projectDriftAlert(null)).toBeNull(); // a JSON-null clear
    expect(projectDriftAlert("nope")).toBeNull();
    expect(projectDriftAlert({})).toBeNull(); // no raisedAt / currentProbedAt
    expect(projectDriftAlert({ raisedAt: "x" })).toBeNull(); // no currentProbedAt
  });

  it("degrades secondary fields (counts/reasons) to safe defaults without nulling the signal", () => {
    const s = projectDriftAlert({ raisedAt: "x", currentProbedAt: "y", counts: "bad", reasons: "bad" });
    expect(s).not.toBeNull();
    expect(s?.counts.operationsRemoved).toBe(0);
    expect(s?.reasons).toEqual([]);
    expect(s?.breakingCount).toBe(0);
  });

  it("drops malformed reason entries but keeps well-formed ones", () => {
    const s = projectDriftAlert({
      raisedAt: "x",
      currentProbedAt: "y",
      reasons: [
        { kind: "operation_removed", operationId: "getThing", detail: "gone" },
        { kind: "not_a_real_kind", detail: "ignored" },
        { detail: "no kind" },
        "junk",
      ],
    });
    expect(s?.reasons).toHaveLength(1);
    expect(s?.reasons[0].operationId).toBe("getThing");
  });

  it("clamps negative / fractional counts to non-negative integers", () => {
    const s = projectDriftAlert({
      raisedAt: "x",
      currentProbedAt: "y",
      counts: { operationsRemoved: -5, fieldsRetyped: 2.9, schemasAdded: 3 },
      breakingCount: -1,
    });
    expect(s?.counts.operationsRemoved).toBe(0);
    expect(s?.counts.fieldsRetyped).toBe(2);
    expect(s?.counts.schemasAdded).toBe(3);
    // breakingCount clamps to a non-negative int (not the reasons-length fallback).
    expect(s?.breakingCount).toBe(0);
  });

  it("caps an oversized reasons array at MAX_STORED_DRIFT_REASONS", () => {
    const reasons = Array.from({ length: MAX_STORED_DRIFT_REASONS + 25 }, (_, i) => ({
      kind: "operation_removed",
      operationId: `op${i}`,
      detail: "gone",
    }));
    const s = projectDriftAlert({ raisedAt: "x", currentProbedAt: "y", reasons });
    expect(s?.reasons).toHaveLength(MAX_STORED_DRIFT_REASONS);
  });

  it("truncates an oversized reason string field", () => {
    const s = projectDriftAlert({
      raisedAt: "x",
      currentProbedAt: "y",
      reasons: [{ kind: "operation_removed", operationId: "getThing", detail: "z".repeat(5_000) }],
    });
    expect(s?.reasons[0].detail.length).toBeLessThanOrEqual(500);
  });
});
