/**
 * Branch coverage for the passkey sign-in error parser.
 *
 * Pins the canonical "Esc on the OS prompt" path to `null` (no banner)
 * and the explicit Better Auth error codes to friendly copy. The login
 * + 2FA pages route their full UI behavior off these branches — a
 * regression that flips a cancellation into a banner is exactly what
 * this file is designed to catch.
 */

import { describe, expect, test } from "bun:test";
import { parsePasskeySignInError } from "./parse-passkey-sign-in-error";

describe("parsePasskeySignInError — cancellation (returns null)", () => {
  test("AUTH_CANCELLED code → silent", () => {
    expect(
      parsePasskeySignInError({
        error: { code: "AUTH_CANCELLED", message: "cancelled", status: 400 },
      }),
    ).toBeNull();
  });

  test("REGISTRATION_CANCELLED code → silent", () => {
    expect(
      parsePasskeySignInError({
        error: { code: "REGISTRATION_CANCELLED", message: "cancelled", status: 400 },
      }),
    ).toBeNull();
  });

  test("NotAllowedError fragment in message → silent", () => {
    expect(
      parsePasskeySignInError({
        error: { message: "DOMException: NotAllowedError on get()", status: 0 },
      }),
    ).toBeNull();
  });
});

describe("parsePasskeySignInError — error codes route to friendly copy", () => {
  test("AUTHENTICATION_FAILED → 'couldn't verify' copy", () => {
    expect(
      parsePasskeySignInError({
        error: { code: "AUTHENTICATION_FAILED", message: "raw blob", status: 400 },
      }),
    ).toContain("couldn't verify");
  });

  test("PASSKEY_NOT_FOUND → 'no passkey for this device' copy", () => {
    expect(
      parsePasskeySignInError({
        error: { code: "PASSKEY_NOT_FOUND", message: "raw", status: 404 },
      }),
    ).toContain("No passkey is registered");
  });

  test("CHALLENGE_NOT_FOUND → 'expired challenge' copy", () => {
    expect(
      parsePasskeySignInError({
        error: { code: "CHALLENGE_NOT_FOUND", message: "raw", status: 400 },
      }),
    ).toContain("challenge expired");
  });

  test("status 429 → rate-limit copy regardless of message wording", () => {
    expect(
      parsePasskeySignInError({
        error: { status: 429, message: "anything" },
      }),
    ).toContain("Too many attempts");
  });
});

describe("parsePasskeySignInError — thrown branch", () => {
  test("TypeError → 'can't reach the server' copy", () => {
    expect(
      parsePasskeySignInError({ thrown: new TypeError("fetch failed") }),
    ).toContain("Can't reach the server");
  });

  test("plain Error with message → exact message bubbles", () => {
    expect(
      parsePasskeySignInError({ thrown: new Error("custom failure") }),
    ).toBe("custom failure");
  });

  test("non-Error throw → fallback copy", () => {
    expect(parsePasskeySignInError({ thrown: "weird string" })).toContain(
      "didn't complete",
    );
  });
});

describe("parsePasskeySignInError — branch ordering invariant", () => {
  test("status 429 with 'cancelled' in body still routes to rate-limited (not silent)", () => {
    // A 429 response that happens to mention 'cancelled' must NOT fall
    // through the cancellation branch. Order of checks in the parser is
    // load-bearing: code/status leads, fuzzy substring match runs after.
    expect(
      parsePasskeySignInError({
        error: { status: 429, message: "Too many requests; previous request cancelled" },
      }),
    ).toContain("Too many attempts");
  });

  test("AUTH_CANCELLED with status 401 still routes to silent (cancellation wins)", () => {
    expect(
      parsePasskeySignInError({
        error: { code: "AUTH_CANCELLED", status: 401, message: "anything" },
      }),
    ).toBeNull();
  });
});
