/**
 * High-level natural-language `query` MCP tool (#4094) — the **Shape A**
 * counterpart to the raw-SQL `executeSQL` MCP tool (Shape B). The related
 * #4047 / ADR-0027 is the raw-SQL-over-REST sibling (`POST /api/v1/execute-sql`
 * + `atlas sql`) that this complements — NOT the MCP `executeSQL` tool, which
 * predates it.
 *
 * `executeSQL` is Shape B: the caller's own LLM writes the SQL, Atlas
 * validates + runs it. `query` is Shape A: the caller sends a *question* and
 * Atlas's own server-side, semantic-layer-aware agent explores the catalog,
 * writes + runs the SELECTs, and hands back the answer plus the SQL it ran.
 * It is the *recommended* MCP path for question-answering; `executeSQL` is
 * documented as the advanced/raw escape hatch (see
 * `apps/docs/content/shared/architecture/mcp-tools.mdx`).
 *
 * **Agent-in-agent, token-metered.** The customer's LLM calls this tool, which
 * runs Atlas's agent (a second LLM) in-process — NOT a loopback HTTP call to
 * `/api/v1/query` (ADR-0016: MCP dispatches into the same `executeAgentQuery`
 * lib seam directly). Like every datasource-reaching tool it declares
 * `checksBilling`, so the ADR-0016 gate-0 workspace-*solvency* check runs
 * before any datasource/LLM work (the metadata-read tools omit it; `executeSQL`
 * declares it too while spending zero Atlas tokens). What makes this an
 * agent-in-agent double-bill is the token spend, not `checksBilling`: because
 * it *additionally* burns Atlas plan tokens, `executeAgentQuery` layers on the
 * claim gate + token metering internally.
 *
 * Registration stays off the agent graph: `executeAgentQuery` (and the billing
 * error classes) are lazy-imported inside the dispatch body, the same deferral
 * the shared dispatch gate + trial footer use. Importing them at module load
 * would couple MCP tool *registration* to the whole `runAgent` graph.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
// Type-only — erased at compile time, so it does NOT pull the `runAgent` graph
// into registration (the reason `executeAgentQuery` itself is lazy-imported).
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";
import {
  QUERY_TOOL_DESCRIPTION,
  QUERY_ERROR_CODES,
  withErrorContract,
} from "@atlas/api/lib/tools/descriptions";
import { type McpTransport, type McpDeployMode } from "./telemetry.js";
import { envelope, toEnvelopeResult, toStructuredContent } from "./error-envelope.js";
import { createMcpDispatch } from "./mcp-dispatch.js";
import { approvalRequiredResult, queryOutputShape } from "./structured-output.js";
import {
  withProgressAndCancellation,
  startHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from "./progress.js";

// The question is free text the customer's LLM composed. Cap it so a hostile
// client can't drive a megabyte prompt into the agent loop; generous enough
// for a rich multi-sentence question (the semantic tools cap free text at
// 1024, but a question legitimately carries more context than a filter term).
const MAX_QUESTION_LEN = 4096;
const MAX_CONNECTION_ID_LEN = 256;

// #4734 — keepalive cadence for the (potentially minutes-long) agent run. A
// module-level `let` (not a user-facing env knob) purely so the test can
// shorten it without a real 15s wait; production always uses the default.
let queryHeartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;

/** @internal test seam — override the #4734 query keepalive cadence. */
export function _setQueryHeartbeatIntervalMsForTest(ms: number): void {
  queryHeartbeatIntervalMs = ms;
}

/**
 * The hint attached to a `billing_blocked` envelope — adapts the wording of
 * billing-gate.ts (claim/setup framing for the agent path; the mapping *logic*
 * below is byte-for-byte identical to billing-gate.ts).
 */
const BILLING_BLOCKED_HINT =
  "Retrying will not help. The workspace owner must resolve the workspace's billing or claim/setup status in Atlas before the agent can run.";

