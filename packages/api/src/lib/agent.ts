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
import { getModel, getProviderType, getModelFromWorkspaceConfig, getWorkspaceProviderType, getSummaryModel, isGatewayAnthropicModel, type ProviderType } from "./providers";
import { defaultRegistry, ToolRegistry } from "./tools/registry";
import { resolveWorkspaceRestDatasources, resolveWorkspaceRestDatasourcesOrThrow } from "./openapi/workspace-datasource";
import type { RestDatasource } from "./openapi/datasource";
import { buildAgentRepresentation } from "./openapi/representation";
import { loadSourceCatalog, type RestCatalogSource } from "./source-catalog/lookup";
import { reachStateFromColumn } from "./group-reach";
import { REST_OPERATION_DESCRIPTION, createExecuteRestOperationTool } from "./tools/rest-operation";
import { getStreamWriter } from "./tools/python-stream";
import { getContextFragments, getDialectHints } from "./plugins/tools";
import { connections, detectDBType, type ConnectionMetadata, type DBType } from "./db/connection";
import { getCrossSourceJoins, type CrossSourceJoin, loadOrgWhitelist, getOrgSemanticIndex } from "./semantic";
import { getSemanticIndex } from "./semantic/search";
import { getConfig } from "./config";
import { createLogger, getRequestContext } from "./logger";
import { getSetting } from "./settings";
import { hasInternalDB, internalExecute } from "./db/internal";
import {
  AGENT_RUN_STATUS,
  isDurabilityEnabled,
  recordRunCheckpoint,
  recordParkedAgentRun,
  recordTerminalAgentRun,
  type AgentRunStatus,
  type TerminalAgentRunStatus,
} from "./durable-session";
import { findApprovalParkSignal } from "./approvals/evaluate";
import {
  buildDurableStateStore,
  commitSessionMemory,
  renderDurableMemoryBlock,
  runWithDurableState,
  type DurableStateStore,
} from "./durable-state";
import { loadGroupRoutingContext } from "./env-routing/lookup";
import { logUsageEvent } from "./metering";
import { toOutputEquivalentTokens } from "./billing/token-weighting";
import { summarizeStepGatewayCostUsd } from "./billing/gateway-cost";
import { buildRetrievalQuery, getRetrievalTurns } from "./learn/pattern-cache";
import { resolveOrgKnowledgeSection } from "./learn/org-knowledge-section";
import { dispatchMutableHook } from "./plugins/hooks";
import { plugins } from "./plugins/registry";
import {
  trace,
  SpanStatusCode,
  context as otelContext,
} from "@opentelemetry/api";
import { type AtlasAiModelShape } from "./effect/ai";
import {
  resolveCompactionSettings,
  estimateContextTokens,
  shouldCompact,
  compactOlderHistory,
  summarizeOlderHistory,
  summarizeIncremental,
  compactionSpanAttributes,
  buildCompactionMarker,
  COMPACTION_STREAM_PART_TYPE,
} from "./agent-compaction";
import { ModelRouter } from "./effect/services";
import { runEnterprise } from "./effect/enterprise-layer";
import { BOUND_AGENT_PROMPT_GUIDANCE } from "./bound-chat-context";
import {
  DEFAULT_ANSWER_STYLE,
  isWorkspaceDefaultAnswerStyle,
  resolveAnswerStyleAddendum,
  WORKSPACE_DEFAULT_STYLE_OPTIONS,
  type AnswerStyle,
  type WorkspaceDefaultAnswerStyle,
} from "./answer-styles";

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

// Once-per-(workspace, value) warn dedupe. Keyed per org — not a single
// process-global slot like `lastWarnedMaxSteps` — because this is a
// workspace-scoped setting in a multi-tenant process: org B's stale token
// must still leave a breadcrumb after org A warned for the same value.
// Bounded in practice: entries come from admin/env config, so cardinality is
// (misconfigured workspaces × distinct bad tokens), effectively tiny.
const warnedAnswerStyleDefaults = new Set<string>();

/**
 * #4303 (PRD #4292) — the workspace default answer style ("house voice"),
 * read from the settings registry (`ATLAS_DEFAULT_ANSWER_STYLE`, workspace
 * DB override > platform DB override > env var; no registry default). The
 * middle tier of the answer-style precedence chain:
 *
 *   explicit `answerStyle` (per-conversation pick #4302, or a chat-platform
 *   surface's explicit style) > THIS workspace default > surface default
 *   (`DEFAULT_ANSWER_STYLE`, applied by `buildSystemParam`).
 *
 * `runAgent` consults it only when the caller passed no style, so
 * chat-platform surfaces — whose entrypoints both map `presentationMode` to
 * an explicit style every turn (`executeQuery` in core, the proactive
 * answer adapter in /ee) — are structurally unaffected. Returns `undefined`
 * when unset, cleared, or empty (legal silent states), and for a token that
 * isn't an offered house voice — the one case that warns, once per
 * (workspace, value): fail-soft to the surface default, because a stale
 * DB/env token must never crash a turn. Non-offered registry styles
 * (`conversational` — see `NON_HOUSE_VOICE_STYLES`) take the same
 * warn-and-fall-back path as unknown tokens: the admin select can't store
 * them, but the env-var ingress bypasses that write validation, and the
 * Slack-tuned addendum must never become the house voice for analyst-grade
 * surfaces.
 *
 * `orgId` threads the workspace tier; when omitted it falls back to the
 * request context's active organization (#3406 shape).
 */
