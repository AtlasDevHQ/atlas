/**
 * `openapi-representation` — turns the slice-0 {@link OperationGraph} into the
 * prompt context the agent reads (the "representation" the v0.0.2 bake-off
 * compares).
 *
 * This is the consumer slice-0 left a clean extension point for: the
 * prompt-context builder reads {@link OperationGraph} rather than re-walking the
 * raw spec (`types.ts` header). Two representation strategies exist:
 *
 *  - **Path A — `"operation-graph"`** (#2924): render a trimmed slice of the
 *    operation graph directly into the prompt. No semantic-YAML layer.
 *    Implemented here.
 *  - **Path B — `"semantic-yaml"`** (#2931): generate a semantic model from the
 *    graph (`semantic-generator.ts`) and feed the rendered entity YAMLs as the
 *    prompt context — the same entity-relational surface the agent already reads
 *    for SQL datasources. Implemented here; delegates the walk to the generator.
 *
 * Both paths share the datasource header ({@link renderDatasourceHeader}) — the
 * "this is a REST API, call executeRestOperation, read-only" framing is identical;
 * only the body (flat operation digest vs entity YAMLs) differs. The acceptance
 * suite (`__tests__/twenty-acceptance.test.ts`) is parameterized over
 * {@link RepresentationMode}; both modes produce an {@link AgentRepresentation}
 * with the same shape (`promptContext` + metrics) so #2931 re-runs identical
 * assertions and compares prompt size / agent step count head-to-head.
 *
 * Token-bounded by construction: the graph is rendered as a compact digest
 * (operation table + schema property summaries), never raw JSON — a real Twenty
 * `/rest/open-api/core` document is ~250KB of JSON, far too large to inline.
 */
import type {
  OpenApiSchema,
  OpenApiSchemaInline,
  Operation,
  OperationGraph,
  OperationParameter,
} from "./types";
import { generateSemanticModel, renderModelYaml, type OpenApiSemanticModel } from "./semantic-generator";

// ─────────────────────────────────────────────────────────────────────
//  Mode knob (the bake-off axis)
// ─────────────────────────────────────────────────────────────────────

/** Every mode the acceptance suite knows how to drive. Path A is index 0. */
export const REPRESENTATION_MODES = ["operation-graph", "semantic-yaml"] as const;

/**
 * Which representation strategy renders the agent's prompt context. Derived from
 * {@link REPRESENTATION_MODES} so the type and the runtime list can never drift.
 *
 * `"operation-graph"` (Path A, #2924) renders the graph directly.
 * `"semantic-yaml"` (Path B, #2931) generates semantic YAMLs first.
 */
export type RepresentationMode = (typeof REPRESENTATION_MODES)[number];

