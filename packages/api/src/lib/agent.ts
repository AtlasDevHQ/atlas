/**
 * The Atlas agent.
 *
 * Runs a single-agent loop driven by a ToolRegistry (default: explore,
 * executeSQL). The loop runs until the step limit is reached (configurable
 * via `ATLAS_AGENT_MAX_STEPS`, default 25) or the model stops issuing
 * tool calls.
 *
 * Effect migration (P10c):
 * The agent function optionally reads its dependencies (model, tools,
 * user context) from Effect Context when available, falling back to
 * global singletons otherwise. This makes the agent testable via
 * Layer.provide with mock services.
 */

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { LanguageModel } from "ai";
import { Effect, Duration } from "effect";
import type { ChatContextWarning } from "@useatlas/types";
import { normalizeError } from "./effect/errors";
import { getModel, getProviderType, getModelFromWorkspaceConfig, getWorkspaceProviderType, isGatewayAnthropicModel, type ProviderType } from "./providers";
import { defaultRegistry, ToolRegistry } from "./tools/registry";
import { resolveWorkspaceRestDatasources, resolveWorkspaceRestDatasourcesOrThrow } from "./openapi/workspace-datasource";
import type { RestDatasource } from "./openapi/datasource";
import { buildAgentRepresentation } from "./openapi/representation";
import { REST_OPERATION_DESCRIPTION, createExecuteRestOperationTool } from "./tools/rest-operation";
import { getContextFragments, getDialectHints } from "./plugins/tools";
import { connections, detectDBType, type ConnectionMetadata, type DBType } from "./db/connection";
import { getCrossSourceJoins, type CrossSourceJoin, loadOrgWhitelist, getOrgSemanticIndex } from "./semantic";
import { getSemanticIndex } from "./semantic/search";
import { getConfig } from "./config";
import { createLogger, getRequestContext } from "./logger";
import { getSetting } from "./settings";
import { hasInternalDB, internalExecute } from "./db/internal";
import { loadGroupRoutingContext } from "./env-routing/lookup";
import { logUsageEvent } from "./metering";
import { buildLearnedPatternsSection, buildRetrievalQuery, getRetrievalTurns } from "./learn/pattern-cache";
import { dispatchMutableHook } from "./plugins/hooks";
import { plugins } from "./plugins/registry";
import {
  trace,
  SpanStatusCode,
  context as otelContext,
} from "@opentelemetry/api";
import { AtlasAiModel, type AtlasAiModelShape } from "./effect/ai";
import { ModelRouter } from "./effect/services";
import { runEnterprise } from "./effect/enterprise-layer";
import { BOUND_AGENT_PROMPT_GUIDANCE } from "./bound-chat-context";

const log = createLogger("agent");
const tracer = trace.getTracer("atlas");

const DEFAULT_MAX_STEPS = 25;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 100;

let lastWarnedMaxSteps: string | undefined;

/**
 * Read agent max steps from settings cache (workspace DB override >
 * platform DB override > env var > default). Exported so the canonical-eval
 * `--mcp-llm` mode (#2119) can clamp its LLM-driven dispatch loop to the
 * same operator-controlled budget the production agent loop honours.
 *
 * `orgId` threads the workspace tier (#3406); when omitted it falls back to
 * the request context's active organization, so in-request callers resolve
 * the workspace override automatically and out-of-request callers (the
 * canonical eval) keep the platform/env resolution.
 */
export function getAgentMaxSteps(orgId?: string): number {
  const effectiveOrgId = orgId ?? getRequestContext()?.user?.activeOrganizationId;
  const raw = getSetting("ATLAS_AGENT_MAX_STEPS", effectiveOrgId) ?? String(DEFAULT_MAX_STEPS);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_MAX_STEPS || n > MAX_MAX_STEPS) {
    if (raw !== lastWarnedMaxSteps) {
      log.warn({ value: raw }, `Invalid ATLAS_AGENT_MAX_STEPS value; using default ${DEFAULT_MAX_STEPS}`);
      lastWarnedMaxSteps = raw;
    }
    return DEFAULT_MAX_STEPS;
  }
  return n;
}

const SYSTEM_PROMPT_PREFIX = `You are Atlas, an expert data analyst AI. You answer questions about data by exploring a semantic layer, writing SQL, and interpreting results.

## Your Workflow

Follow these steps for every question:

### 1. Understand the Question
Parse what the user is really asking. Check the Ambiguous Terms section below if the question uses terms that could have multiple meanings.`;

const SYSTEM_PROMPT_SUFFIX = `## Rules
- Use the Semantic Layer Reference below to identify tables and columns — write SQL directly when the reference has enough detail
- Use the explore tool only when you need information not in the reference (e.g., sample values, complex join SQL, query pattern SQL)
- NEVER guess table or column names — verify them against the reference or via explore
- NEVER modify data — only SELECT queries are allowed
- If you cannot answer a question with the available data, say so clearly
- Be concise but thorough in your interpretations

## Writing Performant SQL (Sargability)
Write filters that let the database use its indexes. A predicate is "sargable" when the optimizer can use an index for it; wrapping a column in a function or arithmetic usually disables the index and forces a full scan.
- **Prefer filtering and joining on indexed columns.** Keep the indexed column bare on one side of the comparison — compare it against a literal or parameter, not against an expression of the same column.
- **Never wrap an indexed column in a function inside a \`WHERE\` (or \`JOIN\`) predicate.** For example, do NOT write \`WHERE YEAR(created_at) = 2024\`, \`WHERE date_trunc('year', created_at) = '2024-01-01'\`, or \`WHERE LOWER(email) = 'x@y.com'\` against a plainly-indexed column — each forces a full scan.
- **Rewrite date filters as half-open ranges** on the bare column instead of extracting parts of it:
  - Instead of \`WHERE YEAR(created_at) = 2024\`, write \`WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'\`.
  - Instead of \`WHERE MONTH(created_at) = 3 AND YEAR(created_at) = 2024\`, write \`WHERE created_at >= '2024-03-01' AND created_at < '2024-04-01'\`.
  - Use \`< next-period-start\` (a half-open upper bound) rather than \`<= last-day\` so the range is correct for both dates and timestamps.
- Function-wrapped expressions are fine for **projection and grouping** (e.g. \`SELECT date_trunc('month', created_at) AS month ... GROUP BY 1\`) — the sargability concern is specifically about **filter and join predicates** on indexed columns.

## Follow-up Questions
When the user asks a follow-up question:
- Reference previous query results — don't re-explore the semantic layer if you already know the schema
- However, if the follow-up involves a different table or entity than the previous query, check the reference or re-explore the relevant entity schema
- Build on prior SQL — reuse CTEs, table aliases, and filters from earlier queries when relevant
- If the user says "break that down by X" or "now filter to Y", modify the previous query rather than starting from scratch
- Refer back to specific numbers from your previous analysis when interpreting new results

## Ambiguous Terms
Before writing SQL, check if the user's question contains terms from the glossary that need clarification:
- If a term has status "ambiguous", ASK the user to clarify which meaning they intend before proceeding
- If a term has a "disambiguation" field (even if status is "defined"), follow its guidance — it may tell you to ask a clarifying question
- Example: if the glossary lists multiple possible_mappings for a term like "size", ask which meaning the user intends
- Only ask ONE clarifying question at a time — don't barrage the user
- If the glossary provides a default interpretation, mention it: "By 'revenue' I'll use companies.revenue (annual company revenue). Would you prefer subscription MRR from accounts.monthly_value?"

## Error Recovery
When a SQL query fails, read the error carefully before retrying. First decide whether it is an **infrastructure outage** or a **query problem** — they call for opposite responses:
- **Infrastructure / connection outage** — If the error says the database or datasource is **unreachable** (e.g., "Database unreachable at ..."), the **connection pool is exhausted**, or the datasource is **temporarily unavailable**, this is an outage, NOT a query you can fix. Do **NOT** retry or modify the SQL — rewriting it wastes steps on something outside your control. Stop and tell the user the data source is temporarily unavailable and to try again shortly.
- **Column not found** — The error often suggests the correct name (e.g., "column 'revnue' does not exist — did you mean 'revenue'?"). Go back to the entity schema to verify the exact column name.
- **Table not found** — Re-read catalog.yml to find the correct table name. The table may use a different name than you expected.
- **Syntax error** — Check the error position hint. Common issues: missing commas, unmatched parentheses, incorrect JOIN syntax.
- **Type mismatch** — You may need to CAST a column (e.g., CAST(value AS numeric)). Check the column type in the entity schema.
- **Timeout** — Simplify the query: remove unnecessary JOINs, add WHERE filters to reduce the dataset, or break into smaller queries.
- Never retry the exact same SQL. Always fix the identified issue first (and for an infrastructure outage, do not retry at all — report it).
- Max 2 retries per question — if the query still fails, explain the issue to the user.

## Suggested Follow-ups
After each substantive answer, end your response with a <suggestions> block containing 2-3 contextual follow-up questions the user might ask next. Base them on the tables, metrics, and data from the current answer. Format:
<suggestions>
What is the trend over the last 12 months?
How does this break down by region?
Which accounts contribute the most?
</suggestions>`;

