/**
 * #3750 — host-side chat resume primitive (`resumeChatTurn`).
 *
 * Pins acceptance criterion 3 (resume re-resolves auth/scoping live, same
 * fail-closed guarantee as web):
 *   - rebuilds the SAME bot actor that parked (so the approval gate's dedup
 *     clears on re-run) and binds it onto the RequestContext;
 *   - re-runs the billing gate — a workspace suspended while parked is
 *     `blocked`, not resumed;
 *   - claims the single-resumer lease via `prepareResume` and only proceeds on
 *     `resumable` (a concurrent `leased`/`none` resume is skipped);
 *   - re-enters `runAgent({ resume })` with the checkpoint transcript and
 *     returns the continued answer;
 *   - releases the lease in every branch (finally);
 *   - never throws — every failure maps to a result variant.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { PrepareResumeResult } from "../../durable-resume";

const mockRunAgent: Mock<(args: unknown) => Promise<{ text: Promise<string> }>> = mock(
  async () => ({ text: Promise.resolve("continued answer") }),
);
const mockPrepareResume: Mock<() => Promise<PrepareResumeResult>> = mock(async () => ({
  status: "resumable",
  handle: { runId: "run_1", transcript: [], priorStepIndex: 2, leaseOwner: "lease_1" },
}));
const mockFinishResume: Mock<(h: unknown) => void> = mock(() => {});
const mockBillingGate: Mock<() => Promise<{ allowed: boolean; errorCode?: string; errorMessage?: string }>> =
  mock(async () => ({ allowed: true }));

// Capture the bound context so we can assert the actor identity + origin.
let capturedContext: Record<string, unknown> | undefined;

void mock.module("@atlas/api/lib/agent", () => ({ runAgent: mockRunAgent }));
void mock.module("@atlas/api/lib/durable-resume", () => ({
  prepareResume: mockPrepareResume,
  finishResume: mockFinishResume,
}));
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockBillingGate,
}));
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: async (ctx: Record<string, unknown>, fn: () => Promise<unknown>) => {
    capturedContext = ctx;
    return fn();
  },
}));

const { resumeChatTurn } = await import("../resume-turn");

const BASE = {
  conversationId: "conv_1",
  orgId: "org_1",
  platform: "slack" as const,
  externalId: "T0123",
};

beforeEach(() => {
  capturedContext = undefined;
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({ text: Promise.resolve("continued answer") });
  mockPrepareResume.mockReset();
  mockPrepareResume.mockResolvedValue({
    status: "resumable",
    handle: { runId: "run_1", transcript: [], priorStepIndex: 2, leaseOwner: "lease_1" },
  });
  mockFinishResume.mockReset();
  mockBillingGate.mockReset();
  mockBillingGate.mockResolvedValue({ allowed: true });
});

describe("resumeChatTurn (#3750)", () => {
  it("rebuilds the parked actor + origin and returns the continued answer", async () => {
    const result = await resumeChatTurn({ ...BASE, externalUserId: "U999" });
    expect(result).toEqual({ status: "answered", answer: "continued answer" });

    // AC3 — the bound actor is the SAME bot identity that parked.
    const user = capturedContext?.user as { id: string; activeOrganizationId?: string };
    expect(user.id).toBe("slack-bot:T0123:U999");
    expect(user.activeOrganizationId).toBe("org_1");
    expect(capturedContext?.agentOrigin).toBe("slack");

    // The resumed loop re-enters from the checkpoint transcript.
    const runArgs = mockRunAgent.mock.calls[0]![0] as { resume?: { runId: string } };
    expect(runArgs.resume?.runId).toBe("run_1");
    // Lease released.
    expect(mockFinishResume).toHaveBeenCalledTimes(1);
  });

  it("blocks (does not resume) when billing re-resolution refuses", async () => {
    mockBillingGate.mockResolvedValueOnce({
      allowed: false,
      errorCode: "workspace_suspended",
      errorMessage: "This workspace is suspended.",
    });
    const result = await resumeChatTurn(BASE);
    expect(result).toEqual({ status: "blocked", message: "This workspace is suspended." });
    expect(mockPrepareResume).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("skips when there is no resumable run (concurrent resume / nothing armed)", async () => {
    mockPrepareResume.mockResolvedValueOnce({ status: "leased" });
    const result = await resumeChatTurn(BASE);
    expect(result).toEqual({ status: "nothing_to_resume" });
    expect(mockRunAgent).not.toHaveBeenCalled();
    // No lease to release — we never claimed one.
    expect(mockFinishResume).not.toHaveBeenCalled();
  });

  it("maps a failed agent run to failed and still releases the lease", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("agent boom"));
    const result = await resumeChatTurn(BASE);
    expect(result).toEqual({ status: "failed", reason: "agent_run_error" });
    expect(mockFinishResume).toHaveBeenCalledTimes(1);
  });

  it("maps a billing-gate throw to failed without resuming", async () => {
    mockBillingGate.mockRejectedValueOnce(new Error("db down"));
    const result = await resumeChatTurn(BASE);
    expect(result).toEqual({ status: "failed", reason: "billing_gate_error" });
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});
