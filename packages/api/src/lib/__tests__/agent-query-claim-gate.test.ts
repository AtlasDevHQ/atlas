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

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mockRunAgent,
}));

// Gate 0 always allows here — we are isolating the claim-gate. (The expiry
// block via Gate 0 is covered in agent-query-billing.test.ts.)
mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mock(async () => ({ allowed: true })),
  BillingBlockedError: class extends Error {},
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

type ClaimResult = { allowed: true } | { allowed: false; claimUrl: string };
let claimResult: ClaimResult = { allowed: true };
const mockCheckClaimGate = mock(async (_orgId: string | undefined) => claimResult);

mock.module("@atlas/api/lib/billing/claim-gate", () => ({
  checkClaimGate: mockCheckClaimGate,
  ClaimRequiredError: ClaimRequiredErrorStub,
  buildClaimUrl: (email?: string) => `https://app.useatlas.dev/signup${email ? `?email=${email}` : ""}`,
}));

const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
const { createAtlasUser } = await import("@atlas/api/lib/auth/types");

describe("executeAgentQuery claim-gate seam", () => {
  beforeEach(() => {
    claimResult = { allowed: true };
    mockRunAgent.mockClear();
    mockCheckClaimGate.mockClear();
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
    claimResult = { allowed: false, claimUrl: "https://app.useatlas.dev/signup?email=owner@acme.com" };
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
});
