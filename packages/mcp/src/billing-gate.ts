/**
 * Billing-enforcement gate for MCP datasource-query tools (#3437).
 *
 * MCP tool calls spend no Atlas LLM tokens (the client's own model
 * pays), but a suspended / trial-expired workspace could still pull
 * tenant data out of connected datasources through `executeSQL` and
 * `runMetric`. Both dispatches consult the shared billing gate
 * (`checkAgentBillingGate`, #3419/#3420) — the same composition the web
 * chat, `/api/v1/query`, chat platforms, and scheduler run — before any
 * query executes. Metadata-only tools (`explore`, `listEntities`,
 * `describeEntity`, `searchGlossary`) are deliberately NOT gated: they
 * read semantic YAML, not datasources.
 *
 * Block → envelope mapping (the gate's verdict is typed, so unlike the
 * string classifiers in `error-envelope.ts` no regex is involved):
 *
 * - `workspace_throttled` (abuse throttle, 429) → `rate_limited` +
 *   `retry_after` — the agent's correct recovery (back off) is identical
 *   to every other rate-limit signal.
 * - 503 check failures (`workspace_check_failed` /
 *   `billing_check_failed`) → `internal_error` + `request_id` — fail
 *   closed on an infra fault, but the recovery is "try again / quote the
 *   request id", NOT "upgrade your plan".
 * - everything else (`workspace_suspended`, `workspace_deleted`,
 *   `trial_expired`, `subscription_required`, `plan_limit_exceeded`) →
 *   `billing_blocked` with the gate's user-safe message verbatim and a
 *   hint steering the agent away from a retry loop.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkAgentBillingGate } from "@atlas/api/lib/billing/agent-gate";
import { envelope, toEnvelopeResult } from "./error-envelope.js";
import { createMcpLogger } from "./logger.js";

const log = createMcpLogger("mcp:billing-gate");

const BILLING_BLOCKED_HINT =
  "Retrying will not help. The workspace owner must resolve the workspace's billing or suspension status in Atlas before queries can run.";

/**
 * Run the billing gate for an MCP datasource-query dispatch.
 *
 * Returns `null` when the dispatch should proceed, or a shaped
 * `AtlasMcpToolError` tool result when the workspace is blocked.
 * `orgId` is the actor's `activeOrganizationId` — undefined (stdio
 * self-hosted, trusted-transport `system:mcp` actor) short-circuits to
 * allowed inside the gate. A throw from the gate itself is intentionally
 * NOT caught here: every dispatch wraps this call in its existing
 * try/catch, which fails closed with an `internal_error` envelope.
 */
export async function billingGateOrNull(args: {
  orgId: string | undefined;
  requestId: string;
}): Promise<CallToolResult | null> {
  const gate = await checkAgentBillingGate(args.orgId);
  if (gate.allowed) return null;

  // Carry orgId / requestId / errorCode explicitly so a billing-block line
  // is self-describing in the aggregator even though the mixin would also
  // stamp requestId from the dispatch context (#3494).
  log.warn(
    {
      orgId: args.orgId,
      requestId: args.requestId,
      errorCode: gate.errorCode,
    },
    "dispatch blocked by billing enforcement",
  );

  if (gate.errorCode === "workspace_throttled") {
    return toEnvelopeResult(
      envelope("rate_limited", gate.errorMessage, {
        ...(gate.retryAfterSeconds !== undefined && { retry_after: gate.retryAfterSeconds }),
      }),
    );
  }

  if (gate.httpStatus === 503) {
    // Enforcement infra failure — fail closed, but as "try again", not
    // "upgrade": billing_blocked would misdirect the agent/user toward
    // billing remediation for what is an operator-side fault.
    return toEnvelopeResult(
      envelope("internal_error", gate.errorMessage, { request_id: args.requestId }),
    );
  }

  return toEnvelopeResult(
    envelope("billing_blocked", gate.errorMessage, { hint: BILLING_BLOCKED_HINT }),
  );
}
