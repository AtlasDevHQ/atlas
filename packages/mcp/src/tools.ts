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
 * and threaded through `registerTools(server, { actor, transport })`.
 *
 * #2029 — every dispatch is also wrapped in `traceMcpToolCall`, which
 * emits an OTel span, increments the tool-call counter, records the latency
 * histogram, and fires a one-time activation event per workspace. The
 * `transport` arg flows from `bin/serve.ts` to keep the span attribute
 * accurate without re-detecting transport per request.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { explore } from "@atlas/api/lib/tools/explore";
import { executeSQL } from "@atlas/api/lib/tools/sql";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import { withRequestContext } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";
import { registerSemanticTools } from "./semantic-tools.js";
import { traceMcpToolCall, type McpTransport } from "./telemetry.js";

export interface RegisterToolsOptions {
  /**
   * Actor bound on every tool dispatch. Resolved once at server boot by
   * `resolveMcpActor()`. The approval gate keys on
   * `RequestContext.user.activeOrganizationId`; an unbound dispatch falls
   * through to the defensive `identityMissing` branch and fails closed
   * with a chat-app-shaped error that doesn't apply to MCP. See #1858.
   */
  actor: AtlasUser;
  /**
   * Carrier transport in use for this MCP server instance. Set once at
   * boot by `bin/serve.ts` and threaded through to every `registerTool`
   * dispatch so OTel spans / counters tag the right transport without
   * re-detecting it per request. Optional for backwards compat; defaults
   * to `stdio`. See #2029.
   */
  transport?: McpTransport;
}

function dispatchId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Resolve the workspace id for OTel span / counter attribution. In
 * trusted-transport mode the actor is `system:mcp` with no
 * `activeOrganizationId`; falling back to the actor id keeps the
 * attribute non-empty (collectors strip empty-string label values
 * inconsistently across vendors). See `actor.ts`.
 */
function workspaceIdOf(actor: AtlasUser): string {
  return actor.activeOrganizationId ?? actor.id;
}

function deployModeOf(): string {
  return getConfig()?.deployMode ?? "self-hosted";
}

export function registerTools(server: McpServer, opts: RegisterToolsOptions): void {
  const { actor, transport = "stdio" } = opts;
  const workspaceId = workspaceIdOf(actor);
  const deployMode = deployModeOf();

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
    async ({ command }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "explore", workspaceId, transport, deployMode },
        () =>
          withRequestContext(
            { requestId: dispatchId("mcp-explore"), user: actor },
            async () => {
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
          ),
      ),
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
    async ({ sql, explanation, connectionId }): Promise<CallToolResult> =>
      traceMcpToolCall(
        { toolName: "executeSQL", workspaceId, transport, deployMode },
        () =>
          withRequestContext(
            { requestId: dispatchId("mcp-executeSQL"), user: actor },
            async () => {
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
          ),
      ),
  );

  // --- typed semantic-layer tools ---
  registerSemanticTools(server, { actor, transport, workspaceId, deployMode });
}
