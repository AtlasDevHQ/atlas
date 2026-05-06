"use client";

/**
 * Better Auth two-factor challenge surface — landing page for the
 * `twoFactorRedirect: true` response from `signIn.email`. The user has no
 * session cookie yet (only a short-lived two-factor cookie identifying the
 * pending user), so failing to complete the flow leaves the user genuinely
 * unauthenticated.
 *
 * A user with a passkey enrolled can also complete the second factor by
 * calling `signIn.passkey()` — the passkey is itself a possession factor,
 * so a successful WebAuthn assertion creates a fresh session that supersedes
 * the partial-auth two-factor cookie. The button is rendered whenever the
 * browser supports WebAuthn; the "no passkey for this user" path surfaces
 * a friendly hint via {@link parsePasskeySignInError}.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, Fingerprint, Loader2, ShieldCheck } from "lucide-react";
import {
  getTwoFactorClient,
  unwrapTwoFactorResult,
  type TwoFactorApiError,
} from "@/lib/auth/two-factor-client";
import { getPasskeySignIn } from "@/lib/auth/passkey-client";
import { parsePasskeySignInError } from "@/lib/auth/parse-passkey-sign-in-error";
import { useWebAuthnSupported } from "@/ui/hooks/use-webauthn-supported";

type Mode = "totp" | "backup";

interface ModeConfig {
  title: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  inputMode: "numeric" | "text";
  maxLength: number;
  isComplete: (value: string) => boolean;
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
  maxLength: 11,
  isComplete: (v) => v.replace(/[-\s]/g, "").length >= 10,
  sanitise: (raw) => raw.replace(/\s+/g, "").slice(0, 11),
  fallback: "That backup code didn't match. Try a different one.",
  switchLabel: "Use my authenticator app instead",
};

const MODES: Record<Mode, ModeConfig> = { totp: TOTP_MODE, backup: BACKUP_MODE };

function logFailure(action: string, raw: TwoFactorApiError | null): void {
  console.warn(`[two-factor:sign-in] ${action} failed`, raw);
}

export default function TwoFactorChallengePage() {
  const router = useRouter();
  const webAuthnSupport = useWebAuthnSupported();
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  // Synchronous in-flight flag — `busy` state lags by a render so a
  // double-click within the same tick would fire two verify calls and burn
  // two backup codes server-side. Ref takes effect immediately.
  const submittingRef = useRef(false);
  const passkeySubmittingRef = useRef(false);

  const config = MODES[mode];
  const passkeyAvailable = webAuthnSupport.kind === "supported";

  async function handlePasskey(): Promise<void> {
    if (passkeySubmittingRef.current) return;
    setPasskeyError(null);
    const signIn = getPasskeySignIn();
    if (!signIn) {
      setPasskeyError(
        "Passkey sign-in is not available right now. Use your authenticator app instead.",
      );
      return;
    }
    passkeySubmittingRef.current = true;
    setPasskeyBusy(true);
    try {
      const res = await signIn();
      if (res.error) {
        const message = parsePasskeySignInError({ error: res.error });
        if (message === null) {
          // Cancellation — log so a misconfigured rpID still leaves a
          // breadcrumb; never render a banner for an Esc on the OS prompt.
          console.debug("[two-factor:sign-in] passkey cancelled", res.error);
        } else {
          console.warn("[two-factor:sign-in] passkey sign-in failed", res.error);
          setPasskeyError(message);
        }
        return;
      }
      if (!res.data) {
        console.warn(
          "[two-factor:sign-in] passkey sign-in returned data:null without error",
          res,
        );
        setPasskeyError(
          "Passkey signed in but the server didn't return a session. Refresh the page.",
        );
        return;
      }
      router.push("/");
    } catch (err) {
      console.warn(
        "[two-factor:sign-in] passkey sign-in threw:",
        err instanceof Error ? err.message : String(err),
      );
      setPasskeyError(
        parsePasskeySignInError({ thrown: err }) ??
          "Passkey sign-in didn't complete. Try your authenticator app.",
      );
    } finally {
      passkeySubmittingRef.current = false;
      setPasskeyBusy(false);
    }
  }

  function switchMode(next: Mode): void {
    setMode(next);
    setCode("");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!config.isComplete(code) || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);

    const client = getTwoFactorClient();
    if (!client) {
      // Developer-facing breadcrumb; user sees the generic copy below.
      console.warn("[two-factor:sign-in] twoFactor client plugin not loaded");
      setError("Two-factor sign-in is not available. Refresh the page or contact your workspace admin.");
      setBusy(false);
      submittingRef.current = false;
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
        submittingRef.current = false;
        return;
      }
      router.push("/");
    } catch (err) {
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
      submittingRef.current = false;
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
          {passkeyAvailable && (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy || passkeyBusy}
                onClick={() => {
                  void handlePasskey();
                }}
                aria-label="Use a passkey instead"
              >
                {passkeyBusy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Fingerprint className="size-4" aria-hidden />
                )}
                {passkeyBusy ? "Waiting for passkey…" : "Use a passkey"}
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
                disabled={busy || passkeyBusy}
                autoFocus
                className="font-mono text-base tracking-widest"
              />
            </div>

            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                id="trust-device"
                checked={trustDevice}
                onCheckedChange={(checked) => setTrustDevice(checked === true)}
                disabled={busy || passkeyBusy}
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
              disabled={busy || passkeyBusy || !config.isComplete(code)}
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

      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={() => switchMode(mode === "totp" ? "backup" : "totp")}
        disabled={busy || passkeyBusy}
        className="mt-4 text-muted-foreground hover:text-primary"
      >
        {config.switchLabel}
      </Button>
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

function formatTrustExpiry(): string {
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(expiry);
  } catch (err) {
    // Intl unavailable in the runtime — surface a breadcrumb so a real
    // regression doesn't go silent, fall back to ISO so the caption stays
    // meaningful.
    console.debug(
      "[two-factor:sign-in] Intl.DateTimeFormat unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return expiry.toISOString().slice(0, 10);
  }
}
