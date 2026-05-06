"use client";

/**
 * Passkey enrollment tile, mounted inside `/admin/settings/security` next to
 * the TOTP and backup-codes tiles.
 *
 * Click flow:
 *   1. Tile button → `addPasskey()` (no name passed).
 *   2. OS biometric prompt fires immediately.
 *   3. On success Better Auth returns the new {@link Passkey} including its id.
 *   4. We render an in-component name modal with a userAgent-derived default
 *      and persist the user's choice via `updatePasskey({ id, name })`.
 *
 * Naming AFTER enrollment (rather than passing a name into addPasskey) means
 * users hit the OS prompt with one click — and a cancelled OS prompt never
 * leaves an orphaned name in flight.
 */

import { useRef, useState } from "react";
import { Fingerprint, KeyRound, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  getPasskeyClient,
  type PasskeyApiError,
} from "@/lib/auth/passkey-client";
import { getDefaultDeviceName } from "@/lib/auth/derive-device-name";
import { useWebAuthnSupported } from "@/ui/hooks/use-webauthn-supported";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Better Auth surfaces user-cancelled WebAuthn flows with code
 * `REGISTRATION_CANCELLED`. Browsers also raise `NotAllowedError` for several
 * non-cancellation reasons (RP ID mismatch, authenticator timeout, etc.) —
 * those are *not* cancellations, but the message folds them into the same
 * shape. Callers must always log on this branch so a misconfigured RP ID
 * doesn't disappear into a silent no-op.
 */
function isUserCancellation(error: PasskeyApiError | null): boolean {
  if (!error) return false;
  if (error.code === "REGISTRATION_CANCELLED") return true;
  const msg = error.message?.toLowerCase() ?? "";
  return msg.includes("notallowed") || msg.includes("cancelled") || msg.includes("canceled");
}

/**
 * Better Auth's `freshSessionMiddleware` rejects sensitive operations
 * (passkey enrollment, account deletion) when the session has aged
 * past `session.freshAge` (default 1 day). Detect the rejection by
 * `code === "SESSION_NOT_FRESH"`; fall back to a message-substring
 * match for older Better Auth versions that surfaced only the literal
 * "Session is not fresh" string with no `code` on the error envelope.
 */
