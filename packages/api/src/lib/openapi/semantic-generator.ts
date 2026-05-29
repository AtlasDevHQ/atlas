/**
 * `openapi-semantic-generator` — Path B of the v0.0.2 representation bake-off
 * (#2931). Walks the slice-0 normalized {@link OperationGraph} and emits a
 * semantic model: REST resources rendered as *entities* (the same shape the
 * agent already reasons over for SQL entities — columns, joins, query patterns),
 * one per path prefix, with the operations that read/write each entity attached.
 *
 * Why a second representation at all: slice 1 (#2924) proved the agent can drive
 * Twenty from a trimmed slice of the raw operation graph (Path A, `representation.ts`).
 * Path B asks the opposite question — does organizing the surface *entity-first*
 * (the way `semantic/entities/*.yml` organizes a SQL datasource) help the agent,
 * and what does the richer structure cost in prompt tokens? The bake-off
 * (`__tests__/twenty-acceptance.test.ts`, re-run in `semantic-yaml` mode) answers
 * it from data; the maintainer records the winning default on #2931.
 *
 * This module is the generalization of the slice-1.6 hotfix `getPersonRestSchema`
 * (#2860), which hand-reached into `components.schemas.Person.properties` for the
 * ONE schema Atlas's own CRM pipeline cared about. Here every resource's column
 * set is derived generically from its record schema — no per-resource code, no
 * Twenty-specific branch (the generalization check in the tests runs the same
 * walk against a second, non-Twenty spec).
 *
 * Three serializations of ONE model, mirroring how a SQL datasource works
 * (YAML on disk → semantic-index digest in the prompt):
 *  - {@link generateSemanticModel} — the canonical in-memory model. This is what
 *    slice 2 caches per-tenant in `workspace_plugins.config.openapi_snapshot`
 *    (OQ4: per-tenant, uncommitted — it's plain JSON-serializable data, no Maps).
 *  - {@link renderEntityYaml} / {@link renderModelYaml} — the YAML artifact
 *    (golden-tested; the on-disk analogue of `semantic/entities/*.yml`).
 *  - The agent prompt context is the YAML fed through `representation.ts`'s
 *    `semantic-yaml` mode (header + entity YAMLs), parallel to how Path A renders
 *    the operation graph.
 *
 * Pure functions over the graph — no I/O, no agent logic, no provider coupling.
 */
import type {
  HttpMethod,
  OpenApiSchema,
  OpenApiSchemaInline,
  Operation,
  OperationGraph,
} from "./types";
import * as yaml from "js-yaml";

// ─────────────────────────────────────────────────────────────────────
//  Model shape (the cacheable `openapi_snapshot`)
// ─────────────────────────────────────────────────────────────────────

/**
 * How an entity operation reads/writes its resource. Derived from HTTP method +
 * whether the path carries a record id (`{id}` segment) — not from the
 * `operationId` string, so it holds across naming conventions.
 */
export type OperationKind = "list" | "get" | "create" | "update" | "delete" | "other";

/** A single column on a generated entity (the REST analogue of a SQL dimension). */
export interface GeneratedColumn {
  /**
   * Property name. Nested inline objects are flattened one level with a dotted
   * path (`emails.primaryEmail`, `bodyV2.markdown`) so the field shapes the agent
   * must get exactly right stay visible — the same traps Path A surfaces.
   */
  readonly name: string;
  /**
   * Semantic type, normalized into the SQL-entity vocabulary so the surface
   * reads the same as a SQL datasource: `string` | `number` | `boolean` |
   * `timestamp` | `object` | a `<type>[]` array form.
   */
  readonly type: string;
  readonly description?: string;
  /** True for the conventional `id` primary key. */
  readonly primaryKey?: boolean;
}

/** A relationship to another entity, derived from a `$ref` (or array of `$ref`). */
export interface GeneratedJoin {
  /** The property carrying the reference, e.g. `noteTargets` or `person`. */
  readonly via: string;
  /** The referenced schema/entity name, e.g. `NoteTarget`. */
  readonly targetEntity: string;
  /** `one_to_many` for an array of refs; `many_to_one` for a single ref. */
  readonly relationship: "one_to_many" | "many_to_one";
  readonly description?: string;
}

