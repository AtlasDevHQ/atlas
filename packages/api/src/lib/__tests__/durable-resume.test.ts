/**
 * Unit tests for the crash-resume entry point (#3747, ADR-0020 phase 2).
 *
 * `prepareResume` is the resume DECISION the chat route calls: gate on the
 * per-workspace durability flag, claim the single-resumer lease, and map the
 * claim outcome to a route-actionable result. These tests mock the durability
 * layer (`loadAndLeaseResumableRun` / settings readers) and pin each branch —
 * notably the single-flight `leased` rejection and the fail-closed `error`
 * mapping (a claim failure must never surface as `resumable`).
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { ModelMessage } from "ai";
import * as realDurable from "@atlas/api/lib/durable-session";
import type {
  ResumeClaim,
  ParkedRun,
  ResolveParkedRunOutcome,
  LoadParkedRunResult,
} from "@atlas/api/lib/durable-session";

let durabilityEnabled = true;
let leaseSeconds = 300;
let nextClaim: ResumeClaim = { status: "none" };
const releaseCalls: Array<{ runId: string; leaseOwner: string }> = [];
let lastClaimArgs: { conversationId: string; leaseSeconds: number } | null = null;
// #3748 — approval-park resolution mocks.
let nextLoadResult: LoadParkedRunResult = { status: "none" };
let resolveResult: ResolveParkedRunOutcome = "resolved";
const resolveCalls: Array<{ runId: string; transcript: ModelMessage[]; stepIndex: number }> = [];
let lastLoadParkRef: string | null = null;

mock.module("@atlas/api/lib/durable-session", () => ({
  ...realDurable,
  isDurabilityEnabled: () => durabilityEnabled,
  getResumeLeaseSeconds: () => leaseSeconds,
  loadAndLeaseResumableRun: async (conversationId: string, secs: number) => {
    lastClaimArgs = { conversationId, leaseSeconds: secs };
    return nextClaim;
  },
  releaseResumeLease: ({ runId, leaseOwner }: { runId: string; leaseOwner: string }) => {
    releaseCalls.push({ runId, leaseOwner });
  },
  loadParkedRunByApprovalRef: async (approvalRequestId: string) => {
    lastLoadParkRef = approvalRequestId;
    return nextLoadResult;
  },
  resolveParkedRun: async (args: { runId: string; transcript: ModelMessage[]; stepIndex: number }) => {
    resolveCalls.push(args);
    return resolveResult;
  },
}));

const { prepareResume, finishResume, resolveApprovalPark } = await import("@atlas/api/lib/durable-resume");

beforeEach(() => {
  durabilityEnabled = true;
  leaseSeconds = 300;
  nextClaim = { status: "none" };
  releaseCalls.length = 0;
  lastClaimArgs = null;
  nextLoadResult = { status: "none" };
  resolveResult = "resolved";
  resolveCalls.length = 0;
  lastLoadParkRef = null;
});

/** A parked run whose transcript ends in the executeSQL needs-approval marker. */
function parkedRun(approvalRequestId: string): ParkedRun {
  return {
    runId: "run-9",
    conversationId: "conv-1",
    orgId: "org-1",
    stepIndex: 2,
    parkedReason: approvalRequestId,
    transcript: [
      { role: "user", content: "show revenue" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "executeSQL",
            output: {
              type: "json",
              value: { success: false, approval_required: true, approval_request_id: approvalRequestId },
            },
          },
        ],
      } as unknown as ModelMessage,
    ],
  };
}

describe("prepareResume", () => {
  it("returns disabled (and never touches the store) when durability is off", async () => {
    durabilityEnabled = false;
    const result = await prepareResume("conv-1", "org-1");
    expect(result.status).toBe("disabled");
    // Short-circuits before the claim — no lease query when resume is unavailable.
    expect(lastClaimArgs).toBeNull();
  });

  it("returns resumable with the handle when a run is claimed", async () => {
    nextClaim = {
      status: "resumable",
      run: {
        runId: "run-9",
        conversationId: "conv-1",
        orgId: "org-1",
        stepIndex: 4,
        transcript: [{ role: "user", content: "hi" }],
        leaseOwner: "lease-token",
      },
    };
    const result = await prepareResume("conv-1", "org-1");
    expect(result.status).toBe("resumable");
    if (result.status !== "resumable") throw new Error("unreachable");
    expect(result.handle.runId).toBe("run-9");
    expect(result.handle.priorStepIndex).toBe(4);
    expect(result.handle.transcript).toEqual([{ role: "user", content: "hi" }]);
    expect(result.handle.leaseOwner).toBe("lease-token");
    // The resolved per-workspace lease TTL is threaded into the claim.
    expect(lastClaimArgs).toEqual({ conversationId: "conv-1", leaseSeconds: 300 });
  });

  it("maps a single-flight rejection to leased", async () => {
    nextClaim = { status: "leased" };
    const result = await prepareResume("conv-1", "org-1");
    expect(result.status).toBe("leased");
  });

  it("maps an empty store to none", async () => {
    nextClaim = { status: "none" };
    expect((await prepareResume("conv-1", "org-1")).status).toBe("none");
  });

  it("maps no_db to none (nothing was ever checkpointed)", async () => {
    nextClaim = { status: "no_db" };
    expect((await prepareResume("conv-1", "org-1")).status).toBe("none");
  });

  it("fails closed — maps a claim error to error, never resumable", async () => {
    nextClaim = { status: "error" };
    const result = await prepareResume("conv-1", "org-1");
    expect(result.status).toBe("error");
  });
});