const MYSQL_DIALECT_GUIDE = `

## SQL Dialect: MySQL
This database uses MySQL. Key differences from PostgreSQL:
- For **projecting or grouping** by a date part, use \`YEAR(col)\` / \`MONTH(col)\` (or \`EXTRACT(YEAR FROM col)\`) and \`DATE_FORMAT(col, '%Y-%m')\` (instead of \`TO_CHAR(col, 'YYYY-MM')\`) — e.g. \`SELECT DATE_FORMAT(created_at, '%Y-%m') AS month ... GROUP BY 1\`
- For **filtering** an indexed date column, do NOT wrap it: \`WHERE YEAR(col) = 2024\` or \`WHERE DATE_FORMAT(col, '%Y-%m') = '2024-03'\` forces a full table scan. Use a half-open range on the bare column instead — \`WHERE col >= '2024-01-01' AND col < '2025-01-01'\` (year) or \`WHERE col >= '2024-03-01' AND col < '2024-04-01'\` (month). See the Sargability rules above
- Use \`IFNULL(col, default)\` or \`COALESCE(col, default)\` — both work
- Use backtick quoting for identifiers: \`\\\`column\\\`\` instead of \`"column"\`
- Use \`CONCAT(a, b)\` for string concatenation — \`||\` is logical OR in MySQL
- No \`ILIKE\` — use \`WHERE col COLLATE utf8mb4_bin LIKE 'pattern'\` for case-sensitive matching
- \`GROUP_CONCAT(col SEPARATOR ', ')\` instead of \`STRING_AGG(col, ', ')\`
- No \`::type\` casting — use \`CAST(x AS SIGNED)\`, \`CAST(x AS DECIMAL)\`
- \`LIMIT offset, count\` or \`LIMIT count OFFSET offset\` — both forms work
- \`COALESCE\`, \`CASE\`, \`NULLIF\`, \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\` work identically`;

// Display names for core DB types. Plugin-registered types fall through
// to the capitalize fallback intentionally.
const DIALECT_DISPLAY_NAMES: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
};

function dialectName(dbType: DBType): string {
  return DIALECT_DISPLAY_NAMES[dbType] ?? dbType.charAt(0).toUpperCase() + dbType.slice(1);
}

/**
 * Filter the connection registry to the set the agent should see in its tool
 * context. On SaaS the runtime-registered `default` connection sources from
 * the shared `ATLAS_DATASOURCE_URL` demo service (NovaMart), not a per-org
 * connection — surfacing it to the agent let it run the workspace's first
 * query against the demo and label demo data as the user's (#2505). #2483
 * gated the admin VIEW; this is the agent-context half. Self-hosted single-
 * tenant deployments keep `default` because it IS their operator connection.
 */
function filterAgentVisibleSources(sources: ConnectionMetadata[]): ConnectionMetadata[] {
  const isSaas = getConfig()?.deployMode === "saas";
  if (!isSaas) return sources;
  return sources.filter((s) => s.id !== "default");
}

/**
 * Active-group routing context passed into the system prompt builder so the
 * agent can decide whether to set `scope` on `executeSQL` (PRD #2515 / slice 2
 * #2517). When `members.length > 1`, the prompt gains a "Cross-Environment
 * Routing" section listing every member id and the comparative-intent
 * heuristics. Single-member groups see no prompt change — back-compat with
 * pre-#2517 single-env workspaces.
 */
export interface ScopeRoutingContext {
  /** Every member id of the conversation's active connection group. */
  readonly members: readonly string[];
  /** The conversation's currently-selected member id (anchors `scope: "this"`). */
  readonly currentMember: string;
  /** Active group id, for display only. */
  readonly groupId?: string;
}

/**
 * Build the "Cross-Environment Routing" prompt section. Returns an empty
 * string when there's nothing to teach the agent (single-member groups,
 * missing routing context). Pure — the upstream caller decides whether to
 * append this to the system prompt.
 *
 * The guidance is conservative-by-default: single-environment cues collapse
 * to `scope: "<that member>"`; ambiguous questions default to single
 * execution against the current member. Fanout (`scope: "all"`) requires
 * an explicit comparative cue so the agent doesn't burn N× tokens on a
 * one-env question that happened to mention a region word.
 */
function buildScopeGuidanceSection(
  routingContext: ScopeRoutingContext | undefined,
): string {
  if (!routingContext) return "";
  const { members, currentMember } = routingContext;
  if (members.length <= 1) return "";

  const memberList = members.map((m) => `\`${m}\``).join(", ");
  return `## Cross-Environment Routing (executeSQL \`scope\`)

This conversation is in a multi-environment group with ${members.length} members: ${memberList}. The conversation's current member is \`${currentMember}\`.

Each \`executeSQL\` call can carry a \`scope\` argument that decides which environment(s) the SQL runs against:

- **\`scope: "this"\`** (or omitted) — runs against the current member \`${currentMember}\`. Default for single-environment questions.
- **\`scope: "all"\`** — fans out across every member (${memberList}); the result merges all rows with a prepended \`__env__\` column so the agent can see per-environment values side by side.
- **\`scope: "<member id>"\`** — routes to that specific member only. Use when the user names an environment.

**When to set scope:**

- **Comparative intent** — "trends across regions", "compare X by region", "side by side", "each environment", "all regions" — set \`scope: "all"\`.
- **Single-environment cue** — "in EU", "production us-int", a region keyword used as the target — set \`scope: "<that member id>"\` (must match one of: ${memberList}).
- **No routing cue / ambiguous** — be conservative: omit \`scope\` or set \`"this"\`. Single execution against the current member is the right default; you can ask a clarifying question if the question is genuinely ambiguous.

**Conservative-by-default examples:**

- "show me the EU schema for orders" → single execution (the user wants the EU schema, not a comparison). Use \`scope: "eu"\` if \`eu\` is a member, otherwise omit.
- "compare order volume across regions" → \`scope: "all"\` (explicit comparative phrasing).
- "show me orders" → omit \`scope\` (no routing cue — stick with the current member).

The result of a fanned-out query carries an \`envContributions\` array describing each environment's row count, duration, and error (if any). Use it to surface partial failures to the user instead of silently treating a failed env as zero rows.`;
}

