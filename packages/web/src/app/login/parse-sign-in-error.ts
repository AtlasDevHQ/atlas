/**
 * Categorizes a Better Auth sign-in failure into a user-facing alert state.
 *
 * Branch order is load-bearing: status / code checks run before fuzzy
 * message regex so a 429 with a body that happens to mention "incorrect"
 * still routes to `rate_limited`, not `invalid_credentials`.
 */

export type SignInErrorKind =
  | "network"
  | "invalid_credentials"
  | "rate_limited"
  | "email_unverified"
  | "sso_required"
  | "unknown";

/**
 * Discriminated by `kind` so `action` is statically reachable only on the
 * `sso_required` variant, and `attemptedEmail` only on `email_unverified`.
 * The render layer narrows on `kind` rather than checking flat optional
 * fields.
 *
 * `attemptedEmail` captures the address that was actually rejected — the
 * resend-verification button uses it instead of the live form-state
 * email so a user who edits the field after the alert renders can't
 * accidentally redirect the verification link to a different address
 * (which would not match the original sign-in attempt).
 */
export type SignInErrorState =
  | {
      kind: "sso_required";
      title: string;
      body: string;
      action?: { label: string; href: string };
    }
  | {
      kind: "email_unverified";
      title: string;
      body: string;
      attemptedEmail: string;
    }
  | {
      kind: "network" | "invalid_credentials" | "rate_limited" | "unknown";
      title: string;
      body: string;
    };

/**
 * Better Auth's standard error envelope plus the optional `ssoRedirectUrl`
 * the F-56 enforcement path attaches when the user's domain requires SSO.
 */
export interface SignInResponseError {
  message?: string | null;
  code?: string | null;
  status?: number | null;
  ssoRedirectUrl?: string | null;
}

export interface SignInErrorInput {
  error?: SignInResponseError;
  thrown?: unknown;
  /**
   * The email that was submitted with the rejected sign-in attempt, if
   * known. Captured at error time so the `email_unverified` branch can
   * carry a stable address into the resend-verification UI even after
   * the user edits the form field.
   */
  attemptedEmail?: string;
}

const UNKNOWN_FALLBACK = {
  title: "Sign in failed",
  body: "We couldn't sign you in. Try again, or contact your workspace admin if it persists.",
} as const;

function safeRedirectUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    // F-56 IdP redirects are always absolute http(s) URLs. Parsing without a
    // base rejects relative paths and garbage like "[object Object]".
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return raw;
  } catch {
    console.warn("Malformed ssoRedirectUrl from server:", raw);
    return null;
  }
}

export function parseSignInError(input: SignInErrorInput): SignInErrorState {
  if (input.thrown !== undefined) {
    if (input.thrown instanceof TypeError) {
      return {
        kind: "network",
        title: "Can't reach the server",
        body: "Check your connection and try again. If this keeps happening, your workspace may be offline.",
      };
    }
    const message =
      input.thrown instanceof Error ? input.thrown.message : String(input.thrown);
    return {
      kind: "unknown",
      title: UNKNOWN_FALLBACK.title,
      body: message || UNKNOWN_FALLBACK.body,
    };
  }

  const err = input.error ?? {};
  const code = (err.code ?? "").toUpperCase();
  const message = err.message ?? "";
  const status = err.status ?? 0;

  // Code/status checks run BEFORE fuzzy message matching so a server message
  // that incidentally mentions "password" doesn't trump a real EMAIL_NOT_VERIFIED
  // or SSO_REQUIRED code. Rate-limit also has to lead to win against a 429
  // body that contains "incorrect" — see ordering invariant test.
  if (status === 429 || code === "RATE_LIMITED" || /too many|rate limit/i.test(message)) {
    return {
      kind: "rate_limited",
      title: "Too many sign-in attempts",
      body: "We've temporarily paused sign-ins from this device. Wait a minute and try again.",
    };
  }

  if (code === "EMAIL_NOT_VERIFIED" || /verify your email|verification link/i.test(message)) {
    return {
      kind: "email_unverified",
      title: "Verify your email first",
      body: "We sent a verification link to your inbox. Open it to activate your account, then sign in.",
      // Empty string when the caller didn't supply an email — the resend
      // button disables itself when the captured address is empty so the
      // request never fires against a falsy target.
      attemptedEmail: input.attemptedEmail ?? "",
    };
  }

  // F-56: server attaches `ssoRedirectUrl` on the error envelope when the
  // user's domain enforces SSO. Surface it as a one-click action when the URL
  // round-trips through the URL constructor.
  if (code === "SSO_REQUIRED" || /single sign-on|sso required/i.test(message)) {
    const redirect = safeRedirectUrl(err.ssoRedirectUrl);
    return {
      kind: "sso_required",
      title: "Your workspace requires single sign-on",
      body: "Sign in with your company's identity provider to continue.",
      action: redirect ? { label: "Continue with SSO", href: redirect } : undefined,
    };
  }

  // Title contains "incorrect" — e2e/browser/auth.spec.ts asserts /invalid|incorrect/i.
  if (
    status === 401 ||
    code === "INVALID_EMAIL_OR_PASSWORD" ||
    /invalid credentials|incorrect (email|password)|wrong password/i.test(message)
  ) {
    return {
      kind: "invalid_credentials",
      title: "Email or password is incorrect",
      body: "Double-check your credentials. If you forgot your password, contact your workspace admin to reset it.",
    };
  }

  return {
    kind: "unknown",
    title: UNKNOWN_FALLBACK.title,
    body: message || UNKNOWN_FALLBACK.body,
  };
}
