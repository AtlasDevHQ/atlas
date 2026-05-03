/**
 * Typed semantic-layer MCP tools (#2020).
 *
 * Exposes four tools that wrap the semantic layer's existing read paths so
 * MCP clients can discover and use it without grepping YAML through the
 * `explore` shell:
 *
 * - `listEntities`    — catalog discovery
 * - `describeEntity`  — full entity schema
 * - `searchGlossary`  — business term lookup, surfaces `status: ambiguous`
 * - `runMetric`       — execute a canonical metric through the same SQL
 *                       pipeline as `executeSQL` (4-layer validation, RLS
 *                       injection, auto-LIMIT, statement timeout)
 *
 * Actor binding mirrors `tools.ts`: every dispatch is wrapped in
 * `withRequestContext({ user: actor, requestId })` so any downstream
 * approval/RLS gate sees a bound caller (#1858 — see tools.ts header).
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import {
  listEntities,
  getEntityByName,
  searchGlossary,
  findMetricById,
} from "@atlas/api/lib/semantic/lookups";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import {
  LIST_ENTITIES_TOOL_DESCRIPTION,
  DESCRIBE_ENTITY_TOOL_DESCRIPTION,
  SEARCH_GLOSSARY_TOOL_DESCRIPTION,
  RUN_METRIC_TOOL_DESCRIPTION,
} from "@atlas/api/lib/tools/descriptions";

export interface RegisterSemanticToolsOptions {
  /** Actor bound on every tool dispatch — see tools.ts. */
  actor: AtlasUser;
}

function dispatchId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function toJsonContent(value: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function toErrorContent(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function registerSemanticTools(
  server: McpServer,
  opts: RegisterSemanticToolsOptions,
): void {
  const { actor } = opts;

  // --- listEntities ---
  server.registerTool(
    "listEntities",
    {
      title: "List Semantic Entities",
      description: LIST_ENTITIES_TOOL_DESCRIPTION,
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe(
            "Optional case-insensitive substring matched against name, table, and description.",
          ),
      },
    },
    async ({ filter }): Promise<CallToolResult> =>
      withRequestContext(
        { requestId: dispatchId("mcp-listEntities"), user: actor },
        async () => {
          try {
            const entities = listEntities({ filter });
            return toJsonContent({ count: entities.length, entities });
          } catch (err) {
            const message = errorMessage(err, "listEntities tool failed");
            process.stderr.write(`[atlas-mcp] listEntities threw: ${err}\n`);
            return toErrorContent(message);
          }
        },
      ),
  );

  // --- describeEntity ---
  server.registerTool(
    "describeEntity",
    {
      title: "Describe Semantic Entity",
      description: DESCRIBE_ENTITY_TOOL_DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            "Entity name (`name` field) or table name. Must not contain path separators.",
          ),
      },
    },
    async ({ name }): Promise<CallToolResult> =>
      withRequestContext(
        { requestId: dispatchId("mcp-describeEntity"), user: actor },
        async () => {
          try {
            const entity = getEntityByName(name);
            if (!entity) {
              return toJsonContent({ found: false, name });
            }
            return toJsonContent({ found: true, entity });
          } catch (err) {
            const message = errorMessage(err, "describeEntity tool failed");
            process.stderr.write(`[atlas-mcp] describeEntity threw: ${err}\n`);
            return toErrorContent(message);
          }
        },
      ),
  );

  // --- searchGlossary ---
  server.registerTool(
    "searchGlossary",
    {
      title: "Search Business Glossary",
      description: SEARCH_GLOSSARY_TOOL_DESCRIPTION,
      inputSchema: {
        term: z
          .string()
          .min(1)
          .describe(
            "Term, phrase, or substring to search across glossary entries.",
          ),
      },
    },
    async ({ term }): Promise<CallToolResult> =>
      withRequestContext(
        { requestId: dispatchId("mcp-searchGlossary"), user: actor },
        async () => {
          try {
            const matches = searchGlossary(term);
            return toJsonContent({
              query: term,
              count: matches.length,
              matches,
            });
          } catch (err) {
            const message = errorMessage(err, "searchGlossary tool failed");
            process.stderr.write(`[atlas-mcp] searchGlossary threw: ${err}\n`);
            return toErrorContent(message);
          }
        },
      ),
  );

  // --- runMetric ---
  // The metric SQL is run through executeSQL.execute — same dispatch path
  // as the agent's executeSQL tool — so it inherits the four validation
  // layers, plugin hooks, RLS injection, auto-LIMIT, statement timeout,
  // and audit logging without re-implementing any of them.
  server.registerTool(
    "runMetric",
    {
      title: "Run Canonical Metric",
      description: RUN_METRIC_TOOL_DESCRIPTION,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Metric id from semantic/metrics/*.yml."),
        filters: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.null()]),
          )
          .optional()
          .describe(
            "Reserved for future filter pass-through. Empty/omitted today; passing a non-empty object returns an error.",
          ),
        connectionId: z
          .string()
          .optional()
          .describe(
            "Target connection id. Omit to use the metric's default connection.",
          ),
      },
    },
    async ({ id, filters, connectionId }): Promise<CallToolResult> =>
      withRequestContext(
        { requestId: dispatchId("mcp-runMetric"), user: actor },
        async () => {
          try {
            if (filters && Object.keys(filters).length > 0) {
              return toErrorContent(
                "runMetric `filters` pass-through is not yet supported. Use `executeSQL` with the metric's raw SQL to apply filters.",
              );
            }

            const metric = findMetricById(id);
            if (!metric) {
              return toErrorContent(`Metric "${id}" not found.`);
            }

            const explanation = metric.description
              ? `MCP runMetric ${metric.id}: ${metric.description}`
              : `MCP runMetric ${metric.id}`;

            const result = (await executeSQL.execute!(
              { sql: metric.sql, explanation, connectionId },
              { toolCallId: "mcp-runMetric", messages: [] },
            )) as Record<string, unknown>;

            if (result.success === false) {
              return toErrorContent(
                String(result.error ?? "Metric execution failed."),
              );
            }

            const columns = Array.isArray(result.columns)
              ? (result.columns as string[])
              : [];
            const rows = Array.isArray(result.rows)
              ? (result.rows as Array<Record<string, unknown>>)
              : [];

            // Single column / single row → scalar value. Otherwise hand back
            // the rows so the caller can inspect — keeps the typed shape
            // honest for breakdown metrics without forcing a shape they don't
            // have.
            const value =
              columns.length === 1 && rows.length === 1
                ? rows[0][columns[0]]
                : rows;

            return toJsonContent({
              id: metric.id,
              label: metric.label,
              value,
              columns,
              rows,
              row_count: result.row_count ?? rows.length,
              truncated: Boolean(result.truncated),
              sql: metric.sql,
              executed_at: new Date().toISOString(),
            });
          } catch (err) {
            const message = errorMessage(err, "runMetric tool failed");
            process.stderr.write(`[atlas-mcp] runMetric threw: ${err}\n`);
            return toErrorContent(message);
          }
        },
      ),
  );
}
