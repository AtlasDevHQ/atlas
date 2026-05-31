/**
 * `openapi-diff` — the pure spec-drift diff over two normalized
 * {@link OperationGraph}s (PRD #2868, v0.0.3 — Spec Lifecycle, #2976).
 *
 * `diffOperationGraphs(prev, next)` is a deep module with one job: turn "the spec
 * was re-probed" into a structured, legible changeset an admin (and, later, the
 * #2979 breaking-change classifier) can read — instead of a silent snapshot swap.
 * It is PURE and SIDE-EFFECT-FREE: no clock, no I/O, no per-API branching. The
 * re-discovery route persists its output; the web detail page renders it.
 *
 * **What it diffs (the agent-relevant surface, AC4):**
 *   - The OPERATION SET — operations added / removed, keyed by `operationId`.
 *   - PER-OPERATION FIELDS — the query-pattern params, request-body fields, and
 *     response-body fields the agent reads, flattened to dotted paths so an
 *     added / removed / retyped field surfaces at exactly its location.
 *   - OPERATION ATTRIBUTES — `method` / `path` / `security` / side-effecting: the
 *     routing-and-safety facts a stable `operationId` can silently change under.
 *   - NAMED COMPONENT SCHEMAS — added / removed / changed, with the same
 *     field-level delta. A `$ref` join (e.g. Person → Company) is a leaf field
 *     whose descriptor carries `ref`, so re-targeting a join reads as a *retyped*
 *     field rather than vanishing into the pointer.
 *
 * **Why operations reference schemas by pointer, and schemas are diffed
 * separately:** the normalized graph models a named-component `$ref` as a pointer
 * (`{ ref: "Person" }`), not an inline copy — that's what keeps a cyclic spec
 * finite (see `types.ts`). So a change *inside* `Person` would be invisible if we
 * only walked each operation's fields and stopped at the pointer. Diffing
 * `graph.schemas` independently captures it once, at the source, instead of
 * smeared across every operation that returns a `Person`.
 *
 * **Deterministic + order-insensitive:** every output list is sorted by a stable
 * key (operationId, schema name, field path), and every map is walked in sorted
 * order. The same two graphs always produce byte-identical output, so the
 * persisted diff is stable to store and compare.
 *
 * **Deliberately NOT here:** breaking-vs-additive classification (#2979 runs over
 * this changeset), and cosmetic prose (`summary` / `description` / `tags`) — the
 * latter is excluded so the diff stays signal, not churn.
 */
import type { Operation, OperationGraph, OpenApiSchema } from "./types";

// ─────────────────────────────────────────────────────────────────────
//  Output shape
// ─────────────────────────────────────────────────────────────────────

/**
 * A normalized, comparable descriptor of one field's type. Only the facts that
 * matter to a consumer reading the field are kept — the same minimal subset the
 * normalized {@link OpenApiSchema} models. A `$ref` join is represented by `ref`
 * (the target component name) and carries no other type facts; an inline field
 * carries `type` / `format` / `nullable` / `enum`. `required` is folded in from
 * the parent object so a field flipping required ↔ optional reads as a retype.
 */
export interface FieldDescriptor {
  /** JSON Schema `type` (e.g. "object", "array", "string"). Absent for a `$ref`. */
  readonly type?: string;
  /** JSON Schema `format` hint (e.g. "uuid", "date-time", "int64"). */
  readonly format?: string;
  /** Named-component pointer — a `$ref` join target (e.g. "Company"). */
  readonly ref?: string;
  /** True when the field is nullable. */
  readonly nullable?: boolean;
  /**
   * True when the parent object lists this property as required. Canonicalized to
   * absent (never `false`) by {@link describeNode}, so {@link descriptorsEqual}'s
   * `undefined !== false` comparison never reads a non-required field as changed.
   */
  readonly required?: boolean;
  /**
   * True when this field is required AND *every enclosing container* up to the
   * request surface is also required — i.e. an existing caller must already be
   * sending this field's whole parent chain, so newly requiring it breaks them
   * (#3050). Distinct from {@link required} (the IMMEDIATE-parent flag): a required
   * child of an OPTIONAL request body / optional ancestor has `required: true` but
   * `effectiveRequired` ABSENT, because a caller omitting the optional container
   * keeps working. Set on request surfaces (the operation's REQUIRED params +
   * required request body) and on named-component fields the diff has proven reachable from
   * a request surface *exclusively* (never also a response — see
   * {@link computeRequestExclusiveSchemas}). Always ABSENT on response/quiet
   * surfaces. It is the SINGLE input the #2979 classifier reads to decide an
   * added-field-is-breaking, so the rule needs no dotted-path parsing.
   *
   * DELIBERATELY EXCLUDED from {@link descriptorsEqual} / {@link serializeDescriptor}:
   * it is a derived classification hint, not a structural fact. A node flipping
   * `effectiveRequired` because an *ancestor* gained/lost `required` must not read as
   * a retype (the requiredness change at the actual node is already caught via
   * {@link required}); and composition-branch keys must stay stable.
   */
  readonly effectiveRequired?: boolean;
  /** Allowed enumerated values, normalized to a sorted string array for stable comparison. */
  readonly enum?: ReadonlyArray<string>;
}

