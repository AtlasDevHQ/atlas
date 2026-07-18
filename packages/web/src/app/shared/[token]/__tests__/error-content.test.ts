import { describe, expect, test } from "bun:test";
import { resolveConversationErrorContent } from "../error-content";
import type { FailReason } from "../share-result";

// #4719 — the conversation surface's error copy feeds the shared `ErrorShell`
// CTA policy. Pin the #4690 crux: `login-required` (and only it) gets the
// login CTA; the signed-in wrong-org viewer is never dead-ended on "Log in".
describe("resolveConversationErrorContent (#4719)", () => {
  test("login-required is the ONLY reason that offers the login CTA", () => {
    const reasons: FailReason[] = [
      "login-required",
      "membership-required",
      "expired",
      "not-found",
      "server-error",
      "network-error",
    ];
    for (const reason of reasons) {
      const content = resolveConversationErrorContent(reason);
      expect(content.primaryAction).toBe(reason === "login-required" ? "login" : "home");
    }
  });

  test("auth-wall and not-found reasons never offer Try again; transient ones do", () => {
    expect(resolveConversationErrorContent("login-required").showTryAgain).toBe(false);
    expect(resolveConversationErrorContent("membership-required").showTryAgain).toBe(false);
    expect(resolveConversationErrorContent("not-found").showTryAgain).toBe(false);
    expect(resolveConversationErrorContent("expired").showTryAgain).toBe(true);
    expect(resolveConversationErrorContent("network-error").showTryAgain).toBe(true);
    expect(resolveConversationErrorContent("server-error").showTryAgain).toBe(true);
  });

  test("membership copy explains the org requirement, not a sign-in ask", () => {
    const content = resolveConversationErrorContent("membership-required");
    expect(content.heading).toContain("access");
    expect(content.message).toContain("organization");
    expect(content.message).not.toMatch(/sign in/i);
  });

  test("expired copy is distinct from not-found", () => {
    expect(resolveConversationErrorContent("expired").heading).not.toBe(
      resolveConversationErrorContent("not-found").heading,
    );
  });
});
