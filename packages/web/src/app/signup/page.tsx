"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { savePlanIntent } from "@/lib/billing/plan-intent";
import { saveSignupDraft, readSignupDraft } from "@/lib/signup-draft";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SignupShell } from "@/ui/components/signup/signup-shell";

/**
 * Email-entry step — the start of the ADR-0024 §4 signup order
 * (**email → region → create-account**).
 *
 * Collecting the email here is NOT an identity write, so picking a region on
 * the next step still precedes the first Better-Auth write. The email is
 * stashed in the signup draft (sessionStorage) so it survives the region step's
 * hard reload, then consumed by `/signup/account`. Region selection points the
 * browser at the regional API; account creation, OTP, workspace, and connect
 * then all run in-region.
 */
export default function SignupPage() {
  const router = useRouter();
  // `?invitationId=…` is set when the user clicks an org-invitation email link
  // while signed out and picks "Create account". It rides in the draft so the
  // account step routes to /accept-invitation post-verify (joining an existing
  // org) rather than /signup/workspace. An invitee joins an org that already
  // has a region, so they skip the region picker.
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitationId");
  // `?plan=…` is the pricing-page CTA intent (#3418). Stashed (not URL state)
  // because the multi-step flow + OAuth redirects drop the param; the billing
  // plan picker consumes it later. Saved in an effect so strict-mode's double
  // render doesn't double-write.
  const planParam = searchParams.get("plan");
  useEffect(() => {
    savePlanIntent(planParam);
  }, [planParam]);

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from an existing draft so Back from the region/account step keeps
  // the email the user already typed.
  useEffect(() => {
    const draft = readSignupDraft();
    if (draft?.email) setEmail(draft.email);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your work email to continue.");
      return;
    }
    setError(null);
    saveSignupDraft({ email: trimmed, invitationId: invitationId ?? undefined });
    // Invitees join an existing org (fixed region) — skip the picker. Everyone
    // else goes to the region step; it auto-skips to /signup/account when no
    // residency is configured (self-hosted / single-region).
    router.push(invitationId ? "/signup/account" : "/signup/region");
  }

  return (
    <SignupShell step="email">
      <Card>
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">Create your account</CardTitle>
          <CardDescription>
            Get started with Atlas — your AI data analyst.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signup-email">Work email</Label>
              <Input
                id="signup-email"
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={!email.trim()}>
              Continue
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            By continuing, you agree to our{" "}
            <a href="https://www.useatlas.dev/terms" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="https://www.useatlas.dev/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </p>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </SignupShell>
  );
}
