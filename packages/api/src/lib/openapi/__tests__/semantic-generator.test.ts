/**
 * `openapi-semantic-generator` tests (#2931) — Path B of the representation
 * bake-off.
 *
 *  1. **Golden tests** — feed Twenty's fixture spec, assert the rendered YAML
 *     for Person / Company / Note (the AC-named entities) matches the committed
 *     golden byte-for-byte. Goldens are regenerated ONLY via the explicit
 *     `bun run openapi:regen-goldens` command, never automatically — a generator
 *     change shows up as a reviewable golden diff.
 *  2. **Structural assertions** — the four Twenty traps survive the entity walk
 *     (filter syntax, targetPersonId join column, inline custom fields,
 *     bodyV2.markdown), and envelope schemas are NOT promoted to entities.
 *  3. **Generalization check** — the SAME walk runs against a second, non-Twenty
 *     hand-crafted spec so the generator isn't Twenty-overfit (the bake-off
 *     report flags any Twenty-only path).
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { buildOperationGraph } from "../spec";
import {
  generateSemanticModel,
  renderEntityYaml,
  renderModelYaml,
  type GeneratedEntity,
  type OpenApiSemanticModel,
} from "../semantic-generator";

const SPEC = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "twenty-acceptance", "spec.json"), "utf8"),
);
const graph = buildOperationGraph(SPEC);
const model = generateSemanticModel(graph);

const GOLDEN_DIR = path.join(import.meta.dir, "semantic-generator", "golden");
const readGolden = (name: string) => fs.readFileSync(path.join(GOLDEN_DIR, `${name}.yml`), "utf8");
const entityNamed = (m: OpenApiSemanticModel, name: string): GeneratedEntity => {
  const e = m.entities.find((x) => x.name === name);
  if (!e) throw new Error(`entity ${name} not generated (got: ${m.entities.map((x) => x.name).join(", ")})`);
  return e;
};

// ─────────────────────────────────────────────────────────────────────
//  1. Golden tests
// ─────────────────────────────────────────────────────────────────────
describe("openapi-semantic-generator — golden YAML (Twenty fixture)", () => {
  // The AC names Person / Company / Note; NoteTarget is included too because it
  // carries the targetPersonId join trap.
  for (const name of ["Person", "Company", "Note", "NoteTarget"]) {
    it(`renders ${name} exactly as the committed golden`, () => {
      const entity = entityNamed(model, name);
      expect(renderEntityYaml(entity)).toBe(readGolden(name));
    });
  }

  it("renderModelYaml concatenates every entity as a --- separated document", () => {
    const rendered = renderModelYaml(model);
    expect(rendered).toContain("name: Person");
    expect(rendered).toContain("name: Company");
    expect(rendered.match(/\n---\n/g) ?? []).toHaveLength(model.entities.length - 1);
  });

  it("the golden dir contains exactly the generated entities (no stale files)", () => {
    const onDisk = fs
      .readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => f.replace(/\.yml$/, ""))
      .toSorted();
    expect(onDisk).toEqual(model.entities.map((e) => e.name).toSorted());
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. Structural assertions (entity model + the four traps)
// ─────────────────────────────────────────────────────────────────────
describe("openapi-semantic-generator — entity model", () => {
  it("groups operations into one entity per REST resource (not one per schema)", () => {
    expect(model.entities.map((e) => e.name).toSorted()).toEqual([
      "Company",
      "Note",
      "NoteTarget",
      "Person",
    ]);
  });

  it("does NOT promote response-envelope schemas to entities", () => {
    expect(model.supportingSchemas).toContain("PersonListResponse");
    expect(model.supportingSchemas).toContain("PersonResponse");
    for (const env of ["PersonListResponse", "PersonResponse"]) {
      expect(model.entities.some((e) => e.name === env)).toBe(false);
    }
  });

  it("resolves the record schema across naming conventions (irregular plural + no-body resource)", () => {
    // people -> Person resolves via the create/update request body (irregular plural).
    expect(entityNamed(model, "Person").recordSchema).toBe("Person");
    // companies -> Company resolves via the operationId (findManyCompanies),
    // since /companies has no request body and no typed response.
    expect(entityNamed(model, "Company").recordSchema).toBe("Company");
  });

  it("attaches the reading/writing operations to each entity with a writes flag", () => {
    const person = entityNamed(model, "Person");
    const ids = person.operations.map((o) => o.operationId).toSorted();
    expect(ids).toEqual([
      "createOnePerson",
      "deleteOnePerson",
      "findManyPeople",
      "findOnePerson",
      "updateOnePerson",
    ]);
    const findMany = person.operations.find((o) => o.operationId === "findManyPeople");
    expect(findMany?.kind).toBe("list");
    expect(findMany?.writes).toBe(false);
    expect(person.operations.find((o) => o.operationId === "createOnePerson")?.writes).toBe(true);
    expect(person.operations.find((o) => o.operationId === "findOnePerson")?.kind).toBe("get");
  });

  // ── The four Twenty traps survive the entity walk ──────────────────
  it("TRAP 1 — the filter syntax is captured once at the datasource level", () => {
    expect(model.filterSyntax).toContain("field[COMPARATOR]:value");
    expect(model.filterSyntax).toContain("emails.primaryEmail[eq]:foo@example.com");
  });

  it("TRAP 2 — NoteTarget exposes targetPersonId as a column and joins Person via `person`", () => {
    const nt = entityNamed(model, "NoteTarget");
    const colNames = nt.columns.map((c) => c.name);
    expect(colNames).toContain("targetPersonId");
    // It must NOT invent a bare personId join column (the jezweb trap).
    expect(colNames).not.toContain("personId");
    const personJoin = nt.joins.find((j) => j.targetEntity === "Person");
    expect(personJoin?.via).toBe("person");
    expect(nt.joins.find((j) => j.targetEntity === "Note")?.relationship).toBe("many_to_one");
  });

  it("TRAP 3 — Atlas custom fields are inline columns on Person (no customFields wrapper)", () => {
    const person = entityNamed(model, "Person");
    const colNames = person.columns.map((c) => c.name);
    expect(colNames).toContain("atlasFirstSource");
    expect(colNames).toContain("atlasLastSource");
    expect(colNames).toContain("atlasStripeCustomerId");
    expect(colNames.some((n) => n.includes("customFields"))).toBe(false);
  });

  it("TRAP 4 — note bodies flatten to bodyV2.markdown, carrying the parent's guidance", () => {
    const note = entityNamed(model, "Note");
    const colNames = note.columns.map((c) => c.name);
    expect(colNames).toContain("bodyV2.markdown");
    const parent = note.columns.find((c) => c.name === "bodyV2");
    expect(parent?.description).toContain("bodyV2.markdown");
  });

  it("flattens nested objects one level (emails.primaryEmail, name.firstName)", () => {
    const colNames = entityNamed(model, "Person").columns.map((c) => c.name);
    expect(colNames).toContain("emails.primaryEmail");
    expect(colNames).toContain("name.firstName");
    expect(colNames).toContain("emails.additionalEmails");
  });

  it("renders $ref array properties as one_to_many joins (Person -> NoteTarget)", () => {
    const person = entityNamed(model, "Person");
    const join = person.joins.find((j) => j.targetEntity === "NoteTarget");
    expect(join?.relationship).toBe("one_to_many");
    expect(join?.via).toBe("noteTargets");
    // noteTargets is a join, not a column.
    expect(person.columns.some((c) => c.name === "noteTargets")).toBe(false);
  });

  it("maps OpenAPI types into the SQL-entity vocabulary (timestamp/number/string[])", () => {
    const person = entityNamed(model, "Person");
    expect(person.columns.find((c) => c.name === "createdAt")?.type).toBe("timestamp");
    expect(person.columns.find((c) => c.name === "emails.additionalEmails")?.type).toBe("string[]");
    expect(person.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    expect(entityNamed(model, "Company").columns.find((c) => c.name === "employees")?.type).toBe("number");
  });

  it("derives list/search/get_by_id query patterns from the operation surface", () => {
    const person = entityNamed(model, "Person");
    const names = person.queryPatterns.map((q) => q.name);
    expect(names).toContain("list");
    expect(names).toContain("search");
    expect(names).toContain("get_by_id");
    // Company has no get-by-id GET, so no get_by_id pattern.
    expect(entityNamed(model, "Company").queryPatterns.map((q) => q.name)).not.toContain("get_by_id");
  });

  it("is JSON-serializable (cacheable as workspace_plugins.config.openapi_snapshot)", () => {
    const round = JSON.parse(JSON.stringify(model));
    expect(round.entities.length).toBe(model.entities.length);
    expect(round.title).toBe("Twenty Core REST API");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. Generalization check — a second, non-Twenty spec
//
//  A hand-crafted "Widget Store" API with a different domain, different
//  naming, and a different join shape than Twenty. If the generator only
//  worked on Twenty, these would fail — proving no Twenty-only path.
// ─────────────────────────────────────────────────────────────────────
const WIDGET_SPEC = {
  openapi: "3.0.3",
  info: { title: "Widget Store API", version: "2.0.0" },
  servers: [{ url: "https://api.widgets.example/v2" }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
    },
    parameters: {
      q: {
        name: "filter",
        in: "query",
        required: false,
        description: "RSQL filter, e.g. price=gt=100;inStock==true",
        schema: { type: "string" },
      },
      page: { name: "page", in: "query", required: false, schema: { type: "integer" } },
    },
    schemas: {
      Widget: {
        type: "object",
        properties: {
          id: { type: "integer" },
          sku: { type: "string", description: "Stock-keeping unit." },
          price: { type: "number" },
          inStock: { type: "boolean" },
          dimensions: {
            type: "object",
            properties: {
              widthMm: { type: "integer" },
              heightMm: { type: "integer" },
            },
          },
          category: { $ref: "#/components/schemas/Category" },
        },
      },
      Category: {
        type: "object",
        properties: {
          id: { type: "integer" },
          label: { type: "string" },
        },
      },
      StockItem: {
        type: "object",
        properties: {
          id: { type: "integer" },
          onHand: { type: "integer" },
        },
      },
    },
  },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        parameters: [
          { $ref: "#/components/parameters/q" },
          { $ref: "#/components/parameters/page" },
        ],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createWidget",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Widget" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/widgets/{widgetId}": {
      parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "integer" } }],
      get: {
        operationId: "getWidget",
        responses: { "200": { description: "ok" } },
      },
    },
    "/categories": {
      get: {
        operationId: "listCategories",
        responses: { "200": { description: "ok" } },
      },
    },
    "/inventory": {
      // Read-only, data-enveloped, and an OPAQUE operationId ("search") that
      // carries no schema name — forces resolution through the response-envelope
      // layer alone (no body, no operationId signal, no name match).
      get: {
        operationId: "search",
        parameters: [{ $ref: "#/components/parameters/q" }],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        items: { type: "array", items: { $ref: "#/components/schemas/StockItem" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapi-semantic-generator — generalization (non-Twenty spec)", () => {
  const widgetGraph = buildOperationGraph(WIDGET_SPEC);
  const widgetModel = generateSemanticModel(widgetGraph);

  it("groups a second spec's resources into entities with NO Twenty-specific code", () => {
    expect(widgetModel.entities.map((e) => e.name).toSorted()).toEqual([
      "Category",
      "StockItem",
      "Widget",
    ]);
  });

  it("resolves the record schema via the request body (Widget) and via name-match (categories -> Category)", () => {
    expect(entityNamed(widgetModel, "Widget").recordSchema).toBe("Widget");
    // /categories has no body and an untyped response — resolved by operationId
    // (listCategories) / name singularization, exactly like Twenty's Company.
    expect(entityNamed(widgetModel, "Category").recordSchema).toBe("Category");
  });

  it("resolves via the response envelope alone when there's no body/operationId/name signal", () => {
    // /inventory -> search returns { data: { items: [StockItem] } } and nothing
    // else points at the schema; only the response-envelope layer can resolve it.
    const stock = entityNamed(widgetModel, "StockItem");
    expect(stock.recordSchema).toBe("StockItem");
    expect(stock.resource).toBe("inventory"); // entity name (schema) != resource name
    expect(stock.columns.map((c) => c.name)).toContain("onHand");
  });

  it("flattens nested objects and surfaces descriptions generically", () => {
    const widget = entityNamed(widgetModel, "Widget");
    const colNames = widget.columns.map((c) => c.name);
    expect(colNames).toContain("dimensions.widthMm");
    expect(colNames).toContain("dimensions.heightMm");
    expect(widget.columns.find((c) => c.name === "sku")?.description).toBe("Stock-keeping unit.");
    expect(widget.columns.find((c) => c.name === "price")?.type).toBe("number");
    expect(widget.columns.find((c) => c.name === "inStock")?.type).toBe("boolean");
  });

  it("derives the Widget -> Category join from a single $ref (many_to_one)", () => {
    const widget = entityNamed(widgetModel, "Widget");
    const join = widget.joins.find((j) => j.targetEntity === "Category");
    expect(join?.relationship).toBe("many_to_one");
    expect(join?.via).toBe("category");
  });

  it("captures a DIFFERENT filter dialect (RSQL, not Twenty's bracket syntax)", () => {
    expect(widgetModel.filterSyntax).toContain("RSQL");
    expect(widgetModel.filterSyntax).not.toContain("field[COMPARATOR]");
  });

  it("classifies single-record paths via the {param} segment regardless of param name", () => {
    // The id segment is {widgetId}, not {id} — classification must still see `get`.
    const widget = entityNamed(widgetModel, "Widget");
    expect(widget.operations.find((o) => o.operationId === "getWidget")?.kind).toBe("get");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. Edge cases + robustness (#2931 review follow-ups)
// ─────────────────────────────────────────────────────────────────────
const EDGE_SPEC = {
  openapi: "3.0.3",
  info: { title: "Edge API", version: "1.0.0" },
  components: {
    schemas: {
      Box: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } },
      Warranty: { type: "object", properties: { months: { type: "integer" } } },
      Gadget: {
        type: "object",
        properties: {
          id: { type: "string" },
          specs: {
            type: "object",
            properties: { dims: { type: "object", properties: { widthMm: { type: "integer" } } } },
          },
          warranty: { $ref: "#/components/schemas/Warranty" },
        },
      },
    },
  },
  paths: {
    // No matching schema at all → operations-only fallback (unresolved).
    "/healthchecks": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
    // Only resource-name singularization (layer 4) matches: boxes -> Box (no body,
    // untyped response, opaque operationId "query" with no verb prefix).
    "/boxes": { get: { operationId: "query", responses: { "200": { description: "ok" } } } },
    // Body $ref resolves Gadget; warranty -> Warranty is a ref to a NON-entity.
    "/gadgets": {
      get: { operationId: "listGadgets", responses: { "200": { description: "ok" } } },
      post: {
        operationId: "createGadget",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Gadget" } } },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
};

describe("openapi-semantic-generator — edge cases + robustness", () => {
  const edgeModel = generateSemanticModel(buildOperationGraph(EDGE_SPEC));

  it("emits an operations-only entity (no columns/joins) when no layer resolves a schema, and flags it", () => {
    expect(edgeModel.unresolvedResources).toContain("healthchecks");
    const hc = entityNamed(edgeModel, "Healthcheck"); // titleCaseSingular("healthchecks")
    expect(hc.recordSchema).toBeUndefined();
    expect(hc.columns).toEqual([]);
    expect(hc.joins).toEqual([]);
    expect(hc.operations.map((o) => o.operationId)).toContain("ping");
    // The YAML omits record_schema / dimensions / joins cleanly.
    const rendered = renderEntityYaml(hc);
    expect(rendered).not.toContain("record_schema");
    expect(rendered).not.toContain("dimensions");
    expect(rendered).not.toContain("joins");
  });

  it("resolves via layer 4 (resource-name singularization) when layers 1-3 all miss", () => {
    // boxes: no body, untyped response, operationId "query" carries no verb —
    // only singularize("boxes") -> "box" (case-insensitive) matches schema Box.
    expect(entityNamed(edgeModel, "Box").recordSchema).toBe("Box");
    expect(edgeModel.unresolvedResources).not.toContain("boxes");
  });

  it("renders a $ref to a NON-entity schema as a typed column, never a dangling join", () => {
    const gadget = entityNamed(edgeModel, "Gadget");
    // Warranty has no /warranties resource → not an entity → must be a column.
    expect(gadget.columns.find((c) => c.name === "warranty")?.type).toBe("Warranty");
    expect(gadget.joins.find((j) => j.targetEntity === "Warranty")).toBeUndefined();
  });

  it("never emits a join whose target is not a generated entity (referential integrity)", () => {
    const names = new Set(edgeModel.entities.map((e) => e.name));
    for (const e of edgeModel.entities) {
      for (const j of e.joins) {
        expect(names.has(j.targetEntity)).toBe(true);
      }
    }
  });

  it("flattens inline objects exactly one level (grandchildren collapse to a typed object)", () => {
    const gadget = entityNamed(edgeModel, "Gadget");
    const cols = gadget.columns.map((c) => c.name);
    expect(cols).toContain("specs.dims"); // one level
    expect(cols).not.toContain("specs.dims.widthMm"); // NOT two levels
    expect(gadget.columns.find((c) => c.name === "specs.dims")?.type).toBe("object");
  });

  it("an empty graph yields no entities and an empty model YAML", () => {
    const empty = generateSemanticModel(
      buildOperationGraph({
        openapi: "3.0.3",
        info: { title: "Empty", version: "1.0.0" },
        components: { schemas: {} },
        paths: {},
      }),
    );
    expect(empty.entities).toEqual([]);
    expect(empty.unresolvedResources).toEqual([]);
    expect(renderModelYaml(empty)).toBe("");
  });

  it("the writes flag is derived purely from HTTP method (no drift)", () => {
    for (const e of model.entities) {
      for (const op of e.operations) {
        expect(op.writes).toBe(op.method !== "GET" && op.method !== "HEAD" && op.method !== "OPTIONS");
      }
    }
  });

  it("primaryKey is set exactly for the `id` column", () => {
    for (const e of model.entities) {
      for (const c of e.columns) {
        expect(Boolean(c.primaryKey)).toBe(c.name === "id");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  5. Multi-key envelope disambiguation (#2931 review — frequency, not key order)
// ─────────────────────────────────────────────────────────────────────
const MULTIKEY_SPEC = {
  openapi: "3.0.3",
  info: { title: "Multi-Key API", version: "1.0.0" },
  components: {
    schemas: {
      Order: { type: "object", properties: { id: { type: "string" }, total: { type: "number" } } },
      Customer: { type: "object", properties: { id: { type: "string" } } },
    },
  },
  paths: {
    "/orders": {
      // First op's data envelope carries TWO ref-bearing keys (customer THEN
      // orders); a naive first-key-wins unwrap would mis-pick Customer.
      get: {
        operationId: "queryOrders",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        customer: { $ref: "#/components/schemas/Customer" },
                        orders: { type: "array", items: { $ref: "#/components/schemas/Order" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      // Second op carries only Order — tips the cross-operation vote to Order.
      post: {
        operationId: "queryOrders2",
        responses: {
          "201": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        orders: { type: "array", items: { $ref: "#/components/schemas/Order" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapi-semantic-generator — multi-key envelope", () => {
  it("disambiguates a multi-key data envelope by cross-operation frequency, not JSON key order", () => {
    const mk = generateSemanticModel(buildOperationGraph(MULTIKEY_SPEC));
    // Order appears in both ops' envelopes, Customer in one — frequency picks Order.
    expect(entityNamed(mk, "Order").recordSchema).toBe("Order");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  6. Inline-response-object fallback (#2931 Codex review)
//
//  A resource described ONLY by an inline `data.<key>` object — no $ref, no
//  request body, no name-matchable operationId — must still surface its fields
//  rather than degrade to an empty operations-only entity.
// ─────────────────────────────────────────────────────────────────────
const INLINE_SPEC = {
  openapi: "3.0.3",
  info: { title: "Inline API", version: "1.0.0" },
  components: { schemas: {} },
  paths: {
    "/snapshots": {
      // Opaque operationId ("fetch"), no body, no named schema — the record
      // shape exists ONLY as an inline object under data.snapshot.
      get: {
        operationId: "fetch",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        snapshot: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            takenAt: { type: "string", format: "date-time" },
                            sizeBytes: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapi-semantic-generator — inline response fallback (Codex review)", () => {
  const m = generateSemanticModel(buildOperationGraph(INLINE_SPEC));

  it("derives columns from an inline data.<key> object when no named schema resolves", () => {
    const e = entityNamed(m, "Snapshot"); // titleCaseSingular("snapshots")
    expect(e.recordSchema).toBeUndefined(); // no NAMED schema backs it
    const cols = e.columns.map((c) => c.name);
    expect(cols).toContain("id");
    expect(cols).toContain("takenAt");
    expect(cols).toContain("sizeBytes");
    expect(e.columns.find((c) => c.name === "takenAt")?.type).toBe("timestamp");
    expect(e.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
  });

  it("does NOT flag an inline-derived resource as unresolved (it has fields)", () => {
    expect(m.unresolvedResources).not.toContain("snapshots");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  7. Codex review — grouping, action bodies, composed schemas, parameters
// ─────────────────────────────────────────────────────────────────────
const CODEX_SPEC = {
  openapi: "3.0.3",
  info: { title: "Codex Edge API", version: "1.0.0" },
  components: {
    schemas: {
      BaseUser: {
        type: "object",
        properties: { id: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
      },
      // Record modeled ONLY via allOf — own props + a $ref branch.
      User: {
        allOf: [
          { $ref: "#/components/schemas/BaseUser" },
          { type: "object", properties: { email: { type: "string" }, role: { type: "string" } } },
        ],
      },
      Person: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      PeopleSearchRequest: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
      },
      Item: { type: "object", properties: { id: { type: "string" }, qty: { type: "integer" } } },
    },
  },
  paths: {
    // Version prefix — must NOT collapse into a "v1"/"api" entity.
    "/api/v1/users": {
      get: {
        operationId: "listUsers",
        parameters: [
          { name: "page", in: "query", required: false, description: "1-based page", schema: { type: "integer" } },
          { name: "x-trace", in: "header", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: { users: { type: "array", items: { $ref: "#/components/schemas/User" } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/people": {
      get: {
        operationId: "listPeople2",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: { people: { type: "array", items: { $ref: "#/components/schemas/Person" } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    // Collection ACTION — its request body must NOT define the Person record.
    "/api/v1/people/search": {
      post: {
        operationId: "searchPeople2",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/PeopleSearchRequest" } } },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: { people: { type: "array", items: { $ref: "#/components/schemas/Person" } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    // Sub-resource — keeps its own `items` entity, not folded into `orders`.
    "/orders/{orderId}/items": {
      get: {
        operationId: "listOrderItems",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: { items: { type: "array", items: { $ref: "#/components/schemas/Item" } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapi-semantic-generator — Codex review fixes", () => {
  const cm = generateSemanticModel(buildOperationGraph(CODEX_SPEC));

  it("does NOT collapse version-prefixed paths into one api/v1 entity (Comment 2)", () => {
    expect(cm.entities.map((e) => e.name).toSorted()).toEqual(["Item", "Person", "User"]);
    expect(cm.entities.some((e) => e.name.toLowerCase() === "v1" || e.name.toLowerCase() === "api")).toBe(false);
    // The resource is the collection after the prefix, not the prefix.
    expect(entityNamed(cm, "User").resource).toBe("users");
  });

  it("keeps a sub-resource as its own entity, not folded into the parent (Comment 2)", () => {
    expect(entityNamed(cm, "Item").resource).toBe("items");
  });

  it("does NOT let an action endpoint's request body define the record schema (Comment 3)", () => {
    const person = entityNamed(cm, "Person");
    // /people/search POSTs a PeopleSearchRequest body, but the record is Person.
    expect(person.recordSchema).toBe("Person");
    expect(person.columns.map((c) => c.name).toSorted()).toEqual(["id", "name"]);
    // The search-form schema is supporting, never promoted to an entity.
    expect(cm.entities.some((e) => e.name === "PeopleSearchRequest")).toBe(false);
    expect(cm.supportingSchemas).toContain("PeopleSearchRequest");
    // The search op is still attached to the Person entity (grouped under people).
    expect(person.operations.map((o) => o.operationId)).toContain("searchPeople2");
  });

  it("flattens a composed (allOf) record schema into its full column set (Comment 4)", () => {
    const user = entityNamed(cm, "User");
    const cols = user.columns.map((c) => c.name).toSorted();
    // id + createdAt from BaseUser, email + role from the inline allOf branch.
    expect(cols).toEqual(["createdAt", "email", "id", "role"]);
    expect(user.columns.find((c) => c.name === "createdAt")?.type).toBe("timestamp");
    expect(user.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
  });

  it("preserves non-path operation parameters in the entity model + YAML (Comment 1)", () => {
    const user = entityNamed(cm, "User");
    const listUsers = user.operations.find((o) => o.operationId === "listUsers");
    const paramNames = listUsers?.parameters.map((p) => p.name) ?? [];
    expect(paramNames).toContain("page"); // query
    expect(paramNames).toContain("x-trace"); // header
    const page = listUsers?.parameters.find((p) => p.name === "page");
    expect(page?.in).toBe("query");
    expect(page?.description).toBe("1-based page");
    // Rendered into the YAML so the agent actually sees it.
    const yaml = renderEntityYaml(user);
    expect(yaml).toContain("parameters:");
    expect(yaml).toContain("name: page");
    expect(yaml).toContain("in: query");
  });
});
