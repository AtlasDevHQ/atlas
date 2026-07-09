/**
 * Tests for the claim-gate seam in `executeAgentQuery` (ADR-0018 / #3651).
 *
 * Pins the contract that the metered claim-gate is consulted AFTER Gate 0 on
 * the Atlas-token path, and that a block throws `ClaimRequiredError` (carrying
 * the claim URL) with ZERO agent spend — while an allowed (claimed) workspace
 * runs the agent normally. The gate's own block-vs-allow matrix lives in
 * `billing/__tests__/claim-gate.test.ts`; here it is mocked at the module
 * boundary, alongside an always-allow billing gate so the two seams are
 * independent.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockRunAgent = mock(async () => ({
  text: Promise.resolve("answer"),
  steps: Promise.resolve([]),
  totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

// Gate 0 result is controllable so we can assert the expiry block precedes
// (and overrides) the claim-gate. Default: allow.
class BillingBlockedErrorStub extends Error {
  override readonly name = "BillingBlockedError";
  readonly errorCode: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly usage: undefined;
  constructor(block: { errorCode: string; errorMessage: string; httpStatus: number; retryable: boolean }) {
    super(block.errorMessage);
    this.errorCode = block.errorCode;
    this.httpStatus = block.httpStatus;
    this.retryable = block.retryable;
    this.retryAfterSeconds = undefined;
    this.usage = undefined;
  }
}

type GateResult =
  | { allowed: true }
  | { allowed: false; errorCode: string; errorMessage: string; httpStatus: number; retryable: boolean };
let gateResult: GateResult = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId: string | undefined) => gateResult);

void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError: BillingBlockedErrorStub,
}));

// Faithful stand-in — `executeAgentQuery` throws this; callers narrow via
// `instanceof`.
class ClaimRequiredErrorStub extends Error {
  override readonly name = "ClaimRequiredError";
  readonly errorCode = "claim_required" as const;
  readonly httpStatus = 403 as const;
  readonly claimUrl: string;
  constructor(claimUrl: string) {
    super(`claim required: ${claimUrl}`);
    this.claimUrl = claimUrl;
  }
}

class ClaimCheckFailedErrorStub extends Error {
  override readonly name = "ClaimCheckFailedError";
  readonly errorCode = "claim_check_failed" as const;
  readonly httpStatus = 503 as const;
  readonly retryable = true as const;
  constructor() {
    super("Unable to verify your workspace's claim status. Please try again.");
  }
}

type ClaimResult =
  | { allowed: true }
  | { allowed: false; reason: "claim_required"; claimUrl: string }
  | { allowed: false; reason: "check_failed" };
let claimResult: ClaimResult = { allowed: true };
const mockCheckClaimGate = mock(async (_orgId: string | undefined) => claimResult);

void mock.module("@atlas/api/lib/billing/claim-gate", () => ({
  checkClaimGate: mockCheckClaimGate,
  ClaimRequiredError: ClaimRequiredErrorStub,
  ClaimCheckFailedError: ClaimCheckFailedErrorStub,
  buildClaimUrl: (email?: string) => `https://app.useatlas.dev/signup${email ? `?email=${email}` : ""}`,
}));

const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
const { createAtlasUser } = await import("@atlas/api/lib/auth/types");

describe("executeAgentQuery claim-gate seam", () => {
  beforeEach(() => {
    claimResult = { allowed: true };
    gateResult = { allowed: true };
    mockRunAgent.mockClear();
    mockCheckClaimGate.mockClear();
    mockCheckAgentBillingGate.mockClear();
  });

  it("consults the claim-gate with the actor's org", async () => {
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-1",
    });
    await executeAgentQuery("how many customers?", "req-1", { actor });
    expect(mockCheckClaimGate).toHaveBeenCalledWith("org-1");
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("throws ClaimRequiredError and never runs the agent when unclaimed", async () => {
    claimResult = { allowed: false, reason: "claim_required", claimUrl: "https://app.useatlas.dev/signup?email=owner@acme.com" };
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-metered",
    });
    const err: unknown = await executeAgentQuery("question", "req-2", { actor }).then(
      () => {
        throw new Error("expected executeAgentQuery to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaimRequiredErrorStub);
    if (!(err instanceof ClaimRequiredErrorStub)) throw new Error("unreachable");
    expect(err.claimUrl).toContain("/signup");
    expect(err.errorCode).toBe("claim_required");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("runs the agent normally once the workspace is claimed (gate allows)", async () => {
    claimResult = { allowed: true };
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-claimed",
    });
    const result = await executeAgentQuery("question", "req-3", { actor });
    expect(result.answer).toBe("answer");
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED with ClaimCheckFailedError (no agent spend) when claim status can't be verified", async () => {
    claimResult = { allowed: false, reason: "check_failed" };
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-unknown",
    });
    const err: unknown = await executeAgentQuery("question", "req-5", { actor }).then(
      () => {
        throw new Error("expected executeAgentQuery to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ClaimCheckFailedErrorStub);
    if (!(err instanceof ClaimCheckFailedErrorStub)) throw new Error("unreachable");
    expect(err.errorCode).toBe("claim_check_failed");
    expect(err.httpStatus).toBe(503);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // AC5/AC7 (#3651) — an EXPIRED trial blocks via Gate 0 (`trial_expired`)
  // BEFORE the claim-gate runs, so expiry overrides the meter: an
  // unclaimed-AND-expired workspace gets `trial_expired` (block + pay), never
  // `claim_required`. This pins the gate ordering this feature introduced;
  // the cross-surface expiry block (setup + MCP) is covered by Gate 0's own
  // tests (billing/agent-gate, mcp tools/dispatch-gate/datasource-tools).
  it("expired trial blocks at Gate 0 before the claim-gate is consulted (expiry overrides metering)", async () => {
    gateResult = {
      allowed: false,
      errorCode: "trial_expired",
      errorMessage: "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
      httpStatus: 403,
      retryable: false,
    };
    // Even if the workspace is also unclaimed, expiry must win.
    claimResult = { allowed: false, reason: "claim_required", claimUrl: "https://app.useatlas.dev/signup" };
    const actor = createAtlasUser("user-1", "managed", "user-1@example.com", {
      activeOrganizationId: "org-expired",
    });
    const err: unknown = await executeAgentQuery("question", "req-4", { actor }).then(
      () => {
        throw new Error("expected executeAgentQuery to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BillingBlockedErrorStub);
    if (!(err instanceof BillingBlockedErrorStub)) throw new Error("unreachable");
    expect(err.errorCode).toBe("trial_expired");
    // Claim-gate never consulted — Gate 0 short-circuited first.
    expect(mockCheckClaimGate).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});
