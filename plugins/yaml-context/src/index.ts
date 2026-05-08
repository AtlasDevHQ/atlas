/**
 * YAML Semantic Layer Context Plugin — reference implementation for AtlasContextPlugin.
 *
 * Wraps the existing semantic layer directory (entities, glossary, metrics)
 * as a plugin that injects a structured overview into the agent system prompt.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@atlas/api/lib/config";
 * import { contextYamlPlugin } from "@useatlas/yaml-context";
 *
 * export default defineConfig({
 *   plugins: [
 *     contextYamlPlugin({ semanticDir: "./semantic" }),
 *   ],
 * });
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { definePlugin } from "@useatlas/plugin-sdk";
import type {
  AtlasContextPlugin,
  AtlasMcpTool,
  PluginHealthResult,
} from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ContextYamlConfig {
  /** Path to the semantic layer directory. Defaults to `./semantic`. */
  semanticDir?: string;
}

// ---------------------------------------------------------------------------
// Internal types for parsed YAML summaries
// ---------------------------------------------------------------------------

interface EntitySummary {
  readonly table: string;
  readonly description?: string;
  readonly dimensionCount: number;
}

interface GlossaryTerm {
  readonly term: string;
  readonly status?: "defined" | "ambiguous" | (string & {});
  readonly definition?: string;
}

interface MetricSummary {
  readonly name: string;
  readonly description?: string;
  readonly entity?: string;
}

// ---------------------------------------------------------------------------
// YAML readers
// ---------------------------------------------------------------------------

function resolveDir(config?: ContextYamlConfig): string {
  return path.resolve(config?.semanticDir ?? "./semantic");
}

