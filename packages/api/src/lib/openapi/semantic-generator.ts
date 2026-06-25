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
import {
  ENTITY_YAML_KEYS,
  ENTITY_YAML_JOIN_KEYS,
  ENTITY_YAML_DIMENSION_KEYS,
  REST_ENTITY_TYPE_TAG,
} from "@useatlas/schemas/semantic-entity-yaml";

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

/** A non-path parameter the agent must know to call an operation correctly. */
export interface GeneratedOperationParameter {
  readonly name: string;
  /** `query` | `header` | `cookie` — path params are implicit in `path`, omitted. */
  readonly in: string;
  readonly required: boolean;
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
  /**
   * The operation's non-path parameters (query/header/cookie), so the agent sees
   * the valid names/locations to pass through `executeRestOperation` rather than
   * inventing or omitting them (Codex review). Path params are excluded — they are
   * already visible in {@link path}. Empty when the operation takes none.
   */
  readonly parameters: ReadonlyArray<GeneratedOperationParameter>;
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
  /**
   * Resources whose record schema NO cascade layer could resolve — they became
   * operations-only entities (addressable, but with no column/join surface). An
   * empty array is the healthy case. Surfaced (rather than logged) because the
   * generator is pure; the prompt-building consumer logs it so a misconfigured or
   * unusual spec is diagnosable instead of silently yielding field-less entities.
   */
  readonly unresolvedResources: ReadonlyArray<string>;
}

/**
 * Compile-time guard: the model MUST stay JSON-serializable — it is persisted to
 * `workspace_plugins.config.openapi_snapshot` and rehydrated with a plain
 * `JSON.parse` in slice 2. This assignment stops compiling the moment a field of
 * a non-JSON-safe type (a `Map`, `Set`, `Date`, function, …) is added, turning
 * the "no Maps" invariant from a comment into a build error — which matters
 * because the upstream {@link OperationGraph} is built entirely from `Map`s, so
 * the natural extension mistake (carrying a graph sub-shape straight through) is
 * exactly what this catches.
 */
type JsonSafe<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<JsonSafe<U>>
    : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ((...args: never[]) => unknown)
      ? never
      : { [K in keyof T]: JsonSafe<T[K]> };