/**
 * #3044 — REST datasource environment-scope framing ([ADR-0010]). Returns the
 * one-line scope banner prepended to a REST datasource's prompt section so the
 * agent (and, downstream, the user) knows whether the datasource is constrained
 * by the conversation's environment selection.
 *
 * The bug this closes: a chat pinned to one SQL environment LOOKS fully
 * constrained, but a workspace-global REST datasource answers regardless of the
 * pin. Making the reach explicit means the model never implies the conversation
 * is scoped tighter than it is.
 *
 * Pure. `boundToEnvironment` toggles the extra "not constrained by the pin"
 * emphasis — it is true whenever the conversation targets a specific environment
 * group (an explicit picker selection or the group resolved from the pinned
 * connection, including the 0062 single-member-group shape). In a true
 * single-connection workspace there is no environment to contrast against, so the
 * softer phrasing avoids implying a selection that isn't there.
 */
export function buildRestDatasourceScopeNote(
  ds: { readonly groupId?: string },
  opts: { readonly boundToEnvironment: boolean },
): string {
  if (ds.groupId) {
    return (
      `**Environment scope:** scoped to environment group \`${ds.groupId}\` — ` +
      `this REST datasource is part of that environment and is only reachable ` +
      `while that group is the conversation's active environment.`
    );
  }
  const pinClause = opts.boundToEnvironment
    ? " It is **NOT** constrained by this conversation's environment selection/pin — " +
      "querying it reaches the same upstream account regardless of which SQL environment is active. " +
      "Do not describe the conversation as limited to one environment when answering from it."
    : "";
  return (
    `**Environment scope:** workspace-global — available in every environment.` +
    pinClause
  );
}

/**
 * #3067 — REST-only focus banner. Prepended to the REST representation when a
 * conversation is focused on a single datasource and `executeSQL` is suspended,
 * so the model knows SQL is off and answers from the API only. Exported so a
 * unit test can pin that the focused branch frames the turn as REST-only.
 */
export const REST_ONLY_FOCUS_GUIDANCE = `## REST-only focus — SQL is suspended

This conversation is **focused on a single REST datasource**. SQL execution (\`executeSQL\`) is **suspended** for this turn: there is no SQL tool available. Answer the user using \`executeRestOperation\` against the datasource described below, and only that datasource. Do not reference SQL tables or attempt to write SQL. If the question genuinely needs the SQL warehouse instead of this API, tell the user the conversation is focused on a single datasource and they can clear the focus in the scope picker to re-enable SQL.`;

/**
 * #3067 — tools that author or execute SQL, suspended together under REST-only
 * focus. `executeSQL` runs SQL directly; `createDashboard` (default registry)
 * and the bound dashboard editor tools `addCard` / `updateCard` / `updateCardSql`
 * each accept SQL card definitions and stage SQL-backed cards. Removing only
 * `executeSQL` would still let a focused turn mint SQL results via a dashboard
 * (Codex review on #3067) — a scope leak — so all of them are stripped together.
 * Stripping a name the base registry doesn't contain (e.g. the editor tools on a
 * non-bound chat) is a harmless no-op.
 */
const SQL_DEPENDENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "executeSQL",
  "createDashboard",
  "addCard",
  "updateCard",
  "updateCardSql",
]);

/**
 * #3067 — build a copy of a tool registry with every SQL-dependent tool removed,
 * for a REST-only focused turn. Every other tool already in the base (explore,
 * executePython, any plugin / action tools) is preserved; the REST tool is
 * merged on top by the caller AFTER this returns. Returns an UNFROZEN registry
 * — the caller merges the REST tool on top and freezes.
 */
function registryWithoutSqlTools(base: ToolRegistry): ToolRegistry {
  const stripped = new ToolRegistry();
  for (const [name, entry] of base.entries()) {
    if (SQL_DEPENDENT_TOOL_NAMES.has(name)) continue;
    stripped.register(entry);
  }
  return stripped;
}

function buildMultiSourceSection(
  sources: ConnectionMetadata[],
): string {
  const lines = sources.map((s) => {
    const dialect = dialectName(s.dbType);
    const desc = s.description ? ` — ${s.description}` : "";
    const healthNote = s.health?.status === "unhealthy"
      ? " (**UNAVAILABLE** — skip queries to this source)"
      : s.health?.status === "degraded"
        ? " (currently degraded — queries may fail)"
        : "";
    return `- **${s.id}** (${dialect})${desc}${healthNote}`;
  });
  let section = `## Available Data Sources

This environment has ${sources.length} database connections. Use the \`connectionId\` parameter in executeSQL to target the correct database.

${lines.join("\n")}

**Important:**
- Always specify \`connectionId\` when querying a non-default source
- Check entity YAML files for the \`connection\` field to see which tables belong to which source
- Tables are scoped to their connection — a table on "warehouse" cannot be queried via "default"

**Semantic layer navigation:**
- Default connection entities are in \`entities/\` at the root
- Other sources have their own subdirectory: \`{connectionId}/entities/\`
- Start by running \`ls\` to see all available source directories
- Each source may also have its own \`metrics/\` and \`glossary.yml\``;

  // Surface cross-source relationships in the system prompt so the agent
  // knows upfront which tables span sources and avoids impossible cross-DB JOINs.
  let crossJoins: readonly CrossSourceJoin[];
  try {
    crossJoins = getCrossSourceJoins();
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to load cross-source joins — continuing without hints");
    crossJoins = [];
  }
  if (crossJoins.length > 0) {
    const joinLines = crossJoins.map((j) => {
      const desc = j.description ? `${j.description} ` : "";
      return `- **${j.fromSource}.${j.fromTable}** → **${j.toSource}.${j.toTable}**: ${desc}(${j.relationship}, on: ${j.on})`;
    });
    section += `\n\n## Cross-Source Relationships\n\n${joinLines.join("\n")}\n\nCross-source joins cannot be done in a single SQL query. Query each source separately and combine results in your analysis.`;
  }

  return section;
}

function appendDialectHints(prompt: string): string {
  const hints = getDialectHints();
  if (hints.length === 0) return prompt;
  return prompt + "\n\n## Additional SQL Dialect Notes\n\n" + hints.map((h) => h.dialect).join("\n\n");
}

const PYTHON_GUIDANCE = `
## SQL vs Python

**Use SQL for:** filtering, aggregation, joins, window functions, GROUP BY, HAVING — anything the database handles natively.
**Use Python for:** statistical analysis (correlations, regressions, hypothesis tests), complex reshaping (pivots, multi-index), time series decomposition, clustering, and advanced visualizations (heatmaps, scatter matrices, violin plots).

**Anti-patterns to avoid:** SELECT * then aggregate in pandas, re-implementing GROUP BY or window functions in Python, using Python for simple counts/sums.

**Chart guidance:** prefer \`_atlas_chart\` (interactive Recharts) for bar/line/pie charts. Use \`chart_path()\` only for advanced matplotlib visualizations that Recharts cannot render.`;

/**
 * #2363 — bound dashboard editor context. When supplied, the agent
 * swaps the generic data-analyst suffix for the dashboard-composition
 * guidance and prepends a compact per-turn card summary so the model
 * can reason about the cards by id without a `getDashboardState`
 * round trip.
 */
export interface BoundDashboardAgentContext {
  /** Pre-built compact card summary string from `buildCardSummary`. */
  cardSummary: string;
}

