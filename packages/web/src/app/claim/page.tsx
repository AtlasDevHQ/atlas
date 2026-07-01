"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { navigatePostAuth } from "@/lib/auth/post-auth-nav";
import {
  isCrossOrigin,
  getActiveRegion,
  applyRegionSignal,
} from "@/lib/api-url";
import { isLikelyEmail, type RegionResolution } from "@/lib/login-frontdoor";
import { getPasskeyClient } from "@/lib/auth/passkey-client";
import { useWebAuthnSupported } from "@/ui/hooks/use-webauthn-supported";
import { VerifyEmailOTPForm } from "@/ui/components/auth/verify-email-otp-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Database,
  Fingerprint,
  KeyRound,
  Loader2,
  MailCheck,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

/**
 * Trial claim interstitial (ADR-0018, #4135) — the credential step that flips a
 * `start_trial` (MCP/CLI) grace account into a fully-claimed, admin-capable
 * workspace, reachable at `/claim?email=<owner>` (the `buildClaimUrl` target,
 * #4125 fault A). NOT `/signup`: the account already exists, so the new-account
 * funnel collides on the email.
 *
 * The ceremony, in order (ADR-0018 "emailOTP verify — never magic link — set a
 * credential/passkey, accept ToS"):
 *   1. emailOTP verify — claims the workspace. `verifyEmail` flips the owner's
 *      `emailVerified` bit (firing `afterEmailVerification` → `extendTrialOnClaim`,
 *      grace→14d) and establishes a session.
 *   2. enroll a WebAuthn passkey — password-free (works for the passwordless
 *      grace shape), and it doubles as the admin-MFA strong factor: the
 *      `admin-mfa-required` gate clears on `passkeyCount>0` (ADR-0025), so a
 *      freshly-claimed owner reaches every admin action with NO password-reset
 *      detour. Password+TOTP is the non-WebAuthn fallback (see below).
 *   3. accept ToS — a required checkbox gates completion.
 *
 * Re-entry / e2e: if the visitor already has a verified session (they bailed
 * mid-flow, or it's the storage-state admin in the passkey ceremony e2e), the
 * OTP step is skipped and the flow resumes at the credential step.
 */

type Phase =
  // Cross-origin SaaS, region not yet pinned: resolve email→region first so the
  // OTP send/verify lands on the account's own regional API (mirrors the login
  // front-door, ADR-0024 §3). Same-origin / self-hosted skips this entirely.
  | "resolving-region"
  // No email in the URL and no session — ask for it before sending an OTP.
  | "email-entry"
  // Email known, OTP dispatched — render the code-entry form.
  | "otp"
  // Email verified (workspace claimed) — enroll the strong factor + accept ToS.
  | "secure"
  // Non-WebAuthn fallback: a password-reset link was sent; finish under
  // Account → Security with an authenticator app.
  | "fallback-sent";

/** Outcome of region resolution — `error` carries the front-door's reason. */
type RegionRouting =
  | { kind: "reloading" }
  | { kind: "proceed" }
  | { kind: "error"; message: string };

/**
 * Narrow an unverified `getSession()` user (typed loosely once it crosses the
 * plugin chain) to "has a verified email". From `unknown` with a runtime check
 * rather than a widening `as` cast, so a future `emailVerified` rename fails the
 * check (→ safe fall-through to the OTP path) instead of silently compiling.
 */
function hasVerifiedEmail(u: unknown): u is { email?: string; emailVerified: boolean } {
  return (
    typeof u === "object" &&
    u !== null &&
    (u as Record<string, unknown>).emailVerified === true
  );
}

