"use client";

import { useState, useEffect } from "react";
import { AtlasChat } from "@useatlas/react";
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
import { Database, ArrowRight, Sparkles } from "lucide-react";

const DEMO_TOKEN_KEY = "atlas-demo-token";
const DEMO_EMAIL_KEY = "atlas-demo-email";
const DEMO_EXPIRES_KEY = "atlas-demo-expires";

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

export default function DemoPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [returning, setReturning] = useState(false);

  // Restore token from sessionStorage on mount, checking expiry
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(DEMO_TOKEN_KEY);
      const expiresAt = sessionStorage.getItem(DEMO_EXPIRES_KEY);
      if (stored && expiresAt && Number(expiresAt) > Date.now()) {
        setToken(stored);
      } else if (stored) {
        // Token expired — clear stale session
        sessionStorage.removeItem(DEMO_TOKEN_KEY);
        sessionStorage.removeItem(DEMO_EXPIRES_KEY);
      }
      const storedEmail = sessionStorage.getItem(DEMO_EMAIL_KEY);
      if (storedEmail) setEmail(storedEmail);
    } catch {
      // intentionally ignored: sessionStorage may be unavailable in some contexts
    }
  }, []);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setError(null);

    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/v1/demo/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? `Failed to start demo (HTTP ${res.status})`);
        return;
      }

      const data: {
        token: string;
        expiresAt: number;
        returning: boolean;
        conversationCount: number;
      } = await res.json();

      setToken(data.token);
      setReturning(data.returning);

      try {
        sessionStorage.setItem(DEMO_TOKEN_KEY, data.token);
        sessionStorage.setItem(DEMO_EMAIL_KEY, email);
        sessionStorage.setItem(DEMO_EXPIRES_KEY, String(data.expiresAt));
      } catch {
        // intentionally ignored: sessionStorage unavailable — token lives in state only
      }
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Unable to reach the server"
          : "Failed to start demo session",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSignOut() {
    setToken(null);
    try {
      sessionStorage.removeItem(DEMO_TOKEN_KEY);
      sessionStorage.removeItem(DEMO_EMAIL_KEY);
      sessionStorage.removeItem(DEMO_EXPIRES_KEY);
    } catch {
      // intentionally ignored: sessionStorage may be unavailable
    }
  }

  // Email gate
  if (!token) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="size-6 text-primary" />
            </div>
            <CardTitle className="text-2xl">Try Atlas</CardTitle>
            <CardDescription>
              Ask questions about a sample cybersecurity dataset — no signup or
              database required.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleStart} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="demo-email">Email</Label>
                <Input
                  id="demo-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                type="submit"
                className="w-full"
                disabled={loading || !email}
              >
                {loading ? "Starting..." : "Start demo"}
                {!loading && <ArrowRight className="ml-2 size-4" />}
              </Button>
            </form>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <a href="/signup" className="text-primary hover:underline">
                Sign in
              </a>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Chat mode
  return (
    <>
      {/* CTA banner */}
      <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-2 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Database className="size-4" />
          <span>
            {returning ? "Welcome back! " : ""}You&apos;re using Atlas in demo
            mode with sample data.
          </span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/signup"
            className="font-medium text-primary hover:underline"
          >
            Sign up to connect your own database
          </a>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Exit demo
          </Button>
        </div>
      </div>

      {/* Chat UI */}
      <div className="flex-1 overflow-hidden">
        <AtlasChat
          apiUrl={getApiUrl()}
          apiKey={token}
          chatEndpoint="/api/v1/demo/chat"
          conversationsEndpoint="/api/v1/demo/conversations"
          sidebar
        />
      </div>
    </>
  );
}
