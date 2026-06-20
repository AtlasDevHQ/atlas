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
import * as realDurable from "@atlas/api/lib/durable-session";
import type { ResumeClaim } from "@atlas/api/lib/durable-session";

let durabilityEnabled = true;
let leaseSeconds = 300;
let nextClaim: ResumeClaim = { status: "none" };
const releaseCalls: Array<{ runId: string; leaseOwner: string }> = [];
let lastClaimArgs: { conversationId: string; leaseSeconds: number } | null = null;

mock.module("@atlas/api/lib/durable-session", () => ({
  ...realDurable,
  isDurabilityEnabled: () => durabilityEnabled,
  getResumeLeaseSeconds: () => leaseSeconds,
  loadAndLeaseResumableRun: async (conversationId: string, secs: number) => {
    lastClaimArgs = { conversationId, leaseSeconds: secs };
    return nextClaim;
  },
  releaseResumeLease: (runId: string, leaseOwner: string) => {
    releaseCalls.push({ runId, leaseOwner });
  },
}));

const { prepareResume, finishResume } = await import("@atlas/api/lib/durable-resume");

beforeEach(() => {
  durabilityEnabled = true;
  leaseSeconds = 300;
  nextClaim = { status: "none" };
  releaseCalls.length = 0;
  lastClaimArgs = null;
});

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
