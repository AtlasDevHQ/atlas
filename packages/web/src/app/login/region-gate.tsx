"use client";

/**
 * Returning-user login region gate (ADR-0024 §3, #3973).
 *
 * The email-first step shown BEFORE the credentials form in cross-origin SaaS
 * mode when no `atlas_region` cookie is set yet. It asks the region-agnostic
 * front-door (`POST /api/login/resolve-region`) which region owns the typed
 * email, then:
 *   - single   → applies the region signal and reloads so the auth client
 *                singleton rebuilds against that region's API (the cookie is
 *                read at import — see lib/auth/client.ts);
 *   - multiple → presents a chooser (same email in >1 region, §6);
 *   - none     → offers signup;
 *   - skip     → reveals the credentials form against the default base
 *                (single-region / not a multi-region deployment);
 *   - error    → lets the user retry (never silently mis-routes to US).
 *
 * The raw email is sent only to our own same-origin front-door, which hashes
 * it; it is never sent to a regional API. The credentials form takes over once
 * `onResolved` fires.
 */

import { useState } from "react";
import { applyRegionSignal } from "@/lib/api-url";
import { isLikelyEmail, type RegionChoice, type RegionResolution } from "@/lib/login-frontdoor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Database, Loader2, AlertCircle, ArrowRight, Globe } from "lucide-react";

/** sessionStorage key carrying the typed email across the post-resolution reload. */
const PENDING_EMAIL_KEY = "atlas_pending_login_email";

export interface LoginRegionGateProps {
  email: string;
  onEmailChange: (email: string) => void;
  /** Region routing is settled — reveal the credentials form (default base). */
  onResolved: () => void;
}

export function LoginRegionGate({ email, onEmailChange, onResolved }: LoginRegionGateProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [choices, setChoices] = useState<RegionChoice[] | null>(null);

  /** Apply the chosen region and reload so the auth client targets it. */
  function routeTo(region: string, apiUrl: string) {
    if (!applyRegionSignal(region, apiUrl)) {
      setError("That region is temporarily unreachable. Please try again.");
      return;
    }
    // Carry the email across the reload so the user doesn't retype it.
    try {
      sessionStorage.setItem(PENDING_EMAIL_KEY, email);
    } catch {
      // intentionally ignored: a blocked sessionStorage just means the user
      // re-types their email on the reloaded form — not worth failing the flow.
    }
    // Hard reload: the auth client binds its baseURL from the atlas_region
    // cookie at module import, so the regional base only takes effect on a
    // fresh load (lib/auth/client.ts). The cookie was just written by
    // applyRegionSignal, so the reload lands on the cookie fast-path.
    window.location.reload();
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!isLikelyEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    setChoices(null);
    try {
      const res = await fetch("/api/login/resolve-region", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email }),
      });
      const result = (await res.json()) as RegionResolution;
      switch (result.outcome) {
        case "single":
          routeTo(result.region, result.apiUrl);
          return; // reload in flight
        case "multiple":
          setChoices(result.regions);
          return;
        case "none":
          setNotFound(true);
          return;
        case "skip":
          // Not a multi-region deployment — keep the typed email and reveal the
          // form against the default base. No region signal, no reload.
          onResolved();
          return;
        case "error":
        default:
          setError(
            "message" in result && result.message
              ? result.message
              : "We couldn't route your sign-in. Please try again.",
          );
          return;
      }
    } catch (err) {
      console.warn(
        "[login] region resolution failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Database className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Atlas</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Enter your email and we&apos;ll take you to your workspace&apos;s region.
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          {choices ? (
            <div className="space-y-3" role="group" aria-label="Choose your region">
              <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                <Globe className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <p>
                  You have workspaces in more than one region. Pick the one you want to
                  sign in to — each region is a separate account.
                </p>
              </div>
              <div className="grid gap-2">
                {choices.map((c) => (
                  <Button
                    key={c.region}
                    type="button"
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => routeTo(c.region, c.apiUrl)}
                  >
                    <span>{c.label}</span>
                    <ArrowRight className="size-4" aria-hidden />
                  </Button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  setChoices(null);
                  setError(null);
                }}
                className="w-full text-center text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={handleContinue} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="login-region-email">Email</Label>
                <Input
                  id="login-region-email"
                  type="email"
                  placeholder="jane@example.com"
                  value={email}
                  onChange={(e) => {
                    onEmailChange(e.target.value);
                    if (notFound) setNotFound(false);
                  }}
                  required
                  autoFocus
                  autoComplete="email"
                  disabled={loading}
                />
              </div>

              {notFound && (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-md border bg-muted/40 p-3 text-sm"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
                    We couldn&apos;t find an account for that email in any region.{" "}
                    <a href="/signup" className="font-medium text-primary hover:underline">
                      Create one
                    </a>
                    .
                  </p>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <p className="flex-1 text-xs leading-relaxed">{error}</p>
                </div>
              )}

              <Button type="submit" className="w-full" disabled={loading || !email}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                    Finding your region…
                  </>
                ) : (
                  <>
                    Continue
                    <ArrowRight className="ml-2 size-4" aria-hidden />
                  </>
                )}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Read + clear the email stashed before a region-routing reload, if any. */
export function takePendingLoginEmail(): string | null {
  try {
    const v = sessionStorage.getItem(PENDING_EMAIL_KEY);
    if (v) sessionStorage.removeItem(PENDING_EMAIL_KEY);
    return v;
  } catch {
    // intentionally ignored: no sessionStorage ⇒ no pending email to restore.
    return null;
  }
}
