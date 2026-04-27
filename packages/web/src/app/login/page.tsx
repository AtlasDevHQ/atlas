"use client";

import { useState, useEffect } from "react";
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
  Loader2,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";
import {
  GoogleIcon,
  GitHubIcon,
  MicrosoftIcon,
} from "@/ui/components/social-icons";

type SocialProvider = "google" | "github" | "microsoft";

const SOCIAL_PROVIDERS: ReadonlyArray<{
  id: SocialProvider;
  label: string;
  Icon: () => React.JSX.Element;
}> = [
  { id: "google", label: "Continue with Google", Icon: GoogleIcon },
  { id: "github", label: "Continue with GitHub", Icon: GitHubIcon },
  { id: "microsoft", label: "Continue with Microsoft", Icon: MicrosoftIcon },
];

type SignInErrorKind =
  | "network"
  | "invalid_credentials"
  | "rate_limited"
  | "email_unverified"
  | "sso_required"
  | "unknown";

interface SignInErrorState {
  kind: SignInErrorKind;
  title: string;
  body: string;
  action?: { label: string; href: string };
}

/**
 * Map a Better Auth sign-in error or thrown exception to a categorized,
 * user-facing alert. Falls back to a generic "try again" if the shape is
 * unfamiliar — never collapses to a silent no-op.
 */
function parseSignInError(input: {
  error?: { message?: string | null; code?: string | null; status?: number | null };
  thrown?: unknown;
}): SignInErrorState {
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
      title: "Sign in failed",
      body: message || "Something went wrong. Try again in a moment.",
    };
  }

  const err = input.error ?? {};
  const code = (err.code ?? "").toUpperCase();
  const message = err.message ?? "";
  const status = err.status ?? 0;

  if (status === 429 || code.includes("RATE") || /too many|rate limit/i.test(message)) {
    return {
      kind: "rate_limited",
      title: "Too many sign-in attempts",
      body: "We've temporarily paused sign-ins from this device. Wait a minute and try again.",
    };
  }

  // Better Auth's standard wrong-credentials envelope. Keep the word
  // "incorrect" — the e2e suite (auth.spec.ts) asserts /invalid|incorrect/i.
  if (
    status === 401 ||
    code.includes("INVALID_EMAIL_OR_PASSWORD") ||
    /invalid|incorrect|password/i.test(message)
  ) {
    return {
      kind: "invalid_credentials",
      title: "Email or password is incorrect",
      body: "Double-check your credentials. If you forgot your password, contact your workspace admin to reset it.",
    };
  }

  if (code.includes("EMAIL_NOT_VERIFIED") || /verify|verification/i.test(message)) {
    return {
      kind: "email_unverified",
      title: "Verify your email first",
      body: "We sent a verification link to your inbox. Open it to activate your account, then sign in.",
    };
  }

  // Server may emit SSO_REQUIRED for domains that enforce single sign-on
  // (F-56). When the response carries a redirect URL, surface it as a
  // one-click action.
  if (code.includes("SSO") || /single sign-on|sso required/i.test(message)) {
    const redirect =
      "ssoRedirectUrl" in (err as Record<string, unknown>)
        ? String((err as Record<string, unknown>).ssoRedirectUrl ?? "")
        : "";
    return {
      kind: "sso_required",
      title: "Your workspace requires single sign-on",
      body: "Sign in with your company's identity provider to continue.",
      action: redirect
        ? { label: "Continue with SSO", href: redirect }
        : undefined,
    };
  }

  return {
    kind: "unknown",
    title: "Sign in failed",
    body: message || "Something went wrong. Try again in a moment.",
  };
}

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<SignInErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<SocialProvider | null>(null);
  const [socialProviders, setSocialProviders] = useState<readonly SocialProvider[]>([]);

  useEffect(() => {
    const base = getApiBase();
    fetch(`${base}/api/v1/onboarding/social-providers`)
      .then((r) => {
        if (!r.ok) throw new Error(`Social providers returned ${r.status}`);
        return r.json();
      })
      .then((data: { providers?: string[] }) => {
        if (Array.isArray(data.providers)) {
          const known = new Set<SocialProvider>(["google", "github", "microsoft"]);
          setSocialProviders(
            data.providers.filter((p): p is SocialProvider =>
              known.has(p as SocialProvider),
            ),
          );
        }
      })
      .catch((err: unknown) => {
        // Graceful degradation: email/password form still works
        console.warn(
          "Social providers unavailable:",
          err instanceof Error ? err.message : String(err),
        );
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);
    setError(null);

    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) {
        setError(parseSignInError({ error: res.error }));
        return;
      }
      router.push("/");
    } catch (err) {
      console.debug(
        "Sign in failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError(parseSignInError({ thrown: err }));
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

  const anyLoading = loading || socialLoading !== null;
  const visibleProviders = SOCIAL_PROVIDERS.filter((p) =>
    socialProviders.includes(p.id),
  );

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
                autoComplete="email"
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
              <Label htmlFor="login-password">Password</Label>
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
  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-md border p-3 text-sm",
        error.kind === "sso_required"
          ? "border-primary/30 bg-primary/5 text-foreground"
          : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
      )}
    >
      {error.kind === "sso_required" ? (
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <div className="flex-1 space-y-1">
        <p className="font-medium leading-tight">{error.title}</p>
        <p
          className={cn(
            "text-xs leading-relaxed",
            error.kind === "sso_required"
              ? "text-muted-foreground"
              : "text-red-800/90 dark:text-red-200/90",
          )}
        >
          {error.body}
        </p>
        {error.action && (
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