/** Whether a field appeared, vanished, or changed type between snapshots. */
export type FieldChangeKind = "added" | "removed" | "retyped";

/**
 * A single field-level change at a dotted path within an operation or schema.
 *
 * A discriminated union on {@link FieldChangeKind} so the descriptor invariant is
 * encoded in the type, not merely asserted in prose: `added` carries only `after`,
 * `removed` only `before`, `retyped` both. Illegal shapes (an `added` with a
 * `before`, a `retyped` missing a side) are unrepresentable, and the #2979
 * classifier can `switch (change.kind)` and read `before`/`after` without a
 * non-null assertion.
 *
 * **`path` grammar** (the field's location — shared by every arm):
 *   - Operation param: `param:<in>:<name>` (e.g. `param:query:limit`).
 *   - Request body: `requestBody:<media>[.prop…]`.
 *   - Response body: `response:<status>:<media>[.prop…]`.
 *   - Named schema: the bare property path. `""` is the schema root itself, which
 *     surfaces a change when the root's own type/ref/enum moved (a scalar/enum/ref
 *     alias retyped, or an object↔array flip at the top level).
 *   - Array elements append `[]`. Composition branches append `|<keyword>[<i>]`
 *     (e.g. `…|oneOf[0]`), where `<keyword>` is `allOf`/`oneOf`/`anyOf` and `<i>`
 *     is the branch's index AFTER a stable content sort — so reordering branches
 *     in the source spec never shifts a path (see {@link flattenSchema}).
 */
export type FieldChange =
  | { readonly path: string; readonly kind: "added"; readonly after: FieldDescriptor }
  | { readonly path: string; readonly kind: "removed"; readonly before: FieldDescriptor }
  | {
      readonly path: string;
      readonly kind: "retyped";
      readonly before: FieldDescriptor;
      readonly after: FieldDescriptor;
    };

/** The operation-level scalar attributes a stable `operationId` can change under. */
export type OperationAttributeName = "method" | "path" | "security" | "sideEffecting";

/** A change to one operation-level attribute. Values are stringified for a uniform shape. */
export interface AttributeChange {
  readonly name: OperationAttributeName;
  readonly before: string;
  readonly after: string;
}

/** A lightweight reference to a wholly-added or wholly-removed operation. */
export interface OperationRef {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary?: string;
}

/** An operation present in both graphs whose attributes and/or fields changed. */
export interface OperationChange {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly attributes: ReadonlyArray<AttributeChange>;
  readonly fields: ReadonlyArray<FieldChange>;
}

/** A named component schema present in both graphs whose fields changed. */
export interface SchemaChange {
  readonly name: string;
  readonly fields: ReadonlyArray<FieldChange>;
}

/** Rolled-up tallies for the one-line summary ("2 new operations, 1 removed, 3 changed fields"). */
export interface DiffCounts {
  readonly operationsAdded: number;
  readonly operationsRemoved: number;
  readonly operationsChanged: number;
  readonly schemasAdded: number;
  readonly schemasRemoved: number;
  readonly schemasChanged: number;
  readonly fieldsAdded: number;
  readonly fieldsRemoved: number;
  readonly fieldsRetyped: number;
}

/** The structured changeset between two operation graphs. */
export interface OperationGraphDiff {
  readonly operations: {
    readonly added: ReadonlyArray<OperationRef>;
    readonly removed: ReadonlyArray<OperationRef>;
    readonly changed: ReadonlyArray<OperationChange>;
  };
  readonly schemas: {
    readonly added: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
    readonly changed: ReadonlyArray<SchemaChange>;
  };
  readonly counts: DiffCounts;
  /** True when every list is empty — a re-probe that moved nothing. Drives "no changes". */
  readonly unchanged: boolean;
}

// ─────────────────────────────────────────────────────────────────────
//  Internals — field flattening
// ─────────────────────────────────────────────────────────────────────

