"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

const OTP_LENGTH = 8;

interface VerifyEmailOTPFormProps {
  /** Address the OTP was dispatched to. Echoed in copy upstream of this form. */
  email: string;
  /**
   * Called once the OTP has been verified successfully, Better Auth has marked
   * the email verified + established a session, and this form has hydrated that
   * session (see `verify` below, #4018). Callers hard-navigate into the guarded
   * app here (`navigatePostAuth`) — a soft `router.push` would carry the funnel's
   * stale session snapshot across the auth boundary and 401 / bounce to /login.
   */
  onVerified: () => void;
}

/**
 * 8-character verification OTP entry. Auto-submits when the slot count is
 * full. The same component renders for the post-signup interstitial and
 * the login-page EMAIL_NOT_VERIFIED state — the only difference is what
 * the caller does in `onVerified`.
 *
 * Better Auth's `emailOTP` plugin is the source of truth for OTP shape,
 * expiry, and rate limiting; this form is a thin client over its
 * `verifyEmail` and `sendVerificationOtp` actions. Error codes
 * (`OTP_EXPIRED`, `INVALID_OTP`, `TOO_MANY_ATTEMPTS`) are mapped to copy
 * the user can act on without reading docs.
 */
export function VerifyEmailOTPForm({ email, onVerified }: VerifyEmailOTPFormProps) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function verify(otp: string) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const verifyEmail = authClient.emailOtp?.verifyEmail;
      if (typeof verifyEmail !== "function") {
        throw new Error("emailOtp.verifyEmail action not available on this client");
      }
      const result = await verifyEmail({ email, otp });
      if (result.error) {
        setError(mapVerifyError(result.error));
        setCode("");
        return;
      }
      // #4018 / #2487 — hydrate the Better Auth session store from the durable
      // cookie `verifyEmail` just established (`autoSignInAfterVerification`),
      // mirroring the login front-door's post-signIn `getSession`. Without this
      // the post-signup handoff carries no settled session into the app, so the
      // cross-origin region API 401s every bootstrap call and a reload bounces
      // the just-verified user to /login. Best-effort + read-only: a hydration
      // hiccup must not trap the user on the code screen, so we still call
      // `onVerified()` (the next nav re-reads the cookie on a fresh load).
      try {
        await authClient.getSession();
      } catch (err) {
        console.warn(
          "[auth] getSession after OTP verify failed",
          err instanceof Error ? err.message : String(err),
        );
      }
      onVerified();
    } catch (err) {
      console.warn(
        "[auth] emailOtp.verifyEmail threw",
        err instanceof Error ? err.message : String(err),
      );
      setError("Could not verify the code. Please try again.");
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  function handleChange(value: string) {
    setCode(value);
    setError(null);
    if (value.length === OTP_LENGTH) {
      void verify(value);
    }
  }

  async function handleResend() {
    if (resendState === "sending") return;
    setResendState("sending");
    setError(null);
    try {
      const send = authClient.emailOtp?.sendVerificationOtp;
      if (typeof send !== "function") {
        throw new Error("emailOtp.sendVerificationOtp not available on this client");
      }
      const result = await send({ email, type: "email-verification" });
      if (result.error) {
        setResendState("error");
        return;
      }
      setResendState("sent");
    } catch (err) {
      console.warn(
        "[auth] emailOtp.sendVerificationOtp threw",
        err instanceof Error ? err.message : String(err),
      );
      setResendState("error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <InputOTP
          maxLength={OTP_LENGTH}
          value={code}
          onChange={handleChange}
          disabled={submitting}
          autoFocus
          aria-label="Verification code"
        >
          <InputOTPGroup>
            {Array.from({ length: OTP_LENGTH }).map((_, i) => (
              <InputOTPSlot key={i} index={i} className="size-10 text-base" />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
      <div aria-live="polite" className="min-h-5 text-center text-sm">
        {submitting && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Verifying…
          </span>
        )}
        {error && !submitting && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
      </div>
      <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
        <span>Didn&apos;t receive a code?</span>
        {resendState === "sent" ? (
          <span className="font-medium text-emerald-700 dark:text-emerald-300">
            Sent — check your inbox (and spam folder).
          </span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resendState === "sending" || !email}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resendState === "sending" ? (
              <>
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Sending…
              </>
            ) : (
              "Resend code"
            )}
          </button>
        )}
        {resendState === "error" && (
          <span className="text-destructive">Could not resend. Please try again.</span>
        )}
      </div>
    </div>
  );
}

function mapVerifyError(error: { message?: string; code?: string }): string {
  switch (error.code) {
    case "OTP_EXPIRED":
      return 'That code expired. Tap "Resend code" for a fresh one.';
    case "INVALID_OTP":
      return "That code didn't match. Double-check and try again.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Wait a moment and request a new code.";
    default:
      return error.message ?? "We couldn't verify that code. Please try again.";
  }
}
