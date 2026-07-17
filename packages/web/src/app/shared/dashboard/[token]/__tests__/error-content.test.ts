import { describe, expect, test } from "bun:test";
import { resolveErrorContent } from "../error-content";

// #4690 — the standalone shared-dashboard page must NOT conflate 401 and 403.
// These tests pin the acceptance criteria:
//   - 401 (login-required) keeps the login redirect.
//   - 403 (membership-required) never presents a bare "Log in" as the only action
//     and explains the membership requirement, offering a home ("Go to Atlas")
//     path instead.
describe("resolveErrorContent (#4690)", () => {
  test("login-required (401) keeps the login redirect and a distinct heading", () => {
    const c = resolveErrorContent("login-required");
    expect(c.primaryAction).toBe("login");
    expect(c.heading).toMatch(/sign in/i);
    expect(c.heading).not.toMatch(/authentication required/i);
    expect(c.showTryAgain).toBe(false);
  });

  test("membership-required (403) does NOT offer login — points at Atlas instead", () => {
    const c = resolveErrorContent("membership-required");
    // The crux of the bug: a signed-in wrong-org viewer must not be dead-ended on
    // a "Log in" CTA. Primary action is the neutral home link.
    expect(c.primaryAction).toBe("home");
    expect(c.primaryAction).not.toBe("login");
    // Copy explains the membership requirement rather than telling them to log in.
    expect(c.message).toMatch(/not a member|member of/i);
    expect(c.message).not.toMatch(/log in|sign in/i);
    expect(c.showTryAgain).toBe(false);
  });

  test("the two auth reasons resolve to distinct headings and messages", () => {
    const login = resolveErrorContent("login-required");
    const membership = resolveErrorContent("membership-required");
    expect(login.heading).not.toBe(membership.heading);
    expect(login.message).not.toBe(membership.message);
  });

  test("transient failures offer Try again; not-found does not", () => {
    expect(resolveErrorContent("expired").showTryAgain).toBe(true);
    expect(resolveErrorContent("network-error").showTryAgain).toBe(true);
    expect(resolveErrorContent("server-error").showTryAgain).toBe(true);
    expect(resolveErrorContent("not-found").showTryAgain).toBe(false);
  });

  test("only login-required uses the login CTA; every other reason goes home", () => {
    const reasons = [
      "membership-required",
      "expired",
      "not-found",
      "network-error",
      "server-error",
    ] as const;
    for (const r of reasons) {
      expect(resolveErrorContent(r).primaryAction).toBe("home");
    }
    expect(resolveErrorContent("login-required").primaryAction).toBe("login");
  });
});
