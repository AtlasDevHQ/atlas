"use client";

/**
 * Backup-method banner — top of `/admin/settings/security`.
 *
 * Renders when the calling user matches the lockout-risk profile:
 * exactly one passkey, no password, no TOTP. Losing the only
 * authenticator in that state requires admin-mediated MFA reset to
 * recover; the banner widens the bottleneck by nudging the user toward
 * a second passkey (preferred) or a password fallback.
 *
 * Dismissal is per-session (`sessionStorage`); the dismissal flag is
 * cleared once the predicate clears so a future at-risk session
 * surfaces the banner cleanly.
 */

import { useEffect, useState } from "react";
import { KeyRound, ShieldAlert, X } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { cn } from "@/lib/utils";

// Hand-mirrored from `MyMfaFactorsResponseSchema` in
// `packages/api/src/api/routes/admin-mfa-reset.ts`. Update both when the
// response shape changes.
const MfaFactorsSchema = z.object({
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  passkeyCount: z.number().int().nonnegative(),
});

type MfaFactors = z.infer<typeof MfaFactorsSchema>;

// Lockout-risk: exactly one passkey, no password, no TOTP.
function isAtLockoutRisk(f: MfaFactors): boolean {
  return f.passkeyCount === 1 && !f.hasPassword && !f.hasTotp;
}

const DISMISS_STORAGE_KEY = "atlas:backup-method-banner:dismissed";

export interface BackupMethodBannerProps {
  /**
   * Click handler for the primary "Enroll a second passkey" CTA. Wired
   * by the parent so the same passkey-add flow as the enrollment tile
   * fires (consistent OS prompt, naming dialog, post-enroll refetch).
   */
  onAddPasskey: () => void;
  /**
   * Click handler for the secondary "Add a password" CTA. Optional —
   * when omitted (e.g. SaaS deploys that don't expose self-service
   * password setup outside the email flow), the secondary button is
   * suppressed and only the passkey CTA renders.
   */
  onAddPassword?: () => void;
}

export function BackupMethodBanner({ onAddPasskey, onAddPassword }: BackupMethodBannerProps) {
  const { data, loading, error } = useAdminFetch<MfaFactors>(
    "/api/v1/admin/me/mfa-factors",
    { schema: MfaFactorsSchema },
  );

  // Per-session dismissal — read once on mount, cleared below when the
  // predicate clears.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(DISMISS_STORAGE_KEY) === "1";
    } catch (err) {
      // intentionally ignored: storage access throws in private-mode browsers.
      console.debug("[backup-method-banner] sessionStorage unavailable", err);
      return false;
    }
  });

  function handleDismiss() {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_STORAGE_KEY, "1");
    } catch (err) {
      // intentionally ignored: storage write throws in private-mode browsers.
      console.debug("[backup-method-banner] sessionStorage write failed", err);
    }
  }

  // Drop the dismissal once the predicate clears so a future at-risk
  // session surfaces the banner cleanly.
  useEffect(() => {
    if (!data) return;
    if (dismissed && !isAtLockoutRisk(data)) {
      try {
        window.sessionStorage.removeItem(DISMISS_STORAGE_KEY);
      } catch (err) {
        console.debug("[backup-method-banner] sessionStorage removeItem failed", err);
      }
      setDismissed(false);
    }
  }, [data, dismissed]);

  if (loading || error || !data || dismissed || !isAtLockoutRisk(data)) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg ring-1 ring-amber-500/30 bg-amber-500/5 p-4",
        "flex items-start gap-3",
      )}
    >
      <span
        className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300"
        aria-hidden
      >
        <ShieldAlert className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Add a backup method</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          You have one passkey and no other way to sign in. If you lose access
          to that authenticator, an admin will need to manually reset your
          MFA before you can recover the account. Enrolling a second
          passkey&mdash;ideally on a different device&mdash;is the simplest
          way to widen the recovery path.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onAddPasskey}>
            <KeyRound className="mr-1.5 size-3.5" />
            Enroll a second passkey
          </Button>
          {/* Secondary CTA only renders when the parent supplies a handler — see prop doc. */}
          {onAddPassword && (
            <Button size="sm" variant="outline" onClick={onAddPassword}>
              Add a password
            </Button>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={handleDismiss}
        aria-label="Dismiss for this session"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
