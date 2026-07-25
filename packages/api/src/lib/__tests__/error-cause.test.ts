/**
 * `rootCause` / `rootCauseMessage` (#4773).
 *
 * The properties that matter are the ones that make it worth having at all:
 * it must reach past MORE than one wrapper (a single `err.cause` was the bug),
 * and it must terminate on a cycle, because a helper whose only job is to
 * improve a log line must never be able to hang the request emitting it.
 */

import { describe, expect, it } from "bun:test";
import { rootCause, rootCauseMessage } from "@atlas/api/lib/error-cause";

describe("rootCause", () => {
  it("walks a MULTI-level chain to the driver error", () => {
    // Two deep is the real shape on the brain path:
    // BrainRoleUnresolvedError → MemberRoleLookupError → driver error. A single
    // `err.cause` stops at the middle link, whose message deliberately carries
    // nothing the log payload does not already have.
    const driver = new Error("statement timeout");
    const middle = new Error("Failed to look up org member role", { cause: driver });
    const outer = new Error("brain read refused", { cause: middle });
    expect(rootCause(outer)).toBe(driver);
  });

  it("returns the error itself when there is no cause", () => {
    const bare = new Error("bare");
    expect(rootCause(bare)).toBe(bare);
  });

  it("returns a non-Error cause verbatim rather than coercing it", () => {
    const outer = new Error("wrapped", { cause: "a string rejection" });
    expect(rootCause(outer)).toBe("a string rejection");
  });

  it("passes a non-Error input straight through", () => {
    expect(rootCause(undefined)).toBeUndefined();
    expect(rootCause("boom")).toBe("boom");
  });

  it("terminates on a cycle instead of spinning", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    // Terminating at all is the assertion; WHICH link of the cycle it lands on
    // is arbitrary and deliberately unspecified.
    const resolved = rootCause(a);
    expect(resolved === a || resolved === b).toBe(true);
  });
});

describe("rootCauseMessage", () => {
  it("reports the root message for a wrapped error", () => {
    const outer = new Error("wrapper", { cause: new Error("connection reset by peer") });
    expect(rootCauseMessage(outer)).toBe("connection reset by peer");
  });

  it("returns undefined for an UNWRAPPED error, so a log does not print it twice", () => {
    // Callers log `err` and `cause` side by side; echoing the same sentence
    // into both is noise that reads like corroboration.
    expect(rootCauseMessage(new Error("bare"))).toBeUndefined();
  });
});