export function readEntitySummaries(semanticDir: string, logger?: { warn(msg: string): void }): EntitySummary[] {
  const entitiesDir = path.join(semanticDir, "entities");

  let files: string[];
  try {
    files = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    (logger ?? console).warn(`[context-yaml] Failed to read entities dir: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const summaries: EntitySummary[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
      const doc = yaml.load(content) as Record<string, unknown> | undefined;
      if (!doc || typeof doc !== "object" || typeof doc.table !== "string") continue;

      summaries.push({
        table: doc.table,
        description:
          typeof doc.description === "string"
            ? doc.description.trim()
            : undefined,
        dimensionCount:
          doc.dimensions && typeof doc.dimensions === "object"
            ? Object.keys(doc.dimensions as object).length
            : 0,
      });
    } catch (err) {
      (logger ?? console).warn(`[context-yaml] Failed to parse entity file ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return summaries;
}

export function readGlossaryTerms(semanticDir: string, logger?: { warn(msg: string): void }): GlossaryTerm[] {
  const glossaryPath = path.join(semanticDir, "glossary.yml");

  try {
    const content = fs.readFileSync(glossaryPath, "utf-8");
    const doc = yaml.load(content) as Record<string, unknown> | undefined;
    if (!doc || !Array.isArray(doc.terms)) return [];

    return (doc.terms as Record<string, unknown>[])
      .filter((t) => typeof t.term === "string")
      .map((t) => ({
        term: t.term as string,
        status: typeof t.status === "string" ? (t.status as GlossaryTerm["status"]) : undefined,
        definition:
          typeof t.definition === "string" ? t.definition.trim() : undefined,
      }));
  } catch (err) {
    (logger ?? console).warn(`[context-yaml] Failed to read glossary ${glossaryPath}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function readMetricSummaries(semanticDir: string, logger?: { warn(msg: string): void }): MetricSummary[] {
  const metricsDir = path.join(semanticDir, "metrics");

  let files: string[];
  try {
    files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    (logger ?? console).warn(`[context-yaml] Failed to read metrics dir: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const summaries: MetricSummary[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(metricsDir, file), "utf-8");
      const doc = yaml.load(content) as Record<string, unknown> | undefined;
      if (!doc || typeof doc !== "object") continue;

      const entity =
        typeof doc.entity === "string" ? doc.entity : undefined;
      const metrics = Array.isArray(doc.metrics)
        ? (doc.metrics as Record<string, unknown>[])
        : [];

      for (const m of metrics) {
        if (typeof m.name === "string") {
          summaries.push({
            name: m.name,
            description:
              typeof m.description === "string"
                ? m.description.trim()
                : undefined,
            entity,
          });
        }
      }
    } catch (err) {
      (logger ?? console).warn(`[context-yaml] Failed to parse metric file ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Context string builder
// ---------------------------------------------------------------------------

export function buildContextString(
  entities: EntitySummary[],
  glossary: GlossaryTerm[],
  metrics: MetricSummary[],
): string {
  const sections: string[] = [];

  if (entities.length > 0) {
    const lines = entities.map((e) => {
      const desc = e.description
        ? ` — ${e.description.split("\n")[0]}`
        : "";
      return `- **${e.table}** (${e.dimensionCount} dimensions)${desc}`;
    });
    sections.push(`### Available Tables\n\n${lines.join("\n")}`);
  }

  if (glossary.length > 0) {
    const lines = glossary.map((t) => {
      const status = t.status === "ambiguous" ? " *(ambiguous)*" : "";
      const def = t.definition
        ? `: ${t.definition.split("\n")[0]}`
        : "";
      return `- **${t.term}**${status}${def}`;
    });
    sections.push(`### Glossary\n\n${lines.join("\n")}`);
  }

  if (metrics.length > 0) {
    const lines = metrics.map((m) => {
      const entity = m.entity ? ` (${m.entity})` : "";
      const desc = m.description
        ? ` — ${m.description.split("\n")[0]}`
        : "";
      return `- **${m.name}**${entity}${desc}`;
    });
    sections.push(`### Metrics\n\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";

  return `## Semantic Layer Context\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// MCP tool — reference implementation of AtlasPlugin.mcpTools (#2078)
// ---------------------------------------------------------------------------

/**
 * Reference description for `getYamlContextStats`. Follows the same
 * rubric as Atlas's native tools (80–150 words, `Use this when …`,
 * `Don't use this …`, inline JSON example) so contributors copying this
 * shape into their own plugins start out CI-compliant.
 *
 * The wording deliberately mirrors `EXPLORE_TOOL_DESCRIPTION` in tone —
 * concrete numbers in the response, an explicit anti-routing anchor for
 * the cases where another tool is better, and a JSON example showing
 * the call shape.
 */
export const GET_YAML_CONTEXT_STATS_DESCRIPTION = `Return summary counts for the semantic layer the \`context-yaml\` plugin loaded at boot — the number of entity YAML files parsed, the number of glossary terms resolved, the number of canonical metrics enumerated, and the absolute on-disk path of the directory. The plugin caches its parsed view of \`semantic/\` after the first context-build, so this call is O(1) once the cache is warm. Example call: \`{ "filter": "orders" }\`. Example response: \`{ "entities": 12, "glossary": 38, "metrics": 5, "semanticDir": "/app/semantic" }\`.

Use this when an MCP client wants a one-line "did Atlas pick up my YAML?" sanity check before routing to \`listEntities\` / \`describeEntity\`, or when a chat surface wants to advertise the workspace's catalog size in a status line.

Don't use this for entity discovery — call \`listEntities\` instead. Avoid using \`getYamlContextStats\` to detect schema drift; the counts cache through cache invalidation only.`;

const yamlContextStatsInputSchema = z.object({
  /**
   * Optional case-insensitive substring filter for entities. Mirrors the
   * `filter` param on `listEntities` so a downstream agent can chain a
   * scoped count + a scoped enumerate without re-coding the predicate.
   */
  filter: z
    .string()
    .max(256)
    .optional()
    .describe(
      "Optional case-insensitive substring filter; entities whose table name does not include the substring are excluded from the count.",
    ),
});

const yamlContextStatsOutputSchema = z.object({
  entities: z.number().int().nonnegative(),
  glossary: z.number().int().nonnegative(),
  metrics: z.number().int().nonnegative(),
  semanticDir: z.string(),
  filter: z.string().optional(),
});

/**
 * Build the plugin's `getYamlContextStats` MCP tool. Pure factory —
 * the closure-captured `semanticDir` keeps the tool transparent to the
 * surrounding plugin lifecycle (`refresh()` clearing `cachedContext`
 * has no effect on the counts because `listEntities` etc. parse the
 * underlying YAML files fresh each call — the host already caches the
 * parsed semantic layer at the engine level).
 */
function buildYamlContextStatsTool(semanticDir: string): AtlasMcpTool<
  z.infer<typeof yamlContextStatsInputSchema>,
  z.infer<typeof yamlContextStatsOutputSchema>
> {
  return {
    name: "getYamlContextStats",
    description: GET_YAML_CONTEXT_STATS_DESCRIPTION,
    errorCodes: ["validation_failed", "internal_error"],
    inputSchema: yamlContextStatsInputSchema,
    outputSchema: yamlContextStatsOutputSchema,
    async handler({ filter }, ctx) {
      const start = performance.now();
      let entities = readEntitySummaries(semanticDir);
      if (filter) {
        const needle = filter.toLowerCase();
        entities = entities.filter((e) => e.table.toLowerCase().includes(needle));
      }
      const glossary = readGlossaryTerms(semanticDir);
      const metrics = readMetricSummaries(semanticDir);
      const durationMs = Math.round(performance.now() - start);

      ctx.audit({
        event: "context_yaml.stats",
        success: true,
        durationMs,
        metadata: {
          entities: entities.length,
          glossary: glossary.length,
          metrics: metrics.length,
          ...(filter !== undefined && { filter }),
        },
      });

      return {
        entities: entities.length,
        glossary: glossary.length,
        metrics: metrics.length,
        semanticDir,
        ...(filter !== undefined && { filter }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin builder
// ---------------------------------------------------------------------------

/**
 * Build the context-yaml plugin object from config.
 *
 * Lower-level builder exposed for testing. Calls `definePlugin()` internally.
 */
export function buildContextYamlPlugin(
  config: ContextYamlConfig = {},
): AtlasContextPlugin<ContextYamlConfig> {
  const semanticDir = resolveDir(config);
  let cachedContext: string | null = null;
  let log: { warn(msg: string): void } | undefined;

  return definePlugin({
    id: "context-yaml",
    types: ["context"] as const,
    version: "0.1.0",
    name: "YAML Semantic Layer Context",
    config,

    mcpTools() {
      return [buildYamlContextStatsTool(semanticDir)];
    },

    contextProvider: {
      async load(): Promise<string> {
        if (cachedContext !== null) return cachedContext;

        const entities = readEntitySummaries(semanticDir, log);
        const glossary = readGlossaryTerms(semanticDir, log);
        const metrics = readMetricSummaries(semanticDir, log);

        if (entities.length === 0 && glossary.length === 0 && metrics.length === 0) {
          (log ?? console).warn(`[context-yaml] Semantic directory ${semanticDir} returned no entities, glossary terms, or metrics`);
        }

        cachedContext = buildContextString(entities, glossary, metrics);
        return cachedContext;
      },

      async refresh(): Promise<void> {
        cachedContext = null;
      },
    },

    async initialize(ctx) {
      log = ctx.logger;
      ctx.logger.info(
        `Context-YAML plugin initialized (dir: ${semanticDir})`,
      );

      if (this.healthCheck) {
        const health = await this.healthCheck();
        if (!health.healthy) {
          ctx.logger.warn(`[context-yaml] Health check warning: ${health.message}`);
        }
      }
    },

    async healthCheck(): Promise<PluginHealthResult> {
      const start = performance.now();
      const entitiesDir = path.join(semanticDir, "entities");

      if (!fs.existsSync(semanticDir)) {
        return {
          healthy: false,
          message: `Semantic directory not found: ${semanticDir}`,
          latencyMs: Math.round(performance.now() - start),
        };
      }

      if (!fs.existsSync(entitiesDir)) {
        return {
          healthy: false,
          message: `Entities directory not found: ${entitiesDir}`,
          latencyMs: Math.round(performance.now() - start),
        };
      }

      try {
        const files = fs
          .readdirSync(entitiesDir)
          .filter((f) => f.endsWith(".yml"));
        const latencyMs = Math.round(performance.now() - start);
        if (files.length === 0) {
          return {
            healthy: false,
            message: "No entity YAML files found in entities directory",
            latencyMs,
          };
        }
        return { healthy: true, message: `${files.length} entity file(s) found`, latencyMs };
      } catch (err) {
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Math.round(performance.now() - start),
        };
      }
    },
  } satisfies AtlasContextPlugin<ContextYamlConfig>);
}

/**
 * Factory function for use in `atlas.config.ts` plugins array.
 *
 * @example
 * ```typescript
 * plugins: [contextYamlPlugin({ semanticDir: "./semantic" })]
 * ```
 */
export function contextYamlPlugin(
  config: ContextYamlConfig = {},
): AtlasContextPlugin<ContextYamlConfig> {
  return buildContextYamlPlugin(config);
}
