/**
 * Branch coverage for the passkey sign-in error parser.
 *
 * Pins the canonical "Esc on the OS prompt" path to `kind: "silent"` and
 * the explicit Better Auth error codes to friendly copy. The login + 2FA
 * pages route their full UI behavior off these branches — a regression
 * that flips a cancellation into a banner is exactly what this file is
 * designed to catch.
 */

import { describe, expect, test } from "bun:test";
import { parsePasskeySignInError } from "./parse-passkey-sign-in-error";

describe("parsePasskeySignInError — cancellation (kind: 'silent')", () => {
  test("AUTH_CANCELLED code → silent", () => {
    expect(
      parsePasskeySignInError({
        kind: "wire",
        error: { code: "AUTH_CANCELLED", message: "cancelled", status: 400 },
      }),
    ).toEqual({ kind: "silent" });
  });

  test("REGISTRATION_CANCELLED code → silent", () => {
    expect(
      parsePasskeySignInError({
        kind: "wire",
        error: { code: "REGISTRATION_CANCELLED", message: "cancelled", status: 400 },
      }),
    ).toEqual({ kind: "silent" });
  });

  test("NotAllowedError fragment in message → silent", () => {
    expect(
      parsePasskeySignInError({
        kind: "wire",
        error: { message: "DOMException: NotAllowedError on get()", status: 0 },
      }),
    ).toEqual({ kind: "silent" });
  });
});

describe("parsePasskeySignInError — error codes route to friendly copy", () => {
  test("AUTHENTICATION_FAILED → 'couldn't verify' copy", () => {
    const result = parsePasskeySignInError({
      kind: "wire",
      error: { code: "AUTHENTICATION_FAILED", message: "raw blob", status: 400 },
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("couldn't verify");
    }
  });

  test("PASSKEY_NOT_FOUND → 'no passkey for this device' copy", () => {
    const result = parsePasskeySignInError({
      kind: "wire",
      error: { code: "PASSKEY_NOT_FOUND", message: "raw", status: 404 },
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("No passkey is registered");
    }
  });

  test("CHALLENGE_NOT_FOUND → 'expired challenge' copy", () => {
    const result = parsePasskeySignInError({
      kind: "wire",
      error: { code: "CHALLENGE_NOT_FOUND", message: "raw", status: 400 },
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("challenge expired");
    }
  });

  test("status 429 → rate-limit copy regardless of message wording", () => {
    const result = parsePasskeySignInError({
      kind: "wire",
      error: { status: 429, message: "anything" },
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("Too many attempts");
    }
  });
});

describe("parsePasskeySignInError — thrown branch", () => {
  test("TypeError → 'can't reach the server' copy", () => {
    const result = parsePasskeySignInError({ kind: "thrown", value: new TypeError("fetch failed") });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("Can't reach the server");
    }
  });

  test("plain Error with message → exact message bubbles", () => {
    const result = parsePasskeySignInError({ kind: "thrown", value: new Error("custom failure") });
    expect(result).toEqual({ kind: "user", message: "custom failure" });
  });

  test("non-Error throw → fallback copy", () => {
    const result = parsePasskeySignInError({ kind: "thrown", value: "weird string" });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("didn't complete");
    }
  });
});

describe("parsePasskeySignInError — invalid rpID (#3045)", () => {
  // The browser throws a SecurityError when the page origin isn't valid for
  // the configured rpID. The server-side resolvePasskeyRpId boot assertion
  // makes this unreachable on deploys that configure a web origin; this branch
  // covers the residual self-hosted / single-origin case and turns the raw
  // DOMException blob into actionable "contact your administrator" copy.
  test("thrown SecurityError (Chrome phrasing) → setup-issue copy, not the raw blob", () => {
    const result = parsePasskeySignInError({
      kind: "thrown",
      value: new Error('The RP ID "app.useatlas.dev" is invalid for this domain.'),
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("aren't set up correctly for this site");
      expect(result.message).not.toContain("app.useatlas.dev"); // raw rpID never leaks
    }
  });

  test("thrown 'registrable domain suffix' phrasing → setup-issue copy", () => {
    const result = parsePasskeySignInError({
      kind: "thrown",
      value: new Error(
        "SecurityError: The relying party ID is not a registrable domain suffix of the origin.",
      ),
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("aren't set up correctly for this site");
    }
  });

  test("wire envelope carrying the invalid-rpID message → setup-issue copy", () => {
    const result = parsePasskeySignInError({
      kind: "wire",
      error: { message: 'The RP ID "x" is invalid for this domain', status: 0 },
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("aren't set up correctly for this site");
    }
  });

  test("a message that merely mentions 'domain' (no RP term) does NOT match", () => {
    // Guards the two-term requirement: 'domain' alone must not hijack an
    // unrelated error into the rpID branch.
    const result = parsePasskeySignInError({
      kind: "thrown",
      value: new Error("Your session expired on this domain"),
    });
    expect(result).toEqual({ kind: "user", message: "Your session expired on this domain" });
  });
});

describe("parsePasskeySignInError — branch ordering invariant", () => {
  test("status 429 with 'cancelled' in body still routes to rate-limited (not silent)", () => {
    // A 429 response that happens to mention 'cancelled' must NOT fall
    // through the cancellation branch. Order of checks in the parser is
    // load-bearing: code/status leads, fuzzy substring match runs after.
    const result = parsePasskeySignInError({
      kind: "wire",
      error: { status: 429, message: "Too many requests; previous request cancelled" },
    });
    expect(result.kind).toBe("user");
    if (result.kind === "user") {
      expect(result.message).toContain("Too many attempts");
    }
  });

  test("AUTH_CANCELLED with status 401 still routes to silent (cancellation wins)", () => {
    expect(
      parsePasskeySignInError({
        kind: "wire",
        error: { code: "AUTH_CANCELLED", status: 401, message: "anything" },
      }),
    ).toEqual({ kind: "silent" });
  });
});
