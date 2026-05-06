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
   * Called once the OTP has been verified successfully and Better Auth has
   * marked the email verified + established a session. Callers typically
   * `router.push` to the next step here.
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
      // The cast is the documented workaround for Better Auth's
      // plugin-augmented client type — `emailOtp` is added at runtime by
      // emailOTPClient() but TS6 strictness loses it through the plugin
      // chain. Same pattern as `getPasskeyClient()` in
      // lib/auth/passkey-client.ts.
      const verifyEmail = (
        authClient as unknown as {
          emailOtp?: {
            verifyEmail: (opts: { email: string; otp: string }) => Promise<{
              data: unknown;
              error: { message?: string; code?: string } | null;
            }>;
          };
        }
      ).emailOtp?.verifyEmail;
      if (typeof verifyEmail !== "function") {
        throw new Error("emailOtp.verifyEmail action not available on this client");
      }
      const result = await verifyEmail({ email, otp });
      if (result.error) {
        setError(mapVerifyError(result.error));
        setCode("");
        return;
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
      const send = (
        authClient as unknown as {
          emailOtp?: {
            sendVerificationOtp: (opts: {
              email: string;
              type: "email-verification";
            }) => Promise<{
              data: unknown;
              error: { message?: string } | null;
            }>;
          };
        }
      ).emailOtp?.sendVerificationOtp;
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
