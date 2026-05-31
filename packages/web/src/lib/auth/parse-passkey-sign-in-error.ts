/**
 * Categorize a Better Auth `signIn.passkey()` failure into a user-facing
 * outcome. The discriminated return type forces every caller to handle
 * the silent-cancellation path explicitly: `kind: "silent"` means the
 * user pressed Esc on the OS prompt and the UI must NOT show a banner;
 * `kind: "user"` carries copy to render.
 *
 * Branch order is load-bearing: code/status checks lead because a 429
 * with a body that mentions "passkey" still routes to rate-limited copy,
 * not unknown-fallback. Mirrors the structure of `parse-sign-in-error.ts`.
 */

import type { PasskeyApiError } from "./passkey-client";

/**
 * Discriminated input. Forces callers to commit to one of two failure
 * surfaces — the `signIn.passkey()` wire envelope (`{ data, error }`) or
 * a caught throw — instead of passing both fields and hoping the parser
 * picks the right one. The implicit-XOR shape this replaces was easy to
 * misuse: `{}` typechecked but always returned the unknown fallback.
 */
export type PasskeySignInErrorInput =
  | {
      kind: "wire";
      /**
       * Result envelope. Better Auth's client wrapper traps
       * `NotAllowedError` from the user-cancelled ceremony and folds it
       * into `error.code === "AUTH_CANCELLED"` — that branch is silent.
       */
      error: PasskeyApiError | null;
    }
  | {
      kind: "thrown";
      /** Caught from a `try/catch` around the call — usually a network failure. */
      value: unknown;
    };

/**
 * Discriminated outcome. `silent` fires when the failure is a user
 * cancellation (Esc on the OS prompt, dismissed authenticator picker) —
 * the caller stops the spinner without rendering a banner. `user`
 * carries the message to display.
 *
 * Callers MUST log on the silent branch — a misconfigured `rpID`
 * surfaces with the same `NotAllowedError` shape and would otherwise
 * disappear without a DevTools breadcrumb.
 */
export type PasskeySignInOutcome =
  | { kind: "silent" }
  | { kind: "user"; message: string };

const FALLBACK_MESSAGE = "Passkey sign-in didn't complete. Try again, or use email and password.";

// Server-misconfiguration copy for the `SecurityError` the browser throws
// synchronously when the page origin isn't valid for the configured rpID
// ("The RP ID \"...\" is invalid for this domain"). This is a deploy setup
// issue (rpID ≠ the deploy's origin), not anything the end user can fix — so
// route it to a clear "contact your administrator" message instead of leaking
// the raw DOMException string. The server-side `resolvePasskeyRpId` boot
// assertion (packages/api) makes this unreachable on deploys that DO configure
// a web origin; this branch covers the residual self-hosted / single-origin
// case where no origin is configured to validate against.
const INVALID_RP_ID_MESSAGE =
  "Passkeys aren't set up correctly for this site — the server's WebAuthn domain doesn't match this address. Contact your administrator, or sign in with email and password.";

export function parsePasskeySignInError(input: PasskeySignInErrorInput): PasskeySignInOutcome {
  if (input.kind === "thrown") {
    if (input.value instanceof TypeError) {
      return {
        kind: "user",
        message: "Can't reach the server. Check your connection and try again.",
      };
    }
    if (input.value instanceof Error && input.value.message) {
      // Misconfigured rpID surfaces here as a thrown SecurityError/DOMException.
      // Catch it before the raw message bubbles to the user.
      if (isInvalidRpIdError(input.value.message)) {
        return { kind: "user", message: INVALID_RP_ID_MESSAGE };
      }
      return { kind: "user", message: input.value.message };
    }
    return { kind: "user", message: FALLBACK_MESSAGE };
  }

  const err = input.error ?? {};
  const code = (err.code ?? "").toUpperCase();
  const message = err.message ?? "";
  const status = err.status ?? 0;

  // Code-based cancellation wins unconditionally — Better Auth surfaces
  // user-cancelled WebAuthn assertions as `AUTH_CANCELLED` regardless of
  // the HTTP status (some browsers report 401 here, others 400).
  if (code === "AUTH_CANCELLED" || code === "REGISTRATION_CANCELLED") {
    return { kind: "silent" };
  }

  // Authoritative status / code branches run BEFORE the fuzzy-message
  // cancellation match so a 429 body that incidentally mentions
  // "cancelled" still routes to rate-limited copy. Same ordering
  // invariant as `parse-sign-in-error.ts`.
  if (status === 429 || code === "RATE_LIMITED" || /too many|rate limit/i.test(message)) {
    return { kind: "user", message: "Too many attempts. Wait a minute and try again." };
  }

  if (code === "AUTHENTICATION_FAILED" || /authentication failed/i.test(message)) {
    return {
      kind: "user",
      message: "We couldn't verify that passkey. Try again, or use email and password.",
    };
  }

  if (code === "PASSKEY_NOT_FOUND" || /passkey not found|no passkey/i.test(message)) {
    return {
      kind: "user",
      message:
        "No passkey is registered for this device. Sign in with your password to add one from Settings → Security.",
    };
  }

  if (code === "CHALLENGE_NOT_FOUND" || /challenge/i.test(message)) {
    return { kind: "user", message: "The sign-in challenge expired. Tap the passkey button again." };
  }

  // Misconfigured rpID — the browser's SecurityError ("The RP ID is invalid
  // for this domain") can also arrive folded into the wire envelope's message.
  // Checked before the fuzzy-cancellation match so it routes to actionable
  // setup copy rather than the raw blob (it doesn't match the cancellation
  // substrings, but keep it ahead to make the precedence explicit).
  if (isInvalidRpIdError(message)) return { kind: "user", message: INVALID_RP_ID_MESSAGE };

  // Fuzzy-message cancellation — older browsers / pre-`@simplewebauthn/
  // browser` v9 wiring surface NotAllowedError in the message field
  // without a stable code. Treat as silent.
  if (isFuzzyCancellation(message)) return { kind: "silent" };

  return { kind: "user", message: message || FALLBACK_MESSAGE };
}

function isFuzzyCancellation(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("notallowed") || m.includes("cancelled") || m.includes("canceled");
}

/**
 * Detect the WebAuthn invalid-rpID `SecurityError` across browser phrasings:
 * Chrome/Safari say `The RP ID "x" is invalid for this domain`; some engines
 * say the rpID `is not a registrable domain suffix of` the origin. Both pair a
 * relying-party term with a domain-mismatch term, so require one of each to
 * avoid false-positives on unrelated messages that merely mention "domain".
 */
function isInvalidRpIdError(message: string): boolean {
  const m = message.toLowerCase();
  const mentionsRp = m.includes("rp id") || m.includes("relying party");
  const mentionsDomainMismatch =
    m.includes("invalid for this domain") || m.includes("registrable domain");
  return mentionsRp && mentionsDomainMismatch;
}
