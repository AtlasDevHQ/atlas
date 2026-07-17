/**
 * Shared agent query execution logic.
 *
 * Used by both the synchronous JSON endpoint (POST /api/v1/query) and the
 * Slack bot routes to run the Atlas agent to completion and extract
 * structured results from the tool calls.
 */

import { runAgent } from "@atlas/api/lib/agent";
import type { AnswerStyle } from "@atlas/api/lib/answer-styles";
import { createLogger, getRequestContext, withRequestContext } from "@atlas/api/lib/logger";
import type { ActorKind, RequestActor } from "@atlas/api/lib/logger";
import { BillingBlockedError } from "@atlas/api/lib/billing/agent-gate";
import { ClaimRequiredError, ClaimCheckFailedError } from "@atlas/api/lib/billing/claim-gate";
import { checkAgentQueryGates } from "@atlas/api/lib/billing/agent-query-gates";
import type { PlanLimitWarning } from "@atlas/api/lib/billing/enforcement";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { ApprovalRequestOrigin } from "@useatlas/types";

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
  /**
   * #3419/#3420 — the plan-usage warning (80%→ceiling warning/metered
   * bands, #4038) from the billing gate. Never blocks the run. Surfaces
   * that render usage warnings
   * (the `/api/v1/query` JSON envelope) attach it to their response;
   * machine-initiated surfaces (chat platforms, scheduler) deliberately
   * leave it unrendered — the band is logged by `billing/enforcement.ts`
   * and visible in the admin billing page.
   */
  planWarning?: PlanLimitWarning;
  /**
   * #3750 — the durable run id minted (or resumed) for this agent turn,
   * surfaced from {@link runAgent}'s returned `runId`. Present whenever the
   * agent loop ran. Async-approval surfaces (chat platforms) pair it with
   * `conversationId` to re-arm and resume the turn once a parked approval is
   * resolved (durable-sessions #3748/#3750). Callers that don't resume
   * (the synchronous `/query` route) simply ignore it. A run id always
   * exists, but a *resumable* parked checkpoint only exists when durability
   * is enabled AND a `conversationId` was supplied — so resume callers must
   * also check `conversationId` + `pendingApproval`.
   */
  runId?: string;
  /**
   * #3750 — the conversation the turn ran under, echoed back so async
   * resume callers needn't thread it separately. Equals
   * `ExecuteAgentQueryOptions.conversationId` when one was supplied; absent
   * otherwise (a conversation-less turn has no durable checkpoint to resume).
   */
  conversationId?: string;
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
  /**
   * #3615 — audit_log discriminator for this agent run. System callers
   * that run outside a route-level `withRequestContext` (the scheduler)
   * MUST pass this so executeSQL audit rows record the right actor_kind
   * (e.g. `scheduler`). When omitted, the actor is propagated from the
   * parent RequestContext (e.g. the `/query` route stamps `human`); when
   * neither is present, `logQueryAudit` defaults the row to `agent`.
   * Excludes `mcp` because the MCP path binds its actor via the inherited
   * RequestContext (the `mcpActor` set in `mcp-dispatch.ts`, carrying
   * `clientId` / `toolName`), never via this option — even the NL-agent `query`
   * MCP tool (#4094), which DOES route through `executeAgentQuery`, inherits
   * that actor rather than passing `actorKind`.
   */
  actorKind?: Exclude<ActorKind, "mcp">;
  /**
   * #2072 — agent origin for origin-scoped approval rules. System
   * callers (scheduler, chat-platform receivers) MUST pass this so an
   * "MCP-only" or "scheduler-only" rule fires for the correct transport.
   * When omitted, falls back to whatever origin the parent
   * RequestContext stamped (or undefined if neither is set, in which
   * case only `'any'` rules match — fail-closed).
   */
  agentOrigin?: ApprovalRequestOrigin;
  /** Execution target for this agent run. */
  connectionId?: string;
  /** Content scope for group-aware semantic overlays. */
  connectionGroupId?: string;
  /**
   * #4299 — answer style for the agent's response body. Threaded through
   * to {@link runAgent}'s `answerStyle` parameter; the chat plugin's
   * `executeQuery` path resolves `"conversational"` so the Slack @mention
   * reply renders as 1-2 sentences of prose with the SQL and tables
   * surfaced via progressive-disclosure buttons (#2705).
   *
   * Optional. When absent, `runAgent` resolves the workspace default
   * answer style (#4303, the `ATLAS_DEFAULT_ANSWER_STYLE` setting), else
   * `"analyst"` (the answer-first analyst voice) — so the synchronous JSON
   * `/api/v1/query` route, MCP, and any other non-chat caller get the
   * workspace's house voice, defaulting to the analyst-grade body.
   */
  answerStyle?: AnswerStyle;
}

