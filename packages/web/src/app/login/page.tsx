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
import { parseSignInError, type SignInErrorState } from "./parse-sign-in-error";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<SignInErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<SocialProvider | null>(null);
  const [socialProviders, setSocialProviders] = useState<readonly SocialProvider[]>([]);

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
