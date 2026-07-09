/**
 * Concrete email dispatcher — maps a `sendEmail` DeliveryResult onto the
 * outbox's DispatchOutcome. The send function is injected so this test
 * needs no module mock of the (heavy) delivery layer.
 */

import { describe, expect, mock, test } from "bun:test";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }),
}));

const { makeEmailDispatcher } = await import("../dispatch");
type ClaimedEmailRow = import("../outbox").ClaimedEmailRow;

const ROW: ClaimedEmailRow = {
  id: "row-1",
  emailType: "password-reset",
  message: { to: "user@example.com", subject: "Reset", html: "<p>x</p>" },
  orgId: null,
  attempts: 1,
  expiresAt: null,
};

describe("makeEmailDispatcher", () => {
  test("forwards the message + orgId to the send fn and maps success to ok", async () => {
    const calls: Array<{ to: string; orgId: string | undefined }> = [];
    const dispatcher = makeEmailDispatcher(async (msg, orgId) => {
      calls.push({ to: msg.to, orgId });
      return { success: true, provider: "resend", messageId: "m1" };
    });
    const outcome = await dispatcher({ ...ROW, orgId: "org-9" });
    expect(outcome.kind).toBe("ok");
    expect(calls).toEqual([{ to: "user@example.com", orgId: "org-9" }]);
  });

  test("passes undefined (not null) orgId for session-less sends", async () => {
    let seen: string | undefined = "sentinel";
    const dispatcher = makeEmailDispatcher(async (_msg, orgId) => {
      seen = orgId;
      return { success: true, provider: "resend" };
    });
    await dispatcher(ROW);
    expect(seen).toBeUndefined();
  });

  test("maps a delivery failure to a transient outcome carrying the provider error", async () => {
    const dispatcher = makeEmailDispatcher(async () => ({
      success: false,
      provider: "resend",
      error: "Resend API returned 503: upstream down",
    }));
    const outcome = await dispatcher(ROW);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.message).toMatch(/503/);
    }
  });

  test("synthesizes a message when a failure carries no error string", async () => {
    const dispatcher = makeEmailDispatcher(async () => ({ success: false, provider: "log" }));
    const outcome = await dispatcher(ROW);
    expect(outcome.kind).toBe("transient");
    if (outcome.kind === "transient") {
      expect(outcome.message).toMatch(/log/);
    }
  });
});
