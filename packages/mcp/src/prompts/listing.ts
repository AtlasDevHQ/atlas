/**
 * Shared listing pipeline for MCP prompts (#2179).
 *
 * Two consumers must produce identical visible-prompt sets for a given
 * workspace: the MCP server's `prompts/list` request handler in
 * `registry.ts`, and the workspace-facing HTTP endpoint
 * `/api/v1/me/mcp-prompts` that powers the Settings → AI Agents
 * preview block. Putting the source-merging + gate-evaluation here
 * — rather than in `registry.ts` — means a regression in either one
 * surface is observable from the other surface's tests, and the
 * canonical-gate semantics live in one place.
 *
 * Source ordering (built-in → canonical → semantic → library) matters
 * because both surfaces render top-down: the SDK list is order-preserving
 * and the workspace preview groups by source, but a future change that
 * re-ordered would silently shift agent prompt-picker behavior.
 *
 * The canonical gate is evaluated per call so flipping the admin toggle
 * takes effect on the next list — same per-request semantics the registry
 * documents in its header.
 */

import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import { scanEntities } from "@atlas/api/lib/semantic/scanner";
import {
  hasInternalDB,
  internalQuery,
} from "@atlas/api/lib/db/internal";
import {
  loadCanonicalPrompts,
  type CanonicalPrompt,
} from "./canonical.js";
import {
  evaluateCanonicalGate,
  type CanonicalGateResult,
} from "./gating.js";
// Wire-shape types come from `@useatlas/schemas/mcp-prompts` so the
// listing pipeline, the route layer (`me-mcp-prompts.ts`), and the
// web client (`me-schemas.ts`) all derive from one Zod source. See
// the schemas module header for the dependency-direction rationale.
import type {
  PromptSource,
  PromptArgumentSpec,
  PromptListEntry,
} from "@useatlas/schemas/mcp-prompts";

export type { PromptSource, PromptArgumentSpec, PromptListEntry };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromptListing {
  readonly prompts: ReadonlyArray<PromptListEntry>;
  readonly canonicalGate: CanonicalGateResult;
}

export interface ListMcpPromptsOptions {
  /** Active workspace id. Drives canonical gating + future per-workspace sources. */
  readonly workspaceId?: string;
}

// ---------------------------------------------------------------------------
// Source loaders
// ---------------------------------------------------------------------------

export interface BuiltinTemplate {
  readonly name: string;
  readonly description: string;
  readonly template: string;
  readonly args: Record<string, string>;
}

/**
 * Built-in templates — the always-on baseline. The `template` field is
 * the substitution string used by the SDK `prompts/get` resolver in
 * `registry.ts`; the listing surface only reads `name` / `description`
 * / `args`. Single source of truth so a description edit can't drift
 * between the listing UI and the resolver.
 */
export const BUILTIN_TEMPLATES: ReadonlyArray<BuiltinTemplate> = [
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
      dimension: "The dimension to group by (e.g., 'region', 'plan type')",
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
] as const;

interface SemanticQueryPattern {
  name?: string;
  description?: string;
  sql?: string;
}

export interface SemanticPrompt {
  readonly name: string;
  readonly description: string;
  readonly text: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Semantic query patterns — read from the process-wide
 * `ATLAS_SEMANTIC_ROOT` (single semantic layer per API process today;
 * per-workspace isolation is a future change). Failures to scan / read
 * the semantic root degrade to "no semantic prompts" rather than
 * failing the listing.
 */
export function loadSemanticPrompts(): SemanticPrompt[] {
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

      prompts.push({
        name: promptName,
        description: `[${table}] ${description}`,
        text,
      });
    }
  }

  return prompts;
}

export interface LibraryPrompt {
  readonly name: string;
  readonly description: string;
  readonly question: string;
}

/**
 * Library prompts — admin-curated rows from the internal DB. Optional;
 * skipped when no internal DB is configured (stdio without DATABASE_URL).
 */
export async function loadLibraryPrompts(): Promise<LibraryPrompt[]> {
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
// Public API
// ---------------------------------------------------------------------------

function builtinEntry(tmpl: BuiltinTemplate): PromptListEntry {
  return {
    name: tmpl.name,
    description: tmpl.description,
    source: "builtin",
    arguments: Object.entries(tmpl.args).map(([name, description]) => ({
      name,
      description,
      required: true,
    })),
  };
}

function canonicalEntry(cp: CanonicalPrompt): PromptListEntry {
  return {
    name: cp.name,
    description: cp.description,
    source: "canonical",
    arguments: [],
  };
}

function semanticEntry(sp: SemanticPrompt): PromptListEntry {
  return {
    name: sp.name,
    description: sp.description,
    source: "semantic",
    arguments: [],
  };
}

function libraryEntry(lp: LibraryPrompt): PromptListEntry {
  return {
    name: lp.name,
    description: lp.description,
    source: "library",
    arguments: [],
  };
}

/**
 * Compute the canonical workspace prompt listing — built-ins always,
 * canonicals iff the gate is open, then semantic + library. Returns
 * the gate envelope so the workspace UI can explain a closed gate.
 */
export async function listMcpPrompts(
  opts: ListMcpPromptsOptions,
): Promise<PromptListing> {
  const canonicalGate = await evaluateCanonicalGate({
    workspaceId: opts.workspaceId,
  });

  const prompts: PromptListEntry[] = [];

  for (const tmpl of BUILTIN_TEMPLATES) {
    prompts.push(builtinEntry(tmpl));
  }

  if (canonicalGate.exposed) {
    for (const cp of loadCanonicalPrompts()) {
      prompts.push(canonicalEntry(cp));
    }
  }

  for (const sp of loadSemanticPrompts()) {
    prompts.push(semanticEntry(sp));
  }

  for (const lp of await loadLibraryPrompts()) {
    prompts.push(libraryEntry(lp));
  }

  return { prompts, canonicalGate };
}