function buildSystemPrompt(
  registry: ToolRegistry,
  orgSemanticIndex?: string,
  learnedPatternsSection?: string,
  routingContext?: ScopeRoutingContext,
  boundDashboardContext?: BoundDashboardAgentContext,
): string {
  const suffix = boundDashboardContext ? BOUND_AGENT_PROMPT_GUIDANCE : SYSTEM_PROMPT_SUFFIX;
  let base = SYSTEM_PROMPT_PREFIX + "\n\n" + registry.describe() + "\n\n" + suffix;
  if (boundDashboardContext) {
    base += "\n\n" + boundDashboardContext.cardSummary;
  }

  // Add Python guidance only when the tool is available
  if (registry.get("executePython")) {
    base += "\n" + PYTHON_GUIDANCE;
  }

  // Append the pre-indexed semantic layer summary (respects config)
  const indexEnabled = getConfig()?.semanticIndex?.enabled !== false;
  if (indexEnabled) {
    // Prefer org-scoped index if available, fall back to file-based
    const semanticIndex = orgSemanticIndex || getSemanticIndex();
    if (semanticIndex) {
      base += "\n\n" + semanticIndex;
    }
  }

  // Append learned patterns (if any)
  if (learnedPatternsSection) {
    base += "\n\n" + learnedPatternsSection;
  }

  // Append plugin context fragments (if any)
  const fragments = getContextFragments();
  if (fragments.length > 0) {
    base += "\n\n" + fragments.join("\n\n");
  }
  const meta = filterAgentVisibleSources(connections.describe());

  // Single-connection: identical to pre-v0.7 behavior
  if (meta.length <= 1) {
    let dbType: DBType;
    try {
      dbType = meta.length === 1
        ? meta[0].dbType
        : detectDBType();
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "Could not detect DB type — omitting dialect guide");
      return appendDialectHints(base);
    }
    // Core adapters get their dialect guide inline; everything else is
    // handled by plugin dialect hints via appendDialectHints().
    if (dbType === "mysql") {
      return appendDialectHints(base + MYSQL_DIALECT_GUIDE);
    }
    return appendDialectHints(base);
  }

  // Multi-connection: list sources + include core dialect guides
  let prompt = base + "\n\n" + buildMultiSourceSection(meta);

  const dbTypes = new Set(meta.map((m) => m.dbType));
  if (dbTypes.has("mysql")) prompt += MYSQL_DIALECT_GUIDE;
  // Non-core dialects (clickhouse, snowflake, duckdb, salesforce, etc.)
  // are provided by plugins via appendDialectHints().

  // Cross-environment routing guidance: only appears when the active group
  // has >1 member (PRD #2515 / slice 2 #2517). Single-member groups omit
  // the section so single-env workspaces see no prompt change.
  const scopeGuidance = buildScopeGuidanceSection(routingContext);
  if (scopeGuidance) prompt += "\n\n" + scopeGuidance;

  return appendDialectHints(prompt);
}

/**
 * Build the system prompt with provider-appropriate cache control.
 *
 * The prompt body is composed from the registry's tool descriptions via
 * `registry.describe()`, sandwiched between the standard prefix and suffix.
 *
 * - Anthropic / Bedrock-Anthropic: returns a SystemModelMessage with
 *   `providerOptions.anthropic.cacheControl` (~80% savings on steps 2+).
 * - Bedrock (non-Anthropic): returns a SystemModelMessage with
 *   `providerOptions.bedrock.cachePoint`.
 * - OpenAI / Ollama / OpenAI-compatible / Gateway: returns a plain string
 *   (OpenAI caches automatically for prompts >= 1024 tokens; others have
 *   no caching).
 */
/**
 * #2705 — Conversational-mode addendum.
 *
 * Appended to the system prompt when the caller requests
 * `presentationMode: "conversational"` (Slack @mention + proactive
 * paths). Overrides the prefix/suffix formatting guidance so the
 * agent renders a chat-platform-friendly answer rather than the
 * analyst-grade developer view. Pairs with the proactive listener's
 * progressive-disclosure buttons (#2705) — anything heavier
 * (markdown tables, SQL, glossary) is one tap away on demand.
 *
 * Exported so unit tests can pin the contract that the conversational
 * branch suppresses SQL/tables and reframes the closing CTA.
 */
export const CONVERSATIONAL_PROMPT_ADDENDUM = `

## Presentation mode — conversational

You are answering inside a chat platform (Slack/Teams/etc.) where the audience is a non-analyst teammate skimming a thread. Override the standard formatting guidance with the following rules:

- Keep the answer to **1-2 sentences of plain English prose**. No headings, no bullet lists, no preamble.
- **Do NOT include SQL** in the response body. The chat surface attaches a "Show SQL" button that surfaces the query on demand.
- **Do NOT use markdown tables.** Express small comparisons as prose ("3 in the US, 1 in EU, 1 in APAC"); use bare numbers, not formatted tables. For larger result sets, summarize the top line in prose and let the "Show details" button surface the breakdown.
- **Skip the glossary lecture.** Assume the reader already knows what a customer / order / MRR is. Don't define terms.
- Cite figures inline in the prose, with units. ("Revenue grew to $1.2M in March, up 14% from February.")
- End with a single short line offering the analyst view: "Want the SQL or full breakdown? Tap the button below." Do NOT use markdown formatting on this closing line.
`;

export function buildSystemParam(
  providerType: ProviderType,
  registry: ToolRegistry = defaultRegistry,
  warnings?: string[],
  orgSemanticIndex?: string,
  learnedPatternsSection?: string,
  routingContext?: ScopeRoutingContext,
  boundDashboardContext?: BoundDashboardAgentContext,
  presentationMode: "developer" | "conversational" = "developer",
  /**
   * #2924 — Path A REST representation. When a REST datasource resolves, the
   * trimmed operation-graph prompt context is appended so the agent can address
   * its operations with `executeRestOperation`. Absent for SQL-only workspaces.
   */
  restRepresentation?: string,
  /**
   * #3099 — Resolved model id, used only to detect when the `gateway` provider
   * routes to an Anthropic-family model so the system prompt gets the same
   * cache breakpoint as the direct Anthropic provider. Ignored otherwise.
   */
  modelId?: string,
): string | SystemModelMessage {
  let content = buildSystemPrompt(registry, orgSemanticIndex, learnedPatternsSection, routingContext, boundDashboardContext);

  if (restRepresentation) {
    content += "\n\n" + restRepresentation;
  }

  if (presentationMode === "conversational") {
    content += CONVERSATIONAL_PROMPT_ADDENDUM;
  }

  if (warnings && warnings.length > 0) {
    content += "\n\n## Warnings\n\n" + warnings.map((w) => `- ${w}`).join("\n");
  }

  const cacheProvider = cacheProviderFor(providerType, modelId);
  switch (cacheProvider) {
    case "anthropic":
    case "bedrock-anthropic":
      return {
        role: "system",
        content,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      };
    case "bedrock":
      return {
        role: "system",
        content,
        providerOptions: {
          bedrock: { cachePoint: { type: "default" } },
        },
      };
    case "openai":
    case "ollama":
    case "openai-compatible":
    case "gateway":
      return content;
    default: {
      const _exhaustive: never = cacheProvider;
      throw new Error(`Unknown provider type: ${_exhaustive}`);
    }
  }
}

/**
 * Resolve the provider whose prompt-cache convention applies to a request.
 *
 * Normally this is just `providerType`. The exception is the AI Gateway: it
 * forwards `providerOptions.anthropic` to the underlying provider, so a gateway
 * route to an Anthropic-family model needs the SAME explicit `cacheControl`
 * markers as the direct Anthropic provider — without them the gateway →
 * Anthropic path runs fully uncached (#3099). OpenAI/other gateway routes keep
 * the no-op (implicit caching), and a gateway request with no resolvable model
 * id falls back to the no-op too.
 */
function cacheProviderFor(providerType: ProviderType, modelId?: string): ProviderType {
  if (providerType === "gateway" && modelId && isGatewayAnthropicModel(modelId)) {
    return "anthropic";
  }
  return providerType;
}