function isSessionNotFresh(error: PasskeyApiError | null): boolean {
  if (!error) return false;
  if (error.code === "SESSION_NOT_FRESH") return true;
  const msg = error.message?.toLowerCase() ?? "";
  return msg.includes("session is not fresh");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PasskeyTileProps {
  /**
   * Whether the user already has at least one passkey enrolled. The tile
   * stays clickable in either state (a user with one passkey on a desktop
   * laptop probably wants another on their phone), but the recommended
   * badge only shows when nothing is enrolled yet.
   */
  hasPasskey: boolean;
  /** Called after a successful addPasskey + name persistence so the parent can refetch the list. */
  onChange?: () => void;
}

export function PasskeyTile({ hasPasskey, onChange }: PasskeyTileProps) {
  const support = useWebAuthnSupported();
  const session = authClient.useSession();
  const userEmail =
    typeof session.data?.user?.email === "string" ? session.data.user.email : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [namingHint, setNamingHint] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; defaultName: string } | null>(null);
  const [name, setName] = useState("");
  const [reauthOpen, setReauthOpen] = useState(false);

  async function runAddPasskey(): Promise<void> {
    const client = getPasskeyClient();
    if (!client) {
      setError("Passkey support couldn't be loaded. Refresh the page and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    setNamingHint(null);
    let result: Awaited<ReturnType<typeof client.addPasskey>>;
    try {
      result = await client.addPasskey();
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] addPasskey threw", msg);
      setError("Could not start passkey enrollment. Please try again.");
      return;
    }
    setBusy(false);

    if (result.error) {
      if (isUserCancellation(result.error)) {
        // Always log — even on the "expected" cancellation branch — so a
        // misconfigured RP ID (very plausible in self-hosted deploys where
        // the cookie domain ≠ API host) doesn't disappear silently.
        console.debug("[passkey] addPasskey cancelled or NotAllowedError", result.error);
        return;
      }
      if (isSessionNotFresh(result.error)) {
        // The session is older than `session.freshAge` (default 1 day).
        // Better Auth requires a fresh session for enrollment so a stolen
        // long-lived cookie can't silently provision a permanent passkey
        // on the attacker's authenticator. Open the re-auth dialog —
        // `runAddPasskey` is re-invoked by the dialog after `signIn.email`
        // mints a new session.
        console.debug("[passkey] addPasskey blocked: SESSION_NOT_FRESH — opening re-auth dialog");
        setReauthOpen(true);
        return;
      }
      console.warn("[passkey] addPasskey failed", result.error);
      setError(result.error.message ?? "Could not register that passkey. Please try again.");
      return;
    }

    if (!result.data) {
      // The wire shape technically allows `{ data: null, error: null }`.
      // Log so a regression is visible in DevTools instead of silent.
      console.warn("[passkey] addPasskey returned data:null without error", result);
      setError("Passkey was registered but no details were returned. Refresh to confirm.");
      onChange?.();
      return;
    }

    const id = result.data.id;
    const defaultName = getDefaultDeviceName();
    setPending({ id, defaultName });
    setName(defaultName);
  }

  function handleAdd(): void {
    void runAddPasskey();
  }

  async function handleReauthSuccess(): Promise<void> {
    setReauthOpen(false);
    // Retry enrollment with the fresh session minted by the dialog.
    await runAddPasskey();
  }

  async function handleSaveName() {
    if (!pending) return;
    const client = getPasskeyClient();
    if (!client) {
      // Naming is cosmetic — the passkey is already enrolled. Surface the
      // failure as a recoverable hint and let the parent refetch.
      setPending(null);
      onChange?.();
      setNamingHint(
        "Saved your passkey, but the rename request couldn't be sent. Rename it from the list below.",
      );
      return;
    }
    const trimmed = name.trim() || pending.defaultName;
    setBusy(true);
    let result: Awaited<ReturnType<typeof client.updatePasskey>>;
    try {
      result = await client.updatePasskey({ id: pending.id, name: trimmed });
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] updatePasskey threw", msg);
      setPending(null);
      onChange?.();
      setNamingHint(
        `Saved your passkey, but renaming failed: ${msg}. You can rename it from the list below.`,
      );
      return;
    }
    setBusy(false);

    if (result.error) {
      console.warn("[passkey] updatePasskey failed", result.error);
      setPending(null);
      onChange?.();
      setNamingHint(
        `Saved your passkey, but renaming failed: ${result.error.message ?? "unknown error"}. You can rename it from the list below.`,
      );
      return;
    }

    setPending(null);
    onChange?.();
  }

  function handleSkipNaming() {
    if (!pending) return;
    console.debug("[passkey] user skipped naming", { id: pending.id });
    setPending(null);
    onChange?.();
  }

  // ── Render ─────────────────────────────────────────────────────────

  if (support.kind === "unsupported") {
    return (
      <Card className="opacity-70">
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
            <ShieldX className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm font-semibold">Passkey unavailable</CardTitle>
            <p className="text-xs text-muted-foreground">
              Your browser doesn't support passkeys. Use an authenticator app instead.
            </p>
          </div>
        </CardHeader>
      </Card>
    );
  }

  const platformAuthenticatorAvailable =
    support.kind === "supported" ? support.platformAuthenticator : false;
  const showRecommendedBadge = !hasPasskey && support.kind === "supported" && platformAuthenticatorAvailable;
  const subtitle =
    support.kind === "supported" && !platformAuthenticatorAvailable
      ? "Limited support — security key only. Connect a hardware key (e.g. YubiKey) to continue."
      : "Phishing-resistant. Works with Touch ID, Face ID, Windows Hello, or a security key.";

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">
            <Fingerprint className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-semibold">Passkey</CardTitle>
              {showRecommendedBadge && (
                <Badge
                  variant="secondary"
                  className="border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
                >
                  Recommended
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Button onClick={handleAdd} disabled={busy || support.kind !== "supported"}>
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <KeyRound className="mr-1.5 size-3.5" />}
            {hasPasskey ? "Add another passkey" : "Add a passkey"}
          </Button>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          {namingHint && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{namingHint}</p>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) handleSkipNaming();
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Name this passkey</AlertDialogTitle>
            <AlertDialogDescription>
              Give it a name you'll recognize later — useful when you have more
              than one device.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5 py-2">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Passkey name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={pending?.defaultName ?? "MacBook · Safari"}
              maxLength={80}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveName();
                }
              }}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleSkipNaming}>Skip</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open while the request is in flight so the
                // user sees the spinner. Radix would otherwise close on click.
                e.preventDefault();
                void handleSaveName();
              }}
              disabled={busy}
            >
              {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PasskeyReauthDialog
        open={reauthOpen}
        email={userEmail}
        onCancel={() => setReauthOpen(false)}
        onSuccess={handleReauthSuccess}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Re-auth dialog (SESSION_NOT_FRESH recovery)
// ---------------------------------------------------------------------------

/**
 * Password-prompt dialog that mints a fresh session and retries the
 * enrollment. Used only when `addPasskey` is rejected with
 * SESSION_NOT_FRESH — i.e. the user's session is older than
 * `session.freshAge` (default 1 day). A fresh `signIn.email` resets
 * `session.createdAt`, which is what `freshSessionMiddleware` checks.
 *
 * Lives in this file (vs. a shared `<ReauthDialog>` module) because
 * re-auth UX has nuance per surface — the wording, the retry shape,
 * and the OAuth-only fallback all want to be tuned at the call site.
 * If we add a second sensitive op (delete passkey, change password
 * inside admin) we should extract this to `ui/components/admin/security/`
 * and share — but premature abstraction is worse than a 60-line copy.
 *
 * OAuth-only users (no `credential` account) cannot re-auth via password.
 * `signIn.email` returns INVALID_EMAIL_OR_PASSWORD; we surface a
 * recoverable hint pointing them at sign-out / sign-back-in.
 */
function PasskeyReauthDialog({
  open,
  email,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  email: string | null;
  onCancel: () => void;
  onSuccess: () => Promise<void> | void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Mid-flight cancellation: Esc and click-outside route through Radix's
  // `onOpenChange(false)` even while `signIn.email` is in flight, but the
  // promise still resolves later. Without this gate the resolved tail
  // would surface a stale error or — worse — call `onSuccess()` on a
  // dialog the user has already dismissed, popping the OS biometric
  // prompt out of nowhere. The ref resets on every open via the JSX
  // `onOpenChange` (see `handleOpenChange(true)`).
  const cancelledRef = useRef(false);

  // Reset local state on close so the next open starts clean — a
  // dismissed-with-error attempt should not show its old banner the
  // next time the dialog is invoked. `onCancel` propagates the close
  // up to the parent which owns the `open` prop.
  function handleOpenChange(next: boolean) {
    if (next) {
      cancelledRef.current = false;
      return;
    }
    cancelledRef.current = true;
    setPassword("");
    setErrorMsg(null);
    setBusy(false);
    onCancel();
  }

  async function handleSubmit(): Promise<void> {
    if (!email) {
      setErrorMsg(
        "Couldn't read your email from the current session. Please sign out and back in to add a passkey.",
      );
      return;
    }
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await authClient.signIn.email({ email, password });
      if (cancelledRef.current) return;
      if (res.error) {
        // The most common branch: wrong password OR an OAuth-only user
        // with no `credential` account. Better Auth folds both into
        // INVALID_EMAIL_OR_PASSWORD; we treat them the same UX-wise.
        const code = (res.error as { code?: string }).code;
        if (code === "INVALID_EMAIL_OR_PASSWORD") {
          setErrorMsg(
            "That password didn't work. If you signed up with Google, GitHub, or SSO, sign out and back in to add a passkey.",
          );
        } else {
          setErrorMsg(
            res.error.message ?? "Could not re-authenticate. Please try again.",
          );
        }
        setBusy(false);
        return;
      }
      // Better Auth returns `twoFactorRedirect: true` when the account has
      // TOTP enabled. Re-auth via password alone won't refresh the session
      // in that case — Better Auth issues the new session only after the
      // 2FA challenge clears. Send the user to /login/two-factor with a
      // callbackURL so they bounce straight back to /admin/settings/security
      // after the challenge clears (see `two-factor/page.tsx` for the
      // same-origin allowlist on the redirect target).
      //
      // Reset busy/password BEFORE assigning so a navigation that gets
      // blocked (popup blocker, CSP, an extension intercepting) doesn't
      // wedge the dialog with `busy === true` and `disabled` Cancel.
      if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        setPassword("");
        setBusy(false);
        window.location.assign("/login/two-factor?callbackURL=/admin/settings/security");
        return;
      }
      setPassword("");
      setBusy(false);
      await onSuccess();
    } catch (err) {
      if (cancelledRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] re-auth signIn.email threw", msg);
      setErrorMsg("Could not re-authenticate. Please try again.");
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="mb-1 flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="size-4" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wider">
              Confirm it&apos;s you
            </span>
          </div>
          <AlertDialogTitle>Re-enter your password to add a passkey</AlertDialogTitle>
          <AlertDialogDescription>
            For your security, passkey enrollment requires a recent sign-in.
            Re-enter your password to continue — we&apos;ll add the passkey
            right after.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 py-2">
          {email && (
            <div className="text-xs text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{email}</span>
            </div>
          )}
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            disabled={busy}
          />
          {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
            disabled={busy || !password || !email}
          >
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Confirm and add passkey
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
