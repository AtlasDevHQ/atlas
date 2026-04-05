/**
 * MCP prompt templates — exposes curated query patterns via the MCP
 * prompts/list and prompts/get protocol.
 *
 * Three sources:
 * 1. Built-in templates — common analytical patterns (revenue, top-N, compare)
 * 2. Semantic layer — query_patterns extracted from entity YAML files
 * 3. Prompt library — items from the internal DB prompt_items table (optional)
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import { scanEntities } from "@atlas/api/lib/semantic/scanner";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptResult(text: string, description?: string): GetPromptResult {
  return {
    description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function substituteArgs(
  template: string,
  args: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => args[key] ?? match);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

interface BuiltinTemplate {
  name: string;
  description: string;
  template: string;
  args: Record<string, string>;
}

const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: "revenue-trend",
    description: "Show revenue trends over a time period",
    template:
      "Show me revenue trends for the last {period}. Break down by month and highlight any significant changes.",
    args: {
      period:
        "Time period to analyze (e.g., '6 months', 'year', 'quarter')",
    },
  },
  {
    name: "top-by-metric",
    description: "Find the top N items ranked by a metric",
    template: "What are the top {count} {entity} by {metric}?",
    args: {
      count: "Number of results to return (e.g., '10', '25')",
      entity: "The entity to rank (e.g., 'customers', 'products')",
      metric: "The metric to rank by (e.g., 'revenue', 'order count')",
    },
  },
  {
    name: "compare-periods",
    description: "Compare a metric between two time periods",
    template:
      "Compare {metric} between {period1} and {period2}. Show the absolute and percentage change.",
    args: {
      metric: "The metric to compare (e.g., 'revenue', 'active users')",
      period1: "First time period (e.g., 'January 2024', 'Q1 2024')",
      period2: "Second time period (e.g., 'February 2024', 'Q2 2024')",
    },
  },
  {
    name: "breakdown",
    description: "Break down a metric by a dimension",
    template:
      "Break down {metric} by {dimension}. Show totals and percentages for each group.",
    args: {
      metric: "The metric to analyze (e.g., 'revenue', 'signups')",
      dimension:
        "The dimension to group by (e.g., 'region', 'plan type')",
    },
  },
  {
    name: "anomaly-detection",
    description: "Find anomalies in a metric over a time period",
    template:
      "Find any anomalies or unusual patterns in {metric} over the last {period}. Flag values that deviate significantly from the trend.",
    args: {
      metric:
        "The metric to check for anomalies (e.g., 'daily revenue', 'error rate')",
      period: "Time period to scan (e.g., '30 days', '3 months')",
    },
  },
];

// ---------------------------------------------------------------------------
// Semantic layer query patterns
// ---------------------------------------------------------------------------

interface SemanticQueryPattern {
  name?: string;
  description?: string;
  sql?: string;
}

interface SemanticPrompt {
  name: string;
  description: string;
  text: string;
}

function loadSemanticPrompts(): SemanticPrompt[] {
  const prompts: SemanticPrompt[] = [];

  let root: string;
  try {
    root = getSemanticRoot();
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] Semantic root not available, skipping semantic prompts: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return prompts;
  }

  let entities: ReturnType<typeof scanEntities>["entities"];
  try {
    ({ entities } = scanEntities(root));
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] Failed to scan entities for prompts: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return prompts;
  }

  for (const { raw } of entities) {
    const table = raw.table as string | undefined;
    if (!table) continue;

    const patterns = raw.query_patterns;
    if (!Array.isArray(patterns)) continue;

    for (const raw_pattern of patterns) {
      const p = raw_pattern as SemanticQueryPattern;
      if (!p.name && !p.description) continue;

      const patternSlug = slugify(p.name ?? p.description ?? "");
      if (!patternSlug) continue;

      const promptName = `entity-${slugify(table)}-${patternSlug}`;
      const description = p.description ?? p.name ?? "";
      const text = p.sql
        ? `Using the ${table} table: ${description}\n\nReference SQL pattern:\n${p.sql}`
        : `Using the ${table} table: ${description}`;

      prompts.push({ name: promptName, description: `[${table}] ${description}`, text });
    }
  }

  return prompts;
}

// ---------------------------------------------------------------------------
// Prompt library (DB-backed, optional)
// ---------------------------------------------------------------------------

interface LibraryPrompt {
  name: string;
  description: string;
  question: string;
}

async function loadLibraryPrompts(): Promise<LibraryPrompt[]> {
  if (!hasInternalDB()) return [];

  try {
    const rows = await internalQuery<{
      id: string;
      question: string;
      description: string | null;
      collection_name: string;
    }>(
      `SELECT pi.id, pi.question, pi.description, pc.name AS collection_name
       FROM prompt_items pi
       JOIN prompt_collections pc ON pc.id = pi.collection_id
       WHERE pc.is_builtin = true
       ORDER BY pc.sort_order ASC, pi.sort_order ASC`,
    );

    return rows.map((row) => ({
      name: `library-${row.id}`,
      description: `[${row.collection_name}] ${row.description ?? row.question}`,
      question: row.question,
    }));
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] Failed to load prompt library: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerPrompts(server: McpServer): Promise<void> {
  // 1. Built-in templates (always present)
  for (const tmpl of BUILTIN_TEMPLATES) {
    const argsSchema: Record<string, z.ZodString> = {};
    for (const [key, desc] of Object.entries(tmpl.args)) {
      argsSchema[key] = z.string().describe(desc);
    }

    server.registerPrompt(
      tmpl.name,
      { description: tmpl.description, argsSchema },
      (args: Record<string, string>) =>
        promptResult(
          substituteArgs(tmpl.template, args),
          tmpl.description,
        ),
    );
  }

  // 2. Semantic layer query patterns (from entity YAML files)
  const semanticPrompts = loadSemanticPrompts();
  for (const sp of semanticPrompts) {
    server.registerPrompt(
      sp.name,
      { description: sp.description },
      () => promptResult(sp.text, sp.description),
    );
  }

  // 3. Prompt library (DB-backed, optional — skipped if no internal DB)
  const libraryPrompts = await loadLibraryPrompts();
  for (const lp of libraryPrompts) {
    server.registerPrompt(
      lp.name,
      { description: lp.description },
      () => promptResult(lp.question, lp.description),
    );
  }
}
