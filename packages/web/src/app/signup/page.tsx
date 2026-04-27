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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { GoogleIcon, GitHubIcon, MicrosoftIcon } from "@/ui/components/social-icons";
import { SignupShell } from "@/ui/components/signup/signup-shell";

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const [socialProviders, setSocialProviders] = useState<string[]>([]);

  useEffect(() => {
    const base = getApiBase();
    fetch(`${base}/api/v1/onboarding/social-providers`)
      .then((r) => {
        if (!r.ok) throw new Error(`Social providers returned ${r.status}`);
        return r.json();
      })
      .then((data: { providers?: string[] }) => {
        if (Array.isArray(data.providers)) setSocialProviders(data.providers);
      })
      .catch((err: unknown) => {
        // Graceful degradation: email/password form still works
        console.warn("Social providers unavailable:", err instanceof Error ? err.message : String(err));
      });
  }, []);

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
      router.push("/signup/workspace");
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
      await authClient.signIn.social({
        provider: provider as "google" | "github" | "microsoft",
        callbackURL: "/signup/workspace",
      });
    } catch (err) {
      console.warn("Social login failed:", err instanceof Error ? err.message : String(err));
      setError(err instanceof Error ? err.message : "Social login failed");
    } finally {
      setSocialLoading(null);
    }
  }

  return (
    <SignupShell step="account">
      <Card>
        <CardHeader className="space-y-1.5 text-center">
          <CardTitle className="text-2xl tracking-tight">Create your account</CardTitle>
          <CardDescription>
            Get started with Atlas — your AI data analyst.
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
              <Label htmlFor="signup-email">Work email</Label>
              <Input
                id="signup-email"
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
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
              disabled={loading || !email || !password}
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