export default function ClaimPage() {
  const searchParams = useSearchParams();
  const webAuthn = useWebAuthnSupported();

  const [email, setEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [phase, setPhase] = useState<Phase>("resolving-region");
  const [regionError, setRegionError] = useState<string | null>(null);

  // Credential-step state.
  const [passkeyEnrolled, setPasskeyEnrolled] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [fallbackSending, setFallbackSending] = useState(false);

  // Bootstrap runs exactly once: resolve an existing verified session (skip OTP),
  // otherwise settle region routing, then dispatch the first OTP. The ref guards
  // against a re-run (each OTP send allocates a server-side code).
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    const urlEmail = searchParams.get("email");
    if (urlEmail) setEmail(urlEmail);

    let cancelled = false;

    void (async () => {
      // 1. Already verified (re-entry, or the e2e storage-state session) →
      //    resume at the credential step, no OTP.
      try {
        const session = await authClient.getSession();
        const user = session?.data?.user;
        if (!cancelled && hasVerifiedEmail(user)) {
          if (user.email) setEmail(user.email);
          setPhase("secure");
          return;
        }
      } catch (err) {
        // A session probe hiccup is non-fatal — fall through to the OTP path.
        console.debug(
          "[claim] getSession probe failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (cancelled) return;

      // 2. No email to work with → ask for it before any OTP.
      if (!urlEmail || !isLikelyEmail(urlEmail)) {
        setPhase("email-entry");
        return;
      }

      // 3. Region routing (cross-origin SaaS only). Same-origin / self-hosted, or
      //    a region already pinned, goes straight to OTP.
      if (isCrossOrigin() && getActiveRegion() === null) {
        const routed = await resolveAndApplyRegion(urlEmail);
        if (cancelled || routed.kind === "reloading") return; // reload in flight
        if (routed.kind === "error") {
          // Surface the front-door's specific reason (retryable) and leave the
          // user on the region step with a retry affordance below.
          setRegionError(routed.message);
          return;
        }
        // "proceed" — single base or not-multi-region: fall through to OTP.
      }

      if (cancelled) return;
      await dispatchOtp(urlEmail);
      if (!cancelled) setPhase("otp");
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally one-shot on mount: the bootstrap reads searchParams once and
    // guards itself with a ref. searchParams is stable for the page's lifetime.
  }, []);

  /**
   * Resolve email→region via the same region-agnostic front-door the login page
   * uses. On a single regional hit, pin the region and reload (the auth client
   * rebuilds its base from the cookie at import); the `?email=` survives in the
   * URL across the reload. Every other outcome ("skip"/"none"/"multiple") falls
   * through to OTP on the current base — a fresh grace account lives in exactly
   * one region, so "multiple" is not expected. The `switch` mirrors the login
   * front-door's exhaustiveness guard (region-gate.tsx): a new `RegionResolution`
   * variant fails the build here rather than silently falling through.
   */
  async function resolveAndApplyRegion(targetEmail: string): Promise<RegionRouting> {
    try {
      const res = await fetch("/api/login/resolve-region", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: targetEmail }),
      });
      if (!res.ok) {
        // A non-2xx (e.g. a 500 whose JSON body has no `outcome`) must NOT fall
        // through to the exhaustive `default` and silently `proceed` on the
        // default base — that mis-routes OTP for a home-region account. Surface
        // it as the retryable `error` the code screen already renders.
        console.warn("[claim] region resolution HTTP error:", res.status);
        return { kind: "error", message: "We couldn't route your claim to the right region. Please try again." };
      }
      const result = (await res.json()) as RegionResolution;
      switch (result.outcome) {
        case "single":
          if (!applyRegionSignal(result.region, result.apiUrl)) {
            return { kind: "error", message: "That region is temporarily unreachable. Please try again." };
          }
          window.location.reload();
          return { kind: "reloading" };
        case "error":
          return {
            kind: "error",
            message: result.message || "We couldn't route your claim to the right region. Please try again.",
          };
        case "multiple":
        case "none":
        case "skip":
          // Proceed on the current (default) base — a fresh grace account lives
          // in exactly one region, so "multiple" here is not expected.
          return { kind: "proceed" };
        default: {
          const _exhaustive: never = result;
          // A 2xx with an unmodeled `outcome` is a server-contract violation;
          // log it (never silently swallow) and surface a retryable error
          // rather than proceeding on a possibly-wrong base.
          console.warn("[claim] unexpected region resolution outcome:", JSON.stringify(_exhaustive));
          return { kind: "error", message: "We couldn't route your claim to the right region. Please try again." };
        }
      }
    } catch (err) {
      console.warn(
        "[claim] region resolution failed:",
        err instanceof Error ? err.message : String(err),
      );
      return { kind: "error", message: "We couldn't reach the server to route your claim. Please try again." };
    }
  }

  /** Dispatch the initial verification OTP. The code screen's "Resend" is the
   *  recovery path, so a send hiccup never traps the user — we still show OTP. */
  async function dispatchOtp(targetEmail: string) {
    try {
      const send = authClient.emailOtp?.sendVerificationOtp;
      if (typeof send !== "function") {
        throw new Error("emailOtp.sendVerificationOtp not available on this client");
      }
      const result = await send({ email: targetEmail, type: "email-verification" });
      if (result?.error) {
        console.warn(
          "[claim] verification OTP send returned an error:",
          result.error.message ?? "unknown",
        );
      }
    } catch (err) {
      console.warn(
        "[claim] verification OTP send failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function handleEmailEntry(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = emailInput.trim();
    if (!isLikelyEmail(trimmed)) return;
    setEmail(trimmed);
    void dispatchOtp(trimmed);
    setPhase("otp");
  }

  async function handleEnrollPasskey() {
    setCredentialError(null);
    const client = getPasskeyClient();
    if (!client) {
      setCredentialError(
        "Passkeys aren't available right now. Use the password option below instead.",
      );
      return;
    }
    setEnrolling(true);
    try {
      const result = await client.addPasskey();
      if (result?.error) {
        const code = result.error.code ?? "";
        // A user-cancelled WebAuthn ceremony surfaces as NotAllowedError /
        // AUTH_CANCELLED — soft, not an error banner (same discipline as the
        // enrollment tile). Anything else is a real failure worth surfacing.
        if (/CANCELL?ED|NotAllowed/i.test(code)) {
          console.debug("[claim] passkey enrollment cancelled:", code);
        } else {
          console.warn("[claim] passkey enrollment failed:", result.error);
          setCredentialError(
            "We couldn't create that passkey. Try again, or use the password option below.",
          );
        }
        return;
      }
      // Refresh the session store so the client carries the updated passkeyCount
      // claim (the admin-MFA gate recomputes it server-side per request, so this
      // is for UI consistency — mirrors MfaPanel's post-enroll refetch).
      try {
        await authClient.getSession();
      } catch (err) {
        console.debug(
          "[claim] getSession after passkey enroll failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      setPasskeyEnrolled(true);
    } catch (err) {
      console.warn(
        "[claim] passkey enrollment threw:",
        err instanceof Error ? err.message : String(err),
      );
      setCredentialError(
        "We couldn't create that passkey. Try again, or use the password option below.",
      );
    } finally {
      setEnrolling(false);
    }
  }

  /**
   * Non-WebAuthn fallback. The grace account is passwordless and there is no
   * set-initial-password endpoint, so route through the standard password-reset
   * email; the owner then enrolls TOTP under Account → Security. The workspace
   * is ALREADY claimed by this point (OTP verified), so leaving to email here
   * doesn't lose the trial — only the strong factor is deferred.
   */
  async function handlePasswordFallback() {
    if (!email) return;
    setCredentialError(null);
    setFallbackSending(true);
    try {
      const redirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/reset-password`
          : "/reset-password";
      const res = await authClient.requestPasswordReset({ email, redirectTo });
      if (res?.error) {
        // Enumeration-safety cuts the OTHER way: Better Auth resolves a
        // *successful* envelope (`data.status: true`) even for an unknown email
        // (forgot-password.tsx documents this), so a POPULATED `error` is a REAL
        // failure — rate-limit, validation, provider-not-configured — NOT the
        // "email doesn't exist" case. Surface it and stay on `secure` to retry;
        // advancing to "check your email" would promise a link that never sent.
        console.warn(
          "[claim] password-reset request returned an error:",
          res.error.message ?? "unknown",
        );
        setCredentialError(
          "We couldn't send the password link right now. Please try again in a moment.",
        );
        return;
      }
      setPhase("fallback-sent");
    } catch (err) {
      console.warn(
        "[claim] password-reset request failed:",
        err instanceof Error ? err.message : String(err),
      );
      setCredentialError(
        "We couldn't send the password link right now. Please try again in a moment.",
      );
    } finally {
      setFallbackSending(false);
    }
  }

  function handleFinish() {
    navigatePostAuth("/");
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const heading = (
    <div className="mb-6 flex flex-col items-center text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
        <Database className="size-6 text-primary" aria-hidden />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Claim your workspace</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Finish setting up the Atlas trial you started from the CLI or MCP.
      </p>
    </div>
  );

  if (phase === "resolving-region") {
    return (
      <div className="flex flex-col items-center">
        {heading}
        <Card className="w-full">
          <CardContent className="flex flex-col items-center gap-3 p-12">
            {regionError ? (
              // Terminal error sub-state: no spinner (it would imply work is
              // still in flight), just the reason + a retry.
              <div className="w-full space-y-3">
                <ErrorBanner>{regionError}</ErrorBanner>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => window.location.reload()}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <>
                <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">Getting things ready…</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "email-entry") {
    return (
      <div className="flex flex-col items-center">
        {heading}
        <Card className="w-full">
          <CardHeader className="space-y-1.5 text-center">
            <CardTitle className="text-xl tracking-tight">What&apos;s your email?</CardTitle>
            <CardDescription>
              Enter the email you used to start the trial — we&apos;ll send a verification code.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleEmailEntry} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="claim-email">Email</Label>
                <Input
                  id="claim-email"
                  type="email"
                  placeholder="jane@example.com"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                />
              </div>
              <Button type="submit" className="w-full" disabled={!emailInput.trim()}>
                Send code
                <ArrowRight className="ml-2 size-4" aria-hidden />
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "otp" && email) {
    return (
      <div className="flex flex-col items-center">
        {heading}
        <Card className="w-full">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MailCheck className="size-6" aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl tracking-tight">Enter your code</CardTitle>
            <CardDescription>
              We sent an 8-character code to{" "}
              <span className="font-medium text-foreground">{email}</span>. It&apos;s good for the
              next 10 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <VerifyEmailOTPForm email={email} onVerified={() => setPhase("secure")} />
            <p className="text-center text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => {
                  setEmail(null);
                  setEmailInput("");
                  setPhase("email-entry");
                }}
                className="font-medium text-primary hover:underline"
              >
                Use a different email
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "fallback-sent") {
    return (
      <div className="flex flex-col items-center">
        {heading}
        <Card className="w-full">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MailCheck className="size-6" aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl tracking-tight">Check your email</CardTitle>
            <CardDescription>
              We sent a link to set your password. After setting it, add an authenticator app
              under <span className="font-medium text-foreground">Account → Security</span> to
              finish securing admin access.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" className="w-full" onClick={handleFinish}>
              Go to your workspace
            </Button>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Your trial is already active — you can finish securing admin access any time.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // phase === "secure" — enroll the strong factor + accept ToS.
  const webAuthnSupported = webAuthn.kind === "supported";
  const canFinish = passkeyEnrolled && tosAccepted;

  return (
    <div className="flex flex-col items-center">
      {heading}
      <Card className="w-full">
        <CardHeader className="space-y-1.5 text-center">
          <div className="mx-auto mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl tracking-tight">Secure your account</CardTitle>
          <CardDescription>
            Add a passkey — it signs you in and unlocks admin actions like connecting a
            datasource. No password to remember.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {passkeyEnrolled ? (
            <div
              className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
              role="status"
            >
              <CheckCircle2 className="size-5 shrink-0" aria-hidden />
              <span>Passkey added. You&apos;re all set.</span>
            </div>
          ) : (
            <>
              {webAuthnSupported && (
                <Button
                  type="button"
                  className="w-full"
                  disabled={enrolling}
                  onClick={handleEnrollPasskey}
                >
                  {enrolling ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Fingerprint className="size-4" aria-hidden />
                  )}
                  {enrolling ? "Waiting for passkey…" : "Create a passkey"}
                </Button>
              )}

              {credentialError && <ErrorBanner>{credentialError}</ErrorBanner>}

              <div className="relative">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                  {webAuthnSupported ? "or" : ""}
                </span>
              </div>

              {/* Non-WebAuthn fallback: password + TOTP (ADR-0018). Gated on
                  ToS too — it's a terminal exit with no later Finish gate. */}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={fallbackSending || !tosAccepted}
                onClick={handlePasswordFallback}
              >
                {fallbackSending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <KeyRound className="size-4" aria-hidden />
                )}
                Set a password instead
              </Button>
              {!webAuthnSupported && (
                <p className="text-center text-xs text-muted-foreground">
                  This browser doesn&apos;t support passkeys — set a password, then add an
                  authenticator app under Account → Security.
                </p>
              )}
            </>
          )}

          <div className="flex items-start gap-2 pt-1">
            <Checkbox
              id="claim-tos"
              checked={tosAccepted}
              onCheckedChange={(checked) => setTosAccepted(checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor="claim-tos" className="text-xs font-normal leading-relaxed text-muted-foreground">
              I agree to the{" "}
              <a
                href="https://www.useatlas.dev/terms"
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                href="https://www.useatlas.dev/privacy"
                className="text-primary hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Privacy Policy
              </a>
              .
            </Label>
          </div>

          <Button type="button" className="w-full" disabled={!canFinish} onClick={handleFinish}>
            Finish & go to your workspace
            <ArrowRight className="ml-2 size-4" aria-hidden />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** Inline destructive-tone alert, matching the auth pages' error treatment. */
function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="flex-1 text-xs leading-relaxed">{children}</p>
    </div>
  );
}
