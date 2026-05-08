/**
 * MCP prompt templates — exposes curated query patterns via the MCP
 * `prompts/list` and `prompts/get` protocol.
 *
 * Four sources, in registration order (matters because the SDK's
 * `prompts/list` is order-preserving and prompt pickers in agent
 * clients render top-down):
 *
 *   1. Built-in templates    — generic analytical patterns
 *                              (revenue, top-N, compare, breakdown,
 *                              anomaly-detection). Always present.
 *   2. Canonical eval prompts — the 20 NovaMart questions from #2025
 *                              (#2076). Workspace-gated — see
 *                              `gating.ts` — and the gate is re-evaluated
 *                              per request so flipping the admin toggle
 *                              propagates within the settings cache TTL
 *                              (5s) without a process restart.
 *   3. Semantic-layer query patterns — `query_patterns` field from
 *                              entity YAML files. Per-workspace by
 *                              construction (semantic root scoped to
 *                              the workspace).
 *   4. Prompt library         — admin-curated rows from the internal
 *                              DB's `prompt_items` table. Optional
 *                              (skipped when no internal DB).
 *
 * Every dispatch (`list` and `get`) emits:
 *   - An OTel counter increment on `atlas.mcp.prompts.calls` so
 *     operators can see which prompts agents actually pull.
 *   - An `audit_log` row (when an internal DB is available) so
 *     compliance can scope agent activity by prompt name.
 *
 * Failures in instrumentation never mask the underlying response.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListPromptsRequestSchema,
  type GetPromptResult,
  type Prompt,
  type PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import { scanEntities } from "@atlas/api/lib/semantic/scanner";
import {
  hasInternalDB,
  internalQuery,
  internalExecute,
} from "@atlas/api/lib/db/internal";
import { mcpPromptCalls } from "@atlas/api/lib/metrics";
import {
  loadCanonicalPrompts,
  type CanonicalPrompt,
} from "./canonical.js";
import {
  shouldExposeCanonicalPrompts,
} from "./gating.js";

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
// Source-tagged descriptor — single shape used by registration + listing.
// ---------------------------------------------------------------------------

export type PromptSource = "builtin" | "semantic" | "library" | "canonical";

interface PromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly source: PromptSource;
  /**
   * Argument metadata used to build the `arguments` field on the
   * `prompts/list` response. Kept alongside the registered prompt so we
   * don't need to introspect the SDK's internal Zod schema in the list
   * override.
   */
  readonly args: ReadonlyArray<{ name: string; description: string }>;
  readonly resolve: (
    args: Record<string, string>,
  ) => GetPromptResult | Promise<GetPromptResult>;
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
// Semantic-layer query patterns
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
// Audit + OTel
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "sse";
export type McpDeployMode = "self-hosted" | "saas";

interface InstrumentationContext {
  readonly workspaceId: string | undefined;
  readonly clientId: string | undefined;
  readonly transport: McpTransport;
  readonly deployMode: McpDeployMode;
}

/**
 * Increment the prompts dispatch counter. Defensive try/catch so an OTel
 * SDK fault never bubbles into a `prompts/list` failure.
 */
