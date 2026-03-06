/**
 * The Atlas agent.
 *
 * Runs a single-agent loop driven by a ToolRegistry (default: explore,
 * executeSQL). The loop runs until the step limit (25) is reached or
 * the model stops issuing tool calls.
 */

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type ModelMessage,
  type SystemModelMessage,
  type UIMessage,
} from "ai";
import { getModel, getProviderType, type ProviderType } from "./providers";
import { defaultRegistry, type ToolRegistry } from "./tools/registry";
import { getContextFragments, getDialectHints } from "./plugins/tools";
import { connections, detectDBType, type ConnectionMetadata, type DBType } from "./db/connection";
import { getCrossSourceJoins, type CrossSourceJoin } from "./semantic";
import { getSemanticIndex } from "./semantic-index";
import { createLogger } from "./logger";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const log = createLogger("agent");
const tracer = trace.getTracer("atlas");

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
When a SQL query fails, read the error carefully before retrying:
- **Column not found** — The error often suggests the correct name (e.g., "column 'revnue' does not exist — did you mean 'revenue'?"). Go back to the entity schema to verify the exact column name.
- **Table not found** — Re-read catalog.yml to find the correct table name. The table may use a different name than you expected.
- **Syntax error** — Check the error position hint. Common issues: missing commas, unmatched parentheses, incorrect JOIN syntax.
- **Type mismatch** — You may need to CAST a column (e.g., CAST(value AS numeric)). Check the column type in the entity schema.
- **Timeout** — Simplify the query: remove unnecessary JOINs, add WHERE filters to reduce the dataset, or break into smaller queries.
- Never retry the exact same SQL. Always fix the identified issue first.
- Max 2 retries per question — if the query still fails, explain the issue to the user.`;

const MYSQL_DIALECT_GUIDE = `

## SQL Dialect: MySQL
This database uses MySQL. Key differences from PostgreSQL:
- Use \`YEAR(col)\` and \`MONTH(col)\` (preferred) or \`EXTRACT(YEAR FROM col)\` — both work
- Use \`DATE_FORMAT(col, '%Y-%m')\` instead of \`TO_CHAR(col, 'YYYY-MM')\`
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

function buildSystemPrompt(registry: ToolRegistry): string {
  let base = SYSTEM_PROMPT_PREFIX + "\n\n" + registry.describe() + "\n\n" + SYSTEM_PROMPT_SUFFIX;

  // Append the pre-indexed semantic layer summary
  const semanticIndex = getSemanticIndex();
  if (semanticIndex) {
    base += "\n\n" + semanticIndex;
  }

  // Append plugin context fragments (if any)
  const fragments = getContextFragments();
  if (fragments.length > 0) {
    base += "\n\n" + fragments.join("\n\n");
  }
  const meta = connections.describe();

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
 * - OpenAI / Ollama / Gateway: returns a plain string (OpenAI caches
 *   automatically for prompts >= 1024 tokens; others have no caching).
 */
export function buildSystemParam(
  providerType: ProviderType,
  registry: ToolRegistry = defaultRegistry,
): string | SystemModelMessage {
  const content = buildSystemPrompt(registry);

  switch (providerType) {
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
    case "gateway":
      return content;
    default: {
      const _exhaustive: never = providerType;
      throw new Error(`Unknown provider type: ${_exhaustive}`);
    }
  }
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
 * - OpenAI / Ollama / Gateway: no-op (OpenAI caches automatically)
 */
export function applyCacheControl(
  messages: ModelMessage[],
  providerType: ProviderType,
): ModelMessage[] {
  if (messages.length === 0) return messages;

  // Only Anthropic-family and Bedrock need explicit cache markers
  const lastIndex = messages.length - 1;

  switch (providerType) {
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
    case "gateway":
      return messages;
    default: {
      const _exhaustive: never = providerType;
      throw new Error(`Unknown provider type: ${_exhaustive}`);
    }
  }
}

/**
 * Run the Atlas agent loop.
 *
 * @param messages - The conversation history from the chat UI.
 * @param tools - Optional custom {@link ToolRegistry}. Defaults to
 *   {@link defaultRegistry} (explore + executeSQL). The loop terminates
 *   when the step limit (25) is reached or the model stops issuing tool calls.
 */
export async function runAgent({
  messages,
  tools: toolRegistry = defaultRegistry,
}: {
  messages: UIMessage[];
  tools?: ToolRegistry;
}) {
  const model = getModel();
  const providerType = getProviderType();

  const span = tracer.startSpan("atlas.agent", {
    attributes: { provider: providerType, messageCount: messages.length },
  });

  let spanEnded = false;
  function endSpan(code: SpanStatusCode, message?: string) {
    if (spanEnded) return;
    spanEnded = true;
    span.setStatus({ code, ...(message && { message }) });
    span.end();
  }

  let result;
  try {
    result = streamText({
      model,
      system: buildSystemParam(providerType, toolRegistry),
      messages: await convertToModelMessages(messages),
      tools: toolRegistry.getAll(),
      temperature: 0.2,
      maxOutputTokens: 4096,
      stopWhen: stepCountIs(25),
      // totalMs: 180s for self-hosted (full agent loop budget).
      // On Vercel, maxDuration caps the serverless function at 60s.
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
          messages: applyCacheControl(stepMessages, providerType),
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
          finishReason: finishReason ?? "",
          totalSteps: steps.length,
          totalInputTokens: totalUsage?.inputTokens ?? 0,
          totalOutputTokens: totalUsage?.outputTokens ?? 0,
        });
        endSpan(SpanStatusCode.OK);
      },
    });
  } catch (err) {
    endSpan(
      SpanStatusCode.ERROR,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  return result;
}