/** An operation that reads or writes this entity's resource. */
export interface GeneratedEntityOperation {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly kind: OperationKind;
  readonly summary?: string;
  /** True for any non-GET (POST/PATCH/PUT/DELETE). The read-only gate keys on this. */
  readonly writes: boolean;
}

/**
 * A usage recipe for the entity — the REST analogue of a SQL `query_patterns`
 * entry. Carries no SQL (there is none); the `description` names the operation +
 * the param shape (filter syntax, pagination) the agent should reach for.
 */
export interface GeneratedQueryPattern {
  readonly name: string;
  readonly description: string;
}

/** One generated entity = one path-prefix resource group. */
export interface GeneratedEntity {
  /** Entity name — the record schema name (`Person`), title-cased resource as fallback. */
  readonly name: string;
  /** The path-prefix resource this entity groups, e.g. `people`. */
  readonly resource: string;
  /** The `components.schemas.*` name backing the columns, when one was resolved. */
  readonly recordSchema?: string;
  readonly description: string;
  readonly operations: ReadonlyArray<GeneratedEntityOperation>;
  readonly columns: ReadonlyArray<GeneratedColumn>;
  readonly joins: ReadonlyArray<GeneratedJoin>;
  readonly queryPatterns: ReadonlyArray<GeneratedQueryPattern>;
}

/**
 * The generated semantic model for an entire REST datasource. JSON-serializable
 * by construction (plain arrays/strings, no Maps) so slice 2 can persist it in
 * `workspace_plugins.config.openapi_snapshot` and rehydrate without a custom
 * reviver.
 */
