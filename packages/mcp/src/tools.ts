/**
 * MCP tool bridge — exposes Atlas's AI SDK tools as MCP tools.
 *
 * Each MCP tool calls the corresponding AI SDK tool's `execute` function
 * directly, preserving all security guarantees (SQL validation, whitelist,
 * timeout, sandboxing, audit logging).
 *
 * #1858 — every tool dispatch is wrapped in `withRequestContext({ user,
 * requestId })` so the approval gate inside `executeSQL` sees a bound
 * actor. Mirrors the F-54 (scheduler) / F-55 (Slack) binding pattern from
 * PR #1860. The actor is resolved once at server boot by `resolveMcpActor`
 * and threaded through `registerTools(server, { actor })`.
 *
 * #2030 — every failure path returns an `AtlasMcpToolError` envelope (JSON
 * body of an `isError: true` MCP response) so an LLM agent can branch on
 * `code` instead of pattern-matching prose. See `error-envelope.ts`.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { explore } from "@atlas/api/lib/tools/explore";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import { registerSemanticTools } from "./semantic-tools.js";
import {
  classifyExecuteSqlError,
  classifyExploreError,
  envelope,
  toEnvelopeResult,
} from "./error-envelope.js";

export interface RegisterToolsOptions {
  /**
   * Actor bound on every tool dispatch. Resolved once at server boot by
   * `resolveMcpActor()`. The approval gate keys on
   * `RequestContext.user.activeOrganizationId`; an unbound dispatch falls
   * through to the defensive `identityMissing` branch and fails closed
   * with a chat-app-shaped error that doesn't apply to MCP. See #1858.
   */
  actor: AtlasUser;
}

function dispatchId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Append the structured error contract to a tool's LLM-facing description
 * so agents can read the recovery surface from the same place they read
 * the tool's purpose.
 */
function withErrorContract(base: string, codes: readonly string[]): string {
  return `${base}

Error contract: failures return an \`{ code, message, hint?, request_id?, retry_after? }\` JSON envelope as the tool result text with \`isError: true\`. Possible codes: ${codes.map((c) => `\`${c}\``).join(", ")}. Branch on \`code\`; never pattern-match \`message\`.`;
}

const EXPLORE_ERROR_CODES = ["rate_limited", "internal_error"] as const;
const EXECUTE_SQL_ERROR_CODES = [
  "validation_failed",
  "rls_denied",
  "query_timeout",
  "unknown_entity",
  "rate_limited",
  "internal_error",
] as const;

export function registerTools(server: McpServer, opts: RegisterToolsOptions): void {
  const { actor } = opts;

  // --- explore ---
  server.registerTool(
    "explore",
    {
      title: "Explore Semantic Layer",
      description: withErrorContract(explore.description ?? "", EXPLORE_ERROR_CODES),
      inputSchema: {
        command: z
          .string()
          .describe(
            'A bash command to run against the semantic layer, e.g. \'cat catalog.yml\', \'grep -r revenue entities/\'',
          ),
      },
    },
    async ({ command }): Promise<CallToolResult> => {
      const requestId = dispatchId("mcp-explore");
      return withRequestContext(
        { requestId, user: actor },
        async () => {
          try {
            const result = await explore.execute!(
              { command },
              { toolCallId: "mcp-explore", messages: [] },
            );
            const text =
              typeof result === "string" ? result : JSON.stringify(result);
            // explore today returns prose strings prefixed with `Error:` or
            // `Error (exit N):` on failure rather than throwing. Lift those
            // into the typed envelope so the agent doesn't have to scrape.
            if (text.startsWith("Error:") || text.startsWith("Error (exit")) {
              const code = classifyExploreError(text);
              const message = text.replace(/^Error(\s\(exit\s\d+\))?:\s*/i, "").trim() || text;
              return toEnvelopeResult(
                envelope(code, message, code === "internal_error" ? { request_id: requestId } : undefined),
              );
            }
            return {
              content: [{ type: "text" as const, text }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[atlas-mcp] explore tool threw: ${err}\n`);
            return toEnvelopeResult(
              envelope("internal_error", message || "explore tool failed", { request_id: requestId }),
            );
          }
        },
      );
    },
  );

  // --- executeSQL ---
  server.registerTool(
    "executeSQL",
    {
      title: "Execute SQL Query",
      description: withErrorContract(executeSQL.description ?? "", EXECUTE_SQL_ERROR_CODES),
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
      const requestId = dispatchId("mcp-executeSQL");
      return withRequestContext(
        { requestId, user: actor },
        async () => {
          try {
            const result = await executeSQL.execute!(
              { sql, explanation, connectionId },
              { toolCallId: "mcp-executeSQL", messages: [] },
            );

            // executeSQL collapses 7+ tagged pipeline errors into
            // { success: false, error } in pipelineErrorToResponse. Lift the
            // string back up into a typed envelope here (see #2030 follow-
            // up note in error-envelope.ts about replumbing tagged errors).
            const obj = result as Record<string, unknown>;
            if (obj.success === false) {
              const rawError = String(obj.error ?? "");
              const code = classifyExecuteSqlError(rawError);
              const extras: { request_id?: string; retry_after?: number } = {};
              if (code === "internal_error") extras.request_id = requestId;
              const retryAfterMs = obj.retryAfterMs;
              if (code === "rate_limited" && typeof retryAfterMs === "number") {
                extras.retry_after = Math.max(1, Math.round(retryAfterMs / 1000));
              }
              return toEnvelopeResult(
                envelope(code, rawError || "Query failed", Object.keys(extras).length ? extras : undefined),
              );
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
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[atlas-mcp] executeSQL tool threw: ${err}\n`);
            return toEnvelopeResult(
              envelope("internal_error", message || "executeSQL tool failed", { request_id: requestId }),
            );
          }
        },
      );
    },
  );

  // --- typed semantic-layer tools ---
  registerSemanticTools(server, opts);
}