/** Thrown when a representation mode is recognized but not yet implemented. */
export class RepresentationNotImplementedError extends Error {
  readonly mode: RepresentationMode;
  constructor(mode: RepresentationMode) {
    super(
      `Representation mode "${mode}" is recognized but not implemented in this slice. ` +
        `Path A ("operation-graph") ships in #2924; Path B ("semantic-yaml") lands in #2931.`,
    );
    this.name = "RepresentationNotImplementedError";
    this.mode = mode;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Output shape
// ─────────────────────────────────────────────────────────────────────

/**
 * The agent-facing representation of a REST datasource, plus the per-run
 * metrics the bake-off (#2931) compares across modes.
 */
export interface AgentRepresentation {
  /** Which strategy produced {@link promptContext}. */
  readonly mode: RepresentationMode;
  /** The text appended to the agent's system prompt. */
  readonly promptContext: string;
  /** Number of operations described — sanity metric for "the agent sees the surface". */
  readonly operationCount: number;
  /**
   * Rough prompt-token estimate of {@link promptContext} (chars / 4). This is
   * the load-bearing bake-off metric: Path A vs Path B differ most on how many
   * tokens the same operation surface costs. Deliberately a cheap heuristic —
   * an exact tokenizer would couple this to a provider.
   */
  readonly approxTokens: number;
  /**
   * Resources whose record schema no cascade layer could resolve (Path B only;
   * always empty for Path A, which has no entity model). The agent-loop consumer
   * logs this so a misconfigured or unusual spec is diagnosable instead of
   * silently yielding field-less entities in the prompt.
   */
  readonly unresolvedResources: ReadonlyArray<string>;
}

export interface BuildRepresentationOptions {
  /**
   * Human-facing name for the datasource, woven into the prompt header so the
   * agent can refer to it ("the Twenty datasource"). Defaults to the spec title.
   */
  readonly displayName?: string;
  /**
   * Whether the sandbox-Python composition path is live. Slice 1 ships
   * read-only single-operation execution via `executeRestOperation`; the Python
   * path (multi-call composition over the upstream) is gated behind slice 3's
   * `networkPolicy` threading, so the prompt does NOT advertise it yet when
   * this is false (the default). Slice 3 (#2927) flips it on.
   */
  readonly pythonCompositionEnabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the agent's prompt context for a REST datasource from its operation
 * graph. Pure function over the graph — no I/O, no agent logic. Both bake-off
 * modes (#2931) are implemented; the {@link RepresentationNotImplementedError}
 * default arm is the compiler-checked guard for any FUTURE mode added to
 * {@link REPRESENTATION_MODES} before it grows a case.
 */
export function buildAgentRepresentation(
  graph: OperationGraph,
  mode: RepresentationMode,
  options: BuildRepresentationOptions = {},
): AgentRepresentation {
  switch (mode) {
    case "operation-graph":
      return finalize(mode, renderOperationGraph(graph, options), graph, []);
    case "semantic-yaml": {
      const model = generateSemanticModel(graph);
      return finalize(mode, renderSemanticYaml(model, graph, options), graph, model.unresolvedResources);
    }
    default: {
      // Exhaustiveness guard: when a NEW mode is added to REPRESENTATION_MODES,
      // the compiler flags this site until the new mode gets a case arm.
      const _exhaustive: never = mode;
      throw new RepresentationNotImplementedError(_exhaustive);
    }
  }
}

/** Wrap a rendered prompt context in the {@link AgentRepresentation} + metrics. */
function finalize(
  mode: RepresentationMode,
  promptContext: string,
  graph: OperationGraph,
  unresolvedResources: ReadonlyArray<string>,
): AgentRepresentation {
  return {
    mode,
    promptContext,
    operationCount: graph.operations.size,
    approxTokens: Math.ceil(promptContext.length / 4),
    unresolvedResources,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Path A renderer — the operation graph as a compact digest
// ─────────────────────────────────────────────────────────────────────

/**
 * The datasource framing shared by both representation modes: "this is a REST
 * API, not SQL; call executeRestOperation; read-only this release". Keeping it
 * in one place means the two bake-off paths differ ONLY in how they describe the
 * surface (flat operation digest vs entity YAMLs), not in the call contract —
 * so a token / step-count delta between them is attributable to the body, not
 * incidental header drift.
 */
function renderDatasourceHeader(
  graph: OperationGraph,
  options: BuildRepresentationOptions,
): string[] {
  const name = options.displayName ?? graph.info.title;
  const out: string[] = [];
  out.push(`## REST Datasource: ${name}`);
  out.push(
    `You can read from the "${name}" REST API (OpenAPI ${graph.info.openapiVersion}). ` +
      `It is NOT a SQL database — there are no tables to \`executeSQL\` against. ` +
      `Instead, call \`executeRestOperation\` with an \`operationId\` from the list below and its parameters.`,
  );
  out.push(
    `**Read-only in this release.** Only GET operations execute; write operations ` +
      `(POST/PATCH/PUT/DELETE) are described so you can plan, but \`executeRestOperation\` ` +
      `rejects them until the write-allowlist ships. Never claim a write succeeded.`,
  );
  if (options.pythonCompositionEnabled) {
    out.push(
      `For multi-step questions that chain operations (e.g. "fetch each person's notes"), ` +
        `prefer \`executePython\` — a pre-seeded \`AtlasRestClient\` lets you loop over results. ` +
        `For a single lookup, use \`executeRestOperation\` directly.`,
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  Path B renderer — the generated semantic model as entity YAMLs
// ─────────────────────────────────────────────────────────────────────

/**
 * Render Path B (`semantic-yaml`): the shared datasource header, the
 * datasource-level filter syntax (surfaced once), then the generated semantic
 * model's entity YAMLs — the same entity-relational surface the agent reads for
 * SQL datasources. Takes the pre-generated model (so the caller can also read its
 * `unresolvedResources`); this function only assembles the prompt frame.
 */
function renderSemanticYaml(
  model: OpenApiSemanticModel,
  graph: OperationGraph,
  options: BuildRepresentationOptions,
): string {
  const out: string[] = renderDatasourceHeader(graph, options);

  out.push(
    `\n### Entities`,
    `This datasource is described below as semantic entities (one per REST resource), ` +
      `the same shape as a SQL datasource: each entity lists the \`operations\` that read/write it ` +
      `(call \`executeRestOperation\` with the \`operationId\`), its \`dimensions\` (columns, including ` +
      `nested fields as dotted paths), \`joins\` to related entities, and \`query_patterns\`.`,
  );
  if (model.filterSyntax) {
    out.push(`\n**Filter syntax** (the \`filter\` query param on list operations): ${model.filterSyntax}`);
  }

  out.push("\n```yaml", renderModelYaml(model).trimEnd(), "```");
  return out.join("\n");
}

function renderOperationGraph(
  graph: OperationGraph,
  options: BuildRepresentationOptions,
): string {
  const out: string[] = renderDatasourceHeader(graph, options);

  // ── Operation table ────────────────────────────────────────────────
  out.push(`\n### Operations`);
  const operations = [...graph.operations.values()].toSorted((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  for (const op of operations) {
    out.push(renderOperation(op));
  }

  // ── Schema digest ──────────────────────────────────────────────────
  // Render the named schemas the operations read/write so the agent knows the
  // field shapes (this is where the filter syntax, targetPersonId join column,
  // inline custom fields, and bodyV2.markdown shape become visible).
  if (graph.schemas.size > 0) {
    out.push(`\n### Record shapes`);
    const schemas = [...graph.schemas.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [schemaName, schema] of schemas) {
      const rendered = renderSchema(schemaName, schema);
      if (rendered) out.push(rendered);
    }
  }

  return out.join("\n");
}

function renderOperation(op: Operation): string {
  const parts: string[] = [`- \`${op.operationId}\` — ${op.method} ${op.path}`];
  if (op.summary) parts.push(`: ${op.summary}`);

  const segments: string[] = [parts.join("")];

  if (op.parameters.length > 0) {
    segments.push(`  params: ${op.parameters.map(renderParameter).join(", ")}`);
  }
  if (op.requestBody) {
    const bodySchema = op.requestBody.content.get("application/json");
    const bodyName = bodySchema ? schemaLabel(bodySchema) : "object";
    const req = op.requestBody.required ? " (required)" : "";
    segments.push(`  body: ${bodyName}${req}`);
  }
  return segments.join("\n");
}

function renderParameter(param: OperationParameter): string {
  const req = param.required ? "!" : "";
  const base = `${param.name}${req} (${param.in})`;
  // Surface the filter parameter's description verbatim — it carries Twenty's
  // non-obvious `field[op]:value` syntax, the single most error-prone shape the
  // agent must get right (regression-guards PR #2865).
  if (param.description && param.name === "filter") {
    return `${base} — ${param.description}`;
  }
  return base;
}

/**
 * Render a named schema's property surface compactly. Refs are shown as
 * `-> Other` pointers (the join the agent follows); inline objects recurse one
 * level so nested shapes like `emails.primaryEmail` and `bodyV2.markdown` are
 * visible without dumping the whole tree. Composition keywords
 * (`allOf`/`oneOf`/`anyOf`) are surfaced too, so a schema built purely from
 * composition (common in generated specs like Stripe — `spec.ts` preserves the
 * branches) isn't silently omitted from the prompt. Returns `undefined` only for
 * a genuinely empty schema (no properties, no composition).
 */
function renderSchema(name: string, schema: OpenApiSchema): string | undefined {
  if (schema.ref !== undefined) {
    return `- **${name}** -> ${schema.ref}`;
  }
  const lines: string[] = [`- **${name}**`];
  if (schema.properties) {
    for (const [propName, propSchema] of schema.properties) {
      lines.push(`  - ${propName}: ${renderPropertyType(propSchema, 1)}${propDescription(propSchema)}`);
    }
  }
  const composition = renderComposition(schema);
  if (composition) lines.push(`  - ${composition}`);
  return lines.length > 1 ? lines.join("\n") : undefined;
}

/** Render a schema's `allOf`/`oneOf`/`anyOf` branches as a compact one-liner. */
function renderComposition(schema: OpenApiSchemaInline): string | undefined {
  if (schema.allOf && schema.allOf.length > 0) {
    return `allOf: ${schema.allOf.map((b) => renderPropertyType(b, 1)).join(" & ")}`;
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return `oneOf: ${schema.oneOf.map((b) => renderPropertyType(b, 1)).join(" | ")}`;
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return `anyOf: ${schema.anyOf.map((b) => renderPropertyType(b, 1)).join(" | ")}`;
  }
  return undefined;
}

/** A short label for a schema in body/param position. */
function schemaLabel(schema: OpenApiSchema): string {
  if (schema.ref !== undefined) return schema.ref;
  if (schema.name !== undefined) return schema.name;
  if (schema.type === "array" && schema.items) return `${schemaLabel(schema.items)}[]`;
  return schema.type ?? "object";
}

/**
 * Render a property's type, recursing into inline objects/arrays up to
 * `maxDepth` so nested shapes (`emails.primaryEmail`, `bodyV2.markdown`) are
 * exposed. Refs render as `-> Name` so the agent can follow the join.
 */
function renderPropertyType(schema: OpenApiSchema, depth: number, maxDepth = 2): string {
  if (schema.ref !== undefined) return `-> ${schema.ref}`;

  if (schema.type === "array" && schema.items) {
    return `${renderPropertyType(schema.items, depth, maxDepth)}[]`;
  }

  if (schema.type === "object" && schema.properties && depth < maxDepth) {
    const inner = [...schema.properties.entries()]
      .map(([k, v]) => `${k}: ${renderPropertyType(v, depth + 1, maxDepth)}`)
      .join(", ");
    return inner.length > 0 ? `{ ${inner} }` : "object";
  }

  // Composition at the property level (e.g. a nullable `anyOf: [{$ref}]`).
  if (schema.allOf && schema.allOf.length > 0) {
    return schema.allOf.map((b) => renderPropertyType(b, depth, maxDepth)).join(" & ");
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return schema.oneOf.map((b) => renderPropertyType(b, depth, maxDepth)).join(" | ");
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return schema.anyOf.map((b) => renderPropertyType(b, depth, maxDepth)).join(" | ");
  }

  const base = schema.type ?? "object";
  return schema.nullable ? `${base}?` : base;
}

/** Only surface property descriptions that carry load-bearing guidance. */
function propDescription(schema: OpenApiSchema): string {
  if (schema.ref !== undefined) return "";
  return schema.description ? ` — ${schema.description}` : "";
}