export interface RegisterQueryToolOptions {
  /** Actor bound on every tool dispatch — see tools.ts. */
  actor: AtlasUser;
  /** OTel transport tag (#2029) — threaded from `bin/serve.ts` via `server.ts`. */
  transport: McpTransport;
  /** Resolved workspace id for OTel attribution (`actor.activeOrganizationId` or `actor.id`). */
  workspaceId: string;
  /** Resolved `deployMode` for OTel attribution (`self-hosted` / `saas`). */
  deployMode: McpDeployMode;
  /** Hosted-MCP OAuth client_id, surfaced into `audit_log.client_id` (#2067). */
  clientId?: string;
  /** #3504 — OAuth token scopes, threaded onto each dispatch's RequestContext. */
  scopes?: readonly string[];
}

export function registerQueryTool(
  server: McpServer,
  opts: RegisterQueryToolOptions,
): void {
  const { actor, transport, workspaceId, deployMode, clientId, scopes } = opts;

  // Shared dispatch wrapper (#3602) — identical contract to tools.ts /
  // semantic-tools.ts (OTel → actor bind → rate-limit → ADR-0016 gate order →
  // body → typed error envelope). `checksBilling` runs the gate-0 solvency
  // check; the claim gate + token metering live inside `executeAgentQuery`.
  const dispatcher = createMcpDispatch({
    actor,
    transport,
    workspaceId,
    deployMode,
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
  });
  const dispatch: typeof dispatcher.dispatch = (...args) =>
    dispatcher.dispatch(...args);

  server.registerTool(
    "query",
    {
      title: "Ask Atlas (NL Data Question)",
      description: withErrorContract(QUERY_TOOL_DESCRIPTION, QUERY_ERROR_CODES),
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(1)
          .max(MAX_QUESTION_LEN)
          .describe(
            "The natural-language data question for Atlas's agent to answer, e.g. \"What were the top 5 products by revenue last quarter?\"",
          ),
        connectionId: z
          .string()
          .min(1)
          .max(MAX_CONNECTION_ID_LEN)
          .optional()
          .describe(
            "Target connection id. Omit to run against the workspace's default (published) connection.",
          ),
      },
      // The agent only runs SELECTs (executeSQL is SELECT-only, validated); any
      // action tool it reaches is approval-gated and returns `pending` rather
      // than mutating — nothing changes synchronously, so read-only. It reaches
      // an external datasource + LLM, so the world is open.
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
      // #3498 — typed result so the client agent parses answer/sql/data instead
      // of re-parsing the text block (which is retained below).
      outputSchema: queryOutputShape,
    },
    async ({ question, connectionId }, extra): Promise<CallToolResult> =>
      dispatch(
        "query",
        // Runs Atlas's agent → burns Atlas plan tokens → gate-0 billing
        // (#3437/#3601), like every datasource-reaching tool. Member-callable
        // read; no bound-org precondition (stdio self-hosted has no org and
        // runs against ATLAS_DATASOURCE_URL).
        { requiresWrite: false, requiresBoundOrg: false, minRole: "member", checksBilling: true },
        async (requestId) => {
          // Lazy-import to keep MCP tool registration off the `runAgent` graph
          // (see module header). ESM caches, so the error classes we import
          // here share identity with the ones `executeAgentQuery` throws.
          const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
          const { BillingBlockedError } = await import("@atlas/api/lib/billing/agent-gate");
          const { ClaimRequiredError, ClaimCheckFailedError } = await import(
            "@atlas/api/lib/billing/claim-gate"
          );

          let result: AgentQueryResult;
          try {
            // #3500 — progress start/end around the (potentially long) agent
            // run. #3575 — `executeAgentQuery` takes no abort signal, so the
            // client-cancel path cuts the dispatch loose at the MCP boundary
            // (the shared dispatch re-throws OperationCancelledError); the agent
            // drains server-side. The signal is intentionally not threaded.
            result = await withProgressAndCancellation(
              extra,
              { startMessage: "Running Atlas agent", endMessage: "Answer ready" },
              async (reporter, _signal) => {
                // #4734 — the POST SSE stream emits zero application bytes during
                // the agent run, so an intermediary idle-timeout (Railway
                // edge/LB, ~120s) closes it before a long run finishes → the
                // client sees "transport dropped". Drive a keepalive heartbeat so
                // periodic progress notifications keep the stream warm. Cleared
                // in `finally` so the timer never outlives the query. (Only
                // reaches the wire for progressToken-supplying clients — see
                // startHeartbeat; a transport-agnostic `: ping` is a follow-up.)
                const stopHeartbeat = startHeartbeat(reporter, {
                  intervalMs: queryHeartbeatIntervalMs,
                  message: "Atlas is still working on your question…",
                });
                try {
                  return await executeAgentQuery(question, requestId, {
                    // The dispatch RequestContext already carries user + actor
                    // (kind:mcp, toolName) + agentOrigin:"mcp" (#1858/#2067/#2072),
                    // which `executeAgentQuery` inherits — so executeSQL audit rows
                    // record actor_kind='mcp' and origin-scoped approval rules fire
                    // for origin=mcp. Only connectionId isn't on the context, so
                    // thread it explicitly (#4124).
                    ...(connectionId ? { connectionId } : {}),
                  });
                } finally {
                  stopHeartbeat();
                }
              },
            );
          } catch (err) {
            // The billing/claim gates inside `executeAgentQuery` throw typed
            // errors (mirroring the `/api/v1/query` route). Map each onto the
            // closed MCP envelope catalog rather than letting the shared
            // dispatch demote it to a bare `internal_error`.

            // Unclaimed metered trial (ADR-0018 / #3651): claim on the web to
            // run Atlas-token Q&A. Reuse `billing_blocked` (an account-standing
            // block the owner resolves on the web) — the closed catalog has no
            // `claim_required` code, and the recovery is the same.
            if (err instanceof ClaimRequiredError) {
              return toEnvelopeResult(
                envelope("billing_blocked", err.message, {
                  hint: `Finish setup on the web to continue: ${err.claimUrl}`,
                }),
              );
            }
            // Claim status unverifiable — fail closed as a retryable
            // internal_error (an infra fault), NOT a claim prompt and NOT a
            // token-spending allow. Mirrors the route's 503.
            if (err instanceof ClaimCheckFailedError) {
              return toEnvelopeResult(
                envelope("internal_error", err.message, { request_id: requestId, retry_after: 2 }),
              );
            }
            // Billing block. Gate-0 (`checksBilling`) normally catches a blocked
            // workspace first, so this is a defensive fallback for a state that
            // changed mid-run. Map exactly like billing-gate.ts: throttle →
            // rate_limited, 503 → internal_error, else → billing_blocked.
            if (err instanceof BillingBlockedError) {
              if (err.errorCode === "workspace_throttled") {
                return toEnvelopeResult(
                  envelope("rate_limited", err.message, {
                    ...(err.retryAfterSeconds !== undefined && { retry_after: err.retryAfterSeconds }),
                  }),
                );
              }
              if (err.httpStatus === 503) {
                return toEnvelopeResult(
                  envelope("internal_error", err.message, { request_id: requestId }),
                );
              }
              return toEnvelopeResult(
                envelope("billing_blocked", err.message, { hint: BILLING_BLOCKED_HINT }),
              );
            }
            // Anything else (provider/LLM errors, unexpected throws) → let the
            // shared dispatch surface a typed `internal_error` with request_id.
            throw err;
          }

          // Approval branch: one of the agent's SELECTs hit an approval rule and
          // was parked (origin=mcp). Surface it as the `approval_required`
          // governance signal (NOT an error) so the client re-runs the identical
          // call once approved, mirroring executeSQL/runMetric.
          if (result.pendingApproval) {
            // #4199 — shared validated builder: #3584 safeParse guard (a null
            // approvalId is omitted, never emitted as `approval_request_id:
            // null`) + #3750 resume hint.
            const { requestId: approvalId, matchedRules, message } = result.pendingApproval;
            return approvalRequiredResult({
              approvalRequestId: approvalId,
              matchedRules,
              message,
              extra: {
                answer: result.answer,
                ...(result.sql.length > 0 ? { sql: result.sql } : {}),
              },
            });
          }

          // Data branch: the prose answer, the SQL the agent ran, the result
          // sets, the step count, and Atlas-plan token spend (the double-billing
          // cost surfaced back — the client already paid its own LLM).
          return toStructuredContent({
            answer: result.answer,
            sql: result.sql,
            data: result.data,
            steps: result.steps,
            usage: { total_tokens: result.usage.totalTokens },
          });
        },
      ),
  );
}
