/**
 * Tests for the composed Atlas-token gate seam (`checkAgentQueryGates`,
 * #4128 / ADR-0018).
 *
 * The seam's whole job is the ORDERING: Gate 0 (solvency) runs first and a
 * block there short-circuits BEFORE the claim check — so an expired trial
 * reports `trial_expired`, never `claim_required` — and both gates ride one
 * door, so a new Atlas-token caller can't get one without the other. Uses
 * the injectable-deps seam (no `mock.module`), matching the claim-gate /
 * reaper test style. The executeAgentQuery-level integration (throws, zero
 * agent spend) is pinned separately in
 * `lib/__tests__/agent-query-claim-gate.test.ts` and `agent-query-billing.test.ts`.
 */

import { describe, it, expect, mock } from "bun:test";
import { checkAgentQueryGates } from "../agent-query-gates";
import type { AgentBillingBlock } from "../agent-gate";

const TRIAL_EXPIRED_BLOCK: AgentBillingBlock = {
  allowed: false,
  errorCode: "trial_expired",
  errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
  httpStatus: 403,
  retryable: false,
};

describe("checkAgentQueryGates — Gate-0-before-claim ordering", () => {
  it("a solvency failure short-circuits BEFORE the claim check (expiry overrides metering)", async () => {
    // Even an unclaimed workspace must surface the Gate 0 block: the claim
    // gate is never consulted.
    const checkClaim = mock(async () => ({
      allowed: false as const,
      reason: "claim_required" as const,
      claimUrl: "https://app.useatlas.dev/claim",
    }));

    const result = await checkAgentQueryGates("org-expired", {
      checkBillingGate: async () => TRIAL_EXPIRED_BLOCK,
      checkClaimGate: checkClaim,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.gate).toBe("billing");
    if (result.gate !== "billing") throw new Error("unreachable");
    expect(result.block.errorCode).toBe("trial_expired");
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("blocks an unclaimed (metered) workspace once Gate 0 passes", async () => {
    const result = await checkAgentQueryGates("org-metered", {
      checkBillingGate: async () => ({ allowed: true }),
      checkClaimGate: async () => ({
        allowed: false,
        reason: "claim_required",
        claimUrl: "https://app.useatlas.dev/claim?email=owner%40acme.com",
      }),
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.gate).toBe("claim");
    if (result.gate !== "claim") throw new Error("unreachable");
    expect(result.reason).toBe("claim_required");
    if (result.reason !== "claim_required") throw new Error("unreachable");
    expect(result.claimUrl).toContain("/claim");
  });

  it("surfaces an indeterminate claim status as the retryable check_failed arm (fail closed)", async () => {
    const result = await checkAgentQueryGates("org-unknown", {
      checkBillingGate: async () => ({ allowed: true }),
      checkClaimGate: async () => ({ allowed: false, reason: "check_failed" }),
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.gate).toBe("claim");
    if (result.gate !== "claim") throw new Error("unreachable");
    expect(result.reason).toBe("check_failed");
  });

  it("consults BOTH gates with the same org and allows when both allow", async () => {
    const checkBilling = mock(async (_orgId: string | undefined) => ({ allowed: true as const }));
    const checkClaim = mock(async (_orgId: string | undefined) => ({ allowed: true as const }));

    const result = await checkAgentQueryGates("org-claimed", {
      checkBillingGate: checkBilling,
      checkClaimGate: checkClaim,
    });

    expect(result.allowed).toBe(true);
    expect(checkBilling).toHaveBeenCalledWith("org-claimed");
    expect(checkClaim).toHaveBeenCalledWith("org-claimed");
  });

  it("passes Gate 0's plan-limit warning through on the allowed arm", async () => {
    const warning = {
      code: "plan_limit_warning" as const,
      message: "You are approaching your included usage credit (85% used).",
      metrics: [],
    };

    const result = await checkAgentQueryGates("org-warn", {
      checkBillingGate: async () => ({ allowed: true, warning }),
      checkClaimGate: async () => ({ allowed: true }),
    });

    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("unreachable");
    expect(result.warning).toEqual(warning);
  });
});