export function resolveWorkspaceDefaultAnswerStyle(
  orgId?: string,
): WorkspaceDefaultAnswerStyle | undefined {
  const effectiveOrgId = orgId ?? getRequestContext()?.user?.activeOrganizationId;
  const raw = getSetting("ATLAS_DEFAULT_ANSWER_STYLE", effectiveOrgId)?.trim();
  // Unset or empty (the admin select stores "" as a legal value) — no house
  // voice configured; the surface default applies.
  if (!raw) return undefined;
  if (!isWorkspaceDefaultAnswerStyle(raw)) {
    const dedupeKey = `${effectiveOrgId ?? "platform"}:${raw}`;
    if (!warnedAnswerStyleDefaults.has(dedupeKey)) {
      log.warn(
        { value: raw, orgId: effectiveOrgId ?? null },
        `ATLAS_DEFAULT_ANSWER_STYLE value is not an offered house voice — using the surface default answer style (valid: ${WORKSPACE_DEFAULT_STYLE_OPTIONS.join(", ")})`,
      );
      warnedAnswerStyleDefaults.add(dedupeKey);
    }
    return undefined;
  }
  return raw;
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
  orgKnowledgeToc?: string,
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

  // Append the Knowledge Base collection ToC (#4208, ADR-0028 §3) right after the
  // authoritative semantic layer — a sibling section, self-framed as third-party
  // descriptive content (never instructions), so the descriptive/authoritative
  // boundary reads crisply in the prompt. Empty ⇒ nothing appended.
  if (orgKnowledgeToc) {
    base += "\n\n" + orgKnowledgeToc;
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
 * #3909 — Cross-source composition guidance (ADR-0022 §2, slice (d)).
 *
 * Teaches the agent how to *compose* an answer across the sources it can now
 * route to. It rides on the Source catalog (#3894): appended only when a catalog
 * is in reach (≥1 source), so single-source / no-internal-DB workspaces — which
 * never get a catalog — are unchanged. Cross-source answers are **LLM
 * composition, not federation** (ADR-0022): query each source on its own engine
 * (each query keeps its dialect + whitelist + 4-layer AST validation), then
 * stitch the result sets together in reasoning. Atlas runs no cross-engine query
 * engine, so a single SQL `JOIN` across sources is never an option.
 *
 * Two behavioral rules the catalog's routing blurb does not cover:
 *   - **Provenance** — name which source(s) the answer drew from, so the user can
 *     sanity-check it.
 *   - **No silent fallback** — if the source that actually holds the answer is
 *     empty or errors, state the gap; never answer from an unrelated source and
 *     imply it is equivalent.
 *
 * Lives in the SYSTEM prompt (out-of-band of the message transcript), placed
 * right after the catalog and ahead of the durable memory block so the
 * memory-LAST invariant (#3755) still holds; like the rest of the system prompt
 * it is itself compaction-immune by construction (compaction only rewrites the
 * message array — ADR-0020). Exported so unit tests can pin the contract.
 */
export const CROSS_SOURCE_COMPOSITION_GUIDANCE = `## Cross-source composition

When a question spans more than one source in the catalog above — several SQL Connection groups, or a group plus a REST datasource — answer by **composition, not federation**:

- **Query each relevant source on its own**, then correlate the result sets in your own reasoning: \`executeSQL\` per Connection group, \`executeRestOperation\` per REST datasource. The "join" is you stitching the returned rows together in context — Atlas runs **no** cross-engine query engine, so never attempt a single SQL \`JOIN\` across sources or assume a federated query layer exists. (Example: "how many of last month's signups converted to paid?" → count signups in the Postgres group, list paid customers from the Stripe datasource, then correlate the two sets yourself.)
- **Report which source(s) you drew from** so the user can check provenance — e.g. "1,240 signups (Postgres), 180 of them paid (Stripe)".
- **Never silently fall back to an unrelated source.** If the source that actually holds the answer is empty or errors, say so plainly and state the gap — do not answer from a different source and imply it is equivalent.`;

export interface BuildSystemParamOptions {
  /** Tool registry the prompt's tool-guidance sections are built from. Defaults to `defaultRegistry`. */
  readonly registry?: ToolRegistry;
  /** Startup/context warnings surfaced to the agent under a `## Warnings` section. */
  readonly warnings?: readonly string[];
  /** Org-scoped (DB-backed) semantic index section; preferred over the file-based index when present. */
  readonly orgSemanticIndex?: string;
  /**
   * #4208 — Knowledge Base collection table-of-contents (ADR-0028 §3). The
   * compressed root-index summary of the workspace's hosted OKF collections,
   * self-framed as third-party descriptive content. Injected right after the
   * semantic index. Empty string / omitted ⇒ nothing appended.
   */
  readonly orgKnowledgeToc?: string;
  /** Org-knowledge section: learned query patterns + favorites + approved suggestions (#3633). */
  readonly learnedPatternsSection?: string;
  /** Scope-routing context; guidance renders only for >1-member connection groups. */
  readonly routingContext?: ScopeRoutingContext;
  /** Bound dashboard context (dashboard-scoped chat). */
  readonly boundDashboardContext?: BoundDashboardAgentContext;
  /**
   * #4299 — the answer's editorial voice. Resolves through the answer-style
   * registry (lib/answer-styles.ts); exactly one style's addendum is appended.
   * Defaults to {@link DEFAULT_ANSWER_STYLE} (`"analyst"`, the answer-first
   * web voice). Chat-platform callers pass `"conversational"`. `runAgent`
   * resolves the workspace default (`ATLAS_DEFAULT_ANSWER_STYLE`, #4303)
   * before calling this, so the fallback here is the SURFACE default — the
   * last tier of the precedence chain, not the whole of it.
   */
  readonly answerStyle?: AnswerStyle;
  /**
   * #2924 — Path A REST representation. When a REST datasource resolves, the
   * trimmed operation-graph prompt context is appended so the agent can address
   * its operations with `executeRestOperation`. Absent for SQL-only workspaces.
   */
  readonly restRepresentation?: string;
  /**
   * #3099 — Resolved model id, used only to detect when the `gateway` provider
   * routes to an Anthropic-family model so the system prompt gets the same
   * cache breakpoint as the direct Anthropic provider. Ignored otherwise.
   */
  readonly modelId?: string;
  /**
   * #3755 — pre-rendered durable working-memory block (the persisted slot values
   * for this session). Appended at a single deterministic position — LAST in the
   * system content, after every other optional section — so the agent carries
   * forward what it recorded earlier without a tool round-trip, AND so it lives in
   * the SYSTEM prompt: out-of-band of the message transcript, where a context-
   * compaction pass (#3759, which only rewrites the message array) can never evict
   * it (the slice-2 invariant recorded in ADR-0020). Empty string / omitted ⇒
   * nothing appended (memory off / empty / no internal DB → no change vs. today).
   */
  readonly memoryBlock?: string;
  /**
   * #3894 — the Source catalog (ADR-0022 §4): the compact routing menu of SQL
   * Connection groups + REST datasources the agent reads to pick a source before
   * drilling in with `explore`. Injected ahead of the cross-source composition
   * guidance (#3909) and the REST representation — the menu sits just ahead of
   * the compose-across-the-menu guidance and the per-datasource detail — and
   * before the durable memory block so the memory-LAST invariant (#3755) holds.
   * Empty string / omitted ⇒ nothing appended (single-source / no-internal-DB
   * workspaces are unchanged).
   */
  readonly sourceCatalog?: string;
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
 * - OpenAI / Ollama / OpenAI-compatible: returns a plain string (OpenAI
 *   caches automatically for prompts >= 1024 tokens; others have no caching).
 * - Gateway: plain string, EXCEPT when `options.modelId` resolves to an
 *   Anthropic-family model — then it takes the Anthropic cacheControl branch
 *   (#3099, see `cacheProviderFor`).
 */
export function buildSystemParam(
  providerType: ProviderType,
  options: BuildSystemParamOptions = {},
): string | SystemModelMessage {
  const {
    registry = defaultRegistry,
    warnings,
    orgSemanticIndex,
    orgKnowledgeToc,
    learnedPatternsSection,
    routingContext,
    boundDashboardContext,
    answerStyle = DEFAULT_ANSWER_STYLE,
    restRepresentation,
    modelId,
    memoryBlock,
    sourceCatalog,
  } = options;
  let content = buildSystemPrompt(registry, orgSemanticIndex, learnedPatternsSection, routingContext, boundDashboardContext, orgKnowledgeToc);

  if (sourceCatalog) {
    content += "\n\n" + sourceCatalog;
    // #3909 — composition guidance rides on the catalog: appended only when a
    // non-empty catalog is supplied (≥1 source in reach), a no-op for single-
    // source / no-catalog workspaces. Sits right after the menu (how to compose
    // across what it lists) and ahead of memory.
    content += "\n\n" + CROSS_SOURCE_COMPOSITION_GUIDANCE;
  }

  if (restRepresentation) {
    content += "\n\n" + restRepresentation;
  }

  // #4299 — the answer style contributes exactly one addendum, resolved
  // through the registry. Position preserved from the #2705 conversational
  // addendum (after the REST representation, before warnings) so the
  // conversational prompt stays byte-identical to the pre-registry assembly.
  content += "\n\n" + resolveAnswerStyleAddendum(answerStyle);

  if (warnings && warnings.length > 0) {
    content += "\n\n## Warnings\n\n" + warnings.map((w) => `- ${w}`).join("\n");
  }

  // #3755 — durable working memory, threaded LAST so it sits at one stable,
  // deterministic position regardless of which optional sections above are
  // present. Empty string ⇒ no block (no behavior change vs. today).
  if (memoryBlock) {
    content += "\n\n" + memoryBlock;
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
 * Wrap each tool's execute so it runs inside the turn's durable-state ambient
 * context (#3754, ADR-0020). Makes {@link defineDurableState} handles resolve to
 * the active session's store from within tool execution — regardless of WHEN the
 * AI SDK invokes the tool as the stream is consumed — because `origExecute` is
 * called synchronously inside `runWithDurableState`, so its async continuation
 * inherits the context.
 *
 * Applied on EVERY durable-capable turn (a Noop store when memory is inactive):
 * a memory-aware tool then reads empty / drops writes rather than throwing on a
 * non-durable turn — identical behavior to today. Tools without an `execute`
 * (client-side / provider-defined) pass through untouched.
 */
function wrapToolsWithDurableState(toolSet: ToolSet, store: DurableStateStore): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(toolSet)) {
    if (!t.execute) {
      wrapped[name] = t;
      continue;
    }
    const origExecute = t.execute;
    wrapped[name] = {
      ...t,
      execute: (
        args: Record<string, unknown>,
        options: Parameters<NonNullable<typeof t.execute>>[1],
      ) => runWithDurableState(store, () => origExecute(args, options)),
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
  answerStyle,
  resume,
  runId: callerRunId,
  subagent,
  abortSignal,
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
  /**
   * #3756 — subagent memory isolation (PRD #3752). When `true`, this run is a
   * DELEGATED CHILD: its durable working memory is forced to the Noop store
   * regardless of `conversationId`, so the child starts with EMPTY memory and
   * can neither read nor write the parent's per-session slots. Working memory
   * never crosses the parent/subagent boundary — a child can't leak or clobber
   * parent state, and the parent is unaffected by anything the child writes.
   * Absent / `false` ⇒ a normal (parent / top-level) run — behavior unchanged.
   *
   * Memory is the only per-session state this gates; the durable-session
   * checkpoint (the `agent_runs` row) is keyed on the run id, which a subagent
   * supplies independently, so it is already child-scoped and unaffected here.
   */
  subagent?: boolean;
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
   * #4299 — the answer style for this turn (PRD #4292). Resolves through
   * the registry in `lib/answer-styles.ts`; exactly one style's prompt
   * addendum is appended by {@link buildSystemParam}.
   *
   * - `"analyst"` (default): the answer-first web voice — lead with the
   *   result, length scales with the question, no emoji headers, caveats
   *   only when material. The default for the web chat, SDK, MCP, and
   *   `/api/v1/query` (superseding #2705's addendum-free "developer" view).
   * - `"conversational"`: 1-2 sentence prose answer for chat-platform
   *   surfaces (Slack @mention, proactive) — behavior-identical to the
   *   #2705 binary. The chat plugin pairs this with progressive-disclosure
   *   buttons that surface the SQL and full result tables on demand.
   * - `"plain-english"` / `"executive"`: selectable voices for the
   *   per-conversation picker (#4302); no surface auto-selects them,
   *   though a workspace default (#4303, below) can.
   *
   * #4303 — when ABSENT, the workspace default answer style (the
   * `ATLAS_DEFAULT_ANSWER_STYLE` setting, resolved per turn via
   * {@link resolveWorkspaceDefaultAnswerStyle}) applies before the surface
   * default. Passing an explicit style always wins — which is what keeps
   * chat-platform surfaces (always explicit) outside the workspace
   * default's reach.
   */
  answerStyle?: AnswerStyle;
  /**
   * #3747 — crash-resume re-entry (ADR-0020 phase 2). When supplied, the agent
   * RE-ENTERS an interrupted turn instead of starting a fresh one:
   *
   * - `runId` reuses the interrupted turn's durable row id, so the resumed
   *   per-step + terminal checkpoints target the SAME `agent_runs` row (one
   *   logical row per turn — resume does not mint a new run).
   * - `transcript` is the stored `ModelMessage[]` as of the last completed step
   *   (input messages + every completed step's assistant/tool messages). It is
   *   handed to `streamText` directly, so the model CONTINUES from the last
   *   completed step — the completed tool calls are already in the messages and
   *   do NOT re-execute. When `resume` is set, `messages` is ignored for the
   *   model input (the transcript supersedes it); the caller passes the loaded
   *   transcript here, not the original UI messages.
   * - `priorStepIndex` is the completed-step count of the checkpoint being
   *   resumed. The loop seeds its observed-step counter from it so a failure
   *   before the first resumed step records the correct (non-regressing) index,
   *   and the monotonic `GREATEST` upsert guarantees steps ≤ N are never
   *   replayed in the durable row.
   *
   * Absent (the default) ⇒ a fresh turn: a new `runId`, `convertToModelMessages`
   * on `messages`, step counting from 0 — every pre-#3747 caller is unchanged.
   */
  resume?: {
    readonly runId: string;
    readonly transcript: ModelMessage[];
    readonly priorStepIndex: number;
  };
  /**
   * #3747 — caller-supplied run id for a FRESH turn, so the chat route can set
   * the `x-run-id` reattach header on the response (the client reattaches with
   * conversation id + run id). Ignored when `resume` is set (the resumed run id
   * wins). Absent ⇒ the loop mints a UUID as before. The resolved run id is
   * surfaced back on the returned object as `runId` for the route to read.
   */
  runId?: string;
  /**
   * #4294 — cooperative cancellation for the user-facing Stop control. When the
   * signal fires, `streamText` stops generating — no further model calls or new
   * tool executions (an in-flight tool call runs to completion unless it honors
   * the signal itself) — and `onAbort` writes the run's terminal checkpoint, so
   * a stopped turn ends the durable row rather than leaving a resumable
   * interruption. This is only ever an EXPLICIT stop (the chat route's abort
   * registry) — the routes deliberately never pass the request's own disconnect
   * signal here, or a tab close would kill runs that ADR-0020 lets finish
   * server-side.
   */
  abortSignal?: AbortSignal;
}) {
  // #3931 — per-turn latency clock. Captured at runAgent entry so the
  // token_usage INSERT in onFinish can persist the agent-turn wall-clock
  // (entry → finish) on the same row as the turn's tokens + cache split.
  // A close proxy for the log-only `first_answer_latency` minus the caller's
  // pre-agent overhead; uniform across every surface (demo + chat).
  const turnStartedAt = Date.now();
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
  // Hoisted out of the else-branch so the #3761 summary-model resolution below
  // can rebuild the SAME workspace provider/credentials with a cheaper model id.
  // Null on the injected and platform-default paths.
  let workspaceConfig: import("@atlas/api/lib/auth/credentials").RawWorkspaceModelConfig | null = null;

  if (injectedAiModel) {
    // Model provided via Effect Context (P10c) — skip provider resolution
    model = injectedAiModel.model;
    providerType = injectedAiModel.providerType;
  } else {
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
  const [orgSemanticIndex, learnedPatternsSection, orgKnowledgeToc] = await Effect.runPromise(
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
      // Organizational knowledge — learned patterns + user favorites +
      // approved popular suggestions (#3633). All three are intent signals;
      // before #3633 only learned patterns reached the agent.
      hasInternalDB()
        ? Effect.tryPromise({
            try: async () => {
              // #3632 — assemble the retrieval query from the last N user
              // turns, not just the final message, so a keyword-less
              // follow-up ("now break that down by region") still matches
              // patterns via the keywords of earlier turns.
              const question = buildRetrievalQuery(messages, getRetrievalTurns(orgId ?? null));
              // No early return on an empty `question` (#3633): only pattern
              // retrieval is keyword-scored, and `getRelevantPatterns` already
              // yields [] when there are no keywords. Favorites/suggestions are
              // question-independent, so we always resolve the block.
              // #3611 — scope retrieval to the active connection group so a
              // `us-prod` session is never primed with `eu-prod`'s patterns.
              // Favorites/suggestions are scoped by org (and user) inside their
              // resolvers, so cross-tenant leakage is structurally impossible.
              const section = await resolveOrgKnowledgeSection({
                orgId: orgId ?? null,
                userId,
                connectionGroupId: connectionGroupId ?? null,
                mode: atlasMode,
                question,
                requestId: reqCtx?.requestId,
              });
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
      // #4208 — Knowledge Base collection ToC (ADR-0028 §3). Best-effort: it is
      // descriptive-only context, so a load failure/timeout degrades to no ToC
      // and never fails the turn (the collections stay browsable via explore).
      (orgId && hasInternalDB())
        ? Effect.tryPromise({
            try: async () => {
              const { buildKnowledgeToc } = await import("./knowledge/mirror");
              const toc = await buildKnowledgeToc(orgId, atlasMode);
              return toc || undefined;
            },
            catch: normalizeError,
          }).pipe(
            Effect.timeoutFail({
              duration: Duration.seconds(30),
              onTimeout: () => new Error("Knowledge collection ToC load timed out after 30s"),
            }),
            Effect.catchAll((err) => {
              log.warn(
                { orgId, err: err.message },
                "Failed to load knowledge collection ToC — continuing without it",
              );
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
  // #3747 — on resume, the stored transcript IS the model input (input messages
  // + completed steps' assistant/tool messages); it supersedes `messages` so the
  // model continues from the last completed step rather than restarting. A fresh
  // turn converts the UI messages as before.
  //
  // #3762 — compact-on-resume needs NO dedicated branch here: `modelMessages`
  // (the rehydrated transcript) is handed to `streamText` as `messages`, and the
  // compaction trigger lives in `prepareStep` below, which the AI SDK invokes
  // before EVERY step — including step 0, whose input messages on a resumed turn
  // ARE this transcript (no prior response messages yet). So a days-long resumed
  // turn whose rehydrated transcript already exceeds the window is compacted by
  // that step-0 trigger BEFORE the first re-entered model call, exactly as the
  // PRD requires — the shared-seam architecture of #3759 subsumes it (the window
  // it trips against is resolved per turn model by #3760). Locked at the resume
  // seam by agent-compaction-resume.test.ts.
  const modelMessages = resume
    ? resume.transcript
    : await convertToModelMessages(messages);

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
  // #3894 — minimal REST projection for the Source catalog (ADR-0022 §4). Filled
  // from the resolved REST datasources inside the preflight below so the catalog
  // lists the same conversation-scoped set the representation describes.
  let restCatalogSources: RestCatalogSource[] = [];
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
    // #3894 — project the resolved REST datasources into the Source catalog
    // shape (id + name + headline operation ids). Same set the representation
    // above describes, so the catalog and the per-datasource detail agree.
    restCatalogSources = restDatasources.map((ds) => ({
      id: ds.id,
      displayName: ds.displayName,
      operationNames: [...ds.graph.operations.keys()],
    }));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "REST datasource preflight failed — continuing without it",
    );
  }

  // ── Durable per-session working memory (#3754, ADR-0020) ────────────────────
  // Part of the durable-sessions substrate: gated on a conversation (the session
  // key) + the per-workspace durability flag, with the helpers additionally
  // no-op without an internal DB — so off / no-DB → behavior identical to today.
  // When active, the session's persisted slots are loaded into a Live store;
  // otherwise a shared Noop store (reads empty, writes dropped). Tools read/write
  // it through `defineDurableState` handles via the ambient context established by
  // `wrapToolsWithDurableState`; the store's dirty slots are committed at step
  // boundaries on the same fire-and-forget path as the transcript checkpoint
  // (`commitMemory` below). Load is fail-soft (empty store on failure), so a
  // degraded memory store never costs the turn its answer.
  const durabilityActive = Boolean(conversationId) && isDurabilityEnabled(orgId);
  // #3756 — subagent memory isolation. A delegated child run forces the Noop
  // memory store regardless of the conversation/durability state: it starts with
  // empty slots and never persists into the parent's session, so working memory
  // never crosses the parent/subagent boundary (PRD #3752). This gates ONLY the
  // working-memory store — the durable-session checkpoint below stays keyed on
  // the run id (already child-scoped), so subagent crash-resumability is intact.
  const memoryStore = await buildDurableStateStore({
    conversationId: conversationId ?? null,
    orgId: orgId ?? null,
    active: durabilityActive,
    subagent: subagent ?? false,
  });

  const rawTools = activeRegistry.getAll();
  const hookedTools = wrapToolsWithHooks(rawTools, { userId: userId ?? undefined, conversationId });
  const tools = wrapToolsWithDurableState(hookedTools, memoryStore);

  // #3755 — render the deterministic working-memory block from the slots loaded
  // for this session (a fresh turn AND a resumed turn both load via
  // `buildDurableStateStore` above, so memory re-threads identically on resume).
  // The Noop store snapshots empty ⇒ "" ⇒ nothing threaded, so an inactive turn
  // (memory off / no internal DB / nothing written) is byte-identical to today.
  // Threaded into the SYSTEM prompt below — out-of-band of the compactable
  // transcript — so a compaction pass can never summarize or evict it (ADR-0020).
  const memoryBlock = renderDurableMemoryBlock(memoryStore.snapshot());

  // #3894 — the Source catalog (ADR-0022 §4): the compact routing menu of SQL
  // groups + REST datasources the agent reads to choose a source before drilling
  // in with `explore`. Built once per turn after REST resolution (it lists the
  // same conversation-scoped REST set). Fail-soft: an assembly hiccup yields ""
  // (no block), never a failed turn.
  //
  // #3895 — narrow the SQL half to the conversation's Group reach: under Focus
  // the menu lists only the focused group, matching what `executeSQL` will allow
  // (so the agent isn't told about groups every query to which would be
  // rejected). Sourced from the same RequestContext value that bounds executeSQL.
  const sourceCatalog = await loadSourceCatalog(
    orgId,
    atlasMode,
    restCatalogSources,
    {},
    reachStateFromColumn(reqCtx?.groupReach),
  );

  // System prompt is built once and pinned: it carries the semantic index +
  // glossary AND the durable memory block (#3755), and is passed to the model
  // separately, so neither ever enters the message array compaction rewrites
  // (#3759).
  const systemParam = buildSystemParam(providerType, {
    registry: activeRegistry,
    warnings,
    orgSemanticIndex,
    orgKnowledgeToc,
    learnedPatternsSection,
    routingContext: scopeRoutingContext,
    boundDashboardContext,
    // #4303 — answer-style precedence: the caller's explicit style (the
    // #4302 per-conversation pick, or a chat-platform surface's explicit
    // "conversational") > the workspace default from the settings registry
    // > the surface default (`DEFAULT_ANSWER_STYLE`, applied inside
    // `buildSystemParam` when this resolves to undefined). Re-read per turn
    // through the settings cache, so an admin's change (or clear) takes
    // effect on the next turn without a restart.
    answerStyle: answerStyle ?? resolveWorkspaceDefaultAnswerStyle(orgId),
    restRepresentation,
    modelId: resolvedModelId,
    memoryBlock,
    sourceCatalog,
  });

  // #3759 — context compaction. Resolved once per turn (knobs hot-reload at the
  // next turn via the settings cache). Off by default ⇒ the prepareStep below
  // behaves exactly as before. `prepareStep` re-receives the full, growing
  // history each step (the AI SDK does not persist our override), so once a turn
  // crosses the threshold every subsequent step would re-summarize. The in-turn
  // memo holds the running summary + how many older messages it covers: an
  // identical older slice is reused verbatim, and a grown one folds only the
  // newly-aged-out delta into the prior summary (rolling summary) — keeping the
  // per-step summarization cost bounded instead of O(full older slice).
  const compactionSettings = resolveCompactionSettings(resolvedModelId, orgId);
  let compactionSummaryMemo: { olderCount: number; text: string } | undefined;

  // #3761 — optional cheaper summary model. When `ATLAS_COMPACTION_SUMMARY_MODEL`
  // names a model distinct from the turn, the summarization call runs on THAT
  // model (resolved on the same provider/credentials as the turn via the
  // providers layer) so reclaiming context costs less than the turn itself.
  // Unset/blank ⇒ the summary runs on the turn model (the Compaction 1 default).
  // Only resolved when compaction is enabled and the turn built its own model
  // (the injected-model path — Effect/tests — has no provider to rebuild from,
  // so it always summarizes on the injected model). Fail-soft: a resolution
  // failure logs and falls back to the turn model — never errors the turn.
  let summaryModel: LanguageModel = model;
  // The separate summary model's id when one is actually IN USE (resolved OK and
  // distinct from the turn model); undefined when summarizing on the turn model.
  // Hoisted to the turn scope so the outer compaction catch below can attribute a
  // summarize failure to it: a typo'd `ATLAS_COMPACTION_SUMMARY_MODEL` resolves to
  // a provider handle WITHOUT throwing here (the SDK validates lazily), so the bad
  // id only fails later inside `generateText` on every pass — naming it in that
  // catch is the only breadcrumb pointing at the misconfigured knob.
  let summaryModelId: string | undefined;
  if (compactionSettings.enabled && !injectedAiModel) {
    const configuredSummaryModelId = getSetting("ATLAS_COMPACTION_SUMMARY_MODEL", orgId)?.trim();
    if (configuredSummaryModelId && configuredSummaryModelId !== resolvedModelId) {
      try {
        summaryModel = getSummaryModel({ summaryModelId: configuredSummaryModelId, workspaceConfig });
        summaryModelId = configuredSummaryModelId;
        log.info(
          { summaryModelId: configuredSummaryModelId, turnModelId: resolvedModelId },
          "compaction: summarizing on a separate model",
        );
      } catch (err) {
        // Synchronous resolution failure (unknown provider, missing key). Degrade
        // to the turn model; `summaryModelId` stays undefined so the outer catch
        // doesn't mis-attribute a later turn-model failure to a separate model.
        log.warn(
          { err: err instanceof Error ? err.message : String(err), summaryModelId: configuredSummaryModelId },
          "compaction summary model resolution failed — summarizing on the turn model",
        );
        summaryModel = model;
      }
    }
  }

  // ── Durable-session checkpoints (#3745 phase 1a, #3746 phase 1b, ADR-0020) ──
  // A turn occupies exactly ONE durable `agent_runs` row, keyed on a stable
  // per-turn `runId` and advanced IN PLACE:
  //   - phase 1b: `onStepFinish` upserts a `running` checkpoint at every step
  //     boundary (monotonic step index, transcript grown to the messages
  //     accumulated so far), so an interrupted turn leaves a recoverable
  //     mid-flight row at the last completed step.
  //   - phase 1a: the terminal write flips that same row to `done`/`failed`.
  // Gated on a conversation id (a run belongs to a conversation) + the
  // per-workspace durability flag; the helpers additionally no-op without an
  // internal DB, so off / no-DB → behavior identical to today. Fire-and-forget:
  // each write rides the shared circuit breaker and never disrupts the stream.
  // `terminalWritten` makes the terminal write idempotent across the
  // onFinish/onError/catch seams (first terminal status wins — one row per turn).
  // `durabilityActive` is computed above (shared with durable memory).
  // #3747 — on resume, reuse the interrupted turn's run id so the resumed
  // checkpoints target the SAME durable row (one logical row per turn); a fresh
  // turn uses the caller-supplied id (for the `x-run-id` header) or mints one.
  // The monotonic `GREATEST` step-index upsert means a resumed write can never
  // regress the row below the checkpoint we resumed from.
  const runId = resume ? resume.runId : (callerRunId ?? crypto.randomUUID());
  let terminalWritten = false;
  // #3747 — seed the observed-step counter from the resumed checkpoint's step
  // count so a failure before the first resumed step records the correct
  // (non-regressing) `failed` index, and so resumed step accounting continues
  // from N rather than restarting at 0. A fresh turn starts at 0.
  let observedSteps = resume ? resume.priorStepIndex : 0;
  // #3747 — the AI SDK's `stepNumber` / `steps.length` count only the steps THIS
  // `streamText` call runs; on resume they restart at 0 / 1, having no knowledge
  // of the prior steps already in the transcript. Offset them by the resumed
  // checkpoint's step count so the durable `step_index` continues monotonically
  // (N → N+1 → …) and never regresses below what we resumed from. 0 for a fresh turn.
  const stepIndexOffset = resume ? resume.priorStepIndex : 0;
  // Response messages (assistant text, tool calls, tool results) generated this
  // turn. In AI SDK 6, `onStepFinish`'s `response.messages` is the CUMULATIVE
  // running transcript (every step 0..N), NOT just the latest step's messages —
  // so we keep the most recent snapshot rather than concatenating. (Concatenating
  // would re-append all prior steps each step and quadratically duplicate the
  // persisted transcript.) `currentTranscript()` prepends the input messages to
  // build the running transcript persisted by the mid-flight (`running`) and
  // failure checkpoints; the clean `onFinish` path uses the same
  // `response.messages` snapshot directly (authoritative for the turn).
  let latestResponseMessages: ModelMessage[] = [];
  const currentTranscript = (): ModelMessage[] => [...modelMessages, ...latestResponseMessages];
  // Per-step / terminal observability on the existing atlas.agent span
  // (last-write-wins). Fail-soft: these run inside onStepFinish/onError/onFinish
  // on the live stream path, so a span-mutation throw must never propagate and
  // disrupt the turn — the same guarantee the fire-and-forget checkpoint write
  // already makes for the DB.
  const setDurableSpanAttrs = (status: AgentRunStatus, stepIndex: number): void => {
    try {
      span.setAttributes({
        "atlas.durable.run_id": runId,
        "atlas.durable.status": status,
        "atlas.durable.step_index": stepIndex,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), runId },
        "Failed to set durable-session span attributes",
      );
    }
  };
  // Commit the durable-memory store's dirty slots (#3754) on the SAME
  // fire-and-forget path as the transcript checkpoint. No-op on the Noop store
  // (never dirty); `drainDirty` clears, so each commit persists only the slots
  // changed since the last step boundary. Never throws (commitSessionMemory rides
  // the internalExecute circuit breaker, type-narrowed catch) — a memory write
  // failure logs and the turn completes.
  const commitMemory = (): void => {
    if (!memoryStore.available) return;
    const slots = memoryStore.drainDirty();
    if (slots.length === 0) return;
    commitSessionMemory({
      conversationId: conversationId as string,
      orgId: orgId ?? null,
      slots,
    });
  };
  const writeCheckpoint = (stepIndex: number): void => {
    if (!durabilityActive) return;
    recordRunCheckpoint({
      runId,
      conversationId: conversationId as string,
      orgId: orgId ?? null,
      stepIndex,
      transcript: currentTranscript(),
    });
    commitMemory();
    setDurableSpanAttrs(AGENT_RUN_STATUS.RUNNING, stepIndex);
  };
  const writeTerminal = (status: TerminalAgentRunStatus, stepIndex: number, transcript: ModelMessage[]): void => {
    if (!durabilityActive || terminalWritten) return;
    terminalWritten = true;
    recordTerminalAgentRun({
      runId,
      conversationId: conversationId as string,
      orgId: orgId ?? null,
      status,
      stepIndex,
      transcript,
    });
    // Flush any slots still dirty at turn end onto the same path.
    commitMemory();
    // Terminal status progression on the span — set before `endSpan` at every
    // call site so the final span reflects the persisted terminal state.
    setDurableSpanAttrs(status, stepIndex);
  };
  // #3748 — approval-park. When a step's `executeSQL` returns a needs-approval
  // result, the loop stops (the `stopWhen` park condition below) and this writes
  // a `parked` checkpoint carrying the approval-queue ref in place of the clean
  // `done` terminal. Shares the `terminalWritten` idempotency guard with the
  // `done`/`failed` writers — a park IS the end of this stream, so only one
  // end-of-turn write lands. `parkedReason` is captured per-step; onFinish reads
  // it to choose this path over `writeTerminal(done)`.
  let parkedReason: string | undefined;
  const writeParked = (reason: string, stepIndex: number, transcript: ModelMessage[]): void => {
    if (!durabilityActive || terminalWritten) return;
    terminalWritten = true;
    recordParkedAgentRun({
      runId,
      conversationId: conversationId as string,
      orgId: orgId ?? null,
      stepIndex,
      transcript,
      parkedReason: reason,
    });
    // Flush any slots still dirty at park time onto the same path — a parked
    // turn that later resumes must see the memory it derived before parking.
    commitMemory();
    setDurableSpanAttrs(AGENT_RUN_STATUS.PARKED, stepIndex);
  };

  let result;
  try {
    result = otelContext.with(agentCtx, () => streamText({
      model,
      system: systemParam,
      messages: modelMessages,
      tools,
      temperature: 0.2,
      maxOutputTokens: 4096,
      // #4294 — explicit user stop (see the option doc above). Absent for every
      // caller that doesn't wire a Stop control; `streamText` ignores undefined.
      abortSignal,
      // #3747 — this cap is PER-`streamText`: `stepCountIs` counts the AI-SDK
      // internal `stepNumber`, which restarts at 0 on a resumed run, so a resumed
      // turn gets a fresh full N-step per-request budget here. That is intentional
      // and NOT subtracted by `priorStepIndex`: a turn interrupted near the
      // per-request cap must still be able to finish its remaining steps on
      // resume, and subtracting the prior index could starve a legitimate resume
      // (or, if the prior index exceeded N, stop it dead at zero). The real
      // ceiling on a resumed flow is the per-CONVERSATION step cap (F-77),
      // reserved + settled by the chat/resume route around this call — that
      // aggregate is what bounds unbounded repeat-resume, not this per-request cap.
      // #3748 — stop the turn the instant a step surfaces an `executeSQL`
      // needs-approval result, in addition to the per-request step cap. The loop
      // makes NO further model call: control inverts to the human reviewer and
      // onFinish parks the run (the gated step finished, but the turn suspends
      // here rather than feeding the needs-approval result back to the model).
      // Self-contained (reads the step's own messages) so it does not depend on
      // onStepFinish/stopWhen evaluation order.
      stopWhen: [
        stepCountIs(maxStepsOverride ?? getAgentMaxSteps()),
        ({ steps }) => {
          const last = steps[steps.length - 1];
          return !!last && findApprovalParkSignal(last.response?.messages) !== undefined;
        },
      ],
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

      // #4294 — explicit user stop. `onAbort` fires BEFORE any `onFinish` and is
      // the authoritative terminal seam for a stopped turn. (In ai@6.0.208
      // `onFinish` can STILL run after an abort when ≥1 step completed — the
      // SDK's own docs claim otherwise — so the terminal write and `endSpan`
      // rely on their idempotency guards, and `onFinish`'s token-usage persist
      // intentionally still records the spend of a stopped turn.) A deliberate
      // stop is a CLEAN end, not an interruption: record `done` with the
      // transcript as of the last completed step, so the run-status probe
      // offers no Resume for a turn the user killed and the next send is never
      // blocked. The in-flight step's partial output is intentionally dropped
      // (it was never checkpointed). Terminal write FIRST, span mutation after
      // and guarded — same fail-soft ordering as onError: a span throw must
      // never cost the checkpoint.
      onAbort: () => {
        log.info({ runId, stepIndex: observedSteps }, "agent turn stopped by user");
        writeTerminal(AGENT_RUN_STATUS.DONE, observedSteps, currentTranscript());
        try {
          span.setAttributes({ "atlas.finish_reason": "aborted" });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err), runId },
            "Failed to set abort span attributes",
          );
        }
        endSpan(SpanStatusCode.OK);
      },

      onError: ({ error }) => {
        log.error(
          { err: error instanceof Error ? error : new Error(String(error)) },
          "stream error",
        );
        // Durable terminal checkpoint for the failure path. Records the
        // transcript accumulated up to the point of failure (input messages +
        // any assistant/tool messages from steps that completed before the
        // error, captured by the per-step checkpoints, #3746). Idempotent via
        // `terminalWritten`, so a subsequent onFinish/catch won't double-write.
        writeTerminal(AGENT_RUN_STATUS.FAILED, observedSteps, currentTranscript());
        endSpan(
          SpanStatusCode.ERROR,
          error instanceof Error ? error.message : String(error),
        );
      },

      prepareStep: async ({ messages: stepMessages }) => {
        let effectiveMessages: ModelMessage[] = stepMessages;

        // #3759 — compaction trigger. When the assembled context (system prompt
        // + messages) crosses the configured fill fraction of the coarse context
        // window, collapse older history into one generated summary (on the turn
        // model, or the cheaper #3761 summary model when configured) and keep
        // going, instead of letting the turn blow the window. Fail-soft: a
        // summarization failure logs and continues with full context —
        // compaction never costs the turn its answer.
        if (compactionSettings.enabled) {
          const beforeTokens = estimateContextTokens(systemParam, stepMessages);
          if (shouldCompact(beforeTokens, compactionSettings)) {
            try {
              const compacted = await compactOlderHistory({
                messages: stepMessages,
                pinnedRecentSteps: compactionSettings.pinnedRecentSteps,
                summarize: async (older) => {
                  const memo = compactionSummaryMemo;
                  // Same older slice as last step → reuse the summary verbatim.
                  if (memo?.olderCount === older.length) return memo.text;
                  // Older grew (history only appends within a turn) → roll the
                  // prior summary forward over just the delta, not the whole
                  // slice. First pass (no memo) summarizes the full older slice.
                  // `summaryModel` is the turn model unless #3761's cheaper
                  // summary-model knob selected a separate one above.
                  const text =
                    memo && memo.olderCount < older.length
                      ? await summarizeIncremental(summaryModel, memo.text, older.slice(memo.olderCount))
                      : await summarizeOlderHistory(summaryModel, older);
                  compactionSummaryMemo = { olderCount: older.length, text };
                  return text;
                },
              });
              if (compacted) {
                effectiveMessages = compacted.messages;
                const afterTokens = estimateContextTokens(systemParam, effectiveMessages);
                log.info(
                  {
                    beforeTokens,
                    afterTokens,
                    beforeMessages: stepMessages.length,
                    afterMessages: effectiveMessages.length,
                    summarizedMessages: compacted.summarizedMessageCount,
                    pinnedMessages: compacted.pinnedMessageCount,
                    fillFraction: compactionSettings.fillFraction,
                    contextWindowTokens: compactionSettings.contextWindowTokens,
                  },
                  "context compaction pass ran",
                );
                // OTel attributes on the enclosing atlas.agent span. Only set
                // when a pass actually runs — a non-compacting turn emits
                // neither this nor the log line above. Last-write-wins across
                // steps: on a multi-pass turn the span reflects the FINAL pass's
                // counts; the per-pass detail lives in the log line above.
                span.setAttributes(
                  compactionSpanAttributes({
                    beforeTokens,
                    afterTokens,
                    beforeMessages: stepMessages.length,
                    afterMessages: effectiveMessages.length,
                    summarizedMessages: compacted.summarizedMessageCount,
                  }),
                );
                // #3761 — client-facing stream marker. The log + span above are
                // operator-only; this surfaces the same "history was summarized"
                // signal to the analyst on the live UI message stream so a
                // compacted transcript isn't a silent surprise. Rides the
                // request-scoped writer the Python tool uses (`getStreamWriter`),
                // so no chat-route wiring is needed; absent in non-streaming
                // contexts (SDK / tests without a registered writer) → a graceful
                // no-op. Emitted ONLY inside this "a pass ran" branch — a turn
                // that does not compact writes no marker. Fail-soft + type-narrowed
                // so a closed/throwing writer never disrupts the turn.
                const writer = getStreamWriter();
                if (writer) {
                  // Build the marker OUTSIDE the writer fail-soft. It's a pure
                  // literal that cannot throw today, but keeping construction out
                  // of the try ensures a future throw here surfaces as a real
                  // error instead of being masked as a benign "not delivered".
                  const marker = buildCompactionMarker({
                    beforeTokens,
                    afterTokens,
                    summarizedMessages: compacted.summarizedMessageCount,
                    pinnedMessages: compacted.pinnedMessageCount,
                  });
                  try {
                    writer.write({
                      type: COMPACTION_STREAM_PART_TYPE,
                      data: marker,
                      // Transient: a notification, not assistant answer content —
                      // delivered to the client's `onData` but not persisted into
                      // the stored message history.
                      transient: true,
                    });
                  } catch (err) {
                    // Best-effort: a closed/aborted client stream is the dominant
                    // cause; the logged `err` carries the actual cause.
                    log.debug(
                      { err: err instanceof Error ? err.message : String(err) },
                      "compaction stream marker not delivered",
                    );
                  }
                }
              }
            } catch (err) {
              log.warn(
                {
                  err: err instanceof Error ? err.message : String(err),
                  // #3761 — attribute a persistent failure to a configured separate
                  // summary model (a typo'd id resolves to a handle without throwing,
                  // then fails here every pass) rather than a generic provider blip.
                  // Undefined ⇒ summarizing on the turn model.
                  summaryModelId,
                },
                "context compaction pass failed — continuing with full context",
              );
            }
          }
        }

        return {
          messages: applyCacheControl(effectiveMessages, providerType, resolvedModelId),
        };
      },

      onStepFinish: ({ stepNumber, finishReason, usage, response }) => {
        // Track the highest observed step so a `failed` checkpoint (onError /
        // outer catch) can record how far the turn got. `stepNumber` is
        // 0-based; +1 gives the count of completed steps. #3747 — add
        // `stepIndexOffset` so a resumed run's step index continues from the
        // checkpoint it resumed (N+1, N+2, …) rather than restarting at 1.
        observedSteps = stepIndexOffset + stepNumber + 1;
        // Snapshot this step's cumulative running transcript — AI SDK 6 hands us
        // every step's messages (0..N) in `response.messages`, not just step N —
        // then upsert a mid-flight `running` checkpoint (#3746) keyed on the
        // turn's run id. In-place update — one row per turn — so an interruption
        // after this step leaves a recoverable row at step index `observedSteps`.
        latestResponseMessages = [...response.messages];
        // #3748 — detect an approval-park in this step's transcript so onFinish
        // can write a `parked` checkpoint (with the queue ref) instead of `done`.
        // Captured here as well as in `stopWhen` so onFinish has the ref
        // regardless of callback ordering; the `stopWhen` condition is what
        // actually halts the loop.
        const parkSignal = findApprovalParkSignal(latestResponseMessages);
        if (parkSignal) parkedReason = parkSignal.approvalRequestId;
        writeCheckpoint(observedSteps);
        log.info(
          {
            step: stepNumber,
            stepIndex: observedSteps,
            finishReason,
            durableStatus: durabilityActive ? AGENT_RUN_STATUS.RUNNING : undefined,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            cacheRead: usage?.inputTokenDetails?.cacheReadTokens,
            cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens,
          },
          "step complete",
        );
      },

      onFinish: ({ finishReason, totalUsage, steps, response }) => {
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

        // Durable terminal checkpoint (#3745, ADR-0020). The full transcript is
        // the input messages plus the messages the model generated this turn
        // (assistant text, tool calls, tool results). `finishReason === "error"`
        // is the AI-SDK's in-band error signal — record it as `failed`, not
        // `done`. Idempotent via `terminalWritten`. Runs BEFORE `endSpan` so its
        // terminal status attributes land on the still-open span.
        const status: TerminalAgentRunStatus =
          finishReason === "error" ? AGENT_RUN_STATUS.FAILED : AGENT_RUN_STATUS.DONE;
        // #3747 — offset `steps.length` (this call's new steps) by the resumed
        // checkpoint's step count so the terminal `step_index` reflects the
        // turn's TOTAL completed steps, not just the resumed portion. The
        // terminal transcript is the resumed transcript (`modelMessages`) plus
        // this call's response messages — the full continued turn, no duplication.
        const finalStepIndex = stepIndexOffset + steps.length;
        const finalTranscript = [...modelMessages, ...response.messages];
        // #3748 — an approval-park ends the stream cleanly (the model was not
        // asked to continue), so finishReason is `tool-calls`, not `error`. Park
        // the run instead of marking it `done`: it lives as a row awaiting a
        // human decision, holding no connection or running function.
        if (parkedReason) {
          writeParked(parkedReason, finalStepIndex, finalTranscript);
        } else {
          writeTerminal(status, finalStepIndex, finalTranscript);
        }
        endSpan(SpanStatusCode.OK);

        // Persist token usage to internal DB (fire-and-forget).
        // Shares the internalExecute circuit breaker with audit writes.
        if (hasInternalDB() && totalUsage) {
          // At-cost provider spend for the turn (#4036): the Vercel AI Gateway
          // annotates each step's actual charged cost on
          // `providerMetadata.gateway.cost`, and the AI-SDK top-level metadata is
          // final-step-only, so sum across `steps`. `null` when no step carried a
          // gateway cost (non-gateway / BYOK-direct provider) → write NULL,
          // distinct from a recorded 0. Recorded on BOTH the token_usage row and
          // the `token` usage event so the cost basis is queryable per-turn and
          // summable per-period. Captured-only here; the Structure B credit +
          // overage meter will draw against it once #4038/#4039 land.
          //
          // Computed in its own guard so a (total, never-throwing) helper change
          // can't break stream finalization, matching the metering block's
          // "never disrupt finalization" contract below.
          let gatewayCostUsd: number | null = null;
          try {
            const costSummary = summarizeStepGatewayCostUsd(steps);
            gatewayCostUsd = costSummary.totalUsd;
            // A present-but-unparseable per-step cost is dropped from the total
            // (we never guess a number), so surface it loudly: this is the
            // gateway-contract-drift signal — the period cost is under-captured
            // until it's investigated. Should be 0 in normal operation.
            if (costSummary.skippedSteps > 0) {
              log.warn(
                {
                  skippedSteps: costSummary.skippedSteps,
                  recordedSteps: costSummary.recordedSteps,
                  totalSteps: steps.length,
                  model: resolvedModelId,
                  orgId: orgId ?? null,
                },
                "Gateway cost capture dropped unparseable provider cost annotation(s) — period at-cost is under-captured; check the gateway cost contract (#4036)",
              );
            }
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "Failed to compute gateway cost for the turn — recording NULL",
            );
          }
          try {
            internalExecute(
              `INSERT INTO token_usage (user_id, conversation_id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, model, provider, org_id, latency_ms, gateway_cost_usd)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
                // #3931 — agent-turn wall-clock (entry → onFinish), persisted
                // alongside the turn's usage so the demo tracking rollup reads
                // tokens + cache + latency from one row.
                Math.max(0, Date.now() - turnStartedAt),
                gatewayCostUsd,
              ],
            );
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to persist token usage");
          }

          // Log usage metering events for billing/overage tracking.
          // Wrapped in its own try/catch to ensure a metering failure
          // never disrupts the onFinish callback or stream finalization.
          try {
            const inputTokens = totalUsage.inputTokens ?? 0;
            const outputTokens = totalUsage.outputTokens ?? 0;
            const totalTokens = inputTokens + outputTokens;
            // Output-equivalent (model-weighted) tokens (#3989): normalize the
            // turn's raw tokens by the per-model weight so budget math can
            // denominate in output-equivalent tokens. Recorded alongside the raw
            // `quantity` on the same agent-step accounting event.
            const weightedTokens = toOutputEquivalentTokens(
              { inputTokens, outputTokens },
              resolvedModelId,
            );
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
                weightedQuantity: weightedTokens,
                // At-cost dollars for the turn (#4036) — the future Structure B
                // billing denominator (enforcement lands in #4038/#4039);
                // captured now. NULL when the provider isn't the gateway.
                gatewayCostUsd,
                metadata: { input: inputTokens, output: outputTokens, weighted: weightedTokens },
              });
            }
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to log usage metering events");
          }
        }
      },
    }));
  } catch (err) {
    // Synchronous setup failure before the stream began. Record a `failed`
    // terminal checkpoint (idempotent) before re-throwing. `currentTranscript()`
    // is just the input messages here (no step ran), matching pre-1b behavior.
    writeTerminal(AGENT_RUN_STATUS.FAILED, observedSteps, currentTranscript());
    endSpan(
      SpanStatusCode.ERROR,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  // #3747 — surface the turn's run id so the chat/resume route can set the
  // `x-run-id` reattach header. Attached as a non-enumerable-ish extra property
  // on the streamText result; existing callers ignore it.
  return Object.assign(result, { runId });
}