describe("finishResume", () => {
  it("releases the lease held by the handle", () => {
    finishResume({ runId: "run-9", leaseOwner: "lease-token" });
    expect(releaseCalls).toEqual([{ runId: "run-9", leaseOwner: "lease-token" }]);
  });
});

describe("resolveApprovalPark (#3748)", () => {
  it("approve: rewrites the transcript and re-arms the run, returning resumed", async () => {
    nextLoadResult = { status: "found", run: parkedRun("req-42") };
    const result = await resolveApprovalPark("req-42", "approve", { reviewerLabel: "admin@x.com" });

    expect(result.status).toBe("resumed");
    if (result.status !== "resumed") throw new Error("unreachable");
    expect(result.conversationId).toBe("conv-1");
    expect(result.runId).toBe("run-9");
    // Loaded by the approval-queue ref (the parked_reason link).
    expect(lastLoadParkRef).toBe("req-42");

    // The transcript handed to resolveParkedRun no longer carries the
    // needs-approval marker — it was rewritten to an approved result.
    expect(resolveCalls).toHaveLength(1);
    const written = resolveCalls[0]!;
    expect(written.runId).toBe("run-9");
    expect(written.stepIndex).toBe(2);
    const toolMsg = written.transcript.find((m) => m.role === "tool")!;
    const part = (toolMsg.content as unknown[])[0] as { output: { value: Record<string, unknown> } };
    expect(part.output.value.approval_resolved).toBe("approved");
    expect(part.output.value.approval_required).toBe(false);
    expect(String(part.output.value.message)).toContain("admin@x.com");
  });

  it("deny: rewrites the transcript to a denial and re-arms the run", async () => {
    nextLoadResult = { status: "found", run: parkedRun("req-42") };
    const result = await resolveApprovalPark("req-42", "deny", { comment: "prod frozen" });

    expect(result.status).toBe("resumed");
    const toolMsg = resolveCalls[0]!.transcript.find((m) => m.role === "tool")!;
    const part = (toolMsg.content as unknown[])[0] as { output: { value: Record<string, unknown> } };
    expect(part.output.value.approval_resolved).toBe("denied");
    expect(String(part.output.value.message)).toContain("prod frozen");
  });

  it("returns none and never writes when no parked run is waiting (benign)", async () => {
    nextLoadResult = { status: "none" };
    const result = await resolveApprovalPark("req-x", "approve");
    expect(result.status).toBe("none");
    expect(resolveCalls).toHaveLength(0);
  });

  it("returns failed (never writes) when the parked run could not be loaded (DB read blip)", async () => {
    // A read-side DB error must NOT slip through as benign `none` — a recorded
    // decision may have a turn stuck behind it. Surface as actionable `failed`.
    nextLoadResult = { status: "error" };
    const result = await resolveApprovalPark("req-42", "approve");
    expect(result.status).toBe("failed");
    expect(resolveCalls).toHaveLength(0);
  });

  it("returns none when the re-arm UPDATE matched nothing (concurrent / double review)", async () => {
    nextLoadResult = { status: "found", run: parkedRun("req-42") };
    resolveResult = "noop";
    const result = await resolveApprovalPark("req-42", "approve");
    // A no-op re-arm (already resolved by a concurrent review) is benign, not failed.
    expect(result.status).toBe("none");
    // It still attempted the write — the row was just already resolved.
    expect(resolveCalls).toHaveLength(1);
  });

  it("fails CLOSED (returns failed, never writes) when the parked transcript has no matching marker", async () => {
    // A parked run is waiting (parked_reason = req-42), but its stored transcript
    // carries a DIFFERENT marker (req-stale) — corruption / encoding drift. The
    // resolver must NOT flip it back to `running` carrying a stale needs-approval
    // result (which would just re-park on resume): it leaves the run parked for
    // the sweep and surfaces `failed`.
    nextLoadResult = { status: "found", run: { ...parkedRun("req-stale"), parkedReason: "req-42" } };
    const result = await resolveApprovalPark("req-42", "approve");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.runId).toBe("run-9");
    // Never attempted the re-arm write — fail closed, not arm-then-hope.
    expect(resolveCalls).toHaveLength(0);
  });

  it("returns failed when the re-arm write errors (DB blip after a recorded decision)", async () => {
    nextLoadResult = { status: "found", run: parkedRun("req-42") };
    resolveResult = "error";
    const result = await resolveApprovalPark("req-42", "approve");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.runId).toBe("run-9");
    // It DID attempt the write — the failure is a real DB error, surfaced as actionable.
    expect(resolveCalls).toHaveLength(1);
  });
});
