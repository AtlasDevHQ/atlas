/**
 * Shared agent query execution logic.
 *
 * Used by both the synchronous JSON endpoint (POST /api/v1/query) and the
 * Slack bot routes to run the Atlas agent to completion and extract
 * structured results from the tool calls.
 */

import { runAgent } from "@atlas/api/lib/agent";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";

const log = createLogger("agent-query");

export interface PendingAction {
  id: string;
  type: string;
  target: string;
  summary: string;
}

export interface AgentQueryResult {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  pendingActions?: PendingAction[];
}

/**
 * Run the Atlas agent on a single question and return structured results.
 *
 * Creates a UIMessage from the question, invokes the agent loop, and
 * extracts SQL queries, data, and the final answer from tool results.
 */
export async function executeAgentQuery(
  question: string,
  requestId?: string,
  options?: { priorMessages?: Array<{ role: "user" | "assistant"; content: string }> },
): Promise<AgentQueryResult> {
  const id = requestId ?? crypto.randomUUID();

  return withRequestContext({ requestId: id }, async () => {
    const priorUIMessages = (options?.priorMessages ?? []).map((m, i) => ({
      id: `${id}-prior-${i}`,
      role: m.role as "user" | "assistant",
      parts: [{ type: "text" as const, text: m.content }],
    }));

    const messages = [
      ...priorUIMessages,
      {
        id,
        role: "user" as const,
        parts: [{ type: "text" as const, text: question }],
      },
    ];

    // Optionally include action tools
    let toolRegistry;
    const includeActions = process.env.ATLAS_ACTIONS_ENABLED === "true";
    if (includeActions) {
      try {
        const { buildRegistry } = await import(
          "@atlas/api/lib/tools/registry"
        );
        toolRegistry = await buildRegistry({ includeActions });
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Failed to build tool registry — falling back to default tools",
        );
      }
    }

    const result = await runAgent({
      messages,
      ...(toolRegistry && { tools: toolRegistry }),
    });

    const [text, steps, totalUsage] = await Promise.all([
      result.text,
      result.steps,
      result.totalUsage,
    ]);

    // Collect SQL queries and their data from tool results
    const sqlQueries: string[] = [];
    const dataResults: { columns: string[]; rows: Record<string, unknown>[] }[] = [];
    const pendingActions: PendingAction[] = [];
    const answer = text;

    for (const step of steps) {
      // No tool results in text-only steps
      if (!step.toolResults) continue;
      for (const tr of step.toolResults) {
        if (tr.toolName === "executeSQL" && tr.output) {
          const r = tr.output as {
            success?: boolean;
            columns?: string[];
            rows?: Record<string, unknown>[];
          };
          const inp = tr.input as { sql?: string };
          if (inp.sql) {
            sqlQueries.push(inp.sql);
          }
          if (r.success && r.columns && r.rows) {
            dataResults.push({ columns: r.columns, rows: r.rows });
          } else if (r.success) {
            log.warn(
              { requestId: id, toolName: "executeSQL", hasColumns: !!r.columns, hasRows: !!r.rows },
              "executeSQL returned success but missing columns or rows",
            );
          }
        }
        // Detect pending action approvals from any action tool
        if (tr.output && typeof tr.output === "object") {
          const out = tr.output as Record<string, unknown>;
          if (out.status === "pending_approval") {
            if (typeof out.actionId !== "string" || !out.actionId) {
              log.warn(
                { toolName: tr.toolName, outputKeys: Object.keys(out) },
                "Tool returned pending_approval but missing or invalid actionId — skipping",
              );
            } else {
              const actionType = typeof (tr.input as Record<string, unknown>)?.actionType === "string"
                ? (tr.input as Record<string, unknown>).actionType as string
                : tr.toolName;
              pendingActions.push({
                id: out.actionId,
                type: actionType,
                target: typeof out.target === "string" ? out.target : "",
                summary: typeof out.summary === "string" ? out.summary : "",
              });
            }
          }
        }
      }
    }

    if (!answer && dataResults.length > 0) {
      log.warn(
        { requestId: id, steps: steps.length, sqlCount: sqlQueries.length },
        "Agent produced data but no text answer — model may have hit step limit before responding",
      );
    }

    return {
      answer,
      sql: sqlQueries,
      data: dataResults,
      steps: steps.length,
      usage: {
        totalTokens:
          (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0),
      },
      ...(pendingActions.length > 0 && { pendingActions }),
    };
  });
}
