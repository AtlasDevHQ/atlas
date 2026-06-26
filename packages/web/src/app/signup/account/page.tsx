"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { navigatePostAuth } from "@/lib/auth/post-auth-nav";
import { getApiBase, getCredentials } from "@/lib/fetch-json";
import { readSignupDraft, clearSignupDraft } from "@/lib/signup-draft";
import { useSignupContext } from "@/ui/components/signup/signup-context-provider";
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
import { Separator } from "@/components/ui/separator";
import { GoogleIcon, GitHubIcon, MicrosoftIcon } from "@/ui/components/social-icons";
import { SignupShell } from "@/ui/components/signup/signup-shell";
import { VerifyEmailOTPForm } from "@/ui/components/auth/verify-email-otp-form";
import { Loader2, MailCheck } from "lucide-react";

/**
 * Account-creation step (ADR-0024 §4) — the FIRST identity write in the flow.
 *
 * On the **regional path** (residency configured, fresh signup) this page is
 * hard-navigated to from the region step (`navigatePostAuth`) with the
 * `atlas_region` cookie set, so `@/lib/auth/client`'s Better-Auth singleton has
 * rebuilt against the chosen region's API base — every call here (`signUp.email`,
 * OTP verify, social sign-in) lands on the regional API and the user /
 * organization / member / session rows are created in-region.
 *
 * Two other paths reach this page WITHOUT a region signal, and that's correct:
 *   - **Invitee** (`/signup` soft-pushes here, region skipped): joins an org
 *     whose region is already fixed by the invitation; account lands on the
 *     default base, matching the pre-reorder invite behavior.
 *   - **Single-region / no residency** (region step soft-replaces here): there
 *     is only one API base, so same-origin IS the region.
 *
 * The email was collected on `/signup` and carried in the signup draft (it
 * survives the region step's hard reload, which wipes React state). No draft
 * means the user deep-linked here — bounce them back to the email step.
 */
