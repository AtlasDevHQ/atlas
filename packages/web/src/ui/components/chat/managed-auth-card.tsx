"use client";

import { useState } from "react";
import { useAtlasConfig } from "../../context";
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
import { Database } from "lucide-react";

export function ManagedAuthCard() {
  const { authClient } = useAtlasConfig();
  const [view, setView] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) setError(res.error.message ?? "Sign in failed");
    } catch (err) {
      console.error("Sign in error:", err);
      setError(err instanceof TypeError ? "Unable to reach the server" : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authClient.signUp.email({ email, password, name: name || email.split("@")[0] });
      if (res.error) setError(res.error.message ?? "Sign up failed");
    } catch (err) {
      console.error("Sign up error:", err);
      setError(err instanceof TypeError ? "Unable to reach the server" : "Sign up failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
            <Database className="size-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">
            {view === "login" ? "Sign in to Atlas" : "Create an account"}
          </CardTitle>
          <CardDescription>
            {view === "login"
              ? "Your AI-powered data analyst."
              : "Get started with Atlas."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={view === "login" ? handleLogin : handleSignup} className="space-y-4">
            {view === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="auth-name">Name</Label>
                <Input
                  id="auth-name"
                  placeholder="Jane Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="auth-email">Email</Label>
              <Input
                id="auth-email"
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auth-password">Password</Label>
              <Input
                id="auth-password"
                type="password"
                placeholder={view === "signup" ? "At least 8 characters" : "Your password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={view === "signup" ? 8 : undefined}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              className="w-full"
              disabled={loading || !email || !password}
            >
              {loading
                ? "..."
                : view === "login"
                  ? "Sign in"
                  : "Create account"}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            {view === "login" ? (
              <>
                Don&apos;t have an account?{" "}
                <button
                  onClick={() => { setView("signup"); setError(""); }}
                  className="text-primary hover:underline"
                >
                  Create one
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => { setView("login"); setError(""); }}
                  className="text-primary hover:underline"
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
