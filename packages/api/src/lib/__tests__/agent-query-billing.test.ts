/**
 * Tests for the billing-enforcement seam in `executeAgentQuery`
 * (#3419 / #3420).
 *
 * Pins the seam contract:
 *  - The gate is consulted with the bound actor's org BEFORE the agent
 *    runs — a blocked workspace produces ZERO LLM spend.
 *  - A block surfaces as `BillingBlockedError` whose `message` is the
 *    user-safe text (chat platforms deliver it verbatim; the scheduler
 *    records it on the run row).
 *  - The 80–109% warning band never blocks; it lands on
 *    `result.planWarning` for surfaces that render it.
 *  - Runs with no org (self-hosted, CLI tooling) pass through.
 *
 * The gate's own composition logic is covered in
 * `billing/__tests__/agent-gate.test.ts`; here it is mocked at the
 * module boundary.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockRunAgent = mock(async () => ({
  text: Promise.resolve("answer"),
  steps: Promise.resolve([]),
  totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

// Faithful stand-in for the real class — `executeAgentQuery` constructs
// it from the gate's block result, and callers narrow via `instanceof`.
class BillingBlockedErrorStub extends Error {
  override readonly name = "BillingBlockedError";
  readonly errorCode: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly usage: { currentUsage: number; limit: number; metric: string } | undefined;
  constructor(block: {
    errorCode: string;
    errorMessage: string;
    httpStatus: number;
    retryable: boolean;
    retryAfterSeconds?: number;
    usage?: { currentUsage: number; limit: number; metric: string };
  }) {
    super(block.errorMessage);
    this.errorCode = block.errorCode;
    this.httpStatus = block.httpStatus;
    this.retryable = block.retryable;
    this.retryAfterSeconds = block.retryAfterSeconds;
    this.usage = block.usage;
  }
}

type GateResult =
  | { allowed: true; warning?: { code: "plan_limit_warning"; message: string; metrics: unknown[] } }
  | { allowed: false; errorCode: string; errorMessage: string; httpStatus: number; retryable: boolean };
let gateResult: GateResult = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId: string | undefined) => gateResult);

mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError: BillingBlockedErrorStub,
}));

const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
const { withRequestContext } = await import("@atlas/api/lib/logger");
const { createAtlasUser } = await import("@atlas/api/lib/auth/types");

describe("executeAgentQuery billing seam", () => {
  beforeEach(() => {
    gateResult = { allowed: true };
    mockRunAgent.mockClear();
    mockCheckAgentBillingGate.mockClear();
  });

  it("consults the gate with the actor's org before running the agent", async () => {
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-1",
    });
    await executeAgentQuery("how many customers?", "req-1", { actor });
    expect(mockCheckAgentBillingGate).toHaveBeenCalledTimes(1);
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-1");
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("throws BillingBlockedError and never runs the agent when blocked", async () => {
    gateResult = {
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
      httpStatus: 403,
      retryable: false,
    };
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-expired",
    });
    const err: unknown = await executeAgentQuery("question", "req-2", { actor }).then(
      () => {
        throw new Error("expected executeAgentQuery to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BillingBlockedErrorStub);
    if (!(err instanceof BillingBlockedErrorStub)) throw new Error("unreachable");
    expect(err.message).toContain("trial has expired");
    expect(err.errorCode).toBe("trial_expired");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("uses the inherited RequestContext user's org when no actor is passed", async () => {
    const user = createAtlasUser("user-parent", "managed", "user-parent@example.com", {
      activeOrganizationId: "org-parent",
    });
    await withRequestContext({ requestId: "outer", user }, async () => {
      await executeAgentQuery("question", "req-3");
    });
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org-parent");
  });

  it("passes the gate undefined when no actor or inherited user exists (self-hosted/CLI)", async () => {
    await executeAgentQuery("question", "req-4");
    expect(mockCheckAgentBillingGate).toHaveBeenCalledWith(undefined);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("surfaces the 80–109% warning band as planWarning without blocking", async () => {
    gateResult = {
      allowed: true,
      warning: {
        code: "plan_limit_warning",
        message: "You are approaching your plan's token budget",
        metrics: [],
      },
    };
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-warn",
    });
    const result = await executeAgentQuery("question", "req-5", { actor });
    expect(result.planWarning?.code).toBe("plan_limit_warning");
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("omits planWarning when the gate allows cleanly", async () => {
    const result = await executeAgentQuery("question", "req-6");
    expect(result.planWarning).toBeUndefined();
  });
});
