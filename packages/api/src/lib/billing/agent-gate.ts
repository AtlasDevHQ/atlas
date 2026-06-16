/**
 * Shared billing-enforcement gate for agent runs (#3419 / #3420).
 *
 * One seam, consulted by `executeAgentQuery` before any LLM spend, so
 * every caller — web `/api/v1/query`, all six chat-platform webhook
 * paths, the scheduler executor, and any future caller — is covered by
 * construction rather than by per-callsite discipline.
 *
 * Composes the three existing checks in order, short-circuiting on the
 * first block:
 *
 *   1. `checkWorkspaceStatus` — suspended / deleted workspaces (and
 *      fail-closed on lookup errors → 503).
 *   2. `checkAbuseStatus` — abuse-suspended (403) and abuse-throttled
 *      (429 + Retry-After) workspaces.
 *   3. `checkPlanLimits` — trial expiry, churned (`locked`) tier, and
 *      the token hard cap (110%+); fail-closed on workspace lookup
 *      errors (503).
 *
 * This module REUSES the tested fail-closed lookups and threshold
 * boundaries in `enforcement.ts` / `workspace.ts` / `abuse.ts` — it
 * adds no policy of its own, only composition and a transport-agnostic
 * envelope (`errorCode` + user-safe `errorMessage` + `httpStatus` +
 * `retryable`), so each surface can shape the block appropriately:
 * HTTP routes map it to their JSON envelope, chat platforms surface
 * `BillingBlockedError.message` as an in-thread reply, and the
 * scheduler records it on the task run.
 *
 * **80–109% warning band:** never blocks. The gate passes the
 * `checkPlanLimits` warning through on the allowed arm; callers that
 * render warnings (the web/API surfaces) attach it to their response,
 * while machine-initiated surfaces (chat platforms, scheduler)
 * intentionally do not render it — the band is already logged by
 * `enforcement.ts` and visible in the admin billing page.
 *
 * **Self-hosted / no billing:** every underlying check short-circuits
 * to allowed when there is no internal DB, no orgId, or (for abuse)
 * a non-SaaS deploy mode — the gate is a no-op passthrough.
 */

import { isRetryableError, type ChatErrorCode } from "@useatlas/types";
import { checkWorkspaceStatus } from "@atlas/api/lib/workspace";
import { checkAbuseStatus } from "@atlas/api/lib/security/abuse";
import { checkPlanLimits, type PlanLimitWarning } from "./enforcement";
import { createLogger } from "@atlas/api/lib/logger";
import { withSpan } from "@atlas/api/lib/tracing";

const log = createLogger("billing:agent-gate");

export interface AgentBillingBlock {
  allowed: false;
  /** Machine-readable code — e.g. `trial_expired`, `workspace_suspended`. */
  errorCode: ChatErrorCode;
  /** User-safe message — surfaced verbatim on chat platforms and run rows. */
  errorMessage: string;
  httpStatus: 403 | 404 | 429 | 503;
  /** Whether retrying (without operator action) may succeed. */
  retryable: boolean;
  /** Set on abuse-throttle blocks so HTTP surfaces can emit Retry-After. */
  retryAfterSeconds?: number;
  /** Set on `plan_limit_exceeded` blocks. */
  usage?: { currentUsage: number; limit: number; metric: string };
}

export type AgentBillingGateResult =
  | { allowed: true; warning?: PlanLimitWarning }
  | AgentBillingBlock;

/**
 * Thrown by `executeAgentQuery` when the gate blocks a run. `message`
 * is the user-safe `errorMessage`, so surfaces that deliver raw error
 * messages to end users (the chat-plugin bridge's error card, the
 * scheduler's run row) are safe by construction.
 *
 * Deliberately a plain `Error` subclass rather than a
 * `Data.TaggedError`: `executeAgentQuery` and its callers are plain
 * async (no Effect context), and the established pattern for errors on
 * that path is `instanceof` sentinels (see the UnknownTenantError
 * family in `lib/chat-plugin/executeQuery.ts`).
 */