/**
 * Recursion guard for the inline-schema walk. `$ref` pointers don't recurse (a
 * named target is diffed separately), so this only bounds genuinely deep inline
 * nesting — a depth no real spec reaches, well past which extra detail is noise.
 */
const MAX_FIELD_DEPTH = 12;

/** Stringify enum members and sort, so member order never reads as a change. */
function normalizeEnum(values: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).toSorted();
}

/**
 * Describe a single schema node as the minimal comparable {@link FieldDescriptor}.
 * `required` is the immediate-parent flag (structural, compared); `chainRequired`
 * is whether the chain ABOVE this node is required. {@link FieldDescriptor.effectiveRequired}
 * (a classification hint, NOT compared) is set only when BOTH hold — i.e. this node
 * is itself required AND every enclosing container is too. The `required` conjunct is
 * load-bearing: a container the chain passes THROUGH (an `allOf` branch root, an
 * array-items node) has `chainRequired: true` but `required: false`, and must NOT be
 * flagged — gaining an `allOf` branch of all-optional fields forces no existing
 * caller to send anything new (#3050 follow-up: the classifier would otherwise emit a
 * false `field_required_added` on the `…|allOf[n]` root).
 */
function describeNode(
  schema: OpenApiSchema,
  required: boolean,
  chainRequired: boolean,
): FieldDescriptor {
  const d: {
    type?: string;
    format?: string;
    ref?: string;
    nullable?: boolean;
    required?: boolean;
    effectiveRequired?: boolean;
    enum?: ReadonlyArray<string>;
  } = {};
  if (schema.ref !== undefined) {
    // A `$ref` pointer carries only its target — no inline type facts apply.
    d.ref = schema.ref;
  } else {
    if (schema.type !== undefined) d.type = schema.type;
    if (schema.format !== undefined) d.format = schema.format;
    if (schema.nullable === true) d.nullable = true;
    if (schema.enum !== undefined) d.enum = normalizeEnum(schema.enum);
  }
  if (required) d.required = true;
  if (required && chainRequired) d.effectiveRequired = true;
  return d;
}

/**
 * Canonical string form of a descriptor, used to content-key composition branches.
 * Fields are emitted positionally in a FIXED order (and `enum` is pre-sorted by
 * {@link normalizeEnum}), so the output is deterministic — equal descriptors
 * always serialize to equal strings, and `undefined` members are preserved as
 * `null` by `JSON.stringify` so position never shifts. `effectiveRequired` is
 * DELIBERATELY omitted (mirroring {@link descriptorsEqual}): a derived
 * classification hint must not perturb branch keys (see {@link FieldDescriptor}).
 */
function serializeDescriptor(d: FieldDescriptor): string {
  return JSON.stringify([d.type, d.format, d.ref, d.nullable, d.required, d.enum]);
}

/** Join a property name onto a base path (no leading dot when the base is the root). */
function joinProp(base: string, name: string): string {
  return base === "" ? name : `${base}.${name}`;
}

/** Append the array-element marker to a base path. */
function joinItems(base: string): string {
  return base === "" ? "[]" : `${base}[]`;
}

/**
 * Flatten a schema into `out` as `path → descriptor` leaves. A `$ref` pointer is
 * a terminal leaf (the named target is diffed in the schema pass — following it
 * here would both double-count and risk a cycle). Inline objects/arrays/
 * compositions recurse with a dotted path, bounded by {@link MAX_FIELD_DEPTH}.
 *
 * `required` is the immediate-parent flag (folded into the descriptor + compared);
 * `chainRequired` is whether the WHOLE chain from the request surface down to and
 * including this node is required, surfaced as `effectiveRequired` (#3050). It
 * propagates only through required-preserving edges: a required object property
 * (`chainRequired && requiredNames.has(name)`), array items (an array present ⟹ its
 * elements present), and `allOf` branches (an intersection — every branch applies).
 * `oneOf`/`anyOf` branches break the chain (a union member is not guaranteed), so
 * they recurse with `chainRequired: false`.
 */
