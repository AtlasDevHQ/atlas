/**
 * #3750 — chat resume-on-approval delivery glue (`deliverChatResumeIfPending`).
 *
 * Pins the orchestration the approval-review handler invokes after a parked
 * turn is re-armed: load coordinates → call the registered deliverer → consume
 * the pending row on a terminal outcome. Also the benign "no pending" (web
 * turn) and fail-soft paths.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { ChatResumeCoordinates } from "../resume-pending-store";
import type {
  ChatResumeDeliverer,
  ChatResumeDeliveryOutcome,
} from "../resume-delivery-registry";

const mockLoad: Mock<(id: string) => Promise<ChatResumeCoordinates | null>> = mock(async () => null);
const mockClear: Mock<(id: string) => Promise<void>> = mock(async () => {});

void mock.module("@atlas/api/lib/chat-plugin/resume-pending-store", () => ({
  loadResumePending: mockLoad,
  clearResumePending: mockClear,
}));

let deliverer: ChatResumeDeliverer;
void mock.module("@atlas/api/lib/chat-plugin/resume-delivery-registry", () => ({
  getChatResumeDeliverer: () => deliverer,
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { deliverChatResumeIfPending } = await import("../resume-delivery");

const COORDS: ChatResumeCoordinates = {
  platform: "slack",
  threadId: "C1:1.1",
  orgId: "org_1",
  externalId: "T0123",
  externalUserId: "U999",
};

function delivererReturning(outcome: ChatResumeDeliveryOutcome): ChatResumeDeliverer {
  return { deliverResumedTurn: mock(async () => outcome) };
}

beforeEach(() => {
  mockLoad.mockReset();
  mockLoad.mockResolvedValue(null);
  mockClear.mockReset();
  mockClear.mockResolvedValue(undefined);
});

describe("deliverChatResumeIfPending (#3750)", () => {
  it("returns no_pending and does not call the deliverer when no coordinates exist", async () => {
    deliverer = delivererReturning({ status: "delivered" });
    const result = await deliverChatResumeIfPending("conv_web", "approve");
    expect(result).toBe("no_pending");
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("delivers and consumes the pending row on success, passing the full actor binding", async () => {
    mockLoad.mockResolvedValueOnce(COORDS);
    const impl = delivererReturning({ status: "delivered" });
    deliverer = impl;

    const result = await deliverChatResumeIfPending("conv_1", "approve");
    expect(result).toBe("delivered");

    // The deliverer receives the thread target AND the actor binding.
    const input = (impl.deliverResumedTurn as Mock<(i: unknown) => unknown>).mock.calls[0]![0];
    expect(input).toEqual({
      conversationId: "conv_1",
      orgId: "org_1",
      platform: "slack",
      threadId: "C1:1.1",
      externalId: "T0123",
      externalUserId: "U999",
    });
    // Consumed exactly once.
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledWith("conv_1");
  });

  it("clears the coordinate when there is nothing to resume (concurrent resume / re-ask)", async () => {
    mockLoad.mockResolvedValueOnce(COORDS);
    deliverer = delivererReturning({ status: "nothing_to_resume" });
    const result = await deliverChatResumeIfPending("conv_2", "approve");
    expect(result).toBe("nothing_to_resume");
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it("clears the coordinate on a blocked outcome (fail-closed security refusal, no retry)", async () => {
    mockLoad.mockResolvedValueOnce(COORDS);
    deliverer = delivererReturning({ status: "blocked" });
    const result = await deliverChatResumeIfPending("conv_blocked", "approve");
    expect(result).toBe("blocked");
    // A billing block won't clear on retry — consume the coordinate.
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it("leaves the coordinate (for TTL/retry) on a failed delivery", async () => {
    mockLoad.mockResolvedValueOnce(COORDS);
    deliverer = delivererReturning({ status: "failed", reason: "thread_post_failed" });
    const result = await deliverChatResumeIfPending("conv_3", "deny");
    expect(result).toBe("failed");
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("leaves the coordinate when no deliverer is registered", async () => {
    mockLoad.mockResolvedValueOnce(COORDS);
    deliverer = delivererReturning({ status: "no_deliverer" });
    const result = await deliverChatResumeIfPending("conv_4", "approve");
    expect(result).toBe("no_deliverer");
    expect(mockClear).not.toHaveBeenCalled();
  });
});
