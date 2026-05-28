import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import {
  OpenApiSpecError,
  type OpenApiSchema,
  type OpenApiSchemaInline,
  type OpenApiSpecErrorReason,
} from "../types";

const FIXTURES = path.join(import.meta.dir, "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

/**
 * Narrow a schema node to its inline arm, asserting it is NOT a `$ref` pointer.
 * Doubles as a test assertion: every call site genuinely expects an inline
 * schema, and the union forces the ref-vs-inline decision to be explicit.
 */
function inline(schema: OpenApiSchema | undefined): OpenApiSchemaInline {
  if (!schema || schema.ref !== undefined) {
    throw new Error(`expected an inline schema, got ${JSON.stringify(schema)}`);
  }
  return schema;
}

describe("buildOperationGraph — minimal corpus", () => {
  const graph = buildOperationGraph(loadFixture("minimal"));

  it("lists every operation keyed by operationId", () => {
    expect([...graph.operations.keys()].toSorted()).toEqual([
      "createWidget",
      "getWidget",
      "listWidgets",
    ]);
  });

  it("registers every named schema and tags each with its name", () => {
    expect([...graph.schemas.keys()].toSorted()).toEqual(["Gadget", "Widget"]);
    expect(graph.schemas.get("Widget")?.name).toBe("Widget");
  });

  it("resolves a $ref to a finite pointer, keeping circular relationships traversable", () => {
    // Widget.owner -> Gadget, Gadget.widgets[] -> Widget is a cycle. A pointer
    // model keeps the graph finite while letting a consumer follow the join.
    const widget = graph.schemas.get("Widget");
    const ownerProp = inline(widget).properties?.get("owner");
    expect(ownerProp).toEqual({ ref: "Gadget" });

    const gadget = graph.schemas.get(ownerProp!.ref!);
    expect(inline(inline(gadget).properties?.get("widgets")).items).toEqual({ ref: "Widget" });

    // Following the cycle back to Widget terminates — same object, no recursion.
    expect(graph.schemas.get("Widget")).toBe(widget);
  });

  it("carries operation method, path, and required-path-param metadata", () => {
    const getWidget = graph.operations.get("getWidget");
    expect(getWidget?.method).toBe("GET");
    expect(getWidget?.path).toBe("/widgets/{id}");
    const idParam = getWidget?.parameters.find((p) => p.name === "id");
    expect(idParam).toMatchObject({ in: "path", required: true });
  });

  it("merges path-level and operation-level parameters via $ref", () => {
    // `limit` comes from the path-level `$ref: LimitParam`; `tag` is op-level.
    const listWidgets = graph.operations.get("listWidgets");
    const names = listWidgets?.parameters.map((p) => p.name).toSorted();
    expect(names).toEqual(["limit", "tag"]);
  });

  it("normalizes security schemes and per-operation requirements", () => {
    expect(graph.security.get("bearerAuth")).toMatchObject({
      kind: "bearer",
      bearerFormat: "JWT",
    });
    expect(graph.security.get("apiKeyHeader")).toMatchObject({
      kind: "apiKey-header",
      parameterName: "X-API-Key",
    });
    // listWidgets inherits the document-level default (bearerAuth).
    expect(graph.operations.get("listWidgets")?.security).toEqual(["bearerAuth"]);
    // createWidget overrides with its own apiKeyHeader requirement.
    expect(graph.operations.get("createWidget")?.security).toEqual(["apiKeyHeader"]);
  });

  it("captures servers and spec info", () => {
    expect(graph.servers[0]?.url).toBe("https://api.widgets.example/v1");
    expect(graph.info).toMatchObject({ title: "Minimal Widgets API", openapiVersion: "3.0.3" });
  });
});

describe("buildOperationGraph — Twenty /rest/open-api/core corpus", () => {
  const graph = buildOperationGraph(loadFixture("twenty-core.excerpt"));

  it("lists every Person operation", () => {
    const personOps = [...graph.operations.values()]
      .filter((op) => op.path === "/people" || op.path.startsWith("/people/"))
      .map((op) => op.operationId)
      .toSorted();
    expect(personOps).toEqual([
      "createOnePerson",
      "deleteOnePerson",
      "findManyPeople",
      "findOnePerson",
      "updateOnePerson",
    ]);
  });

  it("resolves the Person ↔ NoteTarget $ref relationship in both directions", () => {
    // Person → noteTargets[] → NoteTarget
    const person = graph.schemas.get("Person");
    const noteTargetsItem = inline(inline(person).properties?.get("noteTargets")).items;
    expect(noteTargetsItem).toEqual({ ref: "NoteTarget" });

    const noteTarget = inline(graph.schemas.get(noteTargetsItem!.ref!));
    // NoteTarget → person → Person (back-reference completing the cycle)
    expect(noteTarget.properties?.get("person")).toEqual({ ref: "Person" });
    // NoteTarget → note → Note
    expect(noteTarget.properties?.get("note")).toEqual({ ref: "Note" });
    // The join column is targetPersonId (NOT personId — the jezweb trap).
    expect(noteTarget.properties?.has("targetPersonId")).toBe(true);
    expect(noteTarget.properties?.has("personId")).toBe(false);
  });

  it("inlines Atlas custom fields as siblings of standard fields (no customFields wrapper)", () => {
    const person = inline(graph.schemas.get("Person"));
    expect(person.properties?.has("atlasFirstSource")).toBe(true);
    expect(person.properties?.has("customFields")).toBe(false);
  });

  it("resolves the reusable filter parameter onto list operations", () => {
    const findMany = graph.operations.get("findManyPeople");
    const filterParam = findMany?.parameters.find((p) => p.name === "filter");
    expect(filterParam?.in).toBe("query");
    expect(filterParam?.description).toContain("field[COMPARATOR]:value");
  });

  it("merges the path-level id param into every /people/{id} operation", () => {
    for (const opId of ["findOnePerson", "updateOnePerson", "deleteOnePerson"]) {
      const op = graph.operations.get(opId);
      const idParam = op?.parameters.find((p) => p.name === "id");
      expect(idParam, `${opId} should carry the path-level id param`).toMatchObject({
        in: "path",
        required: true,
      });
    }
  });

  it("normalizes request bodies on write operations", () => {
    const create = graph.operations.get("createOnePerson");
    expect(create?.requestBody?.required).toBe(true);
    expect(create?.requestBody?.content.get("application/json")).toEqual({ ref: "Person" });
  });
});

describe("buildOperationGraph — Stripe corpus", () => {
  const graph = buildOperationGraph(loadFixture("stripe.excerpt"));

  it("normalizes operations with PascalCase operationIds", () => {
    expect([...graph.operations.keys()].toSorted()).toEqual([
      "GetCustomers",
      "GetCustomersCustomer",
      "PostCustomers",
    ]);
  });

  it("flattens OR-form security (basic | bearer) to both scheme names", () => {
    expect(graph.security.get("basicAuth")?.kind).toBe("basic");
    expect(graph.security.get("bearerAuth")?.kind).toBe("bearer");
    expect(graph.operations.get("GetCustomers")?.security).toEqual(["basicAuth", "bearerAuth"]);
  });

  it("models array-typed query params (Stripe's expand[])", () => {
    const expand = graph.operations
      .get("GetCustomers")
      ?.parameters.find((p) => p.name === "expand");
    const expandSchema = inline(expand?.schema);
    expect(expandSchema.type).toBe("array");
    expect(inline(expandSchema.items).type).toBe("string");
  });

  it("keys request body content by media type, including non-JSON", () => {
    const body = graph.operations.get("PostCustomers")?.requestBody;
    expect([...(body?.content.keys() ?? [])]).toEqual(["application/x-www-form-urlencoded"]);
  });

  it("walks anyOf composition with resolved $ref pointers", () => {
    const customer = inline(graph.schemas.get("customer"));
    const addressProp = inline(customer.properties?.get("address"));
    expect(addressProp.nullable).toBe(true);
    expect(addressProp.anyOf).toEqual([{ ref: "address" }]);
  });
});

describe("buildOperationGraph — fail-loud resilience (PRD risk R1)", () => {
  /** Assert the call throws an OpenApiSpecError carrying the expected reason + location. */
  function expectSpecError(doc: unknown, reason: OpenApiSpecErrorReason): OpenApiSpecError {
    let caught: unknown;
    try {
      buildOperationGraph(doc);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenApiSpecError);
    const specErr = caught as OpenApiSpecError;
    expect(specErr.reason).toBe(reason);
    // Actionable: the message is non-trivial and names what was wrong.
    expect(specErr.message.length).toBeGreaterThan(20);
    return specErr;
  }

  it("rejects a non-object document", () => {
    expectSpecError(null, "not-an-object");
    expectSpecError("not a spec", "not-an-object");
    expectSpecError([], "not-an-object");
  });

  it("rejects Swagger 2.0 / missing version", () => {
    expectSpecError({ swagger: "2.0", paths: {} }, "unsupported-version");
    expectSpecError({ paths: {} }, "unsupported-version");
  });

  it("rejects a document with no paths object", () => {
    expectSpecError({ openapi: "3.0.0" }, "missing-paths");
  });

  it("rejects an operation missing operationId, naming the path", () => {
    const err = expectSpecError(
      { openapi: "3.0.0", paths: { "/x": { get: { responses: {} } } } },
      "missing-operation-id",
    );
    expect(err.location).toBe("paths./x.get");
  });

  it("rejects duplicate operationIds", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        paths: {
          "/a": { get: { operationId: "dup", responses: {} } },
          "/b": { get: { operationId: "dup", responses: {} } },
        },
      },
      "duplicate-operation-id",
    );
  });

  it("rejects a $ref whose target does not exist", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        components: { schemas: { A: { properties: { b: { $ref: "#/components/schemas/Missing" } } } } },
        paths: {},
      },
      "unresolved-ref",
    );
  });

  it("rejects an unsupported (external / non-component) $ref", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        components: { schemas: { A: { properties: { b: { $ref: "other.json#/X" } } } } },
        paths: {},
      },
      "unsupported-ref",
    );
  });

  it("rejects malformed security schemes", () => {
    expectSpecError(
      { openapi: "3.0.0", components: { securitySchemes: { x: { type: "apiKey", in: "header" } } }, paths: {} },
      "invalid-security-scheme",
    );
    expectSpecError(
      { openapi: "3.0.0", components: { securitySchemes: { x: { type: "carrier-pigeon" } } }, paths: {} },
      "invalid-security-scheme",
    );
    expectSpecError(
      { openapi: "3.0.0", components: { securitySchemes: { x: { type: "http", scheme: "digest" } } }, paths: {} },
      "invalid-security-scheme",
    );
  });

  it("rejects an operation referencing an undeclared security scheme", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        paths: { "/x": { get: { operationId: "x", security: [{ ghost: [] }], responses: {} } } },
      },
      "unknown-security-requirement",
    );
  });

  it("rejects a parameter missing name or in", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        paths: { "/x": { get: { operationId: "x", parameters: [{ in: "query" }], responses: {} } } },
      },
      "invalid-parameter",
    );
  });

  it("rejects a malformed (non-object) schema node", () => {
    expectSpecError(
      { openapi: "3.0.0", components: { schemas: { A: { properties: { b: 42 } } } }, paths: {} },
      "invalid-structure",
    );
  });

  it("rejects a non-object operation under a method key", () => {
    expectSpecError(
      { openapi: "3.0.0", paths: { "/x": { get: "GET" } } },
      "invalid-structure",
    );
  });

  it("rejects a malformed (non-object) response node", () => {
    expectSpecError(
      { openapi: "3.0.0", paths: { "/x": { get: { operationId: "x", responses: { "200": 5 } } } } },
      "invalid-structure",
    );
  });

  it("rejects a malformed (non-object) media-type entry", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        paths: {
          "/x": {
            get: { operationId: "x", responses: { "200": { description: "ok", content: { "application/json": 5 } } } },
          },
        },
      },
      "invalid-structure",
    );
  });

  it("rejects a non-object security requirement entry (string instead of object — a false-negative trap)", () => {
    expectSpecError(
      {
        openapi: "3.0.0",
        components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
        paths: { "/x": { get: { operationId: "x", security: ["bearerAuth"], responses: {} } } },
      },
      "invalid-structure",
    );
  });

  it("rejects a non-object path item", () => {
    expectSpecError({ openapi: "3.0.0", paths: { "/x": 5 } }, "invalid-structure");
  });

  it("rejects a path-item-level $ref (unsupported in this slice)", () => {
    expectSpecError(
      { openapi: "3.0.0", paths: { "/x": { $ref: "#/components/pathItems/Y" } } },
      "unsupported-ref",
    );
  });

  it("ignores vendor extensions (x-*) rather than failing", () => {
    // Stripe / Twenty are full of x- keys; rejecting them would make those
    // corpora unparseable. They must be silently ignored.
    const graph = buildOperationGraph({
      openapi: "3.0.0",
      "x-vendor-thing": { whatever: true },
      info: { title: "t", version: "1", "x-logo": {} },
      paths: {
        "x-speakeasy-ignore": true,
        "/x": {
          "x-internal": true,
          get: { operationId: "x", "x-codegen": "skip", responses: {} },
        },
      },
    });
    expect([...graph.operations.keys()]).toEqual(["x"]);
  });
});