function recordPromptCounter(
  method: "list" | "get",
  name: string,
  source: PromptSource | "(mixed)",
  ctx: InstrumentationContext,
): void {
  try {
    mcpPromptCalls.add(1, {
      method,
      prompt: name,
      source,
      transport: ctx.transport,
      "deploy.mode": ctx.deployMode,
    });
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] prompt counter failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Write an `audit_log` row for a prompts surface call. Fire-and-forget —
 * the inner `internalExecute` already swallows async rejections; we
 * additionally guard against synchronous throws (no internal DB pool,
 * etc.) so the prompts response never hinges on audit success.
 *
 * `sql` is NOT NULL on `audit_log`, so we pack the method + name into
 * a `mcp:` prefixed pseudo-statement. Forensic queries scoped to
 * `actor_kind = 'mcp'` and `tool_name LIKE 'prompts.%'` filter cleanly
 * even if the column-name alignment looks odd at a glance.
 */
function writePromptAudit(
  method: "list" | "get",
  name: string | null,
  source: PromptSource | "(mixed)",
  durationMs: number,
  rowCount: number | null,
  success: boolean,
  ctx: InstrumentationContext,
): void {
  if (!hasInternalDB()) return;
  try {
    const syntheticSql =
      method === "list"
        ? `mcp:prompts.list (source=${source})`
        : `mcp:prompts.get name=${name ?? "?"} (source=${source})`;
    internalExecute(
      `INSERT INTO audit_log (sql, duration_ms, row_count, success, org_id, actor_kind, client_id, tool_name, auth_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        syntheticSql,
        Math.max(0, Math.round(durationMs)),
        rowCount,
        success,
        ctx.workspaceId ?? null,
        "mcp",
        ctx.clientId ?? null,
        `prompts.${method}`,
        "mcp",
      ],
    );
  } catch (err) {
    process.stderr.write(
      `[atlas-mcp] prompt audit insert failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RegisterPromptsOptions {
  /** Active workspace id (`actor.activeOrganizationId`). Drives canonical gating. */
  readonly workspaceId?: string;
  /** Hosted-MCP OAuth client_id, threaded into `audit_log.client_id`. */
  readonly clientId?: string;
  /** Carrier transport for OTel attribution. Defaults to `stdio`. */
  readonly transport?: McpTransport;
  /** Resolved deploy mode, read once at registration time. Defaults to `self-hosted`. */
  readonly deployMode?: McpDeployMode;
}

/**
 * Convert a `CanonicalPrompt` into the resolver shape — captured here
 * (not in `canonical.ts`) so the canonical loader stays free of the
 * MCP SDK types and can be tested as a pure function.
 */
function canonicalDescriptor(
  cp: CanonicalPrompt,
  ctx: InstrumentationContext,
): PromptDescriptor {
  return {
    name: cp.name,
    description: cp.description,
    source: "canonical",
    args: [],
    resolve: async (): Promise<GetPromptResult> => {
      const allowed = await shouldExposeCanonicalPrompts({
        workspaceId: ctx.workspaceId,
      });
      if (!allowed) {
        // Mirror the SDK's "prompt not found" semantics for a gated
        // prompt. Returning the prompt anyway would make the toggle a
        // visibility-only setting; in real-data workspaces we want a
        // hard "no" so an agent that cached a stale list doesn't get
        // an answer it shouldn't see.
        throw new Error(`Prompt ${cp.name} not found`);
      }
      return promptResult(cp.question, cp.description);
    },
  };
}

export async function registerPrompts(
  server: McpServer,
  opts: RegisterPromptsOptions = {},
): Promise<void> {
  const ctx: InstrumentationContext = {
    workspaceId: opts.workspaceId,
    clientId: opts.clientId,
    transport: opts.transport ?? "stdio",
    deployMode: opts.deployMode ?? "self-hosted",
  };

  const descriptors: PromptDescriptor[] = [];

  // 1. Built-in templates (always present)
  for (const tmpl of BUILTIN_TEMPLATES) {
    descriptors.push({
      name: tmpl.name,
      description: tmpl.description,
      source: "builtin",
      args: Object.entries(tmpl.args).map(([name, description]) => ({
        name,
        description,
      })),
      resolve: (args) =>
        promptResult(substituteArgs(tmpl.template, args), tmpl.description),
    });
  }

  // 2. Canonical eval prompts (gated per-request — see canonicalDescriptor)
  for (const cp of loadCanonicalPrompts()) {
    descriptors.push(canonicalDescriptor(cp, ctx));
  }

  // 3. Semantic layer query patterns
  for (const sp of loadSemanticPrompts()) {
    descriptors.push({
      name: sp.name,
      description: sp.description,
      source: "semantic",
      args: [],
      resolve: () => promptResult(sp.text, sp.description),
    });
  }

  // 4. Prompt library
  for (const lp of await loadLibraryPrompts()) {
    descriptors.push({
      name: lp.name,
      description: lp.description,
      source: "library",
      args: [],
      resolve: () => promptResult(lp.question, lp.description),
    });
  }

  // Register every descriptor with the SDK so `prompts/get` routes to
  // our resolver. We wrap the resolver to attach OTel + audit on every
  // dispatch — instrumentation never masks the underlying result.
  const descriptorByName = new Map<string, PromptDescriptor>();
  for (const d of descriptors) {
    descriptorByName.set(d.name, d);

    const argsSchema: Record<string, z.ZodString> = {};
    for (const arg of d.args) {
      argsSchema[arg.name] = z.string().describe(arg.description);
    }

    server.registerPrompt(
      d.name,
      Object.keys(argsSchema).length > 0
        ? { description: d.description, argsSchema }
        : { description: d.description },
      async (args: Record<string, string> = {}) => {
        const start = performance.now();
        let success = true;
        try {
          const result = await d.resolve(args);
          return result;
        } catch (err) {
          success = false;
          throw err;
        } finally {
          recordPromptCounter("get", d.name, d.source, ctx);
          writePromptAudit(
            "get",
            d.name,
            d.source,
            performance.now() - start,
            null,
            success,
            ctx,
          );
        }
      },
    );
  }

  // Override the SDK's default `prompts/list` handler so we can
  //   (a) hide canonical prompts when the gate is closed (per request,
  //       so the toggle propagates within the settings cache TTL), and
  //   (b) emit an audit row + counter increment for every list call.
  // We re-implement the listing from our local descriptors rather than
  // reading the SDK's internal `_registeredPrompts` — that's stable
  // public-shape behavior and keeps the override resilient against SDK
  // refactors.
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const start = performance.now();
    const allowCanonical = await shouldExposeCanonicalPrompts({
      workspaceId: ctx.workspaceId,
    });
    const visible = descriptors.filter(
      (d) => d.source !== "canonical" || allowCanonical,
    );

    const prompts: Prompt[] = visible.map((d) => {
      const out: Prompt = { name: d.name };
      if (d.description !== undefined) out.description = d.description;
      if (d.args.length > 0) {
        out.arguments = d.args.map<PromptArgument>((a) => ({
          name: a.name,
          description: a.description,
          required: true,
        }));
      }
      return out;
    });

    recordPromptCounter("list", "(none)", "(mixed)", ctx);
    writePromptAudit(
      "list",
      null,
      "(mixed)",
      performance.now() - start,
      prompts.length,
      true,
      ctx,
    );

    return { prompts };
  });

  // Test/debug seam — surface our local registry for assertions without
  // reaching into SDK internals.
  (server as unknown as {
    _atlasPromptDescriptors?: ReadonlyMap<string, PromptDescriptor>;
  })._atlasPromptDescriptors = descriptorByName;
}
