/**
 * Categorize a Better Auth `signIn.passkey()` failure into a user-facing
 * message. Distinguishes user cancellation (silent — return `null`) from
 * real failures so the login surface stays quiet on the canonical "user
 * pressed Esc on the OS prompt" path while still surfacing real problems.
 *
 * Branch order is load-bearing: code/status checks lead because a 429 with
 * a body that mentions "passkey" still routes to rate-limited copy, not
 * unknown-fallback. Mirrors the structure of `parse-sign-in-error.ts`.
 */

import type { PasskeyApiError } from "./passkey-client";

export interface PasskeySignInErrorInput {
  /**
   * Result envelope returned by `signIn.passkey()`. Better Auth's client
   * wrapper traps `NotAllowedError` from the WebAuthn ceremony and folds
   * it into `error.code === "AUTH_CANCELLED"` — that branch is silent.
   */
  error?: PasskeyApiError | null;
  /** Caught from a `try/catch` around the call — usually a network failure. */
  thrown?: unknown;
}

const FALLBACK = "Passkey sign-in didn't complete. Try again, or use email and password.";

/**
 * Returns `null` when the failure is a user cancellation (Esc on the OS
 * prompt, dismissed authenticator picker) — the caller should NOT show a
 * banner, just stop the spinner. Returns a string for everything else.
 *
 * Always log on the cancellation branch from the caller — a misconfigured
 * `rpID` surfaces with the same `NotAllowedError` shape and would
 * otherwise disappear silently.
 */
export function parsePasskeySignInError(input: PasskeySignInErrorInput): string | null {
  if (input.thrown !== undefined) {
    if (input.thrown instanceof TypeError) {
      return "Can't reach the server. Check your connection and try again.";
    }
    if (input.thrown instanceof Error && input.thrown.message) {
      return input.thrown.message;
    }
    return FALLBACK;
  }

  const err = input.error ?? {};
  const code = (err.code ?? "").toUpperCase();
  const message = err.message ?? "";
  const status = err.status ?? 0;

  // Code-based cancellation wins unconditionally — Better Auth surfaces
  // user-cancelled WebAuthn ceremonies as `AUTH_CANCELLED` regardless of
  // the HTTP status (some browsers report 401 here, others 400).
  if (code === "AUTH_CANCELLED" || code === "REGISTRATION_CANCELLED") return null;

  // Authoritative status / code branches run BEFORE the fuzzy-message
  // cancellation match so a 429 body that incidentally mentions
  // "cancelled" still routes to rate-limited copy. Same ordering
  // invariant as `parse-sign-in-error.ts`.
  if (status === 429 || code === "RATE_LIMITED" || /too many|rate limit/i.test(message)) {
    return "Too many attempts. Wait a minute and try again.";
  }

  if (code === "AUTHENTICATION_FAILED" || /authentication failed/i.test(message)) {
    return "We couldn't verify that passkey. Try again, or use email and password.";
  }

  if (code === "PASSKEY_NOT_FOUND" || /passkey not found|no passkey/i.test(message)) {
    return "No passkey is registered for this device. Sign in with your password to add one from Settings → Security.";
  }

  if (code === "CHALLENGE_NOT_FOUND" || /challenge/i.test(message)) {
    return "The sign-in challenge expired. Tap the passkey button again.";
  }

  // Fuzzy-message cancellation — older browsers / pre-`@simplewebauthn/
  // browser` v9 wiring surface NotAllowedError in the message field
  // without a stable code. Treat as silent.
  if (isFuzzyCancellation(message)) return null;

  return message || FALLBACK;
}

function isFuzzyCancellation(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("notallowed") || m.includes("cancelled") || m.includes("canceled");
}