describe("buildOperationGraph — reference & edge normalization", () => {
  it("resolves a requestBody $ref into components.requestBodies", () => {
    const graph = buildOperationGraph({
      openapi: "3.0.0",
      components: {
        schemas: { Pet: { type: "object", properties: { id: { type: "string" } } } },
        requestBodies: {
          PetBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: { $ref: "#/components/requestBodies/PetBody" },
            responses: { "201": { description: "created" } },
          },
        },
      },
    });
    const body = graph.operations.get("createPet")?.requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content.get("application/json")).toEqual({ ref: "Pet" });
  });

  it("resolves a response $ref into components.responses", () => {
    const graph = buildOperationGraph({
      openapi: "3.0.0",
      components: {
        schemas: { Err: { type: "object", properties: { message: { type: "string" } } } },
        responses: {
          NotFound: {
            description: "missing",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Err" } } },
          },
        },
      },
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: { "404": { $ref: "#/components/responses/NotFound" } },
          },
        },
      },
    });
    const resp = graph.operations.get("x")?.responses.get("404");
    expect(resp?.description).toBe("missing");
    expect(resp?.content.get("application/json")).toEqual({ ref: "Err" });
  });

  it("rejects a requestBody $ref pointing at the wrong component section", () => {
    let caught: unknown;
    try {
      buildOperationGraph({
        openapi: "3.0.0",
        components: { schemas: { Pet: { type: "object" } } },
        paths: {
          "/pets": {
            post: {
              operationId: "createPet",
              requestBody: { $ref: "#/components/schemas/Pet" },
              responses: {},
            },
          },
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenApiSpecError);
    expect((caught as OpenApiSpecError).reason).toBe("unsupported-ref");
  });

  it("treats an explicit document-level security: [] as 'no auth' for inheriting operations", () => {
    const graph = buildOperationGraph({
      openapi: "3.0.0",
      security: [],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
      paths: { "/x": { get: { operationId: "x", responses: {} } } },
    });
    expect(graph.operations.get("x")?.security).toEqual([]);
  });

  it("normalizes OpenAPI 3.1 type:[..,'null'] into type + nullable", () => {
    const graph = buildOperationGraph({
      openapi: "3.1.0",
      components: {
        schemas: {
          Thing: {
            type: "object",
            properties: { email: { type: ["string", "null"] } },
          },
        },
      },
      paths: {},
    });
    const thing = inline(graph.schemas.get("Thing"));
    const email = inline(thing.properties?.get("email"));
    expect(email.type).toBe("string");
    expect(email.nullable).toBe(true);
  });

  it("normalizes in:cookie parameters into the graph (execution deferred)", () => {
    const graph = buildOperationGraph({
      openapi: "3.0.0",
      paths: {
        "/x": {
          get: {
            operationId: "x",
            parameters: [{ name: "sid", in: "cookie", required: false, schema: { type: "string" } }],
            responses: {},
          },
        },
      },
    });
    const param = graph.operations.get("x")?.parameters.find((p) => p.name === "sid");
    expect(param?.in).toBe("cookie");
  });

  it("normalizes oauth2 / openIdConnect schemes without throwing (flows deferred to slice 6)", () => {
    const graph = buildOperationGraph({
      openapi: "3.0.0",
      components: {
        securitySchemes: {
          oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://x/token", scopes: {} } } },
          oidc: { type: "openIdConnect", openIdConnectUrl: "https://x/.well-known" },
        },
      },
      paths: {},
    });
    expect(graph.security.get("oauth")?.kind).toBe("oauth2");
    expect(graph.security.get("oidc")?.kind).toBe("openIdConnect");
  });
});