const _assertModelJsonSafe = (m: OpenApiSemanticModel): JsonSafe<OpenApiSemanticModel> => m;
void _assertModelJsonSafe;

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

  // Pass 1: resolve each resource's record schema first, so the COMPLETE set of
  // entity names is known before deriving joins. A join may only target a schema
  // that actually became an entity — otherwise it is a dangling edge to a YAML
  // block that doesn't exist (see deriveColumnsAndJoins).
  const resolved = [...groups].map(([resource, operations]) => ({
    resource,
    operations,
    recordSchema: resolveRecordSchema(resource, operations, graph),
  }));
  const entitySchemaNames = new Set(resolved.map((r) => r.recordSchema).filter(isString));

  // Pass 2: derive columns/joins now that the entity set is known. When no named
  // schema resolved, fall back to an inline `data.<key>` response object so a
  // resource specified only by an inline shape still gets fields (Codex review).
  const usedSchemas = new Set<string>();
  const entities: GeneratedEntity[] = resolved.map(({ resource, operations, recordSchema }) => {
    if (recordSchema) usedSchemas.add(recordSchema);

    const schema = recordSchema
      ? graph.schemas.get(recordSchema)
      : inlineResponseRecordSchema(operations, graph);
    const { columns, joins } = schema
      ? deriveColumnsAndJoins(schema, graph, entitySchemaNames)
      : { columns: [], joins: [] };

    const entityOps = operations.map(toEntityOperation);
    const name = recordSchema ?? titleCaseSingular(resource);
    return {
      name,
      resource,
      ...(recordSchema ? { recordSchema } : {}),
      description: describeEntity(name, resource, graph.info.title),
      operations: entityOps,
      columns,
      joins,
      queryPatterns: deriveQueryPatterns(entityOps, filterSyntax),
    };
  });

  entities.sort((a, b) => a.name.localeCompare(b.name));

  // "Unresolved" = no named schema AND no inline fields either — a truly
  // field-less operations-only entity. A resource that drew columns from an
  // inline response is resolved enough to be useful, so it is NOT flagged.
  const unresolvedResources = entities
    .filter((e) => e.recordSchema === undefined && e.columns.length === 0)
    .map((e) => e.resource)
    .toSorted((a, b) => a.localeCompare(b));

  const supportingSchemas = [...graph.schemas.keys()]
    .filter((name) => !usedSchemas.has(name))
    .toSorted((a, b) => a.localeCompare(b));

  return {
    title: graph.info.title,
    openapiVersion: graph.info.openapiVersion,
    entities,
    ...(filterSyntax ? { filterSyntax } : {}),
    supportingSchemas,
    unresolvedResources,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Resource grouping
// ─────────────────────────────────────────────────────────────────────

/**
 * Group operations by their collection resource. Both `/people` and
 * `/people/{id}` belong to resource `people`. Returns a Map sorted by resource
 * name for deterministic output. Operations whose path has no usable segment are
 * bucketed under `""` (rare; e.g. a root `/` operation) and skipped.
 */
function groupOperationsByResource(
  graph: OperationGraph,
): Map<string, Operation[]> {
  const groups = new Map<string, Operation[]>();
  for (const op of graph.operations.values()) {
    const resource = resourceForPath(op.path);
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

/** Path segments OpenAPI specs use as version/base prefixes, never resources. */
const PREFIX_SEGMENT_RE = /^(?:v\d+|api)$/i;

/**
 * The collection segment that names a resource — robust to version/base prefixes
 * and sub-resources (Codex review), where a naive "first non-template segment"
 * would collapse `/api/v1/people` + `/api/v1/companies` into one `api`/`v1`
 * entity and bury Stripe-style `/v1/...` resources entirely:
 *  - leading `api` / `vN` prefixes are skipped (`/api/v1/people` → `people`),
 *    but never the final segment (so a real `/api` endpoint is still addressable);
 *  - a sub-resource keeps its own identity (`/orders/{id}/items` → `items`), by
 *    taking the LAST segment that *starts* a collection (one at the content root
 *    or immediately after a `{template}`);
 *  - a collection action stays with its collection (`/people/search` → `people`),
 *    because `search` is not at a collection boundary.
 * Returns "" for a path with no usable segment (root `/`), which the caller skips.
 */
function resourceForPath(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  // Skip leading version/base prefixes, but never consume the final segment.
  let start = 0;
  while (start < segments.length - 1 && PREFIX_SEGMENT_RE.test(segments[start])) start++;

  let result = "";
  let atCollectionBoundary = true; // first content segment starts a collection
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith("{")) {
      atCollectionBoundary = true; // the next literal segment is a sub-collection
      continue;
    }
    if (atCollectionBoundary) result = seg;
    atCollectionBoundary = false;
  }
  return result;
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
 *  1. **Request-body `$ref`s** — a create/update body on the resource's OWN path
 *     that is a bare `$ref` names the record directly (Twenty: `createOnePerson`
 *     body → `Person`). Strongest signal; handles irregular plurals (people →
 *     Person) for free. Action sub-paths (`/people/search`) are excluded so a
 *     request-form schema can't masquerade as the record (see {@link isRecordPath}).
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
    () => requestBodyRefs(operations, resource),
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

/**
 * Is this path the resource RECORD itself (the collection root or a single
 * record), as opposed to a sub-action like `/people/search`? Only record paths
 * may define the record schema from their request body (Codex review) — an action
 * endpoint's body describes its INPUT payload (`PeopleSearchRequest`), not the
 * returned record, so letting it win would replace the record's fields with the
 * search-form's.
 */
function isRecordPath(path: string, resource: string): boolean {
  const segments = path.split("/").filter((s) => s.length > 0);
  const idx = segments.lastIndexOf(resource);
  if (idx === -1) return false;
  // Every segment after the resource must be a `{template}` (`/people/{id}`),
  // never another literal segment (`/people/search`).
  return segments.slice(idx + 1).every((s) => s.startsWith("{"));
}

function requestBodyRefs(operations: ReadonlyArray<Operation>, resource: string): string[] {
  const out: string[] = [];
  for (const op of operations) {
    if (!isRecordPath(op.path, resource)) continue;
    const json = op.requestBody?.content.get("application/json");
    if (json?.ref !== undefined) out.push(json.ref);
  }
  return out;
}

/** Collect the record refs each `200/201` response unwraps to (see {@link unwrapDataEnvelope}). */
function responseRecordRefs(
  operations: ReadonlyArray<Operation>,
  graph: OperationGraph,
): string[] {
  const out: string[] = [];
  for (const op of operations) {
    for (const status of ["200", "201"]) {
      const json = op.responses.get(status)?.content.get("application/json");
      if (json) out.push(...unwrapDataEnvelope(json, graph));
    }
  }
  return out;
}

/**
 * Unwrap a `{ data: { <resourceKey>: Record | Record[] } }` success envelope to
 * the record schema name(s) it carries. This is the consistent REST list/get
 * shape (Twenty's `PersonListResponse` → `data.people[] -> Person`;
 * `PersonResponse` → `data.person -> Person`; an inline `data.noteTargets[] ->
 * NoteTarget`). A named envelope ref is resolved one hop first. Crucially it
 * descends EXACTLY one `data.<key>` level — it does NOT recurse into the record's
 * own joins (so a Person response never proposes NoteTarget as the *record*).
 *
 * Returns ALL ref-bearing `data.<key>` candidates (not just the first), so a
 * multi-key envelope is disambiguated by the caller's cross-operation frequency
 * scoring rather than by JSON key order. Empty array when the response isn't
 * `data`-wrapped, so resolution falls through to the operationId /
 * name-singularization layers.
 */
function unwrapDataEnvelope(schema: OpenApiSchema, graph: OperationGraph): string[] {
  const envelope = resolveSchema(schema, graph);
  const data = envelope?.properties?.get("data");
  if (!data) return [];
  const dataShape = resolveSchema(data, graph);
  if (!dataShape?.properties) return [];
  const refs: string[] = [];
  for (const value of dataShape.properties.values()) {
    const target = refTargetOf(value);
    if (target) refs.push(target.name);
  }
  return refs;
}

/**
 * Fallback record shape for a resource with NO named record schema: the INLINE
 * `data.<key>` response object (Codex review). A resource described only by an
 * inline response — no `$ref`, no request body, and no name-matchable
 * operationId — would otherwise be an empty operations-only entity even though
 * its fields are fully specified. Returns the first inline object schema found
 * under a 200/201 `data.<key>` (unwrapping a one-level array), or `undefined`
 * when the responses carry only refs (handled by the named layers) or no object
 * shape at all. Ref-bearing keys are skipped — those are the named-schema layers'
 * job, so this never competes with or overrides a resolvable named record.
 */
function inlineResponseRecordSchema(
  operations: ReadonlyArray<Operation>,
  graph: OperationGraph,
): OpenApiSchemaInline | undefined {
  for (const op of operations) {
    for (const status of ["200", "201"]) {
      const json = op.responses.get(status)?.content.get("application/json");
      const envelope = json ? resolveSchema(json, graph) : undefined;
      const data = envelope?.properties?.get("data");
      const dataShape = data ? resolveSchema(data, graph) : undefined;
      if (!dataShape?.properties) continue;
      for (const value of dataShape.properties.values()) {
        if (value.ref !== undefined) continue; // a bare ref → the named-schema layers handle it
        // value is now OpenApiSchemaInline; unwrap a one-level array wrapper.
        const item = value.type === "array" ? value.items : value;
        if (item === undefined || item.ref !== undefined) continue; // array-of-ref → named layers
        const inline = resolveSchema(item, graph);
        if (inline?.properties && inline.properties.size > 0) return inline;
      }
    }
  }
  return undefined;
}

// CRUD verb prefixes generated REST clients put before the resource name, each
// with an optional `One`/`Many` cardinality (find / findOne / findManyPeople /
// listWidgets). The captured remainder must start with an upper-case letter so we
// don't strip "find" off a resource literally named "findings". The optional
// `(?:One|Many)?` is greedy, so "findManyPeople" yields "People" (Many consumed),
// not "ManyPeople" — replacing the old longest-first ordered prefix list.
const OPERATION_VERBS = ["find", "get", "list", "create", "update", "delete"] as const;
const OPERATION_VERB_RE = new RegExp(`^(?:${OPERATION_VERBS.join("|")})(?:One|Many)?([A-Z].*)$`);

/** `deleteOneCompany` → `Company`; `findManyPeople` → `Person` (via singularize). */
function schemaFromOperationId(operationId: string): string | undefined {
  const rest = OPERATION_VERB_RE.exec(operationId)?.[1];
  return rest ? singularize(rest) : undefined;
}

/** Pick the candidate that appears most often AND is a real schema. */
function mostFrequentMatch(candidates: string[], schemaNames: Set<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const match = matchSchemaName(c, schemaNames);
    if (match) counts.set(match, (counts.get(match) ?? 0) + 1);
  }
  // Highest count wins; the stable sort keeps the first-inserted (earliest
  // candidate) on ties — same tie-break as a strict `>` scan.
  const ranked = [...counts.entries()].toSorted(([, a], [, b]) => b - a);
  return ranked[0]?.[0];
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
 * Walk a record schema's properties into columns + joins. A `$ref` (or array of
 * `$ref`) whose target is a real entity becomes a join — a relationship the agent
 * can traverse to another entity block. A `$ref` to a schema that is NOT an
 * entity (a value object with no resource/operations) becomes a typed column
 * instead: the agent can't `executeRestOperation` on a non-resource, so emitting
 * a join to it would be a dangling edge. Everything else is a column. Inline
 * objects are flattened one level into dotted columns so nested shapes
 * (`emails.primaryEmail`, `bodyV2.markdown`) stay visible. The record schema is
 * resolved through one ref hop if it is itself a bare `$ref` pointer.
 */
function deriveColumnsAndJoins(
  schema: OpenApiSchema,
  graph: OperationGraph,
  entitySchemaNames: ReadonlySet<string>,
): { columns: GeneratedColumn[]; joins: GeneratedJoin[] } {
  const resolved = resolveSchema(schema, graph);
  const columns: GeneratedColumn[] = [];
  const joins: GeneratedJoin[] = [];
  if (!resolved) return { columns, joins };

  const properties = collectProperties(resolved, graph);
  for (const [propName, propSchema] of properties) {
    const refTarget = refTargetOf(propSchema);
    if (refTarget && entitySchemaNames.has(refTarget.name)) {
      // Ref to a real entity → a traversable join.
      joins.push({
        via: propName,
        targetEntity: refTarget.name,
        relationship: refTarget.isArray ? "one_to_many" : "many_to_one",
        ...(refTarget.description ? { description: refTarget.description } : {}),
      });
      continue;
    }
    if (refTarget) {
      // Ref to a non-entity schema (value object) → a typed column, never a join,
      // so the model never advertises an edge to an entity block that isn't there.
      columns.push(leafColumn(propName, propSchema));
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

/**
 * Collect a record schema's properties, MERGING any `allOf`/`oneOf`/`anyOf`
 * branches (one ref hop each) so a record modeled purely by composition — common
 * in generated specs like Stripe (`User: allOf: [BaseUser, {...}]`) — still
 * yields its full field surface instead of an empty entity (Codex review). Own
 * properties take precedence and keep their order; branch properties fill in the
 * rest (`oneOf`/`anyOf` unioned best-effort, since a composed record is described
 * by what its variants expose). Deterministic insertion order keeps goldens stable.
 */
function collectProperties(
  schema: OpenApiSchemaInline,
  graph: OperationGraph,
): Map<string, OpenApiSchema> {
  const merged = new Map<string, OpenApiSchema>();
  if (schema.properties) {
    for (const [name, prop] of schema.properties) merged.set(name, prop);
  }
  const branches = [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
  for (const branch of branches) {
    const inline = resolveSchema(branch, graph);
    if (!inline?.properties) continue;
    for (const [name, prop] of inline.properties) {
      if (!merged.has(name)) merged.set(name, prop); // own props win on clash
    }
  }
  return merged;
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
      // Flatten one level: each child becomes a `parent.child` column. A `$ref`
      // child of an inline object is rendered as a typed leaf (type = the ref
      // name), NOT promoted to a join — joins are derived only from top-level
      // properties, since record schemas don't nest entity relationships under
      // anonymous inline objects in practice.
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
    // Non-path params only — path params are already visible in `path`.
    parameters: op.parameters
      .filter((p) => p.in !== "path")
      .map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        ...(p.description ? { description: p.description } : {}),
      })),
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
  quoteStyle: "double",
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
  // Shared entity-YAML key names come from the @useatlas/schemas vocabulary
  // contract (#3628) so this renderer and the DB renderer can't drift on
  // `dimensions` / `joins` / `query_parameters` / `target_entity` etc.
  const doc: Record<string, unknown> = {
    [ENTITY_YAML_KEYS.name]: entity.name,
    [ENTITY_YAML_KEYS.type]: REST_ENTITY_TYPE_TAG,
    resource: entity.resource,
  };
  if (entity.recordSchema) doc.record_schema = entity.recordSchema;
  doc[ENTITY_YAML_KEYS.description] = entity.description;

  doc.operations = entity.operations.map((op) => {
    const o: Record<string, unknown> = {
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      kind: op.kind,
      writes: op.writes,
    };
    if (op.summary) o.summary = op.summary;
    if (op.parameters.length > 0) {
      o.parameters = op.parameters.map((p) => {
        const pp: Record<string, unknown> = { name: p.name, in: p.in, required: p.required };
        if (p.description) pp.description = p.description;
        return pp;
      });
    }
    return o;
  });

  if (entity.columns.length > 0) {
    doc[ENTITY_YAML_KEYS.dimensions] = entity.columns.map((col) => {
      const c: Record<string, unknown> = {
        [ENTITY_YAML_DIMENSION_KEYS.name]: col.name,
        [ENTITY_YAML_DIMENSION_KEYS.type]: col.type,
      };
      if (col.primaryKey) c[ENTITY_YAML_DIMENSION_KEYS.primaryKey] = true;
      if (col.description) c[ENTITY_YAML_DIMENSION_KEYS.description] = col.description;
      return c;
    });
  }

  if (entity.joins.length > 0) {
    doc[ENTITY_YAML_KEYS.joins] = entity.joins.map((join) => {
      const j: Record<string, unknown> = {
        [ENTITY_YAML_JOIN_KEYS.targetEntity]: join.targetEntity,
        [ENTITY_YAML_JOIN_KEYS.relationship]: join.relationship,
        via: join.via,
      };
      if (join.description) j[ENTITY_YAML_KEYS.description] = join.description;
      return j;
    });
  }

  if (entity.queryPatterns.length > 0) {
    doc[ENTITY_YAML_KEYS.queryPatterns] = entity.queryPatterns.map((qp) => ({
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
