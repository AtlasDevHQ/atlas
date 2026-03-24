"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { API_URL } from "@/lib/api-url";
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
import { Database } from "lucide-react";
import { GoogleIcon, GitHubIcon, MicrosoftIcon } from "@/ui/components/social-icons";

function getApiBase(): string {
  if (API_URL) return API_URL;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function LoginPage() {
  const router = useRouter();
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
        setError(res.error.message ?? "Sign in failed");
        return;
      }
      router.push("/");
    } catch (err) {
      console.debug("Sign in failed:", err instanceof Error ? err.message : String(err));
      setError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Sign in failed",
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
        callbackURL: "/",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Social login failed");
    } finally {
      setSocialLoading(null);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Database className="size-6 text-primary" />
        </div>
        <CardTitle className="text-2xl">Sign in to Atlas</CardTitle>
        <CardDescription>
          Your AI-powered data analyst.
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
                  {socialLoading === "google"
                    ? "Redirecting..."
                    : "Continue with Google"}
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
                  {socialLoading === "github"
                    ? "Redirecting..."
                    : "Continue with GitHub"}
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
                  {socialLoading === "microsoft"
                    ? "Redirecting..."
                    : "Continue with Microsoft"}
                </Button>
              )}
            </div>
            <div className="relative">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                or
              </span>
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
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
            />
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
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || !email || !password}
          >
            {loading ? "Signing in..." : "Sign in"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <a href="/signup" className="text-primary hover:underline">
            Create one
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

