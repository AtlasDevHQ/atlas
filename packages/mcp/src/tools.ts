/**
 * MCP tool bridge — exposes Atlas's AI SDK tools as MCP tools.
 *
 * Each MCP tool calls the corresponding AI SDK tool's `execute` function
 * directly, preserving all security guarantees (SQL validation, whitelist,
 * timeout, sandboxing, audit logging).
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { explore } from "@atlas/api/lib/tools/explore";
import { executeSQL } from "@atlas/api/lib/tools/sql";

export function registerTools(server: McpServer): void {
  // --- explore ---
  server.registerTool(
    "explore",
    {
      title: "Explore Semantic Layer",
      description: explore.description,
      inputSchema: {
        command: z
          .string()
          .describe(
            'A bash command to run against the semantic layer, e.g. \'cat catalog.yml\', \'grep -r revenue entities/\'',
          ),
      },
    },
    async ({ command }): Promise<CallToolResult> => {
      try {
        const result = await explore.execute!(
          { command },
          { toolCallId: "mcp-explore", messages: [] },
        );
        const text =
          typeof result === "string" ? result : JSON.stringify(result);
        const isError =
          text.startsWith("Error:") || text.startsWith("Error (exit");
        return {
          content: [{ type: "text" as const, text }],
          isError,
        };
      } catch (err) {
        const text =
          err instanceof Error ? err.message : "explore tool failed";
        process.stderr.write(`[atlas-mcp] explore tool threw: ${err}\n`);
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      }
    },
  );

  // --- executeSQL ---
  server.registerTool(
    "executeSQL",
    {
      title: "Execute SQL Query",
      description: executeSQL.description,
      inputSchema: {
        sql: z.string().describe("The SELECT query to execute"),
        explanation: z
          .string()
          .describe("Brief explanation of what this query does and why"),
        connectionId: z
          .string()
          .optional()
          .describe(
            "Target connection ID. Omit for the default connection.",
          ),
      },
    },
    async ({ sql, explanation, connectionId }): Promise<CallToolResult> => {
      try {
        const result = await executeSQL.execute!(
          { sql, explanation, connectionId },
          { toolCallId: "mcp-executeSQL", messages: [] },
        );

        // executeSQL returns { success: boolean, error?, ... }
        const obj = result as Record<string, unknown>;
        if (obj.success === false) {
          return {
            content: [
              {
                type: "text" as const,
                text: String(obj.error ?? "Query failed"),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  explanation: obj.explanation,
                  row_count: obj.row_count,
                  columns: obj.columns,
                  rows: obj.rows,
                  truncated: obj.truncated,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const text =
          err instanceof Error ? err.message : "executeSQL tool failed";
        process.stderr.write(`[atlas-mcp] executeSQL tool threw: ${err}\n`);
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
        };
      }
    },
  );

}
