"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Lock,
  AlertCircle,
  Loader2,
  ShieldCheck,
  ArrowLeft,
} from "lucide-react";

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  // useSearchParams needs a Suspense boundary in Next 15+ static prerender.
  // The router segment renders nothing on the server, so the boundary just
  // hands the work to the client without flashing fallback content.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const tokenError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Better Auth's callback redirect appends `?error=INVALID_TOKEN` when
  // the token is missing, expired, or already consumed. Treat that as
  // terminal — no point rendering the form.
  if (tokenError === "INVALID_TOKEN" || !token) {
    return <InvalidTokenPanel reason={tokenError === "INVALID_TOKEN" ? "expired" : "missing"} />;
  }
  // Capture into a const so TS narrows across the async closure below —
  // the early-return above already guarantees the token is non-null but
  // the inferred type widens back to `string | null` inside `handleSubmit`.
  const validToken: string = token;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      const res = await authClient.resetPassword({ newPassword: password, token: validToken });
      if (res?.error) {
        setError(parseResetError(res.error));
        return;
      }
      // Success — Better Auth has revoked all other sessions and the
      // user must now sign in with the new password. Push to /login;
      // the message is implicit (the form is gone).
      router.push("/login");
    } catch (err) {
      console.debug(
        "Password reset failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError(
        err instanceof TypeError
          ? "Couldn't reach the server. Check your connection and try again."
          : "Something went wrong. Please request a new reset link.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Lock className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Set a new password
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Choose a strong password you don&apos;t use anywhere else. We&apos;ll
          sign you out of every other Atlas session once you save it.
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                name="password"
                type="password"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm">Confirm new password</Label>
              <Input
                id="reset-confirm"
                name="confirmPassword"
                type="password"
                placeholder="Type it again"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                disabled={loading}
              />
            </div>

            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
                aria-hidden
              />
              <span>
                Your other Atlas sessions will be signed out automatically.
              </span>
            </p>

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
              disabled={loading || !password || !confirmPassword}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  Updating password…
                </>
              ) : (
                "Save new password"
              )}
            </Button>
          </form>
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

function InvalidTokenPanel({ reason }: { reason: "missing" | "expired" }) {
  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-red-100 dark:bg-red-950">
          <AlertCircle className="size-6 text-red-700 dark:text-red-300" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {reason === "missing" ? "Reset link is missing" : "Reset link is invalid or expired"}
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {reason === "missing"
            ? "This page needs a token from a password reset email. Request a new link below."
            : "The link has either expired or already been used. Reset links work once and last for one hour."}
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="space-y-3 pt-6">
          <Button asChild className="w-full">
            <a href="/forgot-password">Request a new reset link</a>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <a href="/login">Back to sign in</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function parseResetError(error: { message?: string; status?: number; code?: string }): string {
  if (error.status === 429) {
    return "Too many reset attempts. Wait a minute and try again.";
  }
  if (error.code === "INVALID_TOKEN") {
    return "This reset link has expired or already been used. Request a new one to continue.";
  }
  if (error.code === "PASSWORD_TOO_SHORT") {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return error.message ?? "We couldn't update your password. Try requesting a new reset link.";
}
