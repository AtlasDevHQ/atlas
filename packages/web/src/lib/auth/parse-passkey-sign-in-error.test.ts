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
