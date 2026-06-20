/**
 * #3750 — chat resume-delivery registry port.
 *
 * Pins the register/clear/get singleton + the NULL fallback (so a self-hosted
 * deployment without the chat plugin never fails an approval review for lack
 * of a deliverer).
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  registerChatResumeDeliverer,
  clearChatResumeDeliverer,
  getChatResumeDeliverer,
  NULL_RESUME_DELIVERER,
  type ChatResumeDeliverer,
} from "../resume-delivery-registry";

afterEach(() => {
  clearChatResumeDeliverer();
});

describe("chat resume-delivery registry (#3750)", () => {
  it("returns NULL_RESUME_DELIVERER when nothing is registered", () => {
    expect(getChatResumeDeliverer()).toBe(NULL_RESUME_DELIVERER);
  });

  it("NULL deliverer reports no_deliverer so the review still succeeds", async () => {
    const outcome = await NULL_RESUME_DELIVERER.deliverResumedTurn({
      conversationId: "c",
      orgId: "o",
      platform: "slack",
      threadId: "t",
      externalId: "T0",
    });
    expect(outcome).toEqual({ status: "no_deliverer" });
  });

  it("returns the registered deliverer after registration", async () => {
    const impl: ChatResumeDeliverer = {
      async deliverResumedTurn() {
        return { status: "delivered" };
      },
    };
    registerChatResumeDeliverer(impl);
    expect(getChatResumeDeliverer()).toBe(impl);
    expect(await getChatResumeDeliverer().deliverResumedTurn({
      conversationId: "c",
      orgId: "o",
      platform: "slack",
      threadId: "t",
      externalId: "T0",
    })).toEqual({ status: "delivered" });
  });

  it("clear restores the NULL fallback", () => {
    registerChatResumeDeliverer({ async deliverResumedTurn() { return { status: "delivered" }; } });
    clearChatResumeDeliverer();
    expect(getChatResumeDeliverer()).toBe(NULL_RESUME_DELIVERER);
  });
});