/**
 * Run the Atlas agent on a single question and return structured results.
 *
 * Creates a UIMessage from the question, invokes the agent loop, and
 * extracts SQL queries, data, and the final answer from tool results.
 *
 * **Billing enforcement seam (#3419/#3420, #3651, #4128):** before the
 * agent runs, the bound actor's workspace is checked against
 * {@link checkAgentQueryGates} — Gate 0 (workspace status → abuse status
 * → plan limits) then the metered claim-gate (ADR-0018), with the
 * Gate-0-first ordering encoded in the seam (#4128). A blocked workspace throws
 * {@link BillingBlockedError}, {@link ClaimRequiredError}, or
 * {@link ClaimCheckFailedError} — whose `message`s are user-safe — with
 * ZERO LLM spend. Putting the gate here (rather than per-callsite) means
 * every current and future caller is covered by construction.
 * Self-hosted deployments and runs without an org pass through untouched.
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
  // #2072 — explicit option wins; otherwise fall through to whatever the
  // parent RequestContext stamped. System-initiated callers (scheduler,
  // Slack, Teams) pass this explicitly because they don't run inside a
  // route-level `withRequestContext` that would have set it.
  const origin = options?.agentOrigin ?? inheritedCtx?.agentOrigin;
  const connectionId = options?.connectionId ?? inheritedCtx?.connectionId;
  const connectionGroupId = options?.connectionGroupId ?? inheritedCtx?.connectionGroupId;
  // #3615 — explicit `actorKind` wins (the scheduler passes "scheduler");
  // otherwise propagate the parent context's actor (the `/query` route stamps
  // "human") so the re-entered context below doesn't drop it. When neither is
  // present, leave it unset — `logQueryAudit` defaults the audit row to "agent".
  const actor: RequestActor | undefined = options?.actorKind
    ? { kind: options.actorKind }
    : inheritedCtx?.actor;

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
      ...(origin ? { agentOrigin: origin } : {}),
      ...(actor ? { actor } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(connectionGroupId ? { connectionGroupId } : {}),
    },
    async () => {
    // #3419/#3420 + ADR-0018/#3651 — the single billing seam for Atlas-token
    // agent runs: Gate 0 (solvency) then the metered claim-gate, with the
    // load-bearing ordering encoded in checkAgentQueryGates itself (#4128),
    // not here. Blocks before any tool registry / LLM work so a suspended,
    // trial-expired, hard-capped, abuse-flagged, or unclaimed (metered)
    // workspace consumes zero platform-paid tokens regardless of which
    // origin called. The claim-gate lives on this Atlas-token path only —
    // NOT in Gate 0, which every MCP `checksBilling` tool (incl. setup)
    // routes through, so MCP executeSQL + setup stay open pre-claim.
    const gateOrgId = boundUser?.activeOrganizationId;
    const gates = await checkAgentQueryGates(gateOrgId);
    if (!gates.allowed) {
      const blockCtx = {
        requestId: id,
        orgId: gateOrgId,
        ...(origin ? { agentOrigin: origin } : {}),
      };
      if (gates.gate === "billing") {
        log.warn(
          { ...blockCtx, errorCode: gates.block.errorCode, httpStatus: gates.block.httpStatus },
          "Agent run blocked by billing enforcement",
        );
        throw new BillingBlockedError(gates.block);
      }
      if (gates.reason === "check_failed") {
        // Fail closed: claim status couldn't be determined (lookup error).
        // Surface a retryable 503 rather than spend Atlas tokens on an
        // unverifiable workspace.
        log.warn(blockCtx, "Agent run blocked: claim status could not be verified");
        throw new ClaimCheckFailedError();
      }
      log.warn(blockCtx, "Agent run blocked: workspace unclaimed (claim required)");
      throw new ClaimRequiredError(gates.claimUrl);
    }

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

    // Build the tool registry for this surface. `executeAgentQuery` serves the
    // non-web programmatic surfaces — the SDK query route, chat-platform
    // adapters (Slack), the MCP query tool, and the scheduler. None of them own
    // a dashboards route, so we pass `dashboardUrlResolver: null` to omit
    // `createDashboard` entirely (#4566, PRD #4553 L2): a handoff link to
    // `/dashboards/[id]` is unreachable from Slack or a scheduled digest, so the
    // agent must never be offered the tool here. Action tools stay opt-in via
    // ATLAS_ACTIONS_ENABLED. On a build failure we fall back to
    // `nonDashboardRegistry` (NOT the dashboards-owning `defaultRegistry`) so the
    // createDashboard omission holds on the error path too — and we always pass
    // `tools` so `runAgent` never defaults to `defaultRegistry`.
    const { buildRegistry, nonDashboardRegistry } = await import(
      "@atlas/api/lib/tools/registry"
    );
    let toolRegistry = nonDashboardRegistry;
    const includeActions = process.env.ATLAS_ACTIONS_ENABLED === "true";
    try {
      const result = await buildRegistry({
        includeActions,
        dashboardUrlResolver: null,
      });
      toolRegistry = result.registry;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "Failed to build tool registry — falling back to the non-dashboard core registry",
      );
    }

    const result = await runAgent({
      messages,
      tools: toolRegistry,
      ...(options?.conversationId && { conversationId: options.conversationId }),
      ...(options?.answerStyle && { answerStyle: options.answerStyle }),
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
      ...(gates.warning ? { planWarning: gates.warning } : {}),
      // #3750 — surface the durable run id + conversation so async-approval
      // surfaces can re-arm and resume a parked turn. `result.runId` is always
      // set by runAgent (Object.assign at the loop's return).
      ...(result.runId ? { runId: result.runId } : {}),
      ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
    };
  });
}
