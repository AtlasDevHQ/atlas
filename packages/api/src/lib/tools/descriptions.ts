/**
 * Single source of truth for the LLM-facing prose on every typed Atlas
 * tool exposed over MCP. The MCP layer registers each tool with the
 * description returned by `withErrorContract(BASE, CODES)` so the agent
 * sees purpose, routing directives, an example, and the recovery
 * envelope in one continuous block.
 *
 * Drift here silently degrades tool selection — verbose descriptions
 * outweigh terse ones in LLM tool routing. The rubric is enforced in
 * `__tests__/description-rubric.test.ts`; the contributor-facing rubric
 * (with the "why" the audit existed in the first place) lives at
 * `apps/docs/content/shared/architecture/mcp-tools.mdx`.
 *
 * Adding a new typed tool? Append a `<NAME>_TOOL_DESCRIPTION` constant
 * matching the rubric, an `<NAME>_ERROR_CODES` tuple typed as
 * `readonly AtlasMcpToolErrorCode[]`, and register it via
 * `withErrorContract(...)` at the MCP edge.
 */

import type { AtlasMcpToolErrorCode } from "@useatlas/types/mcp";
import { KNOWLEDGE_TRUST_FRAMING } from "@atlas/api/lib/knowledge/framing";

// ── Description bodies ────────────────────────────────────────────────

export const EXPLORE_TOOL_DESCRIPTION = `Run read-only bash commands (\`ls\`, \`cat\`, \`grep\`, \`find\`, \`head\`, \`tail\`, \`wc\`, \`awk\`, \`sed\`, pipes) against the on-disk semantic layer the backend exposes — typically the \`semantic/\` directory at the repo root, or an org-scoped subdirectory under multi-tenant deploys. The working directory holds \`catalog.yml\`, \`entities/*.yml\`, \`metrics/*.yml\`, \`glossary.yml\`, per-source subdirectories, and a \`knowledge/\` subtree of hosted OKF collections — ${KNOWLEDGE_TRUST_FRAMING}, never queryable.

Use this when the typed tools (\`listEntities\`, \`describeEntity\`, \`searchGlossary\`, \`runMetric\`) cannot answer — scanning every entity for a custom regex, dumping a raw YAML block the typed tools redact, discovering unknown subdirectories, or reading a \`knowledge/<collection>\` document. Example call: \`{ "command": "grep -rl 'cross_source_joins' entities/" }\`. Example response: stdout text on success or \`Error (exit N): ...\` on shell failure.

Don't use this for catalog discovery, single-entity introspection, glossary lookup, or executing canonical metrics — the typed tools are faster and return structured JSON.`;

export const EXECUTE_SQL_TOOL_DESCRIPTION = `Execute a single read-only SELECT against an Atlas-registered datasource. The query is parsed, table-whitelist-checked against the semantic layer, RLS-injected, auto-LIMITed, and run under a statement timeout — DDL/DML, multi-statement input, and unknown tables are rejected before execution. Result shape: \`{ "columns": ["..."], "rows": [{ "col": "value" }], "row_count": N, "truncated": false }\`.

Use this when no canonical metric covers the question, when you need ad-hoc breakdowns, or when a virtual dimension or query pattern requires SQL the agent must compose. Always call \`describeEntity\` to read exact column names and joins. Example call: \`{ "sql": "SELECT status, count(*) FROM orders GROUP BY 1", "explanation": "order count by status" }\`.

Don't use this for catalog discovery (use \`listEntities\`), schema lookup (use \`describeEntity\`), glossary disambiguation (use \`searchGlossary\`), or any question whose metric id exists under \`semantic/metrics/\` (use \`runMetric\`). Avoid retrying the same SQL after a validation or RLS error — fix the query.`;

export const LIST_ENTITIES_TOOL_DESCRIPTION = `Return the catalog of semantic-layer entities (tables and views) declared for this workspace. Each row carries \`{ name, table, description, source }\`; an optional case-insensitive \`filter\` substring narrows the result against name, table, and description. Example call: \`{ "filter": "order" }\`. Example response: \`{ "count": 3, "entities": [{ "name": "orders", "table": "orders", "description": "...", "source": "default" }] }\`.

Use this when you do not yet know which entity holds the data the user is asking about, when the catalog is large enough that a substring filter is faster than a full enumeration, or when you need the list of available \`source\` subdirectories before deciding which connection to query.

Don't use this to read a single entity's columns or query patterns — call \`describeEntity\` once you know the name. Avoid the \`explore\` shell for catalog reads; the typed result is structured and faster.`;

