"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { getApiUrl } from "@/lib/api-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  Database,
  AlertCircle,
  Fingerprint,
  Loader2,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";
import {
  GoogleIcon,
  GitHubIcon,
  MicrosoftIcon,
} from "@/ui/components/social-icons";
import { parseSignInError, type SignInErrorState } from "./parse-sign-in-error";
import { getPostSignInRoute } from "./post-sign-in-route";
import { getPasskeySignIn } from "@/lib/auth/passkey-client";
import { parsePasskeySignInError } from "@/lib/auth/parse-passkey-sign-in-error";
import { useWebAuthnSupported } from "@/ui/hooks/use-webauthn-supported";
import { VerifyEmailOTPForm } from "@/ui/components/auth/verify-email-otp-form";

type SocialProvider = "google" | "github" | "microsoft";

const SOCIAL_PROVIDERS: ReadonlyArray<{
  id: SocialProvider;
  label: string;
  Icon: React.ComponentType;
}> = [
  { id: "google", label: "Continue with Google", Icon: GoogleIcon },
  { id: "github", label: "Continue with GitHub", Icon: GitHubIcon },
  { id: "microsoft", label: "Continue with Microsoft", Icon: MicrosoftIcon },
];

const KNOWN_PROVIDERS = new Set<SocialProvider>(["google", "github", "microsoft"]);

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function LoginPage() {
  const router = useRouter();
  const webAuthnSupport = useWebAuthnSupported();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<SignInErrorState | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<SocialProvider | null>(null);
  const [socialProviders, setSocialProviders] = useState<readonly SocialProvider[]>([]);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  // The passkey button is hidden entirely on unsupported browsers (no banner —
  // see issue #2091). `webAuthnSupport.kind === "supported"` is the load-bearing
  // gate; `unknown` (pre-effect / SSR) hides the button to avoid hydration
  // mismatch and a no-op click before capability detection settles.
  const passkeyAvailable = webAuthnSupport.kind === "supported";

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${getApiBase()}/api/v1/onboarding/social-providers`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Social providers returned ${r.status}`);
        return r.json();
      })
      .then((data: { providers?: string[] }) => {
        if (controller.signal.aborted || !Array.isArray(data.providers)) return;
        // Filter to providers we render UI for; unknown ids (e.g. saml/oidc)
        // fall through silently to the email/password form.
        setSocialProviders(
          data.providers.filter((p): p is SocialProvider =>
            KNOWN_PROVIDERS.has(p as SocialProvider),
          ),
        );
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        console.warn(
          "Social providers unavailable:",
          err instanceof Error ? err.message : String(err),
        );
      });
    return () => controller.abort();
  }, []);

  // Whether the deployment has an email provider wired. Drives the
  // "Forgot password?" link below — we don't surface a recovery
  // affordance that would email into a black hole on a self-hosted
  // instance with no SMTP. The endpoint is public; deferred fetch
  // keeps the form usable if the API is briefly unreachable.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${getApiBase()}/api/v1/onboarding/password-reset-status`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((data: { enabled?: boolean }) => {
        if (controller.signal.aborted) return;
        setPasswordResetEnabled(Boolean(data.enabled));
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        console.debug(
          "Password reset status unavailable:",
          err instanceof Error ? err.message : String(err),
        );
      });
    return () => controller.abort();
  }, []);

  // Conditional UI autofill — pairs with `autocomplete="username webauthn"`
  // on the email input below to surface saved passkeys in the OS autofill
  // picker without the user clicking the dedicated button. Fires exactly
  // once after capability detection settles; the ref guard prevents a
  // re-render from firing duplicate ceremonies (each ceremony allocates a
  // server-side challenge, so duplicates are wasteful and produce confusing
  // double prompts on slow autofill hardware).
  //
  // Better Auth's wrapper traps `NotAllowedError` from the conditional-UI
  // ceremony and folds it into `error.code === "AUTH_CANCELLED"`. We treat
  // that branch as silent — the autofill picker is allowed to be ignored.
  const autoFillFiredRef = useRef(false);
  useEffect(() => {
    if (webAuthnSupport.kind !== "supported") return;
    if (autoFillFiredRef.current) return;
    const signIn = getPasskeySignIn();
    if (!signIn) return;
    autoFillFiredRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await signIn({ autoFill: true });
        if (cancelled) return;
        if (res.error) {
          // Debug level (not warn) is intentional: the autofill flow is
          // expected to fall through silently for users without a saved
          // passkey, and warn would spam DevTools on every visit. A real
          // misconfiguration (rpID mismatch) still leaves a breadcrumb.
          console.debug(
            "[passkey] autoFill returned error:",
            res.error.code ?? res.error.message ?? "unknown",
          );
          return;
        }
        if (res.data) {
          router.push("/");
          return;
        }
        // Better Auth's wire shape technically allows `{ data: null, error: null }`.
        // It shouldn't happen in practice; warn so a contract drift is visible.
        console.warn("[passkey] autoFill returned data:null without error", res);
      } catch (err) {
        if (cancelled) return;
        // A throw out of `signIn()` is genuinely unexpected — Better Auth
        // catches the user-cancellation NotAllowedError internally — so
        // warn rather than debug.
        console.warn(
          "[passkey] autoFill threw:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [webAuthnSupport.kind, router]);

  async function handlePasskeySignIn() {
    setError(null);
    setPasskeyError(null);
    const signIn = getPasskeySignIn();
    if (!signIn) {
      // Plugin unavailable — surface a soft message rather than a silent
      // no-op so a misconfigured client (e.g. passkeyClient() not
      // registered) is visible to the user rather than baked-in disabled.
      setPasskeyError(
        "Passkey sign-in is not available right now. Use email and password instead.",
      );
      return;
    }
    setPasskeyLoading(true);
    try {
      const res = await signIn();
      if (res.error) {
        const outcome = parsePasskeySignInError({ kind: "wire", error: res.error });
        if (outcome.kind === "silent") {
          // User cancellation — log so a misconfigured rpID is visible in
          // DevTools, but don't render a banner. Same discipline as the
          // enrollment tile in passkey-tile.tsx.
          console.debug("[passkey] sign-in cancelled or NotAllowedError:", res.error);
        } else {
          console.warn("[passkey] sign-in failed", res.error);
          setPasskeyError(outcome.message);
        }
        return;
      }
      if (!res.data) {
        // Wire shape technically allows `{ data: null, error: null }`.
        // Treat as a "refresh the page" hint rather than a silent success.
        console.warn("[passkey] sign-in returned data:null without error", res);
        setPasskeyError(
          "Passkey signed in but the server didn't return a session. Refresh the page.",
        );
        return;
      }
      router.push("/");
    } catch (err) {
      console.warn(
        "[passkey] sign-in threw:",
        err instanceof Error ? err.message : String(err),
      );
      const outcome = parsePasskeySignInError({ kind: "thrown", value: err });
      // Thrown branch never returns `silent` — only the wire-error path
      // does — but the discriminated outcome forces explicit handling.
      if (outcome.kind === "user") setPasskeyError(outcome.message);
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);
    setError(null);

    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) {
        setError(parseSignInError({ error: res.error, attemptedEmail: email }));
        return;
      }
      // Force a session fetch before navigating so AuthGuard sees the
      // just-established session on the next route; otherwise the in-memory
      // store can still hold its pre-signin `null` snapshot and bounce us
      // back to /login (#2487). The 2FA branch returns
      // `twoFactorRedirect: true` (no session yet) — getSession is still safe
      // there since it just returns null.
      await authClient.getSession().catch((err: unknown) => {
        console.debug(
          "[login] getSession after signin failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
      router.push(getPostSignInRoute(res.data));
    } catch (err) {
      console.debug(
        "Sign in failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError(parseSignInError({ thrown: err, attemptedEmail: email }));
    } finally {
      setLoading(false);
    }
  }

  async function handleSocialLogin(provider: SocialProvider) {
    setError(null);
    setSocialLoading(provider);
    try {
      await authClient.signIn.social({ provider, callbackURL: "/" });
    } catch (err) {
      console.debug(
        "Social login failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError(parseSignInError({ thrown: err }));
    } finally {
      setSocialLoading(null);
    }
  }

  const anyLoading = loading || socialLoading !== null || passkeyLoading;
  const visibleProviders = SOCIAL_PROVIDERS.filter((p) =>
    socialProviders.includes(p.id),
  );

  // Email-not-verified is a recoverable signin failure: the server has
  // already auto-sent a verification OTP via `sendOnSignIn: true`, so the
  // user needs to enter that code, not retry the password. Swap to a
  // dedicated OTP-entry view rather than cramming the form into the
  // existing error tile — same component used by the post-signup flow.
  if (error?.kind === "email_unverified") {
    return (
      <div className="flex flex-col items-center">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
            <Database className="size-6 text-primary" aria-hidden />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            We sent an 8-character code to{" "}
            <span className="font-medium text-foreground">{error.attemptedEmail}</span>.
          </p>
        </div>
        <Card className="w-full">
          <CardContent className="space-y-4 pt-6">
            <VerifyEmailOTPForm
              email={error.attemptedEmail}
              onVerified={() => router.push("/")}
            />
            <p className="text-center text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setError(null)}
                className="font-medium text-primary hover:underline"
              >
                Use a different account
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Database className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Sign in to Atlas
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Pick up where you left off — your conversations, dashboards, and
          notebooks are waiting.
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          {passkeyAvailable && (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={anyLoading}
                onClick={handlePasskeySignIn}
                aria-label="Sign in with a passkey"
              >
                {passkeyLoading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Fingerprint className="size-4" aria-hidden />
                )}
                {passkeyLoading ? "Waiting for passkey…" : "Sign in with a passkey"}
              </Button>
              {passkeyError && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <p className="flex-1 text-xs leading-relaxed">{passkeyError}</p>
                </div>
              )}
              <div className="relative">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                  or
                </span>
              </div>
            </>
          )}

          {visibleProviders.length > 0 && (
            <>
              <div className="grid gap-2">
                {visibleProviders.map(({ id, label, Icon }) => {
                  const isLoading = socialLoading === id;
                  return (
                    <Button
                      key={id}
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={anyLoading}
                      onClick={() => handleSocialLogin(id)}
                    >
                      {isLoading ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <Icon />
                      )}
                      {isLoading ? "Redirecting…" : label}
                    </Button>
                  );
                })}
              </div>
              <div className="relative">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                  or
                </span>
              </div>
            </>
          )}

          {/* noValidate: defer to <SignInErrorAlert> instead of native popups. */}
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                // `username webauthn` opts the field into the OS conditional-UI
                // picker driven by `signIn.passkey({ autoFill: true })` above.
                // Falls back to plain `username` (browsers ignore the unknown
                // token) when WebAuthn is unsupported.
                autoComplete={passkeyAvailable ? "username webauthn" : "email"}
                disabled={anyLoading}
              />
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
                  aria-hidden
                />
                <span>
                  Use your work email — we&apos;ll redirect you to single
                  sign-on if your workspace requires it.
                </span>
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password">Password</Label>
                {passwordResetEnabled && (
                  <a
                    href="/forgot-password"
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary hover:underline underline-offset-4"
                  >
                    Forgot password?
                  </a>
                )}
              </div>
              <Input
                id="login-password"
                type="password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                disabled={anyLoading}
              />
            </div>

            {error && <SignInErrorAlert error={error} />}

            <Button
              type="submit"
              className="w-full"
              disabled={anyLoading || !email || !password}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <a
          href="/signup"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Create one
        </a>
      </p>
    </div>
  );
}

function SignInErrorAlert({ error }: { error: SignInErrorState }) {
  const isSso = error.kind === "sso_required";
  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-md border p-3 text-sm",
        isSso
          ? "border-primary/30 bg-primary/5 text-foreground"
          : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
      )}
    >
      {isSso ? (
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <div className="flex-1 space-y-1">
        <p className="font-medium leading-tight">{error.title}</p>
        <p
          className={cn(
            "text-xs leading-relaxed",
            isSso ? "text-muted-foreground" : "text-red-800/90 dark:text-red-200/90",
          )}
        >
          {error.body}
        </p>
        {error.kind === "sso_required" && error.action && (
          <a
            href={error.action.href}
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {error.action.label}
            <ArrowRight className="size-3" aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}

