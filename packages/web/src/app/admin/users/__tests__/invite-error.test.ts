/**
 * #5436 follow-up — the invite dialog's error text.
 *
 * The prod incident was a 500 thrown from `afterCreateInvitation` AFTER
 * the invitation row was committed and the email had been sent. Better
 * Auth's client returned `{ status: 500, statusText: "Internal Server
 * Error" }` with NO `message`, and the dialog rendered the bare fallback
 * "Failed to send invitation." — which names the one step that had
 * actually succeeded, and steers the admin toward a retry that stacks a
 * duplicate pending row against the seat cap.
 *
 * These tests pin the two properties that matter: a message-less failure
 * still says what happened, and a 5xx explicitly warns that the
 * invitation may already exist.
 */

import { describe, it, expect } from "bun:test";
import { inviteErrorMessage } from "../invite-error";

describe("inviteErrorMessage", () => {
  it("prefers the server's own message when there is one", () => {
    expect(
      inviteErrorMessage({
        message: "Workspace seat limit reached.",
        status: 429,
        statusText: "Too Many Requests",
      }),
    ).toBe("Workspace seat limit reached.");
  });

  it("ignores a blank message rather than rendering an empty banner", () => {
    const msg = inviteErrorMessage({ message: "   ", status: 400, statusText: "Bad Request" });
    expect(msg).toContain("HTTP 400");
  });

  it("names the status when the server gives no message (the #5436 shape)", () => {
    // Exactly what Better Auth's client returned during the incident.
    const msg = inviteErrorMessage({ status: 500, statusText: "Internal Server Error" });

    expect(msg).toContain("HTTP 500");
    expect(msg).toContain("Internal Server Error");
    // The whole point: do NOT let the admin read this as "the email failed"
    // and retry into a duplicate.
    expect(
      msg.toLowerCase(),
      "a 5xx must warn that the invitation may already exist",
    ).toContain("may already have been created");
    expect(msg.toLowerCase()).toContain("before retrying");
  });

  it("does not claim possible-duplicate on a 4xx (nothing was created)", () => {
    const msg = inviteErrorMessage({ status: 403, statusText: "Forbidden" });

    expect(msg).toContain("HTTP 403");
    expect(msg.toLowerCase()).not.toContain("may already have been created");
  });

  it("distinguishes a request that never reached the server", () => {
    // The thrown-Error arm: no status at all. Retrying IS safe here, so the
    // duplicate warning would be actively misleading.
    const msg = inviteErrorMessage({ message: null });

    expect(msg.toLowerCase()).toContain("didn't reach the server");
    expect(msg.toLowerCase()).not.toContain("may already have been created");
  });

  it("never returns an empty string, whatever it is handed", () => {
    for (const input of [null, undefined, {}, { message: null, status: null }]) {
      expect(inviteErrorMessage(input).length).toBeGreaterThan(0);
    }
  });
});
