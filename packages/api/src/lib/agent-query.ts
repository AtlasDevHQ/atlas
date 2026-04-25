/**
 * Shared agent query execution logic.
 *
 * Used by both the synchronous JSON endpoint (POST /api/v1/query) and the
 * Slack bot routes to run the Atlas agent to completion and extract
 * structured results from the tool calls.
 */

import { runAgent } from "@atlas/api/lib/agent";
import { createLogger, getRequestContext, withRequestContext } from "@atlas/api/lib/logger";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

const log = createLogger("agent-query");

export interface PendingAction {
  id: string;
  type: string;
  target: string;
  summary: string;
}

export interface PendingApproval {
  /**
   * Approval queue row id. `null` when the upstream tool result reports
   * approval-required without a queued request — this happens when the
   * defensive `identityMissing` path fires (no caller bound an org), since
   * `createApprovalRequest` is short-circuited by the user-identity gate
   * before a row is created. Callers building user-facing links must
   * handle the null branch (e.g., the chat-platform "approve via Atlas"
   * notice doesn't deep-link in this case).
   */
  requestId: string | null;
  ruleName: string;
  matchedRules: string[];
  message: string;
}

export interface AgentQueryResult {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  pendingActions?: PendingAction[];
  /**
   * Set when one or more SQL queries hit an approval rule and were enqueued
   * rather than executed. Callers (scheduler, chat-platform receivers) MUST
   * surface this rather than treat the run as a successful completion —
   * F-54 / F-55 closed the regression where this was silently bypassed.
   */
  pendingApproval?: PendingApproval;
}

export interface ExecuteAgentQueryOptions {
  priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  conversationId?: string;
  /**
   * Identity to bind for the agent run. Required for system-initiated paths
   * (scheduler executor — F-54) and chat-platform webhook receivers (F-55)
   * because the inbound payload has no Atlas session. Without it,
   * `checkApprovalRequired` short-circuits on a missing `orgId` and the
   * approval gate silently disables.
   *
   * When omitted, falls back to the user already bound on the parent
   * RequestContext (e.g. the `/query` route, which authenticates first
   * and only then calls `executeAgentQuery`).
   */
  actor?: AtlasUser;
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
  options?: ExecuteAgentQueryOptions,
): Promise<AgentQueryResult> {
  const id = requestId ?? crypto.randomUUID();
  const inheritedCtx = getRequestContext();
  const boundUser = options?.actor ?? inheritedCtx?.user;
  const inheritedMode = inheritedCtx?.atlasMode;

  if (!boundUser) {
    log.warn(
      { requestId: id },
      "executeAgentQuery invoked without an actor — approval rules will not match. " +
        "Pass options.actor or wrap in withRequestContext({ user }).",
    );
  }

  return withRequestContext(
    {
      requestId: id,
      ...(boundUser ? { user: boundUser } : {}),
      ...(inheritedMode ? { atlasMode: inheritedMode } : {}),
    },
    async () => {
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
        const result = await buildRegistry({ includeActions });
        toolRegistry = result.registry;
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
      ...(options?.conversationId && { conversationId: options.conversationId }),
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
    let pendingApproval: PendingApproval | undefined;
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
            approval_required?: boolean;
            approval_request_id?: string;
            matched_rules?: string[];
            message?: string;
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
          // First approval-required result wins. Surface it to callers so
          // system-initiated paths (scheduler, chat platforms) can fail-loud
          // rather than treat the run as a normal completion. Defensive:
          // both producers in `lib/tools/sql.ts` set `success: false` when
          // they emit `approval_required: true`. A future tool variant that
          // returned `success: true` alongside `approval_required: true`
          // would be a contradictory shape — log a warning and skip rather
          // than push both `dataResults` and `pendingApproval`.
          if (r.approval_required && r.success !== false) {
            log.warn(
              { requestId: id, toolName: tr.toolName },
              "Tool returned both success !== false and approval_required — ignoring contradictory approval flag",
            );
          } else if (r.approval_required && !pendingApproval) {
            const matchedRules = Array.isArray(r.matched_rules) ? r.matched_rules : [];
            pendingApproval = {
              requestId: typeof r.approval_request_id === "string" && r.approval_request_id.length > 0
                ? r.approval_request_id
                : null,
              ruleName: matchedRules[0] ?? "approval-required",
              matchedRules,
              message: typeof r.message === "string"
                ? r.message
                : "This query requires approval before execution.",
            };
          }
        }
        // Detect pending action approvals from any action tool
        if (tr.output && typeof tr.output === "object") {
          const out = tr.output as Record<string, unknown>;
          if (out.status === "pending") {
            if (typeof out.actionId !== "string" || !out.actionId) {
              log.warn(
                { toolName: tr.toolName, outputKeys: Object.keys(out) },
                "Tool returned pending but missing or invalid actionId — skipping",
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
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  });
}