export const DESCRIBE_ENTITY_TOOL_DESCRIPTION = `Return the parsed entity definition — dimensions (types, \`sample_values\`), measures, joins, \`query_patterns\`, grain, and \`connection\` — looked up by \`name\` field or \`table\` name. Pass \`name\` for one entity or \`names\` for a batch (exactly one). Single: \`{"name":"orders"}\` → \`{"found":true,"entity":{...}}\`. Batch: \`{"names":["orders","order_items"]}\` → \`{"count":2,"entities":[...],"notFound":[]}\`.

Prefer the \`names\` batch when a query spans multiple entities (a join): one round-trip instead of one call per table. In batch mode an unrecognized name is not an error — matches return in \`entities\`, misses in \`notFound\`.

Use this when you are about to write SQL against an unfamiliar table, need exact column names, want a pre-validated query pattern (preferred over hand-written SQL), or need the \`connection\` to route an \`executeSQL\` call.

Don't use this to enumerate the catalog — call \`listEntities\` first when names are unknown. Avoid \`explore\` for entity reads; the typed result survives YAML format changes.`;

export const SEARCH_GLOSSARY_TOOL_DESCRIPTION = `Search the business glossary for a term, phrase, or column name. Returns matching entries with \`{ term, status, definition, note, possible_mappings, source }\` — substring match across term, definition, note, and \`possible_mappings\`, so \`orders.status\` will surface a parent term that lists it. Example call: \`{ "term": "churn" }\`. Example response: \`{ "count": 1, "matches": [{ "term": "churn", "status": "defined", "definition": "...", "possible_mappings": ["users.churned_at"] }] }\`.

Use this whenever the user mentions a domain word whose meaning is non-obvious ("revenue", "active user", "churn"), before writing SQL that depends on a possibly-ambiguous term, or to confirm that an undefined term is not silently overloaded.

Don't use this to read column types or table shape — that is \`describeEntity\`'s job. Avoid silently picking when a result returns \`status: ambiguous\`; the LLM must surface the \`possible_mappings\` and ask the user which they meant.`;

export const RUN_METRIC_TOOL_DESCRIPTION = `Execute a canonical metric defined under \`semantic/metrics/\` by id. The metric's authoritative SQL flows through the same read-only pipeline as \`executeSQL\` (4-layer validation, RLS injection, auto-LIMIT, statement timeout) and the result collapses to a scalar when the SQL returns one row × one column; otherwise rows are passed through. Example call: \`{ "id": "monthly_active_users" }\`. Example response: \`{ "id": "monthly_active_users", "value": 4271, "columns": ["mau"], "rows": [{ "mau": 4271 }], "sql": "SELECT ...", "executed_at": "..." }\`.

Use this whenever a metric exists for what the user asked — never re-derive metric SQL by hand, since the canonical definition encodes time grain, deduplication, and exclusion rules the agent will get wrong. Pair with \`listEntities\` or \`grep semantic/metrics/\` to discover ids.

Don't use this when no metric id matches; fall back to \`executeSQL\` with a query pattern from \`describeEntity\`. Avoid passing \`filters\` — pass-through is reserved for future work and is rejected today.`;

export const QUERY_TOOL_DESCRIPTION = `Ask Atlas's server-side analyst agent a natural-language question; it explores the semantic layer, writes and runs the SELECTs itself, and returns a prose \`answer\` plus every SQL statement it ran and the result rows. This is the recommended path for question-answering — the agent knows the catalog, glossary, canonical metrics, joins, and RLS, so it composes better SQL than a generic client writing raw SQL blind. It runs a second server-side LLM and spends Atlas plan tokens; prefer it when answer quality matters. Example call: \`{ "question": "top 5 products by revenue last quarter" }\`. Example response: \`{ "answer": "...", "sql": ["SELECT ..."], "data": [...] }\`.

Use this when the user asks a data question in words and you want a high-quality answer without hand-writing SQL.

Don't use this when you already have exact SQL — call \`executeSQL\`, the raw escape hatch — or for catalog discovery (\`listEntities\` / \`describeEntity\`).`;

