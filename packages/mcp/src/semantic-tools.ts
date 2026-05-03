/**
 * Typed semantic-layer MCP tools — `listEntities`, `describeEntity`,
 * `searchGlossary`, and `runMetric` — that wrap the existing semantic-
 * layer read paths so MCP clients can discover and use the catalog
 * without grepping YAML through the `explore` shell.
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
  type SemanticToolName,
} from "@atlas/api/lib/tools/descriptions";
import {
  traceMcpToolCall,
  type McpTransport,
  type McpDeployMode,
} from "./telemetry.js";

// Modest input bounds — MCP clients (including hostile ones in BYOC
// SaaS) shouldn't be able to drive megabyte strings into the catalog
// scanners or substring search. Identifiers stay short; free-text
// filter/term get a bit more headroom. Bumping these is fine if a real
// user need surfaces.
const MAX_IDENTIFIER_LEN = 256;
const MAX_FREE_TEXT_LEN = 1024;

// Mirrors the entity-name shape `isValidEntityName` accepts in
// `lib/semantic/files.ts` (no `/`, `\`, `..`, `\0`). Surfacing the
// constraint at the Zod boundary gives the MCP client an immediate
// error instead of an indistinguishable `{ found: false }`.
const ENTITY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface RegisterSemanticToolsOptions {
  /** Actor bound on every tool dispatch — see tools.ts. */
  actor: AtlasUser;
  /** OTel transport tag (#2029) — threaded from `bin/serve.ts` via `tools.ts`. */
  transport: McpTransport;
  /** Resolved workspace id for OTel attribution (`actor.activeOrganizationId` or `actor.id`). */
  workspaceId: string;
  /** Resolved `deployMode` for OTel attribution (`self-hosted` / `saas`). */
  deployMode: McpDeployMode;
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
  if (err instanceof Error) return err.message;
  // CLAUDE.md: `err instanceof Error ? err.message : String(err)`. The
  // fallback only kicks in for the truly opaque case (`String(err)` →
  // `""` or `"[object Object]"`) where preserving the original would
  // give the caller no signal anyway.
  const s = String(err);
  return s && s !== "[object Object]" ? s : fallback;
}

export function registerSemanticTools(
  server: McpServer,
  opts: RegisterSemanticToolsOptions,
): void {
  const { actor, transport, workspaceId, deployMode } = opts;

  // --- listEntities ---
  server.registerTool(
    "listEntities" satisfies SemanticToolName,
    {
      title: "List Semantic Entities",
      description: LIST_ENTITIES_TOOL_DESCRIPTION,
      inputSchema: {
        filter: z
          .string()
          .max(MAX_FREE_TEXT_LEN)
          .optional()
          .describe(
            "Optional case-insensitive substring matched against name, table, and description.",
          ),
      },
    },
    async ({ filter }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "listEntities", workspaceId, transport, deployMode },
        () =>
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
      ),
  );

  // --- describeEntity ---
  server.registerTool(
    "describeEntity" satisfies SemanticToolName,
    {
      title: "Describe Semantic Entity",
      description: DESCRIBE_ENTITY_TOOL_DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(MAX_IDENTIFIER_LEN)
          .regex(ENTITY_NAME_PATTERN)
          .describe(
            "Entity name (`name` field) or table name. Alphanumerics, `_`, `-`, `.` only — no path separators.",
          ),
      },
    },
    async ({ name }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "describeEntity", workspaceId, transport, deployMode },
        () =>
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
      ),
  );

  // --- searchGlossary ---
  server.registerTool(
    "searchGlossary" satisfies SemanticToolName,
    {
      title: "Search Business Glossary",
      description: SEARCH_GLOSSARY_TOOL_DESCRIPTION,
      inputSchema: {
        term: z
          .string()
          .min(1)
          .max(MAX_FREE_TEXT_LEN)
          .describe(
            "Term, phrase, or substring to search across glossary entries.",
          ),
      },
    },
    async ({ term }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "searchGlossary", workspaceId, transport, deployMode },
        () =>
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
      ),
  );

  // --- runMetric ---
  // The metric SQL goes through executeSQL.execute, inheriting all four
  // validation layers, plugin hooks, RLS injection, auto-LIMIT,
  // statement timeout, and audit logging. The existing `atlas.sql.execute`
  // span (see `lib/tools/sql.ts`) nests under this dispatch's
  // `atlas.mcp.tool.run` via OTel context propagation through `withSpan`.
  server.registerTool(
    "runMetric" satisfies SemanticToolName,
    {
      title: "Run Canonical Metric",
      description: RUN_METRIC_TOOL_DESCRIPTION,
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(MAX_IDENTIFIER_LEN)
          .describe("Metric id from semantic/metrics/*.yml."),
        filters: z
          .record(
            z.string().max(MAX_IDENTIFIER_LEN),
            z.union([
              z.string().max(MAX_FREE_TEXT_LEN),
              z.number(),
              z.boolean(),
              z.null(),
            ]),
          )
          .optional()
          .describe(
            "Reserved for future filter pass-through. Empty/omitted today; passing a non-empty object returns an error.",
          ),
        connectionId: z
          .string()
          .max(MAX_IDENTIFIER_LEN)
          .optional()
          .describe(
            "Target connection id. Omit to use the default connection.",
          ),
      },
    },
    async ({ id, filters, connectionId }): Promise<CallToolResult> =>
      traceMcpToolCall(
        {
          toolName: "runMetric",
          workspaceId,
          transport,
          deployMode,
          attributes: { "metric.id": id },
        },
        () =>
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
      ),
  );
}