/**
 * Apply prompt caching to the last message in the conversation.
 *
 * This marks the last message with provider-specific cache control so that
 * all preceding context (system prompt + earlier messages) can be cached
 * by the LLM provider on subsequent steps.
 *
 * - Anthropic / Bedrock-Anthropic: `providerOptions.anthropic.cacheControl`
 * - Bedrock (non-Anthropic): `providerOptions.bedrock.cachePoint`
 * - Gateway → Anthropic model: `providerOptions.anthropic.cacheControl` (the
 *   gateway forwards it to the underlying provider; needs `modelId` to detect)
 * - OpenAI / Ollama / OpenAI-compatible / Gateway (non-Anthropic): no-op
 *   (OpenAI-family caches automatically)
 */
export function applyCacheControl(
  messages: ModelMessage[],
  providerType: ProviderType,
  modelId?: string,
): ModelMessage[] {
  if (messages.length === 0) return messages;

  // Only Anthropic-family and Bedrock need explicit cache markers
  const lastIndex = messages.length - 1;

  const cacheProvider = cacheProviderFor(providerType, modelId);
  switch (cacheProvider) {
    case "anthropic":
    case "bedrock-anthropic": {
      return messages.map((message, index) => {
        if (index !== lastIndex) return message;
        return {
          ...message,
          providerOptions: {
            ...message.providerOptions,
            anthropic: { cacheControl: { type: "ephemeral" as const } },
          },
        } as typeof message;
      });
    }
    case "bedrock": {
      return messages.map((message, index) => {
        if (index !== lastIndex) return message;
        return {
          ...message,
          providerOptions: {
            ...message.providerOptions,
            bedrock: { cachePoint: { type: "default" as const } },
          },
        } as typeof message;
      });
    }
    case "openai":
    case "ollama":
    case "openai-compatible":
    case "gateway":
      return messages;
    default: {
      const _exhaustive: never = cacheProvider;
      throw new Error(`Unknown provider type: ${_exhaustive}`);
    }
  }
}

/**
 * Wrap each tool's execute function with beforeToolCall / afterToolCall
 * plugin hook dispatch. No-op when no plugins are registered.
 *
 * Execution order for tools that have domain-specific hooks (e.g. executeSQL):
 *   beforeToolCall → beforeQuery → execute → afterQuery → afterToolCall
 *
 * - beforeToolCall: can return `{ args }` to modify args, or throw to reject
 * - afterToolCall: can return `{ result }` to modify the result, or throw to reject
 */
