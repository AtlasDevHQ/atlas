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

import { useState } from "react";
import { Fingerprint, KeyRound, Loader2, ShieldX } from "lucide-react";
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
import { useWebAuthnSupported } from "@/ui/hooks/use-webauthn-supported";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort default name for a fresh passkey, matched off `navigator.userAgent`.
 * The user can always overwrite the field before saving.
 */
export function deriveDefaultPasskeyName(ua: string): string {
  const lower = ua.toLowerCase();

  let device = "This device";
  if (lower.includes("iphone")) device = "iPhone";
  else if (lower.includes("ipad")) device = "iPad";
  else if (lower.includes("android")) device = "Android";
  else if (lower.includes("mac os") || lower.includes("macintosh")) device = "Mac";
  else if (lower.includes("windows")) device = "Windows PC";
  else if (lower.includes("linux") || lower.includes("cros")) device = "Linux";

  let browser: string | null = null;
  if (lower.includes("edg/")) browser = "Edge";
  else if (lower.includes("chrome/") && !lower.includes("chromium")) browser = "Chrome";
  else if (lower.includes("firefox/")) browser = "Firefox";
  else if (lower.includes("safari/") && !lower.includes("chrome/")) browser = "Safari";

  return browser ? `${device} · ${browser}` : device;
}

function getDefaultName(): string {
  if (typeof navigator === "undefined") return "This device";
  return deriveDefaultPasskeyName(navigator.userAgent);
}

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [namingHint, setNamingHint] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; defaultName: string } | null>(null);
  const [name, setName] = useState("");

  async function handleAdd() {
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
    const defaultName = getDefaultName();
    setPending({ id, defaultName });
    setName(defaultName);
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
    </>
  );
}
