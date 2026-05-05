"use client";

/**
 * Two-factor sign-in challenge.
 *
 * Reached when `/login`'s `signIn.email` call returns
 * `{ data: { twoFactorRedirect: true } }` — Better Auth's signal that the
 * user has TOTP enrolled and the current device doesn't carry a valid
 * trust cookie. Without this page the half-authenticated state has no UI
 * surface at all, which is the primary regression PR C.1 closes (#2082).
 *
 * The user has NOT been issued a session cookie at this point — only a
 * short-lived two-factor cookie that identifies the pending user. Failing
 * to complete the flow means no session is ever created, so route guards
 * on `/admin/*` simply see "no session" and behave normally.
 *
 * Mode toggle (TOTP ↔ backup code) is the same component on the same URL —
 * not a separate route — so deep-links and the back button stay sane.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";
import {
  getTwoFactorClient,
  unwrapTwoFactorResult,
  type TwoFactorApiError,
} from "@/lib/auth/two-factor-client";

type Mode = "totp" | "backup";

interface ModeConfig {
  title: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  inputMode: "numeric" | "text";
  /** TOTP codes are exactly 6 digits; backup codes are 11 chars (5-5 with hyphen). */
  maxLength: number;
  /** Submit-button enable predicate — TOTP demands all 6 digits, backup tolerates user-entered formatting. */
  isComplete: (value: string) => boolean;
  /** Sanitiser run on every keystroke. TOTP strips non-digits; backup is left as-typed (codes are alphanumeric). */
  sanitise: (raw: string) => string;
  fallback: string;
  switchLabel: string;
}

const TOTP_MODE: ModeConfig = {
  title: "Enter your authenticator code",
  description:
    "Open the app you set up during enrollment (Google Authenticator, 1Password, Authy…) and type the 6-digit code.",
  inputLabel: "Authenticator code",
  placeholder: "123456",
  inputMode: "numeric",
  maxLength: 6,
  isComplete: (v) => v.length === 6,
  sanitise: (raw) => raw.replace(/\D/g, "").slice(0, 6),
  fallback: "That code didn't match. Try again.",
  switchLabel: "Use a backup code instead",
};

const BACKUP_MODE: ModeConfig = {
  title: "Enter a backup code",
  description:
    "Use one of the codes saved when you set up two-factor. Each code only works once — pick a fresh one.",
  inputLabel: "Backup code",
  placeholder: "abcde-12345",
  inputMode: "text",
  // 5-5 layout with optional hyphen, plus the hyphen itself.
  maxLength: 11,
  isComplete: (v) => v.replace(/[-\s]/g, "").length >= 10,
  // Backup codes from `generateBackupCodesFn` are alphanumeric — strip
  // whitespace but preserve the hyphen so the user sees the same shape
  // they copied. The server normalises before comparing.
  sanitise: (raw) => raw.replace(/\s+/g, "").slice(0, 11),
  fallback: "That backup code didn't match. Try a different one.",
  switchLabel: "Use my authenticator app instead",
};

const MODES: Record<Mode, ModeConfig> = { totp: TOTP_MODE, backup: BACKUP_MODE };

/**
 * Single audit-trail line so support can recover `code` / `status` from a
 * user report — the UI only surfaces the human-friendly message above.
 */
function logFailure(action: string, raw: TwoFactorApiError | null): void {
  console.warn(`[two-factor:sign-in] ${action} failed`, raw);
}

export default function TwoFactorChallengePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = MODES[mode];

  /**
   * Switch between TOTP and backup mode. Deliberately resets `code` and
   * `error` (different validation rules, different shape) but PRESERVES
   * `trustDevice` — switching input methods shouldn't quietly toggle the
   * security choice the user already made.
   */
  function switchMode(next: Mode): void {
    setMode(next);
    setCode("");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!config.isComplete(code) || busy) return;
    setBusy(true);
    setError(null);

    const client = getTwoFactorClient();
    if (!client) {
      // Plugin missing client-side. Surface a generic failure — the user
      // can't act on this, but support can recover the cause from the
      // breadcrumb below.
      console.warn(
        "[two-factor:sign-in] twoFactor client plugin not loaded — check packages/web/src/lib/auth/client.ts",
      );
      setError("Two-factor sign-in is not available. Refresh the page or contact your workspace admin.");
      setBusy(false);
      return;
    }

    try {
      const result =
        mode === "totp"
          ? await client.verifyTotp({ code, trustDevice })
          : await client.verifyBackupCode({ code, trustDevice });
      const outcome = unwrapTwoFactorResult(result, config.fallback);
      if (!outcome.ok) {
        logFailure(mode === "totp" ? "verifyTotp" : "verifyBackupCode", outcome.raw);
        setError(outcome.message);
        setBusy(false);
        return;
      }
      // Session is now established — Better Auth set the session cookie on
      // the response. Route to the post-login landing; downstream onboarding
      // / mode-router state is fetched by the destination page.
      router.push("/");
    } catch (err) {
      // Network / TypeError path. Catch-and-classify mirrors the main login
      // page; we don't want a thrown fetch to leave the user staring at a
      // disabled form with no feedback.
      console.warn(
        "[two-factor:sign-in] verify threw:",
        err instanceof Error ? err.message : String(err),
      );
      setError(
        err instanceof TypeError
          ? "Can't reach the server. Check your connection and try again."
          : err instanceof Error && err.message
            ? err.message
            : config.fallback,
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{config.title}</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {config.description}
        </p>
      </div>

      <Card className="w-full">
        <CardContent className="space-y-4 pt-6">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="two-factor-code">{config.inputLabel}</Label>
              <Input
                id="two-factor-code"
                type="text"
                inputMode={config.inputMode}
                autoComplete="one-time-code"
                maxLength={config.maxLength}
                placeholder={config.placeholder}
                value={code}
                onChange={(e) => setCode(config.sanitise(e.target.value))}
                disabled={busy}
                autoFocus
                className="font-mono text-base tracking-widest"
              />
            </div>

            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                id="trust-device"
                checked={trustDevice}
                onCheckedChange={(checked) => setTrustDevice(checked === true)}
                disabled={busy}
                className="mt-0.5"
              />
              <span className="flex-1 select-none">
                <span className="font-medium">Trust this device for 30 days</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Skip the code prompt on this browser until {formatTrustExpiry()}.
                  Don't enable on a shared computer.
                </span>
              </span>
            </label>

            {error && <ChallengeErrorAlert message={error} />}

            <Button
              type="submit"
              className="w-full"
              disabled={busy || !config.isComplete(code)}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  Verifying…
                </>
              ) : (
                "Continue"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <button
        type="button"
        onClick={() => switchMode(mode === "totp" ? "backup" : "totp")}
        disabled={busy}
        className="mt-4 text-sm font-medium text-muted-foreground transition-colors hover:text-primary hover:underline underline-offset-4 disabled:opacity-50"
      >
        {config.switchLabel}
      </button>
    </div>
  );
}

function ChallengeErrorAlert({ message }: { message: string }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="flex-1 text-xs leading-relaxed">{message}</p>
    </div>
  );
}

/**
 * Best-effort human-readable expiry stamp for the trust-device caption.
 * Reads the current date at render — accurate to the day, which is enough
 * for "Skip the prompt until April 12" copy. Wrapped so a non-`Intl`
 * runtime (older test environments) doesn't crash the page.
 */
function formatTrustExpiry(): string {
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(expiry);
  } catch {
    // Intl not available — fall back to ISO date so the caption is still meaningful.
    return expiry.toISOString().slice(0, 10);
  }
}