// ── Per-tool error catalogs ───────────────────────────────────────────
//
// Surfaced in tool descriptions via `withErrorContract` so an agent can
// branch on `code` instead of pattern-matching `message`. Keep these in
// lockstep with the classification in `packages/mcp/src/error-envelope.ts`
// and the codes the per-tool execute paths actually return. `satisfies`
// makes a typo'd code (`"timeOut"`, `"unknown_metricz"`) a compile error
// rather than landing in the LLM-facing description silently.

export const EXPLORE_ERROR_CODES = [
  "rate_limited",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];
// `billing_blocked` (#3437) joins the two datasource-query catalogs
// (executeSQL + runMetric): the MCP edge consults the billing gate
// before any datasource query, and a suspended / trial-expired
// workspace gets this code — the LLM-facing description must advertise
// it so agents surface the block instead of blind-retrying.
export const EXECUTE_SQL_ERROR_CODES = [
  "validation_failed",
  "rls_denied",
  "query_timeout",
  "unknown_entity",
  "rate_limited",
  "billing_blocked",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];
// Per-OAuth-client rate limiting (#2071) gates every hosted-MCP tool,
// including the semantic-layer reads — `rate_limited` joins each
// catalog so the LLM-facing description advertises the recovery code
// agents will see under load.
export const LIST_ENTITIES_ERROR_CODES = [
  "rate_limited",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];
export const DESCRIBE_ENTITY_ERROR_CODES = [
  // `validation_failed` (#mcp-token-reduction): the raw-shape inputSchema
  // can't express "exactly one of `name` / `names`", so the handler enforces
  // it and returns this code when both or neither are supplied.
  "validation_failed",
  "unknown_entity",
  "rate_limited",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];
export const SEARCH_GLOSSARY_ERROR_CODES = [
  "ambiguous_term",
  "rate_limited",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];
export const RUN_METRIC_ERROR_CODES = [
  "unknown_metric",
  "validation_failed",
  "rls_denied",
  "query_timeout",
  "rate_limited",
  "billing_blocked",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];
// #4094 — the NL-agent `query` tool. Its datasource work happens inside the
// agent loop (executeSQL swallows per-query SQL failures into the answer, so
// no validation/rls/timeout code surfaces at the tool boundary). What DOES
// surface: the gate-0 billing block (`billing_blocked`), the abuse-throttle /
// per-client rate limit (`rate_limited`), and the catch-all (`internal_error`,
// which also carries the fail-closed claim-check-unverifiable case). The
// unclaimed-trial claim gate maps to `billing_blocked` (resolve on the web),
// reusing the closed catalog rather than minting a new code.
export const QUERY_ERROR_CODES = [
  "billing_blocked",
  "rate_limited",
  "internal_error",
] as const satisfies readonly AtlasMcpToolErrorCode[];

// ── Error contract appendage ──────────────────────────────────────────

/**
 * Append the structured error contract to a tool's LLM-facing description
 * so agents can read the recovery surface from the same place they read
 * the tool's purpose. Codes are surfaced verbatim — keep
 * `<TOOL>_ERROR_CODES` in lockstep with what the dispatch path actually
 * returns. The `AtlasMcpToolErrorCode` type bound prevents a typo'd code
 * from landing in the LLM-facing prose.
 */
export function withErrorContract(
  base: string,
  codes: readonly AtlasMcpToolErrorCode[],
): string {
  return `${base}

Error contract: failures return an \`{ code, message, hint?, request_id?, retry_after? }\` JSON envelope as the tool result text with \`isError: true\`. Possible codes: ${codes.map((c) => `\`${c}\``).join(", ")}. Branch on \`code\`; never pattern-match \`message\`.`;
}

// ── Canonical tool names ──────────────────────────────────────────────

/** Canonical tool names for the typed semantic tools registered over MCP. */
export const SEMANTIC_TOOL_NAMES = [
  "listEntities",
  "describeEntity",
  "searchGlossary",
  "runMetric",
] as const;

export type SemanticToolName = (typeof SEMANTIC_TOOL_NAMES)[number];