export class BillingBlockedError extends Error {
  override readonly name = "BillingBlockedError";
  readonly errorCode: ChatErrorCode;
  readonly httpStatus: 403 | 404 | 429 | 503;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly usage: { currentUsage: number; limit: number; metric: string } | undefined;

  constructor(block: AgentBillingBlock) {
    super(block.errorMessage);
    this.errorCode = block.errorCode;
    this.httpStatus = block.httpStatus;
    this.retryable = block.retryable;
    this.retryAfterSeconds = block.retryAfterSeconds;
    this.usage = block.usage;
  }
}


/**
 * Run the full billing gate for an agent invocation.
 *
 * `orgId` is the workspace of the bound actor (undefined when the run
 * has no org — self-hosted, CLI eval tooling — which always allows).
 * Returns the first block encountered, or `{ allowed: true }` with the
 * optional plan-limit warning (80–109% band) passed through.
 */
export async function checkAgentBillingGate(
  orgId: string | undefined,
): Promise<AgentBillingGateResult> {
  // Span the composed enforcement seam so its three DB-touching checks are
  // attributable on the hot path (a slow checkWorkspaceStatus / checkPlanLimits
  // lookup was previously invisible in traces). Zero overhead when OTel is off.
  return withSpan(
    "billing.agent_gate",
    { "atlas.org_id": orgId ?? "none" },
    () => runAgentBillingGate(orgId),
    (result) => ({
      "atlas.billing.allowed": result.allowed,
      ...(result.allowed ? {} : { "atlas.billing.error_code": result.errorCode }),
    }),
  );
}

async function runAgentBillingGate(
  orgId: string | undefined,
): Promise<AgentBillingGateResult> {
  // 1. Workspace status — suspended / deleted / lookup failure.
  const wsCheck = await checkWorkspaceStatus(orgId);
  if (!wsCheck.allowed) {
    const errorCode = wsCheck.errorCode ?? "workspace_check_failed";
    return {
      allowed: false,
      errorCode,
      errorMessage: wsCheck.errorMessage ?? "Workspace access denied.",
      httpStatus: wsCheck.httpStatus ?? 403,
      retryable: isRetryableError(errorCode),
    };
  }

  if (!orgId) {
    return { allowed: true };
  }

  // 2. Abuse status — in-memory, SaaS-only (returns "none" elsewhere).
  const abuse = checkAbuseStatus(orgId);
  if (abuse.level === "suspended") {
    log.warn({ orgId }, "Agent run blocked: workspace suspended due to abuse");
    return {
      allowed: false,
      errorCode: "workspace_suspended",
      errorMessage:
        "Workspace suspended due to unusual activity. Contact your administrator.",
      httpStatus: 403,
      retryable: false,
    };
  }
  if (abuse.level === "throttled") {
    // Defensive: checkAbuseStatus always supplies throttleDelayMs on the
    // throttled arm (its config floor is > 0), but if a future variant
    // omitted it, still BLOCK with a 1s floor — falling open on an abuse
    // verdict would be a silent fallback on a security check (CLAUDE.md).
    const retryAfterSeconds = Math.max(1, Math.ceil((abuse.throttleDelayMs ?? 1000) / 1000));
    log.warn(
      { orgId, delayMs: abuse.throttleDelayMs },
      "Agent run blocked: workspace throttled due to abuse",
    );
    return {
      allowed: false,
      errorCode: "workspace_throttled",
      errorMessage:
        "Workspace is temporarily throttled due to high usage. Please retry shortly.",
      httpStatus: 429,
      retryable: true,
      retryAfterSeconds,
    };
  }

  // 3. Plan limits — trial expiry, locked tier, token hard cap.
  const planCheck = await checkPlanLimits(orgId);
  if (!planCheck.allowed) {
    return {
      allowed: false,
      errorCode: planCheck.errorCode,
      errorMessage: planCheck.errorMessage,
      httpStatus: planCheck.httpStatus,
      retryable: isRetryableError(planCheck.errorCode),
      ...(planCheck.errorCode === "plan_limit_exceeded" ? { usage: planCheck.usage } : {}),
    };
  }

  return {
    allowed: true,
    ...(planCheck.warning ? { warning: planCheck.warning } : {}),
  };
}
