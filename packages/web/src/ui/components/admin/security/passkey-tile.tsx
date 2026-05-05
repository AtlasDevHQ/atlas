"use client";

/**
 * Passkey enrollment tile, mounted inside `/admin/settings/security` next to
 * the TOTP and backup-codes tiles (#2082 PR B).
 *
 * Click flow:
 *   1. Tile button → `authClient.passkey.addPasskey()` (no name passed).
 *   2. OS biometric prompt fires immediately.
 *   3. On success Better Auth returns the new {@link Passkey} including its id.
 *   4. We render an in-component name modal with a userAgent-derived default
 *      and persist the user's choice via `authClient.passkey.updatePasskey({ id, name })`.
 *
 * Naming AFTER enrollment (rather than passing a name into addPasskey) means
 * users hit the OS prompt with one click — and a cancelled OS prompt never
 * leaves an orphaned name in flight.
 *
 * Tile state matrix is owned by the parent page (`security/page.tsx`); this
 * component just renders + reports back via `onChange()` so the page can
 * refetch the passkey list and surface the new row.
 */

import { useState } from "react";
import { Fingerprint, KeyRound, Loader2, ShieldX } from "lucide-react";
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
import { useWebAuthnSupported } from "@/ui/hooks/use-webauthn-supported";

// ---------------------------------------------------------------------------
// Types — narrow view into the Better Auth passkey client surface
// ---------------------------------------------------------------------------

interface Passkey {
  id: string;
  name?: string;
  createdAt: Date | string;
}

type ClientResult<T> = {
  data: T | null;
  error: { message?: string; code?: string; status?: number } | null;
};

interface PasskeyClient {
  addPasskey: (opts?: {
    name?: string;
    authenticatorAttachment?: "platform" | "cross-platform";
  }) => Promise<ClientResult<Passkey>>;
  updatePasskey: (opts: { id: string; name: string }) => Promise<ClientResult<{ passkey: Passkey }>>;
}

function getPasskeyClient(): PasskeyClient {
  const namespace = (authClient as unknown as { passkey?: PasskeyClient }).passkey;
  if (!namespace) {
    throw new Error(
      "Better Auth passkey client plugin is not loaded — check packages/web/src/lib/auth/client.ts",
    );
  }
  return namespace;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort default name for a fresh passkey.
 *
 * The userAgent string is famously messy. We don't try to be clever — match
 * a handful of obvious tokens, fall back to "This device" when nothing
 * matches. The user can always overwrite the field before saving.
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
 * `REGISTRATION_CANCELLED` — distinguish them from real errors so the UI
 * doesn't shout "system error" when the user hits "Cancel" on the OS prompt.
 */
function isUserCancellation(error: ClientResult<unknown>["error"]): boolean {
  if (!error) return false;
  if (error.code === "REGISTRATION_CANCELLED") return true;
  // Browsers surface the underlying DOMException as `NotAllowedError` when
  // the user dismisses the platform prompt; Better Auth currently passes
  // its message through unchanged for non-mapped errors.
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
  const { supported, platformSupported } = useWebAuthnSupported();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; defaultName: string } | null>(null);
  const [name, setName] = useState("");

  async function handleAdd() {
    setBusy(true);
    setError(null);
    let result: ClientResult<Passkey>;
    try {
      result = await getPasskeyClient().addPasskey();
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
        // No-op: user dismissed the OS prompt themselves; surfacing an
        // error here just looks like a bug. Returning silently lets them
        // tap the tile again.
        return;
      }
      console.warn("[passkey] addPasskey failed", result.error);
      setError(result.error.message ?? "Could not register that passkey. Please try again.");
      return;
    }

    if (!result.data) {
      // Shouldn't happen, but the wire shape technically allows it. Surface
      // a generic message rather than failing silently.
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
    const trimmed = name.trim() || pending.defaultName;
    setBusy(true);
    setError(null);
    let result: ClientResult<{ passkey: Passkey }>;
    try {
      result = await getPasskeyClient().updatePasskey({ id: pending.id, name: trimmed });
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[passkey] updatePasskey threw", msg);
      // Naming is cosmetic — the passkey is enrolled. Close the dialog and
      // let the parent refetch; the row will just show the unnamed default.
      setPending(null);
      onChange?.();
      setError(`Saved your passkey, but renaming failed: ${msg}. You can rename it from the list.`);
      return;
    }
    setBusy(false);

    if (result.error) {
      console.warn("[passkey] updatePasskey failed", result.error);
      setPending(null);
      onChange?.();
      setError(
        `Saved your passkey, but renaming failed: ${result.error.message ?? "unknown error"}. You can rename it from the list.`,
      );
      return;
    }

    setPending(null);
    onChange?.();
  }

  // ── Render ─────────────────────────────────────────────────────────

  if (supported === false) {
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

  const showRecommendedBadge = !hasPasskey && supported === true && platformSupported !== false;
  const subtitle =
    platformSupported === false
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
          <Button onClick={handleAdd} disabled={busy || supported !== true}>
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <KeyRound className="mr-1.5 size-3.5" />}
            {hasPasskey ? "Add another passkey" : "Add a passkey"}
          </Button>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            // Dismissing the rename dialog still leaves the passkey enrolled —
            // it just won't have a custom name. Trigger a refetch so the row
            // appears in the list.
            setPending(null);
            onChange?.();
          }
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
            <AlertDialogCancel
              onClick={() => {
                setPending(null);
                onChange?.();
              }}
            >
              Skip
            </AlertDialogCancel>
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