function wrapToolsWithHooks(
  toolSet: ToolSet,
  hookCtx: { userId?: string; conversationId?: string },
): ToolSet {
  // Optimization: skip wrapping when no plugins are registered at request time.
  // Plugins are initialized at boot before any requests — this is safe.
  if (plugins.size === 0) return toolSet;

  const callCounter = { value: 0 };
  const wrapped: ToolSet = {};

  for (const [name, t] of Object.entries(toolSet)) {
    if (!t.execute) {
      wrapped[name] = t;
      continue;
    }

    const origExecute = t.execute;
    wrapped[name] = {
      ...t,
      execute: async (
        args: Record<string, unknown>,
        options: Parameters<NonNullable<typeof t.execute>>[1],
      ) => {
        callCounter.value++;
        const ctx = {
          toolName: name,
          args,
          context: { ...hookCtx, toolCallCount: callCounter.value },
        };

        // beforeToolCall — can modify args or throw to reject
        let finalArgs: Record<string, unknown>;
        try {
          finalArgs = await dispatchMutableHook(
            "beforeToolCall",
            ctx,
            "args",
          ) as Record<string, unknown>;
        } catch (err) {
          log.warn(
            { toolName: name, err: err instanceof Error ? err : new Error(String(err)) },
            "Tool call rejected by plugin",
          );
          return `Tool call rejected by plugin: ${err instanceof Error ? err.message : String(err)}`;
        }

        const start = Date.now();
        const result = await origExecute(finalArgs, options);
        const durationMs = Date.now() - start;

        // afterToolCall — can modify result or throw to reject
        try {
          return await dispatchMutableHook(
            "afterToolCall",
            { ...ctx, args: finalArgs, result, durationMs, context: { ...hookCtx, toolCallCount: callCounter.value } },
            "result",
          );
        } catch (err) {
          log.error(
            { toolName: name, err: err instanceof Error ? err : new Error(String(err)) },
            "Tool result rejected by plugin",
          );
          return `Tool result rejected by plugin: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    };
  }

  return wrapped;
}

/**
 * Run the Atlas agent loop.
 *
 * @param messages - The conversation history from the chat UI.
 * @param tools - Optional custom {@link ToolRegistry}. Defaults to
 *   {@link defaultRegistry} (explore + executeSQL). The loop terminates
 *   when the step limit is reached (configurable via `ATLAS_AGENT_MAX_STEPS`,
 *   default 25) or the model stops issuing tool calls.
 * @param conversationId - Optional conversation ID for token usage tracking.
 *   When provided, the recorded token usage row links to this conversation.
 */
export async function runAgent({
  messages,
  tools: toolRegistry = defaultRegistry,
  conversationId,
  warnings,
  contextWarnings,
  maxSteps: maxStepsOverride,
  /** Optional pre-resolved AI model. When provided, skips provider resolution. */
  aiModel: injectedAiModel,
  boundDashboardContext,
  presentationMode,
}: {
  messages: UIMessage[];
  tools?: ToolRegistry;
  conversationId?: string;
  warnings?: string[];
  /**
   * Out-parameter (#1988 B5). When supplied, the agent's preflight loaders
   * push a structured {@link ChatContextWarning} entry per failure so the
   * caller can write each one as an SSE `data-context-warning` frame
   * before merging the model stream.
   *
   * Independent of {@link warnings}: both populate on the same failure
   * branch. `warnings` feeds the system-prompt note that primes the model
   * (caller-allocated; `runAgent` no-ops the push when the array is
   * absent because the parameter binding is local to this function).
   * `contextWarnings` feeds the SSE frame the UI renders. A caller that
   * supplies one and not the other gets exactly that subset of the
   * failure signal — the chat route supplies both; legacy embedded
   * callers (SDK, tests) may only supply `warnings`.
   */
  contextWarnings?: ChatContextWarning[];
  /** Override the default agent step limit (e.g. for demo mode). */
  maxSteps?: number;
  /** Pre-resolved AI model from Effect Context (P10c). */
  aiModel?: AtlasAiModelShape;
  /**
   * #2363 — bound dashboard editor context. When set the agent swaps to
   * the dashboard-composition prompt and injects a compact card summary.
   * The chat route resolves this from `conversations.bound_dashboard_id`
   * after the conversation is created / loaded.
   */
  boundDashboardContext?: BoundDashboardAgentContext;
  /**
   * #2705 — presentation mode for the agent's response body.
   *
   * - `"developer"` (default): analyst-grade output — markdown,
   *   SQL, tables, glossary disambiguation. Matches every pre-#2705
   *   surface (web chat, SDK, MCP).
   * - `"conversational"`: 1-2 sentence prose answer for chat-platform
   *   surfaces (Slack @mention, proactive). Suppresses SQL by
   *   default, replaces markdown tables with prose comparisons, drops
   *   glossary lectures. The chat plugin pairs this with progressive-
   *   disclosure buttons that surface the developer view on demand.
   *
   * Optional + defaulting to `"developer"` keeps every pre-#2705
   * caller's behavior unchanged.
   */
  presentationMode?: "developer" | "conversational";
}) {
  // Capture context eagerly — AsyncLocalStorage may have exited by the time onFinish fires
  const reqCtx = getRequestContext();
  const userId = reqCtx?.user?.id ?? null;
  const orgId = reqCtx?.user?.activeOrganizationId;
  const atlasMode = reqCtx?.atlasMode ?? "published";
  // #2345 — group-aware routing. Per-turn `connectionId` overrides the
  // conversation's stored execution target; `connectionGroupId` is the
  // content scope (semantic-layer overlays, dashboard scope). Both are
  // optional — when absent the agent falls back to legacy single-
  // connection behavior, matching the prompt's acceptance criterion.
  const connectionId = reqCtx?.connectionId;
  const connectionGroupId = reqCtx?.connectionGroupId;
  // #3066 — per-conversation REST datasource exclude-set. Threads into the
  // REST resolver below so an excluded datasource never reaches the prompt
  // or the bound `executeRestOperation` tool. Undefined ⇒ exclude nothing.
  const restExcludedDatasourceIds = reqCtx?.restExcludedDatasourceIds;
  // #3067 — per-conversation REST-only focus. When set, the REST block below
  // resolves ONLY this datasource and suspends `executeSQL` (REST-only turn).
  // Undefined / null ⇒ not focused (default scope: SQL routing + exclude-set).
  const restFocusDatasourceId = reqCtx?.restFocusDatasourceId;

  // Resolve model: injected > workspace config (enterprise) > platform env vars
  let model: LanguageModel;
  let providerType: ProviderType;

  if (injectedAiModel) {
    // Model provided via Effect Context (P10c) — skip provider resolution
    model = injectedAiModel.model;
    providerType = injectedAiModel.providerType;
  } else {
    let workspaceConfig: import("@atlas/api/lib/auth/credentials").RawWorkspaceModelConfig | null = null;
    if (orgId && hasInternalDB()) {
      // Resolve workspace model config via the `ModelRouter` Tag — EE
      // provides the real implementation; self-hosted (no EE) sees the
      // no-op default which returns null and the platform-default path
      // below fires. Decrypt failure still surfaces as a user-visible
      // error so the platform isn't silently billed against the
      // workspace's consent. Other failures (DB unreachable, EE
      // disabled, internal-query rejected) keep the
      // log-and-fall-through behavior.
      const { ModelConfigDecryptError } = await import(
        "@atlas/api/lib/model-routing/errors"
      );
      const program = Effect.gen(function* () {
        const router = yield* ModelRouter;
        return yield* router.getWorkspaceModelConfigRaw(orgId);
      });
      try {
        workspaceConfig = await runEnterprise(program);
      } catch (err) {
        if (err instanceof ModelConfigDecryptError) {
          throw new Error(
            "Your workspace's API key could not be decrypted. Re-enter it on the AI Provider settings page before continuing.",
            { cause: err },
          );
        }
        log.warn(
          { orgId, err: err instanceof Error ? err.message : String(err) },
          "Workspace model config not available — falling back to platform default",
        );
      }
    }

    if (workspaceConfig) {
      model = getModelFromWorkspaceConfig(workspaceConfig);
      providerType = getWorkspaceProviderType(workspaceConfig.provider);
      log.info({ orgId, provider: workspaceConfig.provider, model: workspaceConfig.model }, "Using workspace model config");
    } else {
      model = getModel();
      providerType = getProviderType();
    }
  }

  const resolvedModelId = typeof model === "string" ? model : model.modelId;

  // Pre-load org-scoped semantic data and learned patterns before the agent loop.
  // Effect.all with concurrency: 2 and per-branch timeouts (30s each).
  const [orgSemanticIndex, learnedPatternsSection] = await Effect.runPromise(
    Effect.all([
      // Org semantic data: whitelist + index
      (orgId && hasInternalDB())
        ? Effect.all([
            Effect.tryPromise({
              try: () => loadOrgWhitelist(orgId, atlasMode),
              catch: normalizeError,
            }),
            Effect.tryPromise({
              try: () => getOrgSemanticIndex(orgId),
              catch: normalizeError,
            }),
          ], { concurrency: "unbounded" }).pipe(
            Effect.map(([, idx]) => idx || undefined),
            Effect.timeoutFail({
              duration: Duration.seconds(30),
              onTimeout: () => new Error("Org semantic data load timed out after 30s"),
            }),
            Effect.catchAll((err) => {
              log.error({ orgId, err: err.message }, "Failed to load org semantic data — agent will use file-based fallback");
              if (!warnings) warnings = [];
              warnings.push("Your organization's semantic layer could not be loaded. Using default configuration. Contact your admin if this persists.");
              // #1988 B5 — also surface as a structured frame so the UI can
              // render a "degraded answer" banner instead of relying on the
              // model to repeat the system-prompt warning verbatim.
              contextWarnings?.push({
                severity: "warning",
                code: "semantic_layer_unavailable",
                title: "Semantic layer unavailable",
                detail:
                  "Your organization's semantic layer could not be loaded — the answer below was generated against the default schema. Contact your admin if this persists.",
              });
              return Effect.succeed(undefined);
            }),
          )
        : Effect.succeed(undefined),
      // Learned patterns
      hasInternalDB()
        ? Effect.tryPromise({
            try: async () => {
              // #3632 — assemble the retrieval query from the last N user
              // turns, not just the final message, so a keyword-less
              // follow-up ("now break that down by region") still matches
              // patterns via the keywords of earlier turns.
              const question = buildRetrievalQuery(messages, getRetrievalTurns(orgId ?? null));
              if (!question) return undefined;
              // #3611 — scope retrieval to the active connection group so a
              // `us-prod` session is never primed with `eu-prod`'s patterns.
              const section = await buildLearnedPatternsSection(
                orgId ?? null,
                question,
                connectionGroupId ?? null,
              );
              return section || undefined;
            },
            catch: normalizeError,
          }).pipe(
            Effect.timeoutFail({
              duration: Duration.seconds(30),
              onTimeout: () => new Error("Learned patterns load timed out after 30s"),
            }),
            Effect.catchAll((err) => {
              log.warn({ orgId, err: err.message }, "Failed to load learned patterns — continuing without");
              // #1988 B5 — surface to the UI. Lower severity than the
              // semantic-layer failure: a missing patterns section just
              // skips the few-shot priming, so the title is softer.
              contextWarnings?.push({
                severity: "warning",
                code: "learned_patterns_unavailable",
                title: "Query history hints unavailable",
                detail:
                  "Atlas couldn't load similar past queries to prime this answer. The answer is still generated normally — accuracy may be slightly lower for ambiguous questions.",
              });
              return Effect.succeed(undefined);
            }),
          )
        : Effect.succeed(undefined),
    ], { concurrency: "unbounded" }),
  );

  const span = tracer.startSpan("atlas.agent", {
    attributes: {
      "atlas.provider": providerType,
      "atlas.model": resolvedModelId,
      "atlas.message_count": messages.length,
      // #2345 — surface routing so traces show which env/replica the
      // turn ran against. Empty string when absent so the span never
      // carries a sentinel value the dashboards have to special-case.
      "atlas.connection_id": connectionId ?? "",
      "atlas.connection_group_id": connectionGroupId ?? "",
    },
  });
  // Make the agent span the active context so tool spans (withSpan in
  // sql.ts, explore.ts) become children in the trace hierarchy.
  const agentCtx = trace.setSpan(otelContext.active(), span);

  let spanEnded = false;
  function endSpan(code: SpanStatusCode, message?: string) {
    if (spanEnded) return;
    spanEnded = true;
    span.setStatus({ code, ...(message && { message }) });
    span.end();
  }

  // Resolve async work before entering otelContext.with() (sync callback).
  const modelMessages = await convertToModelMessages(messages);

  // #2517 — load active-group routing context so the system prompt can
  // teach the agent when to set `scope` on `executeSQL`. Falls back to
  // a 1×1 result (no prompt section) when no group is bound or the
  // lookup fails — single-env workspaces see no behavioural change.
  // Resolved BEFORE the REST block (#3044) so each REST datasource's
  // representation can be framed against whether a multi-env pin exists.
  let scopeRoutingContext: ScopeRoutingContext | undefined;
  let resolvedGroupId: string | undefined;
  if (connectionId) {
    const ctx = await loadGroupRoutingContext(orgId, connectionId);
    resolvedGroupId = ctx.groupId;
    if (ctx.members.length > 1) {
      scopeRoutingContext = {
        members: ctx.members,
        currentMember: ctx.currentMember,
        ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
      };
    }
  }
  // #3044 — the environment this turn is bound to: the picker's explicit
  // `connectionGroupId`, else (legacy / API callers that send only
  // `connectionId`) the group resolved from the pinned connection's membership.
  // REST datasources scoped to it are reachable; a workspace-global one escapes
  // it. `null` ⇒ no environment context → only workspace-global datasources.
  const activeRestGroupId = connectionGroupId ?? resolvedGroupId ?? null;
  // The chat targets a specific environment whenever a group resolved — a
  // multi-member group OR a single-member environment the user selected from a
  // multi-environment picker (the 0062 1:1 backfill shape). A workspace-global
  // REST datasource escapes that selection, so the framing must say so.
  const chatBoundToEnvironment = activeRestGroupId !== null;

  // #2926 — REST datasources (slice 2: per-workspace `openapi-generic` installs).
  // Resolve every REST datasource the workspace has installed (Twenty, Stripe,
  // an internal service…) from `workspace_plugins`, merge the
  // `executeRestOperation` tool bound to exactly that set, and append each one's
  // representation to the system prompt. Workspaces with no REST datasource (the
  // common case) resolve `[]` and pay nothing. The slice-1 `ATLAS_OPENAPI_TWENTY*`
  // env path is retired. Fail-soft: a preflight error degrades to "no REST
  // datasource" rather than breaking the chat turn.
  //
  // #3044 — scope filter: a datasource scoped to a different environment group
  // resolves out (the resolver keeps workspace-global + active-group matches).
  // `activeRestGroupId` is the explicit OR connection-inferred active group, so a
  // chat whose environment is known (even via connectionId alone) still reaches
  // that environment's scoped REST datasources; a scoped one never leaks past it.
  let activeRegistry = toolRegistry;
  let restRepresentation: string | undefined;
  // #3067 — set true once a REST-only focus actually resolves to a datasource;
  // gates executeSQL suspension + the focus prompt banner below.
  let sqlSuspended = false;
  try {
    // Resolve the REST datasource set this turn runs against. Default scope
    // (group-scope + exclude-set), unless the conversation is FOCUSED on one
    // datasource (#3067), in which case only that one resolves and SQL is off.
    let restDatasources: ReadonlyArray<RestDatasource> = [];
    if (orgId) {
      if (restFocusDatasourceId) {
        // #3067 — REST-only focus: resolve ONLY the focus target. The resolver
        // short-circuits group-scope + the exclude-set (they're inert while
        // focused). Use the THROWING resolver so a genuine empty (the focus
        // matched no install → uninstalled) is distinguishable from a load
        // failure / credential-reconnect: the never-rejects resolver would
        // collapse all three to `[]`, letting a transient internal-DB blip
        // masquerade as "focus gone" and silently re-enable executeSQL on a
        // conversation the user deliberately narrowed (a scope leak).
        let focused: ReadonlyArray<RestDatasource> | null = null;
        try {
          focused = await resolveWorkspaceRestDatasourcesOrThrow(orgId, {
            focus: restFocusDatasourceId,
          });
        } catch (err) {
          // Load failed OR the focus install needs a reconnect — the focus is
          // NOT gone. Fail CLOSED: keep executeSQL suspended and tell the model
          // the focused datasource is temporarily unavailable, rather than
          // widening scope back to SQL + the default REST set.
          log.error(
            { focus: restFocusDatasourceId, err: err instanceof Error ? err.message : String(err) },
            "REST-only focus datasource temporarily unresolvable — keeping SQL suspended (not falling back)",
          );
          sqlSuspended = true;
          restDatasources = [];
          if (!warnings) warnings = [];
          warnings.push(
            "The datasource this conversation is focused on is temporarily unavailable. " +
              "Tell the user it could not be reached right now and to retry shortly, or clear the focus in the scope picker to re-enable SQL. Do not attempt SQL.",
          );
          // Mirror the model-facing warning as a structured frame so the UI can
          // render a deterministic "focused datasource unavailable, SQL still
          // suspended" banner instead of relying on the model to repeat the
          // system-prompt text — same pattern as the semantic-layer / learned-
          // patterns degradations above (#1988 B5 / #3067 review).
          contextWarnings?.push({
            severity: "warning",
            code: "rest_focus_unavailable",
            title: "Focused datasource unavailable",
            detail:
              "The datasource this conversation is focused on is temporarily unavailable, so SQL stays suspended. " +
              "Retry shortly, or clear the focus in the scope picker to re-enable SQL.",
          });
        }
        if (focused !== null) {
          if (focused.length > 0) {
            restDatasources = focused;
            sqlSuspended = true;
          } else {
            // Genuinely uninstalled (rows loaded fine, focus matched no install)
            // — fall back SAFELY to default scope: SQL stays active and the
            // exclude-set applies, exactly as an un-focused conversation resolves
            // (the "focused datasource was uninstalled" acceptance criterion).
            log.warn(
              { focus: restFocusDatasourceId },
              "REST-only focus datasource is no longer installed — falling back to default scope (SQL active)",
            );
            restDatasources = await resolveWorkspaceRestDatasources(orgId, {
              activeGroupId: activeRestGroupId,
              ...(restExcludedDatasourceIds && restExcludedDatasourceIds.length > 0
                ? { excluded: restExcludedDatasourceIds }
                : {}),
            });
          }
        }
      } else {
        restDatasources = await resolveWorkspaceRestDatasources(orgId, {
          activeGroupId: activeRestGroupId,
          // #3066 — drop the conversation's excluded datasources. The tool is
          // bound to exactly this set below, so exclusion is enforced at both
          // prompt-build and tool-execution (the agent can't route to an id
          // that isn't in the bound set). Empty / omitted ⇒ exclude nothing
          // (guard on length, not truthiness — `[]` is truthy).
          ...(restExcludedDatasourceIds && restExcludedDatasourceIds.length > 0
            ? { excluded: restExcludedDatasourceIds }
            : {}),
        });
      }
    }
    // #3067 — suspend SQL for a focused REST-only turn by stripping every
    // SQL-dependent tool (executeSQL + the SQL-card dashboard tools) from the
    // base registry, so neither the prompt's tool list nor the runtime exposes a
    // way to run or stage SQL. Default turns keep the registry untouched.
    const baseRegistry = sqlSuspended
      ? registryWithoutSqlTools(toolRegistry)
      : toolRegistry;
    activeRegistry = baseRegistry;
    if (restDatasources.length > 0) {
      const restRegistry = new ToolRegistry();
      restRegistry.register({
        name: "executeRestOperation",
        description: REST_OPERATION_DESCRIPTION,
        // Bind the tool to exactly the datasources rendered into the prompt, so
        // the agent's `datasourceId` choice resolves against the same set the
        // representation described (no per-execute re-resolution / drift).
        tool: createExecuteRestOperationTool({
          resolveDatasources: async () => restDatasources,
        }),
      });
      activeRegistry = ToolRegistry.merge(baseRegistry, restRegistry).freeze();
      // Representation mode is the #2931 bake-off knob, resolved per install from
      // its `workspace_plugins.config`. Path A vs Path B differ only in how the
      // surface is described; both drive the same executeRestOperation. With more
      // than one datasource, surface each one's `datasourceId` so the agent can
      // route; a single datasource keeps the slice-1 prompt shape unchanged.
      const multiple = restDatasources.length > 1;
      const sections: string[] = [];
      for (const ds of restDatasources) {
        const rep = buildAgentRepresentation(ds.graph, ds.representationMode, {
          displayName: ds.displayName,
          ...(multiple ? { datasourceId: ds.id } : {}),
        });
        // #3044 — prepend the environment-scope banner so the agent never
        // implies the conversation is constrained tighter than it is.
        const scopeNote = buildRestDatasourceScopeNote(ds, {
          boundToEnvironment: chatBoundToEnvironment,
        });
        sections.push(`${scopeNote}\n\n${rep.promptContext}`);
        if (rep.unresolvedResources.length > 0) {
          log.warn(
            { datasource: ds.id, resources: rep.unresolvedResources },
            `REST datasource "${ds.id}": ${rep.unresolvedResources.length} resource(s) ` +
              `resolved to no record schema — the agent sees their operations but no field surface.`,
          );
        }
      }
      restRepresentation = sections.join("\n\n");
      // #3067 — prepend the REST-only focus banner so the model treats the turn
      // as API-only (the SQL tool is already gone from the registry above).
      if (sqlSuspended) {
        restRepresentation = `${REST_ONLY_FOCUS_GUIDANCE}\n\n${restRepresentation}`;
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "REST datasource preflight failed — continuing without it",
    );
  }

  const rawTools = activeRegistry.getAll();
  const tools = wrapToolsWithHooks(rawTools, { userId: userId ?? undefined, conversationId });

  let result;
  try {
    result = otelContext.with(agentCtx, () => streamText({
      model,
      system: buildSystemParam(providerType, activeRegistry, warnings, orgSemanticIndex, learnedPatternsSection, scopeRoutingContext, boundDashboardContext, presentationMode ?? "developer", restRepresentation, resolvedModelId),
      messages: modelMessages,
      tools,
      temperature: 0.2,
      maxOutputTokens: 4096,
      stopWhen: stepCountIs(maxStepsOverride ?? getAgentMaxSteps()),
      // Per-step AI-SDK telemetry (#3183 L-2): emit `ai.streamText` /
      // `ai.streamText.doStream` child spans under the enclosing `atlas.agent`
      // span so a multi-step run no longer collapses into one span — each step's
      // finish reason, token split, and tool-call count become visible. Gated on
      // the OTLP endpoint so it's a true no-op (zero AI-SDK span overhead) when
      // OTel is off, matching every other span site. `recordInputs`/`recordOutputs`
      // are OFF by intent: spans carry structural metadata only, never prompt or
      // completion text — same security stance as `atlas.sql.execute` (which
      // excludes SQL content). Prompts here would otherwise attach user questions
      // + semantic-layer context + tool args to the trace.
      experimental_telemetry: {
        isEnabled: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
        functionId: "atlas.agent",
        recordInputs: false,
        recordOutputs: false,
      },
      // totalMs: 180s for self-hosted (full agent loop budget).
      // On Vercel, maxDuration caps the serverless function at 300s (Pro plan).
      timeout: { totalMs: 180_000, stepMs: 30_000, chunkMs: 5_000 },

      onError: ({ error }) => {
        log.error(
          { err: error instanceof Error ? error : new Error(String(error)) },
          "stream error",
        );
        endSpan(
          SpanStatusCode.ERROR,
          error instanceof Error ? error.message : String(error),
        );
      },

      prepareStep: ({ messages: stepMessages }) => {
        return {
          messages: applyCacheControl(stepMessages, providerType, resolvedModelId),
        };
      },

      onStepFinish: ({ stepNumber, finishReason, usage }) => {
        log.info(
          {
            step: stepNumber,
            finishReason,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            cacheRead: usage?.inputTokenDetails?.cacheReadTokens,
            cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens,
          },
          "step complete",
        );
      },

      onFinish: ({ finishReason, totalUsage, steps }) => {
        log.info(
          {
            finishReason,
            totalSteps: steps.length,
            totalInput: totalUsage?.inputTokens,
            totalOutput: totalUsage?.outputTokens,
            totalCacheRead: totalUsage?.inputTokenDetails?.cacheReadTokens,
            totalCacheWrite: totalUsage?.inputTokenDetails?.cacheWriteTokens,
          },
          "agent finished",
        );
        span.setAttributes({
          "atlas.finish_reason": finishReason ?? "",
          "atlas.total_steps": steps.length,
          "atlas.total_input_tokens": totalUsage?.inputTokens ?? 0,
          "atlas.total_output_tokens": totalUsage?.outputTokens ?? 0,
        });
        endSpan(SpanStatusCode.OK);

        // Persist token usage to internal DB (fire-and-forget).
        // Shares the internalExecute circuit breaker with audit writes.
        if (hasInternalDB() && totalUsage) {
          try {
            internalExecute(
              `INSERT INTO token_usage (user_id, conversation_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, model, provider, org_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                userId,
                conversationId ?? null,
                totalUsage.inputTokens ?? 0,
                totalUsage.outputTokens ?? 0,
                totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
                totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
                resolvedModelId,
                providerType,
                orgId ?? null,
              ],
            );
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to persist token usage");
          }

          // Log usage metering events for billing/overage tracking.
          // Wrapped in its own try/catch to ensure a metering failure
          // never disrupts the onFinish callback or stream finalization.
          try {
            const totalTokens = (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0);
            logUsageEvent({
              workspaceId: orgId ?? null,
              userId: userId ?? null,
              eventType: "query",
              quantity: 1,
              metadata: { conversationId, model: resolvedModelId, steps: steps.length },
            });
            if (totalTokens > 0) {
              logUsageEvent({
                workspaceId: orgId ?? null,
                userId: userId ?? null,
                eventType: "token",
                quantity: totalTokens,
                metadata: { input: totalUsage.inputTokens ?? 0, output: totalUsage.outputTokens ?? 0 },
              });
            }
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to log usage metering events");
          }
        }
      },
    }));
  } catch (err) {
    endSpan(
      SpanStatusCode.ERROR,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  return result;
}

// ── Effect-based agent runner (P10c) ────────────────────────────────

/**
 * Run the Atlas agent as an Effect program.
 *
 * Reads the AI model from `AtlasAiModel` in the Effect Context and
 * delegates to `runAgent`. This is the preferred entry point for
 * Effect-based callers — it makes the agent testable via Layer.provide
 * with a mock LLM.
 *
 * @example
 * ```ts
 * import { runAgentEffect } from "@atlas/api/lib/agent";
 * import { createAiModelTestLayer } from "@atlas/api/lib/effect/ai";
 *
 * // In tests — provide a mock model
 * const result = await Effect.runPromise(
 *   runAgentEffect({ messages }).pipe(
 *     Effect.provide(createAiModelTestLayer({ ... })),
 *   ),
 * );
 * ```
 */
export function runAgentEffect(params: {
  messages: UIMessage[];
  tools?: ToolRegistry;
  conversationId?: string;
  warnings?: string[];
  maxSteps?: number;
}): Effect.Effect<ReturnType<typeof streamText>, Error, AtlasAiModel> {
  return Effect.gen(function* () {
    const aiModel = yield* AtlasAiModel;
    return yield* Effect.tryPromise({
      try: () => runAgent({ ...params, aiModel }),
      catch: (err) =>
        new Error(
          `Agent execution failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
  });
}