export interface OpenApiSemanticModel {
  /** Datasource title from the spec `info.title`. */
  readonly title: string;
  /** The raw OpenAPI version string, for the snapshot's spec-identity. */
  readonly openapiVersion: string;
  readonly entities: ReadonlyArray<GeneratedEntity>;
  /**
   * The `filter` query-param syntax, surfaced once at the datasource level when
   * any operation documents it. Twenty's `field[COMPARATOR]:value` shape lives
   * here (TRAP 1). `undefined` when the spec has no described filter param.
   */
  readonly filterSyntax?: string;
  /**
   * Schemas present in the graph that were NOT promoted to an entity (response
   * envelopes like `PersonListResponse`, value objects). Listed for completeness
   * / diagnostics; not rendered into the agent prompt.
   */
  readonly supportingSchemas: ReadonlyArray<string>;
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate the semantic model from a normalized operation graph. Pure function;
 * deterministic (entities and their members are sorted) so the YAML goldens are
 * stable across runs.
 */
export function generateSemanticModel(graph: OperationGraph): OpenApiSemanticModel {
  const groups = groupOperationsByResource(graph);
  const filterSyntax = findFilterSyntax(graph);

  const entities: GeneratedEntity[] = [];
  const usedSchemas = new Set<string>();

  for (const [resource, operations] of groups) {
    const recordSchema = resolveRecordSchema(resource, operations, graph);
    if (recordSchema) usedSchemas.add(recordSchema);

    const schema = recordSchema ? graph.schemas.get(recordSchema) : undefined;
    const { columns, joins } = schema
      ? deriveColumnsAndJoins(schema, graph)
      : { columns: [], joins: [] };

    const entityOps = operations.map(toEntityOperation);
    entities.push({
      name: recordSchema ?? titleCaseSingular(resource),
      resource,
      ...(recordSchema ? { recordSchema } : {}),
      description: describeEntity(recordSchema ?? titleCaseSingular(resource), resource, graph.info.title),
      operations: entityOps,
      columns,
      joins,
      queryPatterns: deriveQueryPatterns(entityOps, filterSyntax),
    });
  }

  entities.sort((a, b) => a.name.localeCompare(b.name));

  const supportingSchemas = [...graph.schemas.keys()]
    .filter((name) => !usedSchemas.has(name))
    .toSorted((a, b) => a.localeCompare(b));

  return {
    title: graph.info.title,
    openapiVersion: graph.info.openapiVersion,
    entities,
    ...(filterSyntax ? { filterSyntax } : {}),
    supportingSchemas,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Resource grouping
// ─────────────────────────────────────────────────────────────────────

/**
 * Group operations by their first path segment (the collection name). Both
 * `/people` and `/people/{id}` belong to resource `people`. Returns a Map sorted
 * by resource name for deterministic output. Operations whose path has no usable
 * segment are bucketed under `""` (rare; e.g. a root `/` operation) and skipped
 * if that produces a nameless group with no schema.
 */
function groupOperationsByResource(
  graph: OperationGraph,
): Map<string, Operation[]> {
  const groups = new Map<string, Operation[]>();
  for (const op of graph.operations.values()) {
    const resource = firstPathSegment(op.path);
    if (!resource) continue;
    const bucket = groups.get(resource);
    if (bucket) bucket.push(op);
    else groups.set(resource, [op]);
  }
  // Sort members within each group by operationId so YAML goldens are stable.
  for (const ops of groups.values()) {
    ops.sort((a, b) => a.operationId.localeCompare(b.operationId));
  }
  return new Map([...groups.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

/** First non-template path segment, e.g. `/people/{id}` → `people`. */
function firstPathSegment(path: string): string {
  for (const seg of path.split("/")) {
    if (seg.length > 0 && !seg.startsWith("{")) return seg;
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────
//  Record-schema resolution (layered, generic — no per-resource code)
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the named `components.schemas.*` that describes one record of this
 * resource. Layered so it works across naming conventions and degrades
 * gracefully — this is the generalization of `getPersonRestSchema`'s hardcoded
 * `Person` lookup. Each layer proposes candidate names; the first layer whose
 * most-frequent candidate is an actual schema in the graph wins:
 *
 *  1. **Request-body `$ref`s** — a create/update body that is a bare `$ref`
 *     names the record directly (Twenty: `createOnePerson` body → `Person`).
 *     Strongest signal; handles irregular plurals (people → Person) for free.
 *  2. **Unwrapped responses** — a `200/201` envelope of shape `data.<key>` or
 *     `data.<key>[]` whose leaf is a `$ref` (Twenty's `PersonListResponse` →
 *     `data.people[] -> Person`, or an inline `data.noteTargets[] -> NoteTarget`).
 *  3. **operationId-derived** — strip a `find/get/create/update/delete + One/Many`
 *     verb prefix and singularize the remainder (`deleteOneCompany` → `Company`).
 *     Covers resources with neither bodies nor typed responses.
 *  4. **Resource-name singularization** — `companies` → `Company` (case-insensitive).
 *
 * Returns `undefined` only when no layer matches a real schema — the entity is
 * then operations-only (still addressable, just no column set).
 */
function resolveRecordSchema(
  resource: string,
  operations: ReadonlyArray<Operation>,
  graph: OperationGraph,
): string | undefined {
  const schemaNames = new Set(graph.schemas.keys());

  const layers: Array<() => string[]> = [
    () => requestBodyRefs(operations),
    () => responseRecordRefs(operations, graph),
    () => operations.map((op) => schemaFromOperationId(op.operationId)).filter(isString),
    () => [singularize(resource)],
  ];

  for (const layer of layers) {
    const match = mostFrequentMatch(layer(), schemaNames);
    if (match) return match;
  }
  return undefined;
}

function requestBodyRefs(operations: ReadonlyArray<Operation>): string[] {
  const out: string[] = [];
  for (const op of operations) {
    const json = op.requestBody?.content.get("application/json");
    if (json?.ref !== undefined) out.push(json.ref);
  }
  return out;
}

/** Collect the record ref each `200/201` response unwraps to (see {@link unwrapDataEnvelope}). */
function responseRecordRefs(
  operations: ReadonlyArray<Operation>,
  graph: OperationGraph,
): string[] {
  const out: string[] = [];
  for (const op of operations) {
    for (const status of ["200", "201"]) {
      const json = op.responses.get(status)?.content.get("application/json");
      const ref = json ? unwrapDataEnvelope(json, graph) : undefined;
      if (ref) out.push(ref);
    }
  }
  return out;
}

/**
 * Unwrap a `{ data: { <resourceKey>: Record | Record[] } }` success envelope to
 * the record's schema name. This is the consistent REST list/get shape (Twenty's
 * `PersonListResponse` → `data.people[] -> Person`; `PersonResponse` →
 * `data.person -> Person`; an inline `data.noteTargets[] -> NoteTarget`). A named
 * envelope ref is resolved one hop first. Crucially it descends EXACTLY one
 * `data.<key>` level — it does NOT recurse into the record's own joins (so a
 * Person response never proposes NoteTarget as the *record*). Returns `undefined`
 * when the response isn't `data`-wrapped, so resolution falls through to the
 * operationId / name-singularization layers.
 */
function unwrapDataEnvelope(schema: OpenApiSchema, graph: OperationGraph): string | undefined {
  const envelope = resolveSchema(schema, graph);
  const data = envelope?.properties?.get("data");
  if (!data) return undefined;
  const dataShape = resolveSchema(data, graph);
  if (!dataShape?.properties) return undefined;
  for (const value of dataShape.properties.values()) {
    const target = refTargetOf(value);
    if (target) return target.name;
  }
  return undefined;
}

// Verb prefixes generated REST clients put before the resource name. Ordered
// longest-first so "findMany" matches before "find".
const OPERATION_VERB_PREFIXES = [
  "findMany",
  "findOne",
  "createMany",
  "createOne",
  "updateMany",
  "updateOne",
  "deleteMany",
  "deleteOne",
  "getMany",
  "getOne",
  "listMany",
  "list",
  "get",
  "create",
  "update",
  "delete",
  "find",
] as const;

/** `deleteOneCompany` → `Company`; `findManyPeople` → `Person` (via singularize). */
function schemaFromOperationId(operationId: string): string | undefined {
  for (const prefix of OPERATION_VERB_PREFIXES) {
    if (operationId.startsWith(prefix) && operationId.length > prefix.length) {
      const rest = operationId.slice(prefix.length);
      // Only treat as a verb prefix when the remainder starts upper-case (so we
      // don't strip "find" off a resource literally named "findings").
      if (rest[0] === rest[0]?.toUpperCase()) return singularize(rest);
    }
  }
  return undefined;
}

/** Pick the candidate that appears most often AND is a real schema. */
function mostFrequentMatch(candidates: string[], schemaNames: Set<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const match = matchSchemaName(c, schemaNames);
    if (match) counts.set(match, (counts.get(match) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** Exact, then case-insensitive match of a candidate against real schema names. */
function matchSchemaName(candidate: string, schemaNames: Set<string>): string | undefined {
  if (schemaNames.has(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  for (const name of schemaNames) {
    if (name.toLowerCase() === lower) return name;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
//  Column + join derivation
// ─────────────────────────────────────────────────────────────────────

/**
 * Walk a record schema's properties into columns + joins. `$ref` properties
 * (and arrays of `$ref`) become joins (the relationships the agent traverses);
 * everything else becomes a column. Inline objects are flattened one level into
 * dotted columns so nested shapes (`emails.primaryEmail`, `bodyV2.markdown`) stay
 * visible. The record schema is resolved through one ref hop if it is itself a
 * bare `$ref` pointer.
 */
function deriveColumnsAndJoins(
  schema: OpenApiSchema,
  graph: OperationGraph,
): { columns: GeneratedColumn[]; joins: GeneratedJoin[] } {
  const resolved = resolveSchema(schema, graph);
  const columns: GeneratedColumn[] = [];
  const joins: GeneratedJoin[] = [];
  if (!resolved?.properties) return { columns, joins };

  for (const [propName, propSchema] of resolved.properties) {
    // Array-of-ref or single ref → join.
    const refTarget = refTargetOf(propSchema);
    if (refTarget) {
      joins.push({
        via: propName,
        targetEntity: refTarget.name,
        relationship: refTarget.isArray ? "one_to_many" : "many_to_one",
        ...(refTarget.description ? { description: refTarget.description } : {}),
      });
      continue;
    }
    appendColumns(propName, propSchema, columns);
  }
  return { columns, joins };
}

/**
 * Resolve a possibly-`$ref` schema to its inline form (one hop). Returns
 * `undefined` if the target is missing or is itself a bare `$ref` (a ref-to-ref
 * chain we don't follow further — record schemas are inline objects in practice).
 */
function resolveSchema(
  schema: OpenApiSchema,
  graph: OperationGraph,
): OpenApiSchemaInline | undefined {
  if (schema.ref === undefined) return schema;
  const target = graph.schemas.get(schema.ref);
  return target && target.ref === undefined ? target : undefined;
}

interface RefTarget {
  readonly name: string;
  readonly isArray: boolean;
  readonly description?: string;
}

/** Returns the ref target if `schema` is a `$ref` or an array whose items are a `$ref`. */
function refTargetOf(schema: OpenApiSchema): RefTarget | undefined {
  if (schema.ref !== undefined) return { name: schema.ref, isArray: false };
  if (schema.type === "array" && schema.items?.ref !== undefined) {
    return {
      name: schema.items.ref,
      isArray: true,
      ...(schema.description ? { description: schema.description } : {}),
    };
  }
  return undefined;
}

/**
 * Append one or more columns for a non-ref property. Inline objects with their
 * own properties are flattened one level into `parent.child` columns; an object
 * that carries a description also yields a parent row so load-bearing guidance
 * (Twenty's `bodyV2` "write markdown under bodyV2.markdown") is not lost.
 */
function appendColumns(name: string, schema: OpenApiSchema, out: GeneratedColumn[]): void {
  if (schema.ref !== undefined) return; // handled as a join upstream

  if (schema.type === "object" && schema.properties && schema.properties.size > 0) {
    if (schema.description) {
      out.push({ name, type: "object", description: schema.description });
    }
    for (const [childName, childSchema] of schema.properties) {
      // Refs nested inside an inline object stay columns-by-path is wrong — but
      // record schemas don't nest joins under anonymous objects in practice;
      // flatten scalar children, and represent a nested ref child as a typed leaf.
      out.push(leafColumn(`${name}.${childName}`, childSchema));
    }
    return;
  }
  out.push(leafColumn(name, schema));
}

/** A single non-object leaf column with the SQL-vocabulary type. */
function leafColumn(name: string, schema: OpenApiSchema): GeneratedColumn {
  return {
    name,
    type: semanticType(schema),
    ...(schema.ref === undefined && schema.description ? { description: schema.description } : {}),
    ...(name === "id" ? { primaryKey: true } : {}),
  };
}

/**
 * Map an OpenAPI schema node to the SQL-entity type vocabulary so the REST
 * surface reads identically to a SQL datasource: number / boolean / timestamp /
 * string / object / `<type>[]`.
 */
function semanticType(schema: OpenApiSchema): string {
  if (schema.ref !== undefined) return schema.ref;
  if (schema.type === "array") {
    return schema.items ? `${semanticType(schema.items)}[]` : "array";
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string") {
    return schema.format === "date-time" || schema.format === "date" ? "timestamp" : "string";
  }
  if (schema.type === "object") return "object";
  // Composition-only or untyped node — fall back to a readable label.
  if (schema.oneOf || schema.anyOf || schema.allOf) return "object";
  return schema.type ?? "string";
}

// ─────────────────────────────────────────────────────────────────────
//  Operations + query patterns
// ─────────────────────────────────────────────────────────────────────

function toEntityOperation(op: Operation): GeneratedEntityOperation {
  return {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    kind: classifyOperation(op),
    ...(op.summary ? { summary: op.summary } : {}),
    writes: op.method !== "GET" && op.method !== "HEAD" && op.method !== "OPTIONS",
  };
}

/** Classify by method + whether the path targets a single record (`{...}` segment). */
function classifyOperation(op: Operation): OperationKind {
  const targetsOne = /\{[^}]+\}/.test(op.path);
  switch (op.method) {
    case "GET":
      return targetsOne ? "get" : "list";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return "other";
  }
}

/**
 * Derive usage recipes from the operation surface. The issue's "pagination
 * params → query-pattern hints" lands here: a `list` operation yields a list
 * recipe; a filterable list yields a search recipe. The full `field[op]:value`
 * filter syntax is surfaced ONCE at the datasource level
 * ({@link OpenApiSemanticModel.filterSyntax}) rather than copied into every
 * entity — repeating a ~250-char string per entity would inflate the Path B
 * prompt for no added signal (the bake-off measures token cost honestly).
 */
function deriveQueryPatterns(
  operations: ReadonlyArray<GeneratedEntityOperation>,
  filterSyntax: string | undefined,
): GeneratedQueryPattern[] {
  const patterns: GeneratedQueryPattern[] = [];
  const list = operations.find((op) => op.kind === "list");
  const get = operations.find((op) => op.kind === "get");

  if (list) {
    patterns.push({
      name: "list",
      description: `List records via ${list.operationId}. Paginate with limit + starting_after (cursor); omit filter for a plain list.`,
    });
    if (filterSyntax) {
      patterns.push({
        name: "search",
        description: `Search via ${list.operationId} by passing the filter query param (see the datasource-level filter syntax).`,
      });
    }
  }
  if (get) {
    patterns.push({
      name: "get_by_id",
      description: `Fetch one record by id via ${get.operationId}.`,
    });
  }
  return patterns;
}

/** Find the first described `filter` query param across all operations (TRAP 1). */
function findFilterSyntax(graph: OperationGraph): string | undefined {
  for (const op of graph.operations.values()) {
    for (const param of op.parameters) {
      if (param.name === "filter" && param.in === "query" && param.description) {
        return param.description;
      }
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
//  Naming helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Lightweight English singularization — enough for collection→record names
 * (`companies` → `company`, `notes` → `note`). Deliberately NOT a full
 * inflector: irregular plurals (people → person) are handled upstream by the
 * request-body / operationId layers, so this only needs the regular cases.
 */
function singularize(word: string): string {
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** `note_targets` / `noteTargets` → `NoteTarget` — the operations-only fallback name. */
function titleCaseSingular(resource: string): string {
  const singular = singularize(resource);
  const words = singular.split(/[-_]/).flatMap((w) => w.split(/(?=[A-Z])/));
  return words.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("");
}

function describeEntity(name: string, resource: string, datasourceTitle: string): string {
  return `REST resource backed by the "${resource}" path group of ${datasourceTitle}. Read with the GET operations below; pass parameters to executeRestOperation.`;
}

function isString(v: string | undefined): v is string {
  return typeof v === "string";
}

// ─────────────────────────────────────────────────────────────────────
//  YAML rendering (golden artifact + cacheable snapshot)
// ─────────────────────────────────────────────────────────────────────

const YAML_OPTIONS: yaml.DumpOptions = {
  // Stable, readable, no anchors/refs — deterministic for golden comparison.
  indent: 2,
  lineWidth: -1, // never wrap (keeps long filter-syntax strings on one line)
  noRefs: true,
  sortKeys: false, // we control key order via insertion order below
  quotingType: '"',
};

/**
 * Render ONE entity as a semantic YAML document — the on-disk analogue of a
 * `semantic/entities/*.yml` file, adapted for a REST resource (an `operations`
 * block replaces a SQL table name; columns/joins/query_patterns mirror the SQL
 * shape). Stable output (deterministic key + member order) so it golden-tests.
 */
export function renderEntityYaml(entity: GeneratedEntity): string {
  // Build an ordered plain object; js-yaml preserves insertion order with
  // sortKeys:false. Omit empty sections so the golden stays lean.
  const doc: Record<string, unknown> = {
    name: entity.name,
    type: "rest_resource",
    resource: entity.resource,
  };
  if (entity.recordSchema) doc.record_schema = entity.recordSchema;
  doc.description = entity.description;

  doc.operations = entity.operations.map((op) => {
    const o: Record<string, unknown> = {
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      kind: op.kind,
      writes: op.writes,
    };
    if (op.summary) o.summary = op.summary;
    return o;
  });

  if (entity.columns.length > 0) {
    doc.dimensions = entity.columns.map((col) => {
      const c: Record<string, unknown> = { name: col.name, type: col.type };
      if (col.primaryKey) c.primary_key = true;
      if (col.description) c.description = col.description;
      return c;
    });
  }

  if (entity.joins.length > 0) {
    doc.joins = entity.joins.map((join) => {
      const j: Record<string, unknown> = {
        target_entity: join.targetEntity,
        relationship: join.relationship,
        via: join.via,
      };
      if (join.description) j.description = join.description;
      return j;
    });
  }

  if (entity.queryPatterns.length > 0) {
    doc.query_patterns = entity.queryPatterns.map((qp) => ({
      name: qp.name,
      description: qp.description,
    }));
  }

  return yaml.dump(doc, YAML_OPTIONS);
}

/**
 * Render the whole model as a multi-document YAML string — every entity as a
 * `---`-separated document, in the model's (sorted) entity order. This is the
 * agent-facing serialization Path B feeds into the prompt, and the form slice 2
 * caches in `openapi_snapshot`.
 */
export function renderModelYaml(model: OpenApiSemanticModel): string {
  return model.entities.map(renderEntityYaml).join("---\n");
}
