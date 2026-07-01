/**
 * The composed billing seam for Atlas-token agent runs (#4128, ADR-0018).
 *
 * `executeAgentQuery` — the single headless Atlas-token path (web
 * `/api/v1/query`, the chat platforms, the scheduler, and the MCP `query`
 * NL tool, #4094) — must consult BOTH gates, in the order the #3651
 * claim-gate seam established and CONTEXT.md records (an expired trial is
 * blocked by Gate 0 regardless of claim state):
 *
 *   1. **Gate 0** (`checkAgentBillingGate`) — solvency: workspace status,
 *      abuse status, plan limits. Owns `trial_expired` / `locked` /
 *      hard-cap on EVERY surface, so an unclaimed-AND-expired trial reports
 *      `trial_expired` (block + pay), never `claim_required`.
 *   2. **The claim-gate** (`checkClaimGate`) — metering: an unclaimed
 *      (metered) trial withholds Atlas-token Q&A until the owner claims the
 *      Workspace on the web.
 *
 * That order used to be two inline blocks in `executeAgentQuery` with a
 * comment as the only guard: a reorder would have silently let an unclaimed
 * trial spend Atlas tokens before the claim check, and a future Atlas-token
 * caller could have bypassed the claim-gate entirely by not copying the
 * second block. This seam encodes the ordering in the function body — any
 * headless Atlas-token caller gets both gates or neither.
 *
 * Web `/api/v1/chat` also spends Atlas tokens but streams via `runAgent`
 * directly and runs Gate 0 at the route (#3451) without the claim-gate: a
 * claim-gateable workspace is one whose owner has no verified credential
 * yet, so on production it cannot hold any credential that route accepts
 * (session, API key, device-flow bearer — all bootstrap from a verified
 * web sign-in). Deliberately NOT used by the Gate-0-only surfaces either
 * (the MCP `checksBilling` tools, `executeSQL`, the setup/metrics routes):
 * those spend no Atlas
 * tokens and must stay open pre-claim — that asymmetry is the point of
 * ADR-0018, and routing them through this seam would close the metered
 * trial's setup path.
 */

import {
  checkAgentBillingGate,
  type AgentBillingBlock,
  type AgentBillingGateResult,
} from "./agent-gate";
import { checkClaimGate, type ClaimGateResult } from "./claim-gate";
import type { PlanLimitWarning } from "./enforcement";

/**
 * Injectable boundaries for {@link checkAgentQueryGates}, so the ordering
 * contract can be exercised without `mock.module` (the same DI seam shape as
 * `ClaimGateDeps` / `ReapDeps`).
 */
export interface AgentQueryGatesDeps {
  readonly checkBillingGate: (orgId: string | undefined) => Promise<AgentBillingGateResult>;
  readonly checkClaimGate: (orgId: string | undefined) => Promise<ClaimGateResult>;
}

export type AgentQueryGatesResult =
  | { allowed: true; warning?: PlanLimitWarning }
  | { allowed: false; gate: "billing"; block: AgentBillingBlock }
  | { allowed: false; gate: "claim"; reason: "claim_required"; claimUrl: string }
  | { allowed: false; gate: "claim"; reason: "check_failed" };

/**
 * Run both gates for an Atlas-token agent run, Gate 0 first. Returns the
 * first block encountered — a solvency failure short-circuits BEFORE the
 * claim check — or `{ allowed: true }` with Gate 0's plan-limit warning
 * (the 80%→ceiling warning/metered bands, #4038) passed through for
 * surfaces that render it.
 *
 * Both underlying gates fail CLOSED on status/claim lookup errors
 * (503-shaped blocks), so this seam never converts an indeterminate
 * billing/claim STATUS into a token spend. (Usage-read failures inside
 * Gate 0 deliberately fail open per #3428, surfacing as an allowed-arm
 * warning — an indeterminate usage amount, not an indeterminate status.)
 */
export async function checkAgentQueryGates(
  orgId: string | undefined,
  overrides: Partial<AgentQueryGatesDeps> = {},
): Promise<AgentQueryGatesResult> {
  const billing = await (overrides.checkBillingGate ?? checkAgentBillingGate)(orgId);
  if (!billing.allowed) {
    return { allowed: false, gate: "billing", block: billing };
  }

  const claim = await (overrides.checkClaimGate ?? checkClaimGate)(orgId);
  if (!claim.allowed) {
    return claim.reason === "claim_required"
      ? { allowed: false, gate: "claim", reason: "claim_required", claimUrl: claim.claimUrl }
      : { allowed: false, gate: "claim", reason: "check_failed" };
  }

  return { allowed: true, ...(billing.warning ? { warning: billing.warning } : {}) };
}