export default function AccountPage() {
  const router = useRouter();
  const ctx = useSignupContext();
  // `showRegion` reflects only whether residency is configured (the store keys
  // on config, not on this user's path). It drives the Back affordance together
  // with `invitationId` below: an invitee skips the region step, so their Back
  // must go to /signup even on a multi-region deploy.
  const showRegion = ctx.status === "ready" ? ctx.showRegion : false;

  const [email, setEmail] = useState<string | null>(null);
  const [invitationId, setInvitationId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const [socialProviders, setSocialProviders] = useState<string[]>([]);
  // Mirrors the prior single-page flow: when email verification is required,
  // signUp returns no session token and the OTP has already been sent — hold
  // the email to render the code-entry interstitial instead of navigating.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // Hydrate the email/invitation from the signup draft. A missing draft means
  // the user landed here directly (no email step) — send them back to start.
  useEffect(() => {
    const draft = readSignupDraft();
    if (!draft) {
      router.replace("/signup");
      return;
    }
    setEmail(draft.email);
    setInvitationId(draft.invitationId ?? null);
  }, [router]);

  useEffect(() => {
    const base = getApiBase();
    fetch(`${base}/api/v1/onboarding/social-providers`, { credentials: getCredentials() })
      .then((r) => {
        if (!r.ok) throw new Error(`Social providers returned ${r.status}`);
        return r.json();
      })
      .then((data: { providers?: string[] }) => {
        if (Array.isArray(data.providers)) setSocialProviders(data.providers);
      })
      .catch((err: unknown) => {
        // Graceful degradation: email/password form still works.
        console.warn("Social providers unavailable:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  const postSignupPath = invitationId
    ? `/accept-invitation/${encodeURIComponent(invitationId)}`
    : "/signup/workspace";
  // Invitees skipped the region step (routed straight from /signup), so Back
  // returns them to the email step — never the region picker they never saw.
  const backHref = !invitationId && showRegion ? "/signup/region" : "/signup";

  function completeAndNavigate() {
    // The draft has served its purpose once the account exists; clear it so a
    // later visit to /signup starts clean.
    clearSignupDraft();
    navigatePostAuth(postSignupPath);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);
    setError(null);

    try {
      const res = await authClient.signUp.email({
        email,
        password,
        name: name || email.split("@")[0],
      });
      if (res.error) {
        setError(res.error.message ?? "Sign up failed");
        return;
      }
      // Verification required → no token, OTP already dispatched: switch to the
      // code-entry view. Verification off (self-hosted dev) → token present,
      // navigate straight on. (See the prior single-page flow's rationale.)
      const token = (res.data as { token?: string | null } | undefined)?.token;
      if (token) {
        completeAndNavigate();
      } else {
        setPendingEmail(email);
      }
    } catch (err) {
      console.warn("Signup failed:", err instanceof Error ? err.message : String(err));
      setError(
        err instanceof TypeError
          ? "Unable to reach the server. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Sign up failed. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSocialLogin(provider: string) {
    setError(null);
    setSocialLoading(provider);
    try {
      // Social sign-in is also an identity write; it runs here (post-region) so
      // the OAuth callback lands on the regional API. Clear the draft before the
      // provider redirect — its only job was to carry the email/invitationId to
      // this page; the callback target (postSignupPath) doesn't read it, and the
      // email/invitationId already live in component state for this render.
      clearSignupDraft();
      await authClient.signIn.social({
        provider: provider as "google" | "github" | "microsoft",
        callbackURL: postSignupPath,
      });
    } catch (err) {
      console.warn("Social login failed:", err instanceof Error ? err.message : String(err));
      setError(err instanceof Error ? err.message : "Social login failed");
    } finally {
      setSocialLoading(null);
    }
  }

  // Pre-hydration (or mid-redirect when no draft): render the stepped shell
  // with a spinner so there's no flash of an empty form.
  if (!email) {
    return (
      <SignupShell step="account" back={{ href: backHref }}>
        <Card>
          <CardContent className="flex items-center justify-center p-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </SignupShell>
    );
  }

  if (pendingEmail) {
    return (
      <SignupShell step="account">
        <Card>
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MailCheck className="size-6" aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl tracking-tight">Enter your code</CardTitle>
            <CardDescription>
              We sent an 8-character code to{" "}
              <span className="font-medium text-foreground">{pendingEmail}</span>.
              It&apos;s good for the next 10 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <VerifyEmailOTPForm email={pendingEmail} onVerified={completeAndNavigate} />
            <p className="text-center text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => router.replace("/signup")}
                className="font-medium text-primary hover:underline"
              >
                Use a different email
              </button>
            </p>
          </CardContent>
        </Card>
      </SignupShell>
    );
  }

  return (
    <SignupShell step="account" back={{ href: backHref }}>
      <Card>
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">Create your account</CardTitle>
          <CardDescription>
            Signing up as <span className="font-medium text-foreground">{email}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {socialProviders.length > 0 && (
            <>
              <div className="grid gap-2">
                {socialProviders.includes("google") && (
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={socialLoading !== null}
                    onClick={() => handleSocialLogin("google")}
                  >
                    <GoogleIcon />
                    {socialLoading === "google" ? "Redirecting..." : "Continue with Google"}
                  </Button>
                )}
                {socialProviders.includes("github") && (
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={socialLoading !== null}
                    onClick={() => handleSocialLogin("github")}
                  >
                    <GitHubIcon />
                    {socialLoading === "github" ? "Redirecting..." : "Continue with GitHub"}
                  </Button>
                )}
                {socialProviders.includes("microsoft") && (
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={socialLoading !== null}
                    onClick={() => handleSocialLogin("microsoft")}
                  >
                    <MicrosoftIcon />
                    {socialLoading === "microsoft" ? "Redirecting..." : "Continue with Microsoft"}
                  </Button>
                )}
              </div>
              <div className="relative">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  or
                </span>
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signup-name">Name</Label>
              <Input
                id="signup-name"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-password">Password</Label>
              <Input
                id="signup-password"
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={loading || !password}
            >
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            By signing up, you agree to our{" "}
            <a href="https://www.useatlas.dev/terms" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="https://www.useatlas.dev/privacy" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </p>
        </CardContent>
      </Card>
    </SignupShell>
  );
}
