/**
 * Shared tool descriptions for typed semantic-layer tools (#2020).
 *
 * Both surfaces — agent tool registry and MCP `registerSemanticTools` —
 * import from this module so the LLM-facing prose for `listEntities`,
 * `describeEntity`, `searchGlossary`, and `runMetric` stays in lockstep.
 *
 * Why these strings live here and not next to each tool:
 * - The agent registry exposes tool descriptions in the system prompt;
 *   the MCP server exposes them in tool metadata. Both need identical
 *   prose, and neither surface owns the other.
 * - `explore` and `executeSQL` keep their descriptions inline because
 *   they're already AI SDK `tool({ description })` definitions
 *   (`packages/api/src/lib/tools/{explore,sql}.ts`). The MCP layer reads
 *   `tool.description` directly. New typed tools have no AI SDK wrapper
 *   yet, so this file is their single source of truth.
 *
 * Style: terse, schema-first, tells the LLM when to call the tool and
 * what shape to expect back. Avoid prose that duplicates the input/output
 * Zod schema — the schema is the contract.
 */

export const LIST_ENTITIES_TOOL_DESCRIPTION = `List semantic-layer entities (tables/views) declared in the project.

Returns one row per entity with { name, table, description, source }. Use this to
discover what tables are available before reading their schemas. Pass an optional
\`filter\` (case-insensitive substring) when the catalog is large — matches
against name, table, and description.

Prefer this tool over the \`explore\` shell when you only need the catalog.`;

export const DESCRIBE_ENTITY_TOOL_DESCRIPTION = `Return the full parsed entity definition for a single entity.

Output is the entity's YAML rendered as JSON: dimensions (with types and sample
values), measures, joins, query patterns, grain, and connection. Look up by the
entity's \`name\` field or by \`table\` name — both work.

Always call this before writing SQL against an unfamiliar table. Returns
{ found: false } when the entity does not exist.`;

export const SEARCH_GLOSSARY_TOOL_DESCRIPTION = `Search the business glossary for a term.

Returns matching glossary entries with { term, status, definition, note,
possible_mappings, source }. Substring match across term, definition, and note.

Critical: when a returned term has \`status: ambiguous\`, do NOT pick a mapping
silently — surface the ambiguity to the user with the \`possible_mappings\` and
ask which they mean. Empty result means no canonical definition; treat the term
as a free-form column name and verify against entity schemas.`;

export const RUN_METRIC_TOOL_DESCRIPTION = `Execute a canonical metric defined under \`semantic/metrics/\`.

Looks up the metric by \`id\`, runs its authoritative SQL through the same
read-only pipeline as \`executeSQL\` (4-layer validation, RLS injection,
auto-LIMIT, statement timeout), and returns { value, columns, rows, sql,
executed_at }. \`value\` is the scalar when the result is a single column / single
row; otherwise it falls back to the row array.

Use this whenever a metric exists for what the user asked — never reinvent the
SQL. Returns an error when the metric id is unknown or the underlying SQL fails
validation.

\`filters\` is reserved for future pre-aggregation filter pass-through; passing
a non-empty \`filters\` object is rejected today.`;

/** Canonical tool names for the typed semantic tools registered over MCP. */
export const SEMANTIC_TOOL_NAMES = [
  "listEntities",
  "describeEntity",
  "searchGlossary",
  "runMetric",
] as const;

export type SemanticToolName = (typeof SEMANTIC_TOOL_NAMES)[number];