function flattenSchema(
  schema: OpenApiSchema,
  path: string,
  out: Map<string, FieldDescriptor>,
  depth: number,
  required: boolean,
  chainRequired: boolean,
): void {
  out.set(path, describeNode(schema, required, chainRequired));
  if (schema.ref !== undefined || depth >= MAX_FIELD_DEPTH) return;

  if (schema.properties) {
    const requiredNames = new Set(schema.required ?? []);
    for (const name of [...schema.properties.keys()].toSorted()) {
      const child = schema.properties.get(name);
      const childRequired = requiredNames.has(name);
      if (child)
        flattenSchema(child, joinProp(path, name), out, depth + 1, childRequired, chainRequired && childRequired);
    }
  }
  if (schema.items) {
    flattenSchema(schema.items, joinItems(path), out, depth + 1, false, chainRequired);
  }
  for (const [keyword, branches] of [
    ["allOf", schema.allOf],
    ["oneOf", schema.oneOf],
    ["anyOf", schema.anyOf],
  ] as const) {
    if (!branches) continue;
    const branchChainRequired = keyword === "allOf" && chainRequired;
    // Composition branches are an UNORDERED set — `allOf` is an intersection,
    // `oneOf`/`anyOf` a union; JSON Schema assigns no meaning to their array
    // order. A generator that merely reorders branches between probes must
    // therefore read as `unchanged`, not field churn. So sort branches by a
    // stable key derived from their own flattened content BEFORE assigning the
    // positional index in the path — a pure reorder then yields byte-identical
    // paths, preserving the module's order-insensitive contract. (A genuine
    // add/remove of a branch still surfaces.) Keys are computed once, not on
    // every comparator call, to keep the sort cheap.
    const keyed = branches.map((branch) => ({
      key: stableSchemaKey(branch, depth + 1),
      branch,
    }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    keyed.forEach(({ branch }, i) =>
      flattenSchema(branch, `${path}|${keyword}[${i}]`, out, depth + 1, false, branchChainRequired),
    );
  }
}

/**
 * A stable, content-derived key for one composition branch: its own flattened
 * `path → descriptor` leaves serialized in sorted order. Used to sort
 * `allOf`/`oneOf`/`anyOf` branches deterministically so their array order in the
 * source spec never leaks into the diff (see {@link flattenSchema}). Recurses
 * through {@link flattenSchema}, so it is bounded by {@link MAX_FIELD_DEPTH} the
 * same way the main walk is.
 */
function stableSchemaKey(schema: OpenApiSchema, depth: number): string {
  const tmp = new Map<string, FieldDescriptor>();
  flattenSchema(schema, "", tmp, depth, false, false);
  return [...tmp.keys()]
    .toSorted()
    .map((p) => `${p}=${serializeDescriptor(tmp.get(p)!)}`)
    .join("|");
}

/**
 * Flatten a named component schema's fields (root under the empty path).
 * `requestExclusive` seeds the chain-required flag and is the caller's verdict that
 * the schema was request-exclusive *in the prior spec* — reachable from a request
 * surface via an all-required chain and NEVER from a response (see
 * {@link computeRequestExclusiveSchemas}). True ⇒ a newly-required field on it breaks
 * the spec's pre-existing request callers (#3050). For any other schema
 * (response-reachable, unreachable, or only newly request-reachable in this diff) the
 * chain starts broken, so added fields stay quiet — preserving both the conservative
 * "ambiguous surface ⇒ additive" policy and the "additive change can't break an
 * existing caller" rule.
 */
function flattenSchemaFields(
  schema: OpenApiSchema,
  requestExclusive: boolean,
): Map<string, FieldDescriptor> {
  const out = new Map<string, FieldDescriptor>();
  flattenSchema(schema, "", out, 0, false, requestExclusive);
  return out;
}

/**
 * Flatten an operation's agent-relevant fields: query-pattern parameters, the
 * request body, and every response body — each under a location-prefixed path so
 * a `limit` query param and a `limit` response field never collide. Request
 * surfaces seed `chainRequired` from their own requiredness (a param's `required`,
 * the request body's `required`); responses seed it `false` (an added response
 * field can never break a caller). #3050: a required child of an OPTIONAL request
 * body therefore carries `required: true` but NOT `effectiveRequired`.
 */
function flattenOperationFields(op: Operation): Map<string, FieldDescriptor> {
  const out = new Map<string, FieldDescriptor>();
  for (const p of op.parameters) {
    const base = `param:${p.in}:${p.name}`;
    if (p.schema) flattenSchema(p.schema, base, out, 0, p.required, p.required);
    else out.set(base, p.required ? { required: true, effectiveRequired: true } : {});
  }
  if (op.requestBody) {
    for (const media of [...op.requestBody.content.keys()].toSorted()) {
      const schema = op.requestBody.content.get(media);
      if (schema)
        flattenSchema(schema, `requestBody:${media}`, out, 0, op.requestBody.required, op.requestBody.required);
    }
  }
  for (const status of [...op.responses.keys()].toSorted()) {
    const resp = op.responses.get(status);
    if (!resp) continue;
    for (const media of [...resp.content.keys()].toSorted()) {
      const schema = resp.content.get(media);
      if (schema) flattenSchema(schema, `response:${status}:${media}`, out, 0, false, false);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Internals — named-schema request/response reachability (#3050)
// ─────────────────────────────────────────────────────────────────────

/**
 * The named component schemas reachable from a request surface via an ALL-REQUIRED
 * chain and NEVER from a response surface. An added-required field on such a schema
 * breaks request callers exactly as an inline required request field would (#3050),
 * so {@link flattenSchemaFields} seeds those fields' `effectiveRequired`. A schema
 * also reachable from a response (a read surface) is excluded — matching the
 * standing conservative policy that an added field on an ambiguous surface is
 * additive (the agent reads more, not less).
 *
 * Pure graph walk over `$ref` pointers, bounded by per-side visited sets so a
 * cyclic spec (Twenty's Person ↔ NoteTarget) terminates. The required walk only
 * follows required-preserving edges (required properties, array items, `allOf`
 * branches); `oneOf`/`anyOf` members and optional properties break the chain. The
 * response walk follows EVERY edge — any response appearance makes a schema a read
 * surface, which is enough to keep it quiet.
 */
function computeRequestExclusiveSchemas(graph: OperationGraph): ReadonlySet<string> {
  const requestRequired = new Set<string>();
  const response = new Set<string>();

  // Required walk: contributes a ref target only while the chain stays required.
  const visitedReq = new Set<string>();
  function walkRequired(schema: OpenApiSchema, chainRequired: boolean): void {
    if (!chainRequired) return;
    if (schema.ref !== undefined) {
      if (visitedReq.has(schema.ref)) return;
      visitedReq.add(schema.ref);
      requestRequired.add(schema.ref);
      const target = graph.schemas.get(schema.ref);
      if (target) walkRequired(target, true);
      return;
    }
    if (schema.properties) {
      const requiredNames = new Set(schema.required ?? []);
      for (const [name, child] of schema.properties) walkRequired(child, requiredNames.has(name));
    }
    if (schema.items) walkRequired(schema.items, true);
    if (schema.allOf) for (const branch of schema.allOf) walkRequired(branch, true);
    // oneOf/anyOf members are not guaranteed present → the chain breaks (skip).
  }

  // Response walk: any appearance under a response marks a schema a read surface.
  const visitedResp = new Set<string>();
  function walkResponse(schema: OpenApiSchema): void {
    if (schema.ref !== undefined) {
      if (visitedResp.has(schema.ref)) return;
      visitedResp.add(schema.ref);
      response.add(schema.ref);
      const target = graph.schemas.get(schema.ref);
      if (target) walkResponse(target);
      return;
    }
    if (schema.properties) for (const child of schema.properties.values()) walkResponse(child);
    if (schema.items) walkResponse(schema.items);
    for (const branches of [schema.allOf, schema.oneOf, schema.anyOf]) {
      if (branches) for (const branch of branches) walkResponse(branch);
    }
  }

  for (const op of graph.operations.values()) {
    for (const p of op.parameters) {
      if (p.required && p.schema) walkRequired(p.schema, true);
    }
    if (op.requestBody?.required) {
      for (const schema of op.requestBody.content.values()) walkRequired(schema, true);
    }
    for (const resp of op.responses.values()) {
      for (const schema of resp.content.values()) walkResponse(schema);
    }
  }

  const exclusive = new Set<string>();
  for (const name of requestRequired) if (!response.has(name)) exclusive.add(name);
  return exclusive;
}

// ─────────────────────────────────────────────────────────────────────
//  Internals — comparison
// ─────────────────────────────────────────────────────────────────────

/** Structural equality of two field descriptors (enum compared element-wise, both pre-sorted). */
function descriptorsEqual(a: FieldDescriptor, b: FieldDescriptor): boolean {
  if (a.type !== b.type || a.format !== b.format || a.ref !== b.ref) return false;
  if (a.nullable !== b.nullable || a.required !== b.required) return false;
  const ae = a.enum;
  const be = b.enum;
  if (ae === undefined || be === undefined) return ae === be;
  return ae.length === be.length && ae.every((v, i) => v === be[i]);
}

/** Diff two flattened field maps into a sorted-by-path list of changes. */
function diffFieldMaps(
  prev: Map<string, FieldDescriptor>,
  next: Map<string, FieldDescriptor>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const paths = new Set<string>([...prev.keys(), ...next.keys()]);
  for (const path of [...paths].toSorted()) {
    const before = prev.get(path);
    const after = next.get(path);
    if (before === undefined && after !== undefined) {
      changes.push({ path, kind: "added", after });
    } else if (before !== undefined && after === undefined) {
      changes.push({ path, kind: "removed", before });
    } else if (before !== undefined && after !== undefined && !descriptorsEqual(before, after)) {
      changes.push({ path, kind: "retyped", before, after });
    }
  }
  return changes;
}

/** The operation-level attributes that changed, sorted by attribute name. */
function diffAttributes(prev: Operation, next: Operation): AttributeChange[] {
  const changes: AttributeChange[] = [];
  if (prev.method !== next.method) {
    changes.push({ name: "method", before: prev.method, after: next.method });
  }
  if (prev.path !== next.path) {
    changes.push({ name: "path", before: prev.path, after: next.path });
  }
  const prevSec = [...prev.security].toSorted().join(",");
  const nextSec = [...next.security].toSorted().join(",");
  if (prevSec !== nextSec) {
    changes.push({ name: "security", before: prevSec, after: nextSec });
  }
  const prevSE = String(prev.sideEffecting === true);
  const nextSE = String(next.sideEffecting === true);
  if (prevSE !== nextSE) {
    changes.push({ name: "sideEffecting", before: prevSE, after: nextSE });
  }
  return changes;
}

/** Project an operation to its add/remove summary ref. */
function toOperationRef(op: Operation): OperationRef {
  return {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    ...(op.summary ? { summary: op.summary } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Diff two normalized operation graphs into a structured, deterministic,
 * order-insensitive changeset. The first argument is the PRIOR snapshot's graph,
 * the second the freshly re-probed one; an empty `prev` (the first-ever-discovery
 * baseline) reports every operation and schema as added.
 *
 * Pure: no clock, no I/O. The caller stamps timestamps and persists the result.
 */
export function diffOperationGraphs(
  prev: OperationGraph,
  next: OperationGraph,
): OperationGraphDiff {
  // ── Operations ──────────────────────────────────────────────────────────
  const addedOps: OperationRef[] = [];
  const removedOps: OperationRef[] = [];
  const changedOps: OperationChange[] = [];

  for (const id of [...next.operations.keys()].toSorted()) {
    if (!prev.operations.has(id)) addedOps.push(toOperationRef(next.operations.get(id)!));
  }
  for (const id of [...prev.operations.keys()].toSorted()) {
    if (!next.operations.has(id)) removedOps.push(toOperationRef(prev.operations.get(id)!));
  }
  for (const id of [...next.operations.keys()].toSorted()) {
    const prevOp = prev.operations.get(id);
    const nextOp = next.operations.get(id);
    if (!prevOp || !nextOp) continue; // added/removed handled above
    const attributes = diffAttributes(prevOp, nextOp);
    const fields = diffFieldMaps(flattenOperationFields(prevOp), flattenOperationFields(nextOp));
    if (attributes.length > 0 || fields.length > 0) {
      changedOps.push({ operationId: id, method: nextOp.method, path: nextOp.path, attributes, fields });
    }
  }

  // ── Named component schemas ─────────────────────────────────────────────
  const addedSchemas: string[] = [];
  const removedSchemas: string[] = [];
  const changedSchemas: SchemaChange[] = [];

  // Which named schemas were request-exclusive in the PRIOR spec — seeds the
  // `effectiveRequired` for a schema present in BOTH graphs (a "changed" schema). A
  // breaking change is one that breaks a PRE-EXISTING caller, and a caller exists only
  // for a request surface that already existed; so an added-required field on a
  // component reads as breaking iff the component was *already* a request-exclusive
  // surface — NOT iff it merely becomes one in this diff (#3050 follow-up). Seeding
  // from `next` would both false-POSITIVE (a brand-new required request body referencing
  // a previously-unused/response-only component + a new required prop has no existing
  // callers to break) and false-NEGATIVE (a component already on a required request
  // body that newly also appears in a response would have its real request break masked
  // by the fresh response reachability). Both flatten sides use the same prior seed —
  // `effectiveRequired` is excluded from equality, so the seed never perturbs detection;
  // it only sets the verdict on the `added` side.
  const priorRequestExclusive = computeRequestExclusiveSchemas(prev);

  for (const name of [...next.schemas.keys()].toSorted()) {
    if (!prev.schemas.has(name)) addedSchemas.push(name);
  }
  for (const name of [...prev.schemas.keys()].toSorted()) {
    if (!next.schemas.has(name)) removedSchemas.push(name);
  }
  for (const name of [...next.schemas.keys()].toSorted()) {
    const prevSchema = prev.schemas.get(name);
    const nextSchema = next.schemas.get(name);
    if (!prevSchema || !nextSchema) continue;
    const seed = priorRequestExclusive.has(name);
    const fields = diffFieldMaps(flattenSchemaFields(prevSchema, seed), flattenSchemaFields(nextSchema, seed));
    if (fields.length > 0) changedSchemas.push({ name, fields });
  }

  // ── Counts + roll-up ────────────────────────────────────────────────────
  let fieldsAdded = 0;
  let fieldsRemoved = 0;
  let fieldsRetyped = 0;
  for (const change of [...changedOps, ...changedSchemas]) {
    for (const f of change.fields) {
      if (f.kind === "added") fieldsAdded++;
      else if (f.kind === "removed") fieldsRemoved++;
      else fieldsRetyped++;
    }
  }

  const counts: DiffCounts = {
    operationsAdded: addedOps.length,
    operationsRemoved: removedOps.length,
    operationsChanged: changedOps.length,
    schemasAdded: addedSchemas.length,
    schemasRemoved: removedSchemas.length,
    schemasChanged: changedSchemas.length,
    fieldsAdded,
    fieldsRemoved,
    fieldsRetyped,
  };

  const unchanged =
    addedOps.length === 0 &&
    removedOps.length === 0 &&
    changedOps.length === 0 &&
    addedSchemas.length === 0 &&
    removedSchemas.length === 0 &&
    changedSchemas.length === 0;

  return {
    operations: { added: addedOps, removed: removedOps, changed: changedOps },
    schemas: { added: addedSchemas, removed: removedSchemas, changed: changedSchemas },
    counts,
    unchanged,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Persistence record (stored on the install) + fail-soft projection
// ─────────────────────────────────────────────────────────────────────

/**
 * The spec-diff record persisted at `workspace_plugins.config.openapi_last_diff`
 * on every re-discovery (AC2). Wraps the structured {@link OperationGraphDiff}
 * with the two probe timestamps it was computed across, so the detail page can
 * say "since last refresh (probed at …)". The full diff is retained (not just the
 * summary) so #2979's breaking-change classifier can run over the same changeset
 * without re-probing.
 *
 * There are THREE legitimate states, discriminated by `diff` + `priorParseFailed`:
 *   1. FIRST-EVER DISCOVERY — `diff: null`, `previousProbedAt: null`. Nothing to
 *      compare against (the install baseline). Built by {@link baselineSpecDiffRecord}.
 *   2. UNPARSEABLE PRIOR — `diff: null`, `previousProbedAt` SET, `priorParseFailed:
 *      true`. A prior snapshot existed but no longer rebuilds (older builder /
 *      corrupt cached doc), so the comparison was *abandoned* — distinct from (1),
 *      because real drift may have gone unseen. Built by {@link unparseablePriorDiffRecord}.
 *   3. COMPUTED DIFF — `diff` present; `diff.unchanged` says whether anything moved.
 *
 * Depth note for #2979: the field walk is bounded by {@link MAX_FIELD_DEPTH}, so
 * two specs differing ONLY below that depth read as `unchanged`. The bound is
 * symmetric (both sides truncate identically) so it never invents drift, but a
 * consumer treating `unchanged` as "provably no breaking change" should read it as
 * "no change down to depth {@link MAX_FIELD_DEPTH}".
 */
export interface SpecDiffRecord {
  /**
   * ISO-8601 `probedAt` of the snapshot diffed FROM. `null` only for a first-ever
   * discovery (state 1); SET for an unparseable-prior baseline (state 2) and a
   * computed diff (state 3).
   */
  readonly previousProbedAt: string | null;
  /** ISO-8601 `probedAt` of the freshly re-probed snapshot. */
  readonly currentProbedAt: string;
  /** The structured changeset — `null` for either baseline (states 1 and 2). */
  readonly diff: OperationGraphDiff | null;
  /**
   * `true` only in state 2 — a prior snapshot existed but no longer parsed, so the
   * comparison was dropped. Absent for states 1 and 3. Lets the UI/audit say
   * "comparison unavailable" rather than mislabeling a dropped compare as a clean
   * baseline. See {@link unparseablePriorDiffRecord}.
   */
  readonly priorParseFailed?: boolean;
}

/**
 * Build a BASELINE diff record — the shape a first-ever discovery (install)
 * persists, since there's no prior snapshot to diff against (AC2). Re-discovery
 * later overwrites it with a computed diff. Kept here so every "first discovery"
 * site (the form + oauth-datasource install handlers) stamps an identical shape.
 */
export function baselineSpecDiffRecord(currentProbedAt: string): SpecDiffRecord {
  return { previousProbedAt: null, currentProbedAt, diff: null };
}

/**
 * Build an UNPARSEABLE-PRIOR baseline record (state 2 of {@link SpecDiffRecord}):
 * a prior snapshot existed (so `previousProbedAt` is known) but no longer rebuilds
 * into a graph, so the re-discovery records a baseline rather than failing — and
 * flags `priorParseFailed` so the UI/audit don't mistake the dropped comparison
 * for a clean first-ever baseline. The fresh snapshot is still persisted by the
 * caller; only the *comparison* was lost.
 */
export function unparseablePriorDiffRecord(
  previousProbedAt: string,
  currentProbedAt: string,
): SpecDiffRecord {
  return { previousProbedAt, currentProbedAt, diff: null, priorParseFailed: true };
}

/**
 * Lightweight projection of a {@link SpecDiffRecord} for the list/detail card —
 * the timestamps, the roll-up counts, and the two flags the UI branches on. Omits
 * the per-field detail so the list endpoint stays small; the full diff lives in
 * the persisted record for #2979.
 */
export interface SpecDiffSummary {
  readonly previousProbedAt: string | null;
  readonly currentProbedAt: string;
  /** True when this was a baseline (first discovery, OR an unparseable prior — see {@link priorParseFailed}). */
  readonly baseline: boolean;
  /**
   * True only when `baseline` is true BECAUSE the prior snapshot no longer parsed
   * (state 2) — the comparison was dropped, not absent. Drives the UI's
   * "comparison unavailable" wording vs. a clean "Baseline recorded".
   */
  readonly priorParseFailed: boolean;
  /** True when a comparison ran and nothing moved — drives the "no changes" UI. */
  readonly unchanged: boolean;
  readonly counts: DiffCounts;
}

const ZERO_COUNTS: DiffCounts = {
  operationsAdded: 0,
  operationsRemoved: 0,
  operationsChanged: 0,
  schemasAdded: 0,
  schemasRemoved: 0,
  schemasChanged: 0,
  fieldsAdded: 0,
  fieldsRemoved: 0,
  fieldsRetyped: 0,
};

/** Validate + coerce the 9 numeric tallies read back from JSONB, or `null` if any is missing/wrong-typed. */
function coerceCounts(raw: unknown): DiffCounts | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: Record<keyof DiffCounts, number> = { ...ZERO_COUNTS };
  for (const key of Object.keys(ZERO_COUNTS) as Array<keyof DiffCounts>) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[key] = v;
  }
  return out;
}

/**
 * Fail-soft projection of a `config.openapi_last_diff` value read back from JSONB
 * into a {@link SpecDiffSummary}, or `null` when the install has no (valid) diff
 * record yet. The value is untyped at the trust boundary — an older writer, an
 * absent field, or a hand-edited row could be malformed — so a record missing its
 * `currentProbedAt` or its numeric `counts` coerces to `null` (the card shows
 * nothing) rather than rendering `undefined`/`NaN`. A record whose `diff` is
 * `null` is a legitimate baseline, surfaced as `baseline: true`; when that baseline
 * is due to an unparseable prior (`priorParseFailed: true` on the record), the flag
 * is carried through so the UI can distinguish a dropped comparison from a clean
 * first-ever baseline.
 */
export function summarizeSpecDiffRecord(raw: unknown): SpecDiffSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.currentProbedAt !== "string") return null;
  const previousProbedAt = typeof r.previousProbedAt === "string" ? r.previousProbedAt : null;

  // Baseline: no prior snapshot was compared against (first discovery, or the
  // prior snapshot no longer parsed) — `diff` is explicitly null/absent.
  if (r.diff === null || r.diff === undefined) {
    return {
      previousProbedAt,
      currentProbedAt: r.currentProbedAt,
      baseline: true,
      priorParseFailed: r.priorParseFailed === true,
      unchanged: false,
      counts: ZERO_COUNTS,
    };
  }

  if (typeof r.diff !== "object") return null;
  const counts = coerceCounts((r.diff as Record<string, unknown>).counts);
  if (!counts) return null;
  return {
    previousProbedAt,
    currentProbedAt: r.currentProbedAt,
    baseline: false,
    priorParseFailed: false,
    unchanged: (r.diff as Record<string, unknown>).unchanged === true,
    counts,
  };
}
