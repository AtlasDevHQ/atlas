"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  KeyRound,
  AlertCircle,
  Loader2,
  Mail,
  ArrowLeft,
} from "lucide-react";

/**
 * The Better Auth `requestPasswordReset` endpoint always returns the same
 * 200 envelope regardless of whether the email exists — the enumeration
 * defense lives there. The UI mirrors that contract: success copy never
 * confirms the address was found, and a delivery failure (no provider
 * configured, transient SMTP error) renders the same neutral message
 * because Better Auth has already issued the verification token by the
 * time the email send is attempted.
 */
const RESET_REDIRECT_PATH = "/reset-password";

function getResetRedirectUrl(): string {
  if (typeof window === "undefined") return RESET_REDIRECT_PATH;
  return `${window.location.origin}${RESET_REDIRECT_PATH}`;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setError(null);

    try {
      // The exact method name shipped with Better Auth 1.4+. The client
      // is auto-generated from server endpoints, so this maps to
      // POST /api/auth/request-password-reset.
      const res = await authClient.requestPasswordReset({
        email,
        redirectTo: getResetRedirectUrl(),
      });
      // Better Auth returns `{ data, error }`. Even when the email
      // doesn't exist the call resolves successfully with `data: { status: true }`
      // — that's the enumeration-safe contract. We surface an error only
      // when the call itself failed (network, validation, rate limit).
      if (res?.error) {
        setError(parseResetError(res.error));
        return;
      }
      setSubmitted(true);
    } catch (err) {
      console.debug(
        "Password reset request failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError(
        err instanceof TypeError
          ? "Couldn't reach the server. Check your connection and try again."
          : "We couldn't send the reset link right now. Please try again in a moment.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <KeyRound className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Reset your password
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {submitted
            ? "We've sent you a recovery link if an Atlas account exists for that email."
            : "Enter your email and we'll send you a link to set a new password."}
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          {submitted ? (
            <ConfirmationPanel email={email} onResend={() => setSubmitted(false)} />
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  placeholder="jane@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                  disabled={loading}
                />
              </div>

              {error && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <p className="leading-tight">{error}</p>
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading || !email}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                    Sending link…
                  </>
                ) : (
                  "Send reset link"
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        <a
          href="/login"
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
        >
          <ArrowLeft className="size-3" aria-hidden />
          Back to sign in
        </a>
      </p>
    </div>
  );
}

/**
 * Confirmation copy that does NOT confirm the email exists. "Check your
 * inbox" is correct whether or not we sent anything — the user is the
 * one who knows whether they have an account, and we won't tell them
 * either way.
 */
function ConfirmationPanel({ email, onResend }: { email: string; onResend: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
        <Mail className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <p className="font-medium leading-tight">Check your inbox</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            If <span className="font-medium text-foreground">{email}</span> matches
            an Atlas account, the reset link will arrive within a minute. The link
            expires in one hour and can be used only once.
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onResend}
      >
        Use a different email
      </Button>
    </div>
  );
}

function parseResetError(error: { message?: string; status?: number; code?: string }): string {
  if (error.status === 429) {
    return "Too many reset attempts. Wait a minute and try again.";
  }
  if (error.code === "RESET_PASSWORD_DISABLED") {
    return "Password reset isn't configured on this Atlas instance. Contact your admin.";
  }
  return error.message ?? "We couldn't send the reset link right now. Please try again.";
}
